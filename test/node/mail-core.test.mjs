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

// headers.get не существует на Map — оборачиваем.
function mockHeaders(obj) { return { get: (k) => obj[k] ?? null }; }
function res(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: mockHeaders(headers), json: async () => body };
}

test('MailError carries providerId/reason/status/retryAfter', async () => {
  const RegLog = await freshMail();
  const e = new RegLog.mail.MailError('mailtm', 'rate', { status: 429, retryAfter: 30 });
  assert.equal(e.providerId, 'mailtm');
  assert.equal(e.reason, 'rate');
  assert.equal(e.retryAfter, 30);
});

test('acquire retries with suffix on 422 taken, succeeds without switching provider', async () => {
  const RegLog = await freshMail();
  let accountCalls = 0;
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith('/domains')) return res(200, [{ domain: 'example.tld', isActive: true, isPrivate: false }]);
    if (url.endsWith('/accounts')) {
      accountCalls++;
      if (accountCalls < 2) return res(422, {});
      return res(201, { id: 'acc1' });
    }
    if (url.endsWith('/token')) return res(200, { token: 'tok1' });
    throw new Error('unexpected url ' + url);
  };
  const outcome = await RegLog.mail.acquire('example.com', { localPart: 'amber-harbor-47' });
  assert.equal(outcome.provider.id, 'mailtm');
  assert.equal(accountCalls, 2);
});

test('acquire falls through to next provider on repeated MailError and sets cooldown', async () => {
  const RegLog = await freshMail();
  await RegLog.store.setSettings({ providers: ['mailtm', 'mailgw'], providersOff: [] });
  globalThis.fetch = async (url) => {
    if (url.startsWith('https://api.mail.tm')) return res(500, {});
    if (url.endsWith('/domains')) return res(200, [{ domain: 'gw.tld', isActive: true, isPrivate: false }]);
    if (url.endsWith('/accounts')) return res(201, { id: 'acc2' });
    if (url.endsWith('/token')) return res(200, { token: 'tok2' });
    throw new Error('unexpected url ' + url);
  };
  const outcome = await RegLog.mail.acquire('example.org', { localPart: 'x' });
  assert.equal(outcome.provider.id, 'mailgw');
  const cooling = await RegLog.store.isCooling('mailtm');
  assert.equal(cooling, true);
});

test('acquireDiagnostics distinguishes all-rejected vs all-cooling', async () => {
  const RegLog = await freshMail();
  await RegLog.store.setSettings({ providers: ['mailtm'], providersOff: [] });
  await RegLog.store.addRejected('rejected-domain.com', 'mailtm');
  const d1 = await RegLog.mail.acquireDiagnostics('rejected-domain.com');
  assert.equal(d1.allManuallyRejected, true);

  await RegLog.store.setCooldown('mailtm', Date.now() + 60000);
  const d2 = await RegLog.mail.acquireDiagnostics('cooling-domain.com');
  assert.equal(d2.allCooling, true);
  assert.equal(d2.allManuallyRejected, false);
});

test('GraphQL 200 OK with errors body throws MailError(rate) via _checkGraphQLErrors', async () => {
  const RegLog = await freshMail();
  await assert.rejects(
    () => RegLog.mail._checkGraphQLErrors('maildrop', { errors: [{ message: 'RATE_LIMIT_EXCEEDED' }] }),
    (e) => e instanceof RegLog.mail.MailError && e.reason === 'rate'
  );
});

test('next marks provider rejected and switches to the following one', async () => {
  const RegLog = await freshMail();
  await RegLog.store.setSettings({ providers: ['mailtm', 'mailgw'], providersOff: [] });
  globalThis.fetch = async (url) => {
    if (url.startsWith('https://api.mail.gw') && url.endsWith('/domains')) return res(200, [{ domain: 'gw.tld', isActive: true, isPrivate: false }]);
    if (url.endsWith('/accounts')) return res(201, { id: 'acc3' });
    if (url.endsWith('/token')) return res(200, { token: 'tok3' });
    throw new Error('unexpected url ' + url);
  };
  const outcome = await RegLog.mail.next('switch.com', 'mailtm');
  assert.equal(outcome.provider.id, 'mailgw');
  const rejected = await RegLog.store.getRejected();
  assert.deepEqual(rejected['switch.com'], ['mailtm']);
});

test('poll backs off to 15s interval after 13+ consecutive empty list results', async () => {
  const RegLog = await freshMail();

  // Create a minimal session
  const session = {
    provider: 'mailtm',
    address: 'test@example.com',
    secret: { token: 'tok_test', password: 'pwd', accountId: 'acc_test' },
    createdAt: Date.now(),
    touchedAt: Date.now()
  };

  const intervals = [];
  const callbacks = [];
  const realSetTimeout = globalThis.setTimeout;

  // Mock setTimeout to capture intervals and callbacks for deferred invocation
  globalThis.setTimeout = (callback, delay) => {
    intervals.push(delay);
    callbacks.push(callback);
    return {};
  };

  try {
    // Mock adapter.list to return empty messages, triggering empty streak
    const mockAdapter = {
      ...RegLog.mail.adapters[0],
      sessionTtlMs: 0,
      list: async () => []
    };
    const originalAdapters = RegLog.mail.adapters;
    RegLog.mail.adapters = [mockAdapter];

    const batches = [];
    const stop = RegLog.mail.poll(session, (batch) => {
      batches.push(batch);
    });

    // Wait a tick for first async operation to complete and schedule next tick
    await new Promise(r => realSetTimeout(r, 0));

    // Now manually drive ticks by invoking scheduled callbacks
    // We need 14+ scheduled ticks (1 initial outside loop + 13+ more) to exceed emptyStreak > 12
    for (let i = 0; i < 14 && callbacks.length > 0; i++) {
      const cb = callbacks.shift();
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => realSetTimeout(() => {
        cb(); // Invoke tick
        r(); // Resolve after tick completes
      }, 0));
    }

    // Verify backoff happened: after 13+ empties, interval should reach 15000 (±jitter)
    // Jitter is ±700ms, so delays should be in range [14300, 15700]
    assert.ok(intervals.length > 12, `Expected at least 13 intervals, got ${intervals.length}: [${intervals.join(', ')}]`);
    const backedOffDelays = intervals.filter(d => d >= 14300 && d <= 15700);
    assert.ok(backedOffDelays.length > 0, `Expected at least one delay between 14300-15700 in [${intervals.join(', ')}]`);

    stop();
    RegLog.mail.adapters = originalAdapters;
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
