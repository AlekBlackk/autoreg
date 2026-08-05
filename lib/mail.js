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

  mail.adapters = [mailtm, mailgw]; // Task 8 дополнит массив maildrop/dropmail/guerrilla через push перед закрытием IIFE

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

})(typeof window !== 'undefined' ? window : globalThis);
