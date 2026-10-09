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

test('all seven adapters conform to contract 5.1 shape', async () => {
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
