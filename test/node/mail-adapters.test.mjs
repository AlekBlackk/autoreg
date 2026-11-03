import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installMockChrome } from './_mockChrome.mjs';

const generatePath = fileURLToPath(new URL('../../lib/generate.js', import.meta.url));
const storagePath = fileURLToPath(new URL('../../lib/storage.js', import.meta.url));
const mailPath = fileURLToPath(new URL('../../lib/mail.js', import.meta.url));
const generateSource = readFileSync(generatePath, 'utf8');
const storageSource = readFileSync(storagePath, 'utf8');
const mailSource = readFileSync(mailPath, 'utf8');

function loadModules() {
  new Function(generateSource)();
  new Function(storageSource)();
  new Function(mailSource)();
}

async function freshMail() {
  installMockChrome();
  delete globalThis.RegLog;
  loadModules();
  await globalThis.RegLog.store.init();
  return globalThis.RegLog;
}

function mockHeaders(obj) { return { get: (k) => obj[k] ?? null }; }
function res(status, body, headers = {}) { return { ok: status >= 200 && status < 300, status, headers: mockHeaders(headers), json: async () => body }; }

test('maildrop.create makes zero network requests', async () => {
  const RegLog = await freshMail();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return res(200, {}); };
  const maildrop = RegLog.mail.adapters.find(a => a.id === 'maildrop');
  const session = await maildrop.create('amber-harbor-47-a1b2c3d4e5');
  assert.equal(calls, 0);
  assert.equal(session.address, 'amber-harbor-47-a1b2c3d4e5@maildrop.cc');
});

test('maildrop.list surfaces GraphQL errors as MailError even on HTTP 200', async () => {
  const RegLog = await freshMail();
  globalThis.fetch = async () => res(200, { errors: [{ message: 'RATE_LIMIT_EXCEEDED' }] });
  const maildrop = RegLog.mail.adapters.find(a => a.id === 'maildrop');
  await assert.rejects(
    () => maildrop.list({ address: 'x@maildrop.cc' }),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'rate'
  );
});

test('dropmail.list returns MailError(expired) when session(id:) is null', async () => {
  const RegLog = await freshMail();
  globalThis.fetch = async () => res(200, { data: { session: null } });
  const dropmail = RegLog.mail.adapters.find(a => a.id === 'dropmail');
  await assert.rejects(
    () => dropmail.list({ secret: { sessionId: 's1', endpointToken: 'af_x' } }),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'expired'
  );
});

test('guerrilla passes sid_token as query parameter on check_email, not cookies', async () => {
  const RegLog = await freshMail();
  let capturedUrl = null, capturedOpts = null;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('f=check_email')) { capturedUrl = url; capturedOpts = opts; return res(200, { list: [{ mail_id: '1', mail_from: 'a@b', mail_subject: 's', mail_timestamp: '1700000000', mail_excerpt: 'e', mail_read: '0' }] }); }
    throw new Error('unexpected ' + url);
  };
  const guerrilla = RegLog.mail.adapters.find(a => a.id === 'guerrilla');
  const list = await guerrilla.list({ secret: { sidToken: 'TOKEN123' } });
  assert.ok(capturedUrl.includes('sid_token=TOKEN123'));
  assert.equal(capturedOpts.credentials, undefined); // явно не передаём credentials
  assert.equal(list[0].from, 'a@b');
});

test('dustmail.create posts to /api/inbox and maps id/email into session', async () => {
  const RegLog = await freshMail();
  let capturedUrl = null, capturedOpts = null;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url; capturedOpts = opts;
    return res(201, { id: 'inbox-1', email: 'foo@dustmail.net', domain: 'dustmail.net', expires_at: '2026-01-01T00:00:00.000Z' });
  };
  const dustmail = RegLog.mail.adapters.find(a => a.id === 'dustmail');
  const session = await dustmail.create();
  assert.equal(capturedUrl, 'https://dustmail.net/api/inbox');
  assert.equal(capturedOpts.method, 'POST');
  assert.equal(session.provider, 'dustmail');
  assert.equal(session.address, 'foo@dustmail.net');
  assert.equal(session.secret.inboxId, 'inbox-1');
});

test('dustmail.list maps emails[] preview fields, dustmail.read fetches full body by id', async () => {
  const RegLog = await freshMail();
  globalThis.fetch = async (url) => {
    if (url === 'https://dustmail.net/api/inbox/inbox-1') {
      return res(200, { inbox: { id: 'inbox-1' }, emails: [{ id: 'm1', from_address: 'a@b.com', subject: 's', preview: 'hi', received_at: '2026-01-01T00:00:00.000Z' }] });
    }
    if (url === 'https://dustmail.net/api/email/m1') {
      return res(200, { id: 'm1', body_text: 'plain', body_html: '<p>hi</p>' });
    }
    throw new Error('unexpected ' + url);
  };
  const dustmail = RegLog.mail.adapters.find(a => a.id === 'dustmail');
  const list = await dustmail.list({ secret: { inboxId: 'inbox-1' } });
  assert.equal(list[0].from, 'a@b.com');
  assert.equal(list[0].subject, 's');
  const body = await dustmail.read({}, 'm1');
  assert.equal(body.text, 'plain');
  assert.equal(body.html, '<p>hi</p>');
});

test('dustmail.list returns MailError(expired) on HTTP 404 (expired/unknown inbox id)', async () => {
  const RegLog = await freshMail();
  globalThis.fetch = async () => res(404, { error: 'Inbox not found' });
  const dustmail = RegLog.mail.adapters.find(a => a.id === 'dustmail');
  await assert.rejects(
    () => dustmail.list({ secret: { inboxId: 'gone' } }),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'expired'
  );
});

test('all adapters conform to contract 5.1 shape', async () => {
  const RegLog = await freshMail();
  for (const a of RegLog.mail.adapters) {
    for (const field of ['id', 'label', 'canPickLocal', 'publicInbox', 'sessionTtlMs', 'bodyInList', 'localPartOpts', 'disabled']) {
      assert.ok(field in a, `${a.id} missing ${field}`);
    }
    for (const method of ['create', 'list', 'read', 'refresh']) {
      assert.equal(typeof a[method], 'function', `${a.id}.${method} missing`);
    }
  }
});

// --- Mail.cx -----------------------------------------------------------------

const MAILCX_CONFIG = {
  system_domains: [{ domain: 'uqu.me', default: true }, { domain: '9k3r.com', default: false }, { domain: 'ddker.com', default: false }],
  local_part_rules: { min_length: 2, max_length: 20 }, ttl_seconds: 3600
};

// Пустой ящик mail.cx отвечает 204 без тела: res.json() на нём бросает, как в браузере.
function emptyBodyRes(status) {
  return { ok: status >= 200 && status < 300, status, headers: mockHeaders({}), json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
}

function abortError() { return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); }

test('mailcx.create reads /v1/config only and picks a system domain for the given local part', async () => {
  const RegLog = await freshMail();
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); return res(200, MAILCX_CONFIG); };
  const mailcx = RegLog.mail.adapters.find(a => a.id === 'mailcx');
  const session = await mailcx.create('amber-harbor-k3m9x2p7qa');
  assert.deepEqual(urls, ['https://mail.cx/v1/config'], 'the mailbox needs no creation request');
  assert.equal(session.provider, 'mailcx');
  const [local, domain] = session.address.split('@');
  assert.equal(local, 'amber-harbor-k3m9x2p7qa');
  assert.ok(MAILCX_CONFIG.system_domains.some(d => d.domain === domain), `unexpected domain ${domain}`);
  assert.deepEqual(session.secret, {});
});

test('mailcx.create rejects a config without usable domains as MailError(shape)', async () => {
  const RegLog = await freshMail();
  globalThis.fetch = async () => res(200, { system_domains: [{ domain: '' }, null, { default: true }] });
  const mailcx = RegLog.mail.adapters.find(a => a.id === 'mailcx');
  await assert.rejects(
    () => mailcx.create('amber-harbor-k3m9x2p7qa'),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'shape'
  );
});

test('mailcx.create maps 429 to MailError(rate) with Retry-After', async () => {
  const RegLog = await freshMail();
  globalThis.fetch = async () => res(429, {}, { 'Retry-After': '30' });
  const mailcx = RegLog.mail.adapters.find(a => a.id === 'mailcx');
  await assert.rejects(
    () => mailcx.create('amber-harbor-k3m9x2p7qa'),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'rate' && e.retryAfter === 30
  );
});

test('mailcx address fits the service limit: acquire sanitizes the local part to 20 chars with entropy', async () => {
  const RegLog = await freshMail();
  await RegLog.store.setSettings({ providers: ['mailcx'], providersOff: [] });
  globalThis.fetch = async () => res(200, MAILCX_CONFIG);
  const outcome = await RegLog.mail.acquire('signup.example', { localPart: 'extremelylongusernamethatdoesnotfit99' });
  assert.equal(outcome.provider.id, 'mailcx');
  const local = outcome.session.address.split('@')[0];
  assert.ok(local.length <= 20, `local part "${local}" exceeds the 20-char service limit`);
  assert.match(local, /-[a-z0-9]{10}$/, 'public inbox needs the random suffix');
  assert.match(local, /^[a-z0-9._-]+$/);
});

test('mailcx.list encodes the address, maps emails[] and treats 204 as an empty inbox', async () => {
  const RegLog = await freshMail();
  const urls = [];
  const responses = [
    res(200, { emails: [
      { id: 'm1', from_name: 'Shop', from_email: 'no-reply@shop.example', subject: 'Your code', preview_text: 'x'.repeat(200), created_at: '2026-10-09T17:14:41Z' },
      { id: 'm2', from_name: 'Only Name', from_email: '', subject: '', created_at: 'garbage' }
    ], next_since: '1' }),
    emptyBodyRes(204)
  ];
  globalThis.fetch = async (url) => { urls.push(url); return responses.shift(); };
  const mailcx = RegLog.mail.adapters.find(a => a.id === 'mailcx');
  const session = { address: 'amber-k3m9x2p7qa@uqu.me' };

  const list = await mailcx.list(session);
  assert.equal(urls[0], 'https://mail.cx/v1/inbox/amber-k3m9x2p7qa%40uqu.me');
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'm1');
  assert.equal(list[0].from, 'no-reply@shop.example');
  assert.equal(list[0].subject, 'Your code');
  assert.equal(list[0].date, Date.parse('2026-10-09T17:14:41Z'));
  assert.equal(list[0].intro.length, 120);
  assert.equal(list[1].from, 'Only Name', 'falls back to the display name when the address is empty');
  assert.equal(typeof list[1].date, 'number');

  assert.deepEqual(await mailcx.list(session), []);
});

test('mailcx.list maps an unexpected body to MailError(shape) and error statuses to their reasons', async () => {
  const RegLog = await freshMail();
  const mailcx = RegLog.mail.adapters.find(a => a.id === 'mailcx');
  const session = { address: 'a@uqu.me' };
  const expectReason = async (response, reason) => {
    globalThis.fetch = async () => response;
    await assert.rejects(
      () => mailcx.list(session),
      (e) => e instanceof RegLog.mail.MailError && e.reason === reason,
      `${response.status} should map to ${reason}`
    );
  };
  await expectReason(res(200, { nope: true }), 'shape');
  await expectReason(res(404, {}), 'expired');
  await expectReason(res(410, {}), 'expired');
  await expectReason(res(403, {}), 'auth');
  await expectReason(res(500, {}), 'server');
  globalThis.fetch = async () => res(429, { error: 'too_many_streams' }, { 'Retry-After': '12' });
  await assert.rejects(
    () => mailcx.list(session),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'rate' && e.retryAfter === 12
  );
});

test('mailcx.list long-polls with a 30s timeout; wait:false gives up after 3s and reports an empty inbox', async () => {
  const RegLog = await freshMail();
  const mailcx = RegLog.mail.adapters.find(a => a.id === 'mailcx');
  const session = { address: 'a@uqu.me' };

  const realSetTimeout = globalThis.setTimeout;
  const requestedDelays = [];
  globalThis.setTimeout = (fn, ms, ...rest) => { requestedDelays.push(ms); return realSetTimeout(fn, ms > 1000 ? 1_000_000 : ms, ...rest); };
  globalThis.fetch = async () => { throw abortError(); }; // как если бы таймер сработал
  try {
    assert.deepEqual(await mailcx.list(session, { wait: false }), []);
    assert.ok(requestedDelays.includes(3000), `wait:false must arm a 3s timeout, got ${requestedDelays}`);

    requestedDelays.length = 0;
    await assert.rejects(
      () => mailcx.list(session),
      (e) => e instanceof RegLog.mail.MailError && e.reason === 'timeout',
      'a timed-out long poll is an error, not an empty inbox'
    );
    assert.ok(requestedDelays.includes(30000), `long poll must arm a 30s timeout, got ${requestedDelays}`);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('mailcx.list wait:false still reports real network failures', async () => {
  const RegLog = await freshMail();
  const mailcx = RegLog.mail.adapters.find(a => a.id === 'mailcx');
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(
    () => mailcx.list({ address: 'a@uqu.me' }, { wait: false }),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'network'
  );
});

test('mailcx.read fetches text_body/html_body by encoded id and maps 404 to expired', async () => {
  const RegLog = await freshMail();
  const mailcx = RegLog.mail.adapters.find(a => a.id === 'mailcx');
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return res(200, { id: 'm1', text_body: 'code 482915', html_body: '<p>code <strong>482915</strong></p>' }); };
  const body = await mailcx.read({}, 'm1/../x');
  assert.equal(capturedUrl, 'https://mail.cx/v1/email/m1%2F..%2Fx');
  assert.equal(body.text, 'code 482915');
  assert.equal(body.html, '<p>code <strong>482915</strong></p>');

  globalThis.fetch = async () => res(404, {});
  await assert.rejects(
    () => mailcx.read({}, 'gone'),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'expired'
  );
});

test('poll drops a response that arrives after stop(), so a long poll cannot repaint another inbox', async () => {
  const RegLog = await freshMail();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requested = false;
  globalThis.fetch = async () => { requested = true; await gate; return res(200, { emails: [{ id: 'late', subject: 's', created_at: '2026-10-09T17:14:41Z' }] }); };

  const batches = [];
  const stop = RegLog.mail.poll(null, { provider: 'mailcx', address: 'a@uqu.me', secret: {}, touchedAt: Date.now() }, b => batches.push(b));
  for (let i = 0; i < 100 && !requested; i++) await new Promise(r => setImmediate(r));
  assert.ok(requested, 'the poll should have a request in flight');

  stop();
  release();
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(batches, [], 'a stopped poll must not deliver batches');
});

// --- TempMail.lol ------------------------------------------------------------

const TEMPMAILLOL_EMAIL = {
  _id: '6ae9c4a952c54018406243c7', to: 'amber3889c2@jhf.arcadehearth.com', from: 'probe@example.org',
  subject: 'RegLog probe code 482913', body: 'Your verification code is 482913',
  html: '<p>Your verification code is <b>482913</b></p>', date: 1793705129830
};

test('tempmaillol.create posts the prefix and keeps the token, not the address, as the secret', async () => {
  const RegLog = await freshMail();
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return res(201, { address: 'amber-harbor3889c2@jhf.arcadehearth.com', token: 'tok-1' });
  };
  const tempmaillol = RegLog.mail.adapters.find(a => a.id === 'tempmaillol');
  const session = await tempmaillol.create('amber-harbor');
  assert.equal(captured.url, 'https://api.tempmail.lol/v2/inbox/create');
  assert.equal(captured.options.method, 'POST');
  assert.deepEqual(JSON.parse(captured.options.body), { prefix: 'amber-harbor' });
  assert.equal(session.provider, 'tempmaillol');
  assert.equal(session.address, 'amber-harbor3889c2@jhf.arcadehearth.com');
  assert.deepEqual(session.secret, { token: 'tok-1' });
});

test('tempmaillol.create maps a malformed body to shape and 429 to rate with Retry-After', async () => {
  const RegLog = await freshMail();
  const tempmaillol = RegLog.mail.adapters.find(a => a.id === 'tempmaillol');
  globalThis.fetch = async () => res(201, { address: 'a@b.c' });
  await assert.rejects(
    () => tempmaillol.create('amber'),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'shape'
  );
  globalThis.fetch = async () => res(429, {}, { 'Retry-After': '45' });
  await assert.rejects(
    () => tempmaillol.create('amber'),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'rate' && e.retryAfter === 45
  );
});

test('tempmaillol.list encodes the token and maps emails[] with the preview taken from the body', async () => {
  const RegLog = await freshMail();
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return res(200, { emails: [TEMPMAILLOL_EMAIL, { _id: 'm2', from: '', subject: '', body: 'x'.repeat(200), date: 'garbage' }], expired: false });
  };
  const tempmaillol = RegLog.mail.adapters.find(a => a.id === 'tempmaillol');
  const list = await tempmaillol.list({ secret: { token: 'a/b c' } });
  assert.equal(capturedUrl, 'https://api.tempmail.lol/v2/inbox?token=a%2Fb%20c');
  assert.equal(list.length, 2);
  assert.equal(list[0].id, TEMPMAILLOL_EMAIL._id);
  assert.equal(list[0].from, 'probe@example.org');
  assert.equal(list[0].subject, 'RegLog probe code 482913');
  assert.equal(list[0].date, 1793705129830);
  assert.equal(list[0].intro, 'Your verification code is 482913');
  assert.equal(list[1].intro.length, 120);
  assert.equal(typeof list[1].date, 'number');
});

test('tempmaillol.list reports an unknown or expired token as expired, and other failures by reason', async () => {
  const RegLog = await freshMail();
  const tempmaillol = RegLog.mail.adapters.find(a => a.id === 'tempmaillol');
  const session = { secret: { token: 't' } };
  const expectReason = async (response, reason) => {
    globalThis.fetch = async () => response;
    await assert.rejects(
      () => tempmaillol.list(session),
      (e) => e instanceof RegLog.mail.MailError && e.reason === reason,
      `${response.status} ${JSON.stringify(response.body)} should map to ${reason}`
    );
  };
  await expectReason(res(404, { emails: [], expired: true }), 'expired');
  await expectReason(res(200, { emails: [], expired: true }), 'expired');
  await expectReason(res(200, { nope: true }), 'shape');
  await expectReason(res(500, {}), 'server');
});

test('tempmaillol.read finds the message in the inbox listing; a vanished message is expired', async () => {
  const RegLog = await freshMail();
  globalThis.fetch = async () => res(200, { emails: [TEMPMAILLOL_EMAIL], expired: false });
  const tempmaillol = RegLog.mail.adapters.find(a => a.id === 'tempmaillol');
  const session = { secret: { token: 't' } };
  const body = await tempmaillol.read(session, TEMPMAILLOL_EMAIL._id);
  assert.equal(body.text, 'Your verification code is 482913');
  assert.equal(body.html, '<p>Your verification code is <b>482913</b></p>');
  await assert.rejects(
    () => tempmaillol.read(session, 'gone'),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'expired'
  );
});

test('tempmaillol.read tolerates a null html part', async () => {
  const RegLog = await freshMail();
  globalThis.fetch = async () => res(200, { emails: [{ ...TEMPMAILLOL_EMAIL, html: null }], expired: false });
  const tempmaillol = RegLog.mail.adapters.find(a => a.id === 'tempmaillol');
  const body = await tempmaillol.read({ secret: { token: 't' } }, TEMPMAILLOL_EMAIL._id);
  assert.equal(body.html, '');
});

// --- Temp-Mail.io ------------------------------------------------------------

const TEMPMAILIO_MESSAGE = {
  id: '64479dc0-f201-4b8f-ad66-7366c123d122', from: '<probe@example.org>', to: 'amberharbork3m9x2p7qa@lnovic.com', cc: null,
  subject: 'RegLog probe code 482913', body_text: 'Your verification code is 482913\n',
  body_html: '<p>Your verification code is <b>482913</b></p>\n', created_at: '2026-11-03T11:25:49.412906Z', attachments: []
};

test('tempmailio.create posts only the name and takes the address from the response', async () => {
  const RegLog = await freshMail();
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return res(200, { email: 'amberharbork3m9x2p7qa@olipii.com', token: 'tok' });
  };
  const tempmailio = RegLog.mail.adapters.find(a => a.id === 'tempmailio');
  const session = await tempmailio.create('amber-harbor-k3m9x2p7qa');
  assert.equal(captured.url, 'https://api.internal.temp-mail.io/api/v3/email/new');
  assert.deepEqual(JSON.parse(captured.options.body), { name: 'amber-harbor-k3m9x2p7qa' });
  assert.equal(session.provider, 'tempmailio');
  assert.equal(session.address, 'amberharbork3m9x2p7qa@olipii.com', 'the service strips hyphens, so the response wins');
  assert.deepEqual(session.secret, {});
});

test('tempmailio.create maps a malformed body to shape and 429 to rate', async () => {
  const RegLog = await freshMail();
  const tempmailio = RegLog.mail.adapters.find(a => a.id === 'tempmailio');
  globalThis.fetch = async () => res(200, { email: 'no-at-sign' });
  await assert.rejects(
    () => tempmailio.create('amber'),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'shape'
  );
  globalThis.fetch = async () => res(429, {}, { 'Retry-After': '9' });
  await assert.rejects(
    () => tempmailio.create('amber'),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'rate' && e.retryAfter === 9
  );
});

test('tempmailio address fits acquire: sanitized local part keeps the random suffix for the public inbox', async () => {
  const RegLog = await freshMail();
  await RegLog.store.setSettings({ providers: ['tempmailio'], providersOff: [] });
  let sentName;
  globalThis.fetch = async (url, options) => {
    sentName = JSON.parse(options.body).name;
    return res(200, { email: `${sentName.replace(/-/g, '')}@olipii.com`, token: 't' });
  };
  const outcome = await RegLog.mail.acquire('signup.example', { localPart: 'extremelylongusernamethatdoesnotfit99' });
  assert.equal(outcome.provider.id, 'tempmailio');
  assert.ok(sentName.length <= 32);
  assert.match(sentName, /-[a-z0-9]{10}$/, 'public inbox needs the random suffix');
});

test('tempmailio.list keeps the @ unencoded in the path, strips <> from the sender and maps messages', async () => {
  const RegLog = await freshMail();
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return res(200, [TEMPMAILIO_MESSAGE, { id: 'm2', from: 'Shop <no-reply@shop.example>', subject: '', body_text: 'x'.repeat(200), created_at: 'garbage' }]);
  };
  const tempmailio = RegLog.mail.adapters.find(a => a.id === 'tempmailio');
  const list = await tempmailio.list({ address: 'amber.k3m9x2p7qa@lnovic.com' });
  assert.equal(capturedUrl, 'https://api.internal.temp-mail.io/api/v3/email/amber.k3m9x2p7qa@lnovic.com/messages');
  assert.equal(list.length, 2);
  assert.equal(list[0].id, TEMPMAILIO_MESSAGE.id);
  assert.equal(list[0].from, 'probe@example.org');
  assert.equal(list[0].subject, 'RegLog probe code 482913');
  assert.equal(list[0].date, Date.parse('2026-11-03T11:25:49.412906Z'));
  assert.equal(list[0].intro, 'Your verification code is 482913\n');
  assert.equal(list[1].from, 'Shop <no-reply@shop.example>', 'only a bare <address> is unwrapped');
  assert.equal(list[1].intro.length, 120);
  assert.equal(typeof list[1].date, 'number');
});

test('tempmailio.list reports an unknown address (400) as expired, and other failures by reason', async () => {
  const RegLog = await freshMail();
  const tempmailio = RegLog.mail.adapters.find(a => a.id === 'tempmailio');
  const session = { address: 'a@lnovic.com' };
  const expectReason = async (response, reason) => {
    globalThis.fetch = async () => response;
    await assert.rejects(
      () => tempmailio.list(session),
      (e) => e instanceof RegLog.mail.MailError && e.reason === reason,
      `${response.status} should map to ${reason}`
    );
  };
  await expectReason(res(400, { code: 101, message: 'Email not found' }), 'expired');
  await expectReason(res(200, { nope: true }), 'shape');
  await expectReason(res(429, {}), 'rate');
  await expectReason(res(500, {}), 'server');
});

test('tempmailio.read fetches body_text/body_html by encoded message id', async () => {
  const RegLog = await freshMail();
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return res(200, TEMPMAILIO_MESSAGE); };
  const tempmailio = RegLog.mail.adapters.find(a => a.id === 'tempmailio');
  const body = await tempmailio.read({}, 'm1/../x');
  assert.equal(capturedUrl, 'https://api.internal.temp-mail.io/api/v3/message/m1%2F..%2Fx');
  assert.equal(body.text, 'Your verification code is 482913\n');
  assert.equal(body.html, '<p>Your verification code is <b>482913</b></p>\n');
});
