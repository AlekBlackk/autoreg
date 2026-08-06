(function (global) {
  'use strict';
  const RegLog = global.RegLog = global.RegLog || {};
  const mail = RegLog.mail = {};

  mail.registrableDomain = RegLog.store.registrableDomain;

  class MailError extends Error {
    constructor(providerId, reason, { status = 0, retryAfter = 0 } = {}) {
      super(`${providerId}: ${reason}`);
      this.name = 'MailError';
      this.providerId = providerId;
      this.reason = reason; // 'network'|'timeout'|'rate'|'auth'|'taken'|'expired'|'server'|'shape'
      this.status = status;
      this.retryAfter = retryAfter;
    }
  }
  mail.MailError = MailError;

  const controllers = new Set();
  if (typeof addEventListener === 'function') {
    addEventListener('pagehide', () => { for (const c of controllers) c.abort(); controllers.clear(); });
  }

  const lastRequestAt = new Map(); // providerId -> ts, троттлинг 1 запрос / 500мс

  async function throttle(providerId) {
    const last = lastRequestAt.get(providerId) || 0;
    const wait = 500 - (Date.now() - last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestAt.set(providerId, Date.now());
  }

  async function timedFetch(providerId, url, options = {}) {
    await throttle(providerId);
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } catch (e) {
      if (e.name === 'AbortError') throw new MailError(providerId, 'timeout');
      throw new MailError(providerId, 'network');
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
      clearTimeout(timeout);
    }
  }
  mail._timedFetch = timedFetch; // экспорт для переиспользования в адаптерах Task 8

  function retryAfterSeconds(res) {
    const h = res.headers.get('Retry-After');
    if (!h) return 0;
    const n = Number(h);
    if (!Number.isNaN(n)) return n;
    const date = new Date(h).getTime();
    return Number.isNaN(date) ? 0 : Math.max(0, Math.round((date - Date.now()) / 1000));
  }
  mail._retryAfterSeconds = retryAfterSeconds;

  function normalizeDate(v) {
    if (typeof v === 'number') return v;
    const t = Date.parse(v);
    return Number.isNaN(t) ? Date.now() : t;
  }
  mail._normalizeDate = normalizeDate;

  async function checkGraphQLErrors(providerId, body) {
    if (body && Array.isArray(body.errors) && body.errors.length > 0) {
      const msg = String(body.errors[0].message || '');
      if (/RATE_LIMIT/i.test(msg)) throw new MailError(providerId, 'rate');
      if (/EXPIRED|NOT_FOUND/i.test(msg)) throw new MailError(providerId, 'expired');
      if (/AUTH|UNAUTHORIZED/i.test(msg)) throw new MailError(providerId, 'auth');
      throw new MailError(providerId, 'server');
    }
  }
  mail._checkGraphQLErrors = checkGraphQLErrors;

  function makeMailTmLike(id, label, baseUrl) {
    async function getDomain() {
      const res = await timedFetch(id, `${baseUrl}/domains`);
      if (!res.ok) throw new MailError(id, 'server', { status: res.status });
      const body = await res.json();
      const list = Array.isArray(body['hydra:member']) ? body['hydra:member'] : body;
      if (!Array.isArray(list)) throw new MailError(id, 'shape');
      const domain = list.find(d => d.isActive && !d.isPrivate);
      if (!domain) throw new MailError(id, 'server');
      return domain.domain;
    }

    async function createAccount(address, password) {
      const res = await timedFetch(id, `${baseUrl}/accounts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password })
      });
      if (res.status === 422) throw new MailError(id, 'taken', { status: 422 });
      if (res.status === 429) throw new MailError(id, 'rate', { status: 429, retryAfter: retryAfterSeconds(res) });
      if (!res.ok) throw new MailError(id, 'server', { status: res.status });
      return res.json();
    }

    async function getToken(address, password) {
      const res = await timedFetch(id, `${baseUrl}/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password })
      });
      if (res.status === 429) throw new MailError(id, 'rate', { status: 429, retryAfter: retryAfterSeconds(res) });
      if (!res.ok) throw new MailError(id, 'auth', { status: res.status });
      const body = await res.json();
      if (!body || typeof body.token !== 'string') throw new MailError(id, 'shape');
      return body.token;
    }

    async function doRefresh(session) {
      try {
        const token = await getToken(session.address, session.secret.password);
        return { ...session, secret: { ...session.secret, token }, touchedAt: Date.now() };
      } catch (e) { return null; }
    }

    async function authedRequest(url, session, adapterRef) {
      let res = await timedFetch(id, url, { headers: { Authorization: `Bearer ${session.secret.token}` } });
      if (res.status === 401 || res.status === 403) {
        const fresh = await doRefresh(session);
        if (!fresh) throw new MailError(id, 'auth');
        Object.assign(session, fresh);
        res = await timedFetch(id, url, { headers: { Authorization: `Bearer ${session.secret.token}` } });
        if (res.status === 401 || res.status === 403) throw new MailError(id, 'auth');
      }
      if (res.status === 429) throw new MailError(id, 'rate', { status: 429, retryAfter: retryAfterSeconds(res) });
      if (!res.ok) throw new MailError(id, 'server', { status: res.status });
      return res;
    }

    return {
      id, label, canPickLocal: true, publicInbox: false, sessionTtlMs: 0, bodyInList: false,
      localPartOpts: { maxLen: 32, allowDot: true, minEntropyChars: 0 }, disabled: false,
      async create(localPart) {
        const domain = await getDomain();
        const password = RegLog.gen.password(24, false);
        const suffixes = ['', `-${RegLog.gen.username('random').slice(0, 3)}`, `-${RegLog.gen.username('random').slice(0, 5)}`];
        let lastErr;
        for (const suffix of suffixes) {
          const address = `${localPart}${suffix}@${domain}`;
          try {
            const acc = await createAccount(address, password);
            const token = await getToken(address, password);
            return {
              provider: id, address, secret: { token, password, accountId: acc.id },
              createdAt: Date.now(), touchedAt: Date.now()
            };
          } catch (e) {
            if (e instanceof MailError && e.reason === 'taken') { lastErr = e; continue; }
            throw e;
          }
        }
        throw lastErr;
      },
      async list(session) {
        const res = await authedRequest(`${baseUrl}/messages`, session);
        const body = await res.json();
        const list = Array.isArray(body['hydra:member']) ? body['hydra:member'] : body;
        if (!Array.isArray(list)) throw new MailError(id, 'shape');
        return list.map(m => ({
          id: m.id, from: (m.from && (m.from.address || m.from.name)) || '',
          subject: m.subject || '', date: normalizeDate(m.createdAt || m.updatedAt), intro: '', seen: !!m.seen
        }));
      },
      async read(session, msgId) {
        const res = await authedRequest(`${baseUrl}/messages/${msgId}`, session);
        const body = await res.json();
        return { text: body.text || '', html: Array.isArray(body.html) ? body.html.join('') : (body.html || '') };
      },
      async refresh(session) { return doRefresh(session); }
    };
  }

  const mailtm = makeMailTmLike('mailtm', 'mail.tm', 'https://api.mail.tm');
  const mailgw = makeMailTmLike('mailgw', 'mail.gw', 'https://api.mail.gw');

  const maildrop = {
    id: 'maildrop', label: 'Maildrop', canPickLocal: true, publicInbox: true, sessionTtlMs: 0, bodyInList: false,
    localPartOpts: { maxLen: 32, allowDot: false, minEntropyChars: 10 }, disabled: false,

    async create(localPart) {
      return { provider: 'maildrop', address: `${localPart}@maildrop.cc`, secret: {}, createdAt: Date.now(), touchedAt: Date.now() };
    },

    async list(session) {
      const mailbox = session.address.split('@')[0];
      const query = `query($m: String!) { inbox(mailbox: $m) { id headerfrom subject date } }`;
      const res = await timedFetch('maildrop', 'https://api.maildrop.cc/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { m: mailbox } })
      });
      if (!res.ok) throw new MailError('maildrop', 'server', { status: res.status });
      const body = await res.json();
      await checkGraphQLErrors('maildrop', body);
      const list = body.data && body.data.inbox;
      if (!Array.isArray(list)) throw new MailError('maildrop', 'shape');
      return list.map(m => ({ id: m.id, from: m.headerfrom || '', subject: m.subject || '', date: normalizeDate(m.date), intro: '', seen: true }));
    },

    async read(session, msgId) {
      const mailbox = session.address.split('@')[0];
      const query = `query($m: String!, $i: String!) { message(mailbox: $m, id: $i) { data html } }`;
      const res = await timedFetch('maildrop', 'https://api.maildrop.cc/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { m: mailbox, i: msgId } })
      });
      if (!res.ok) throw new MailError('maildrop', 'server', { status: res.status });
      const body = await res.json();
      await checkGraphQLErrors('maildrop', body);
      const msg = body.data && body.data.message;
      if (!msg) throw new MailError('maildrop', 'shape');
      return { text: msg.data || '', html: msg.html || '' };
    },

    async refresh() { return null; }
  };

  const dropmail = {
    // Отключён: реальный API DropMail отклоняет самостоятельно выпущенные токены
    // (подтверждено вживую — HTTP 403 invalid_token/legacy_token_disabled на любом
    // формате токена), рабочего ключа нет. Код и тесты оставлены как документация
    // ожидаемого поведения на случай появления легального способа авторизации.
    id: 'dropmail', label: 'DropMail', canPickLocal: false, publicInbox: false, sessionTtlMs: 600000, bodyInList: true,
    localPartOpts: { maxLen: 32, allowDot: false, minEntropyChars: 0 }, disabled: true,

    async create() {
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let token = 'af_';
      for (let i = 0; i < 20; i++) token += alphabet[RegLog.gen.randomInt(alphabet.length)];
      const mutation = `mutation { introduceSession(input: {withAddress: true}) { id expiresAt addresses { address restoreKey } } }`;
      const res = await timedFetch('dropmail', `https://dropmail.me/api/graphql/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: mutation })
      });
      if (!res.ok) throw new MailError('dropmail', 'server', { status: res.status });
      const body = await res.json();
      await checkGraphQLErrors('dropmail', body);
      const sess = body.data && body.data.introduceSession;
      if (!sess || !Array.isArray(sess.addresses) || !sess.addresses[0]) throw new MailError('dropmail', 'shape');
      return {
        provider: 'dropmail', address: sess.addresses[0].address,
        secret: { sessionId: sess.id, endpointToken: token, restoreKey: sess.addresses[0].restoreKey },
        createdAt: Date.now(), touchedAt: Date.now()
      };
    },

    async list(session) {
      const query = `query($id: ID!) { session(id: $id) { id expiresAt mails { id fromAddr toAddr headerSubject text html receivedAt rawSize } } }`;
      const res = await timedFetch('dropmail', `https://dropmail.me/api/graphql/${session.secret.endpointToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { id: session.secret.sessionId } })
      });
      if (!res.ok) throw new MailError('dropmail', 'server', { status: res.status });
      const body = await res.json();
      await checkGraphQLErrors('dropmail', body);
      const sess = body.data && body.data.session;
      if (sess === null) throw new MailError('dropmail', 'expired');
      if (!sess || !Array.isArray(sess.mails)) throw new MailError('dropmail', 'shape');
      return sess.mails.map(m => ({
        id: m.id, from: m.fromAddr || '', subject: m.headerSubject || '',
        date: normalizeDate(m.receivedAt), intro: (m.text || '').slice(0, 120), seen: true
      }));
    },

    async read(session, msgId) {
      const list = await this.list(session);
      const query = `query($id: ID!) { session(id: $id) { mails { id text html } } }`;
      const res = await timedFetch('dropmail', `https://dropmail.me/api/graphql/${session.secret.endpointToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { id: session.secret.sessionId } })
      });
      const body = await res.json();
      await checkGraphQLErrors('dropmail', body);
      const sess = body.data && body.data.session;
      if (sess === null) throw new MailError('dropmail', 'expired');
      const mail_ = sess && sess.mails && sess.mails.find(m => m.id === msgId);
      return { text: (mail_ && mail_.text) || '', html: (mail_ && mail_.html) || '' };
    },

    async refresh(session) {
      const mutation = `mutation($key: String!) { introduceSession(input: {restoreKey: $key}) { id expiresAt addresses { address restoreKey } } }`;
      try {
        const res = await timedFetch('dropmail', `https://dropmail.me/api/graphql/${session.secret.endpointToken}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: mutation, variables: { key: session.secret.restoreKey } })
        });
        const body = await res.json();
        if (body.errors) return null;
        const sess = body.data && body.data.introduceSession;
        if (!sess) return null;
        return {
          ...session, secret: { ...session.secret, sessionId: sess.id, restoreKey: sess.addresses[0].restoreKey },
          touchedAt: Date.now()
        };
      } catch (e) { return null; }
    }
  };

  const guerrilla = {
    id: 'guerrilla', label: 'Guerrilla Mail', canPickLocal: true, publicInbox: false, sessionTtlMs: 0, bodyInList: true,
    localPartOpts: { maxLen: 32, allowDot: false, minEntropyChars: 0 }, disabled: false,

    async create(localPart) {
      const base = 'https://api.guerrillamail.com/ajax.php';
      const res1 = await timedFetch('guerrilla', `${base}?f=get_email_address&ip=127.0.0.1&agent=reglog`);
      if (!res1.ok) throw new MailError('guerrilla', 'server', { status: res1.status });
      const body1 = await res1.json();
      if (!body1 || typeof body1.sid_token !== 'string') throw new MailError('guerrilla', 'shape');
      const sidToken = body1.sid_token;

      const res2 = await timedFetch('guerrilla', `${base}?f=set_email_user&sid_token=${encodeURIComponent(sidToken)}&email_user=${encodeURIComponent(localPart)}`);
      if (!res2.ok) throw new MailError('guerrilla', 'server', { status: res2.status });
      const body2 = await res2.json();
      const address = (body2 && body2.email_addr) || body1.email_addr;
      if (!address) throw new MailError('guerrilla', 'shape');

      return { provider: 'guerrilla', address, secret: { sidToken }, createdAt: Date.now(), touchedAt: Date.now() };
    },

    async list(session) {
      const base = 'https://api.guerrillamail.com/ajax.php';
      const res = await timedFetch('guerrilla', `${base}?f=check_email&sid_token=${encodeURIComponent(session.secret.sidToken)}&seq=0`);
      if (!res.ok) throw new MailError('guerrilla', 'server', { status: res.status });
      const body = await res.json();
      if (!body || !Array.isArray(body.list)) throw new MailError('guerrilla', 'shape');
      return body.list.map(m => ({
        id: m.mail_id, from: m.mail_from || '', subject: m.mail_subject || '',
        date: normalizeDate(Number(m.mail_timestamp) * 1000 || m.mail_date), intro: (m.mail_excerpt || '').slice(0, 120), seen: !!Number(m.mail_read)
      }));
    },

    async read(session, msgId) {
      const base = 'https://api.guerrillamail.com/ajax.php';
      const res = await timedFetch('guerrilla', `${base}?f=fetch_email&sid_token=${encodeURIComponent(session.secret.sidToken)}&email_id=${encodeURIComponent(msgId)}`);
      if (!res.ok) throw new MailError('guerrilla', 'server', { status: res.status });
      const body = await res.json();
      return { text: body.mail_body_plain || body.mail_excerpt || '', html: body.mail_body || '' };
    },

    async refresh() { return null; }
  };

  mail.adapters = [mailtm, mailgw]; // Task 8 дополнит массив maildrop/dropmail/guerrilla через push перед закрытием IIFE
  mail.adapters.push(maildrop, dropmail, guerrilla);

  mail.healthCheck = async function (providerId) {
    const adapter = mail.adapters.find(a => a.id === providerId);
    if (!adapter || adapter.disabled) return false;
    try {
      if (adapter.id === 'mailtm' || adapter.id === 'mailgw') {
        const res = await timedFetch(adapter.id, `${adapter.id === 'mailtm' ? 'https://api.mail.tm' : 'https://api.mail.gw'}/domains`);
        return res.ok;
      }
      return true; // остальные адаптеры переопределяют своё поведение health-check в Task 8, если потребуется
    } catch (e) { return false; }
  };

  const _origHealthCheck = mail.healthCheck;
  mail.healthCheck = async function (providerId) {
    const adapter = mail.adapters.find(a => a.id === providerId);
    if (!adapter || adapter.disabled) return false;
    try {
      if (providerId === 'mailtm' || providerId === 'mailgw') return _origHealthCheck(providerId);
      if (providerId === 'maildrop') {
        const query = `query { ping(message: "reglog") }`;
        const res = await timedFetch('maildrop', 'https://api.maildrop.cc/graphql', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query })
        });
        if (!res.ok) return false;
        const body = await res.json();
        return !body.errors && body.data && body.data.ping === 'reglog';
      }
      if (providerId === 'dropmail') {
        const query = `query { domains { id } }`;
        const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let token = 'af_'; for (let i = 0; i < 20; i++) token += alphabet[RegLog.gen.randomInt(alphabet.length)];
        const res = await timedFetch('dropmail', `https://dropmail.me/api/graphql/${token}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query })
        });
        if (!res.ok) return false;
        const body = await res.json();
        return !body.errors;
      }
      if (providerId === 'guerrilla') return true;
      return true;
    } catch (e) { return false; }
  };

  mail.acquire = async function (domain, { localPart }) {
    const settings = await RegLog.store.getSettings();
    const rejected = await RegLog.store.getRejected();
    const domainRejected = new Set(rejected[domain] || []);

    let candidates = settings.providers
      .filter(id => !settings.providersOff.includes(id))
      .map(id => mail.adapters.find(a => a.id === id))
      .filter(a => a && !a.disabled)
      .filter(a => !domainRejected.has(a.id));

    let allCooling = true;
    for (const adapter of candidates) {
      if (await RegLog.store.isCooling(adapter.id)) continue;
      allCooling = false;
      try {
        const local = RegLog.gen.sanitizeLocalPart(localPart, adapter.localPartOpts);
        const session = adapter.canPickLocal ? await adapter.create(local) : await adapter.create();
        await RegLog.store.setSession(domain, session);
        return { session, provider: adapter };
      } catch (e) {
        const cooldownMs = (e instanceof MailError && e.reason === 'rate' && e.retryAfter)
          ? e.retryAfter * 1000 : 10 * 60 * 1000;
        await RegLog.store.setCooldown(adapter.id, Date.now() + cooldownMs);
      }
    }

    const totalCandidates = settings.providers
      .filter(id => !settings.providersOff.includes(id))
      .map(id => mail.adapters.find(a => a.id === id))
      .filter(a => a && !a.disabled);
    const allManuallyRejected = totalCandidates.every(a => domainRejected.has(a.id));

    return null; // popup.js (Task 10) различает причину через allManuallyRejected/allCooling — см. Step 4
  };

  mail.acquireDiagnostics = async function (domain) {
    const settings = await RegLog.store.getSettings();
    const rejected = await RegLog.store.getRejected();
    const domainRejected = new Set(rejected[domain] || []);
    const totalCandidates = settings.providers
      .filter(id => !settings.providersOff.includes(id))
      .map(id => mail.adapters.find(a => a.id === id))
      .filter(a => a && !a.disabled);
    const allManuallyRejected = totalCandidates.length > 0 && totalCandidates.every(a => domainRejected.has(a.id));
    let allCooling = totalCandidates.length > 0;
    for (const a of totalCandidates) if (!(await RegLog.store.isCooling(a.id))) { allCooling = false; break; }
    return { allManuallyRejected, allCooling, empty: totalCandidates.length === 0 };
  };

  mail.next = async function (domain, currentProviderId) {
    await RegLog.store.addRejected(domain, currentProviderId);
    await RegLog.store.clearSession(domain);
    const draft = await RegLog.store.getDraft(domain);
    const localPart = (draft && draft.username) || RegLog.gen.username('words');
    return mail.acquire(domain, { localPart });
  };

  mail.poll = function (session, onBatch) {
    let stopped = false;
    let interval = 5000;
    let emptyStreak = 0;
    let timer = null;

    async function tick() {
      if (stopped) return;
      const adapter = mail.adapters.find(a => a.id === session.provider);
      try {
        const list = await adapter.list(session);
        session.touchedAt = Date.now();
        if (list.length > 0) { emptyStreak = 0; interval = 5000; } else { emptyStreak++; }
        if (emptyStreak > 12) interval = 15000;
        onBatch({ ok: true, messages: list });
      } catch (e) {
        if (e instanceof MailError && e.reason === 'rate') {
          interval = e.retryAfter > 0 ? e.retryAfter * 1000 : Math.min(60000, interval * 2);
        } else if (e instanceof MailError && e.reason === 'expired') {
          onBatch({ ok: false, error: e });
          stop();
          return;
        } else {
          onBatch({ ok: false, error: e });
        }
      }
      if (adapter.sessionTtlMs > 0) interval = Math.min(interval, Math.floor(adapter.sessionTtlMs / 3));
      const jitter = Math.floor((Math.random() * 1400) - 700);
      if (!stopped) timer = setTimeout(tick, Math.max(1000, interval + jitter));
    }

    function stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }

    tick();
    if (typeof addEventListener === 'function') addEventListener('pagehide', stop);
    return stop;
  };

  function htmlToText(html) {
    if (typeof DOMParser === 'undefined') {
      // Node-тестовое окружение без DOMParser: минимальный фолбэк-стриппер тегов,
      // используется только в юнит-тестах extract(); в браузере всегда есть DOMParser.
      return String(html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    }
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    doc.querySelectorAll('style, script').forEach(n => n.remove());
    return (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ').trim();
  }

  const KEYWORD_RE = /code|код|verification|подтвержд|pin|otp|одноразов/i;

  mail.extract = function extract(message) {
    const text = message.text && message.text.trim() ? message.text : htmlToText(message.html);
    const html = message.html || '';

    const candidateRe = /\b(\d[\d\s-]{2,10}\d)\b/g;
    const candidates = [];
    let m;
    while ((m = candidateRe.exec(text)) !== null) {
      const clean = m[1].replace(/[\s-]/g, '');
      if (clean.length < 4 || clean.length > 8) continue;
      candidates.push({ raw: m[1], clean, index: m.index });
    }

    function lineOf(index) {
      const start = text.lastIndexOf('\n', index);
      const end = text.indexOf('\n', index);
      return text.slice(start === -1 ? 0 : start, end === -1 ? text.length : end);
    }

    function isAloneOnLine(cand) {
      const line = lineOf(cand.index).trim();
      const stripped = line.replace(cand.raw, '').replace(/[^\d]/g, '');
      return stripped.length === 0;
    }

    function isYearLike(clean) {
      return /^(19|20)\d{2}$/.test(clean);
    }

    function isPartOfLongerSequence(text_, index, raw) {
      const before = text_[index - 1];
      const after = text_[index + raw.length];
      return (before && /\d/.test(before)) || (after && /\d/.test(after));
    }

    function nearKeyword(index) {
      const windowStart = Math.max(0, index - 60);
      const windowEnd = Math.min(text.length, index + 60);
      return KEYWORD_RE.test(text.slice(windowStart, windowEnd));
    }

    function nearCurrency(cand) {
      const before = text.slice(Math.max(0, cand.index - 3), cand.index);
      const after = text.slice(cand.index + cand.raw.length, cand.index + cand.raw.length + 4);
      return /[$€£₽%]\s*$/.test(before) || /^\s*(%|₽|руб)/.test(after);
    }

    function wrappedInEmphasis(clean) {
      const re = new RegExp(`<(b|strong|h1|h2|h3|code)[^>]*>[^<]*${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^<]*</\\1>`, 'i');
      return re.test(html);
    }

    let best = null;
    for (const cand of candidates) {
      let score = 0;
      if (nearKeyword(cand.index)) score += 5;
      if (isAloneOnLine(cand)) score += 3;
      if (cand.clean.length === 6) score += 2;
      if (cand.clean.length === 4 || cand.clean.length === 8) score += 1;
      if (wrappedInEmphasis(cand.clean)) score += 2;
      if (isYearLike(cand.clean) && !nearKeyword(cand.index)) score -= 4;
      if (nearCurrency(cand)) score -= 4;
      if (isPartOfLongerSequence(text, cand.index, cand.raw)) score -= 5;
      // Изолированное число без ключевого слова рядом (номер заказа/счёта в отдельной строке) —
      // не код, даже если само по себе "одиноко в строке" даёт бонус выше.
      if (isAloneOnLine(cand) && !nearKeyword(cand.index)) score -= 2;
      if (!best || score > best.score) best = { code: cand.clean, score };
    }

    const code = best && best.score >= 5 ? best.code : null;
    const confidence = best && best.score >= 8 ? 'high' : 'low';

    let link = null;
    if (typeof DOMParser !== 'undefined') {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const a of doc.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        let url;
        try { url = new URL(href, 'https://placeholder.invalid/'); } catch (e) { continue; }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        if (/verif|confirm|activate|signup|подтвер|token=|key=/i.test(href)) { link = href; break; }
      }
    } else {
      const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
      let hm;
      while ((hm = hrefRe.exec(html)) !== null) {
        const href = hm[1];
        if (/^javascript:|^data:/i.test(href)) continue;
        if (/verif|confirm|activate|signup|подтвер|token=|key=/i.test(href)) { link = href; break; }
      }
    }

    return { code, link, confidence: code ? confidence : 'low' };
  };

})(typeof window !== 'undefined' ? window : globalThis);
