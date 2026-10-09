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

function localGet(key) {
  return new Promise(r => globalThis.__mockChrome.storage.local.get(key, (o) => r(o[key])));
}
function localSet(obj) {
  return new Promise(r => globalThis.__mockChrome.storage.local.set(obj, r));
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

// --- SPEC 5.4 health-check ------------------------------------------------
// The probe exists so a broken provider costs one cheap request instead of a
// full create() cycle with an 8s timeout per step. Maildrop is the honest
// subject here: its create() is offline (it just builds an address string), so
// any request the acquire loop makes for Maildrop is the probe and nothing else.

test('healthCheck is assigned exactly once', () => {
  const hits = mailSource.match(/mail\.healthCheck\s*=/g) || [];
  assert.equal(hits.length, 1,
    'a second assignment shadows the first one, leaving unreachable code behind');
});

test('acquire probes health before create and cools a provider that fails the probe', async () => {
  const RegLog = await freshMail();
  await RegLog.store.setSettings({ providers: ['maildrop', 'mailgw'], providersOff: [] });
  globalThis.fetch = async (url) => {
    if (url === 'https://api.maildrop.cc/graphql') return res(500, {});
    if (url.endsWith('/domains')) return res(200, [{ domain: 'gw.tld', isActive: true, isPrivate: false }]);
    if (url.endsWith('/accounts')) return res(201, { id: 'acc_hc' });
    if (url.endsWith('/token')) return res(200, { token: 'tok_hc' });
    throw new Error('unexpected url ' + url);
  };
  const outcome = await RegLog.mail.acquire('probe.example', { localPart: 'amber-harbor-4711' });
  assert.equal(outcome.provider.id, 'mailgw',
    'a provider that fails its probe must not be handed an address');
  assert.equal(await RegLog.store.isCooling('maildrop'), true);
});

test('health probe runs once per browser session, not on every acquire', async () => {
  const RegLog = await freshMail();
  await RegLog.store.setSettings({ providers: ['maildrop'], providersOff: [] });
  let pings = 0;
  globalThis.fetch = async (url) => {
    if (url === 'https://api.maildrop.cc/graphql') {
      pings++;
      return res(200, { data: { ping: 'reglog' } });
    }
    throw new Error('unexpected url ' + url);
  };
  const first = await RegLog.mail.acquire('one.example', { localPart: 'amber-harbor-4711' });
  const second = await RegLog.mail.acquire('two.example', { localPart: 'amber-harbor-4712' });
  assert.equal(first.provider.id, 'maildrop');
  assert.equal(second.provider.id, 'maildrop');
  assert.equal(pings, 1, 'the probe result is memoized for the whole browser session');
});

test('healthCheck reports no-probe providers as healthy without touching the network', async () => {
  const RegLog = await freshMail();
  globalThis.fetch = async (url) => { throw new Error('unexpected url ' + url); };
  // Guerrilla (get_email_address), DustMail (POST /api/inbox) and Mail.cx (GET /v1/config) have no request
  // cheaper than create() itself — a separate probe would only double the traffic.
  assert.equal(await RegLog.mail.healthCheck('guerrilla'), true);
  assert.equal(await RegLog.mail.healthCheck('dustmail'), true);
  assert.equal(await RegLog.mail.healthCheck('mailcx'), true);
  assert.equal(await RegLog.mail.healthCheck('dropmail'), false, 'disabled adapters are never healthy');
  assert.equal(await RegLog.mail.healthCheck('nope'), false);
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
    const stop = RegLog.mail.poll('poll-domain.com', session, (batch) => {
      batches.push(batch);
    });

    // Каждый tick асинхронный (adapter.list, затем запись touchedAt в storage), поэтому
    // между вызовом коллбэка и появлением следующего таймера нужно прокрутить очередь
    // микрозадач. Считать «один макротик = один запланированный таймер» нельзя: число
    // await внутри tick зависит от реализации, и тест на этом уже ломался.
    const drain = () => new Promise(r => realSetTimeout(r, 0));
    async function takeScheduledTick() {
      for (let attempt = 0; attempt < 100 && callbacks.length === 0; attempt++) await drain();
      return callbacks.shift() || null;
    }

    // tick #1 запускается внутри poll(); дальше 14 раз дожидаемся таймера и дёргаем его,
    // чтобы emptyStreak перевалил за 12 и интервал ушёл на 15000.
    for (let i = 0; i < 14; i++) {
      const cb = await takeScheduledTick();
      assert.ok(cb, `tick ${i + 1}: следующий таймер не запланирован, intervals=[${intervals.join(', ')}]`);
      cb();
    }
    await drain();

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

test('next keeps the working session when no provider is left to switch to', async () => {
  const RegLog = await freshMail();
  await RegLog.store.setSettings({ providers: ['mailtm'], providersOff: [] });
  await RegLog.store.setSession('keep.com', { provider: 'mailtm', address: 'old@example.tld', secret: { token: 'tok_old' } });
  globalThis.fetch = async (url) => { throw new Error('fetch не должен вызываться: кандидатов нет, ' + url); };

  const outcome = await RegLog.mail.next('keep.com', 'mailtm');

  assert.equal(outcome, null); // переключаться некуда: единственный сервис теперь отклонён
  const session = await RegLog.store.getSession('keep.com');
  assert.ok(session, 'старый ящик обязан выжить: письма на него ещё можно прочитать');
  assert.equal(session.address, 'old@example.tld');
  assert.equal(session.secret.token, 'tok_old');
});

test('poll persists touchedAt through store.touchSession', async () => {
  const RegLog = await freshMail();
  await RegLog.store.setSession('poll-domain.com', { provider: 'mailtm', address: 'a@example.tld' });
  const sessions = await localGet('sessions');
  sessions['poll-domain.com'].touchedAt = 1000;
  await localSet({ sessions });

  const session = { ...sessions['poll-domain.com'] };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => ({}); // следующий tick не планируем — хватит первого

  let stop;
  try {
    const mockAdapter = { ...RegLog.mail.adapters[0], sessionTtlMs: 0, list: async () => [] };
    const originalAdapters = RegLog.mail.adapters;
    RegLog.mail.adapters = [mockAdapter];
    try {
      stop = RegLog.mail.poll('poll-domain.com', session, () => {});
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(r => realSetTimeout(r, 0));
        if ((await localGet('sessions'))['poll-domain.com'].touchedAt > 1000) break;
      }
    } finally {
      RegLog.mail.adapters = originalAdapters;
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    if (stop) stop();
  }

  const persisted = (await localGet('sessions'))['poll-domain.com'].touchedAt;
  assert.ok(persisted > 1000, `touchedAt не доехал до диска: ${persisted}`);
  assert.ok(session.touchedAt >= persisted - 5, 'счётчик TTL в попапе замкнут на этот объект');
});

test('poll с сессией от неизвестного сервиса отдаёт MailError(shape) и останавливается', async () => {
  const RegLog = await freshMail();
  const session = { provider: 'nosuchmail', address: 'a@nosuch.tld', secret: {}, createdAt: Date.now(), touchedAt: Date.now() };

  const realSetTimeout = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setTimeout = (fn, ms) => { scheduled.push(ms); return {}; };

  const batches = [];
  let stop;
  try {
    stop = RegLog.mail.poll('ghost-domain.com', session, (batch) => { batches.push(batch); });
    for (let attempt = 0; attempt < 100 && batches.length === 0; attempt++) {
      await new Promise(r => realSetTimeout(r, 0));
    }
    // Ещё несколько прокруток очереди: если tick() падает необработанным reject'ом
    // (adapter.sessionTtlMs вне try), это видно именно после отдачи батча.
    for (let i = 0; i < 5; i++) await new Promise(r => realSetTimeout(r, 0));
  } finally {
    globalThis.setTimeout = realSetTimeout;
    if (stop) stop();
  }

  assert.equal(batches.length, 1, `ожидался ровно один батч, получено ${batches.length}`);
  assert.equal(batches[0].ok, false);
  assert.ok(batches[0].error instanceof RegLog.mail.MailError, 'ошибка обязана быть MailError, а не TypeError');
  assert.equal(batches[0].error.reason, 'shape');
  assert.equal(batches[0].error.providerId, 'nosuchmail');
  assert.deepEqual(scheduled, [], 'следующий tick планировать нечем: адаптера нет, поллинг остановлен');
});

test('decodeEntities decodes named entities', async () => {
  const RegLog = await freshMail();
  assert.equal(RegLog.mail.decodeEntities('spam fighter&#039;s ally'), "spam fighter's ally");
  assert.equal(RegLog.mail.decodeEntities('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.equal(RegLog.mail.decodeEntities('&lt;b&gt;bold&lt;/b&gt;'), '<b>bold</b>');
  assert.equal(RegLog.mail.decodeEntities('&quot;quoted&quot;'), '"quoted"');
  assert.equal(RegLog.mail.decodeEntities('a&nbsp;b'), 'a b');
});

test('decodeEntities decodes numeric entities (decimal and hex)', async () => {
  const RegLog = await freshMail();
  assert.equal(RegLog.mail.decodeEntities('it&#39;s'), "it's");
  assert.equal(RegLog.mail.decodeEntities('it&#x27;s'), "it's");
  const rightQuote = String.fromCharCode(0x2019);
  assert.equal(RegLog.mail.decodeEntities('&#8217;curly&#8217;'), rightQuote + 'curly' + rightQuote);
});

test('decodeEntities handles empty/null/plain input', async () => {
  const RegLog = await freshMail();
  assert.equal(RegLog.mail.decodeEntities(''), '');
  assert.equal(RegLog.mail.decodeEntities(null), '');
  assert.equal(RegLog.mail.decodeEntities(undefined), '');
  assert.equal(RegLog.mail.decodeEntities('plain text, no entities'), 'plain text, no entities');
  assert.equal(RegLog.mail.decodeEntities('50% off & free shipping'), '50% off & free shipping');
});

test('decodeEntities does not throw on out-of-range numeric entity', async () => {
  const RegLog = await freshMail();
  assert.doesNotThrow(() => RegLog.mail.decodeEntities('subject &#99999999; text'));
  assert.equal(RegLog.mail.decodeEntities('subject &#99999999; text'), 'subject &#99999999; text');
  assert.doesNotThrow(() => RegLog.mail.decodeEntities('&#x110000;'));
  assert.equal(RegLog.mail.decodeEntities('&#x110000;'), '&#x110000;');
});

test('decodeEntities does not double-decode and leaves unknown named entities alone', async () => {
  const RegLog = await freshMail();
  // '&amp;amp;' -> the leading '&amp;' token decodes to '&', leaving the trailing
  // literal text 'amp;' untouched (no second decode pass) -> '&amp;'.
  assert.equal(RegLog.mail.decodeEntities('&amp;amp;'), '&amp;');
  // '&copy;' is not in the supported named-entity set, so it passes through unchanged.
  assert.equal(RegLog.mail.decodeEntities('&copy; 2024'), '&copy; 2024');
});

test('splitLinkChips возвращает один text-сегмент, если скобочных ссылок нет', async () => {
  const RegLog = await freshMail();
  assert.deepEqual(
    RegLog.mail.splitLinkChips('привет, это обычный текст письма'),
    [{ type: 'text', value: 'привет, это обычный текст письма' }]
  );
});

test('splitLinkChips сворачивает [url]короткий_лейбл в link-сегмент', async () => {
  const RegLog = await freshMail();
  const segs = RegLog.mail.splitLinkChips('до [https://a.test/x.png]LinkedIn после');
  assert.deepEqual(segs, [
    { type: 'text', value: 'до ' },
    { type: 'link', url: 'https://a.test/x.png', label: 'LinkedIn' },
    { type: 'text', value: ' после' }
  ]);
});

test('splitLinkChips с мусорным (длинным слитным) лейблом падает на хост, хвост не съедает', async () => {
  const RegLog = await freshMail();
  const junk = 'a'.repeat(30); // >20 символов без пробелов — не человеческий лейбл
  const segs = RegLog.mail.splitLinkChips(`[https://mail.example.com/c/x]${junk} хвост`);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], { type: 'link', url: 'https://mail.example.com/c/x', label: 'mail.example.com' });
  assert.equal(segs[1].type, 'text');
  assert.equal(segs[1].value, `${junk} хвост`, 'мусорный хвост остаётся текстом, а не пропадает');
});

test('splitLinkChips: короткий лейбл, похожий на URL, тоже падает на хост (не даёт спуфить адрес)', async () => {
  const RegLog = await freshMail();
  const segs = RegLog.mail.splitLinkChips('[https://real.test/x]https://evil.test/y хвост');
  assert.equal(segs[0].type, 'link');
  assert.equal(segs[0].url, 'https://real.test/x');
  assert.equal(segs[0].label, 'real.test', 'лейбл обязан быть хостом реальной ссылки, а не текстом со спуфящим доменом');
});

test('splitLinkChips: пустой лейбл (сразу перевод строки) тоже падает на хост', async () => {
  const RegLog = await freshMail();
  const segs = RegLog.mail.splitLinkChips('[https://icons.test/a.png]\nследующая строка');
  assert.equal(segs[0].type, 'link');
  assert.equal(segs[0].label, 'icons.test');
  assert.equal(segs[1].value, '\nследующая строка');
});

test('splitLinkChips обрабатывает несколько чипов подряд', async () => {
  const RegLog = await freshMail();
  const segs = RegLog.mail.splitLinkChips('[https://a.test/1]Один[https://b.test/2]Два');
  assert.deepEqual(segs.map(s => s.type), ['link', 'link']);
  assert.equal(segs[0].label, 'Один');
  assert.equal(segs[1].label, 'Два');
});

test('splitLinkChips: скобка без http(s)-схемы не распознаётся как ссылка', async () => {
  const RegLog = await freshMail();
  const segs = RegLog.mail.splitLinkChips('текст [javascript:alert(1)]хвост и ещё [/relative]текст');
  assert.deepEqual(segs, [{ type: 'text', value: 'текст [javascript:alert(1)]хвост и ещё [/relative]текст' }]);
});

test('splitLinkChips на пустой строке отдаёт пустой список', async () => {
  const RegLog = await freshMail();
  assert.deepEqual(RegLog.mail.splitLinkChips(''), []);
});
