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

test('all five adapters conform to contract 5.1 shape', async () => {
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
