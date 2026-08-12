import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installMockChrome } from './_mockChrome.mjs';

// Node's ESM loader caches a module per resolved URL; a `?t=...` cache-busting
// query string was tried first (per the brief's suggested approach) but does
// NOT force re-evaluation on this Node version (v24) — the second `import()`
// silently returned without re-running the IIFE, leaving `globalThis.RegLog`
// undefined after `fresh()` deleted it. Switched to the brief's documented
// fallback: read the source once and re-execute it via `new Function(...)`
// for every test, which genuinely re-runs the module's top-level IIFE against
// a freshly-deleted `globalThis.RegLog` each time.
const storagePath = fileURLToPath(new URL('../../lib/storage.js', import.meta.url));
const storageSource = readFileSync(storagePath, 'utf8');

function loadStorage() {
  new Function(storageSource)();
}

function fresh() {
  const areas = installMockChrome();
  delete globalThis.RegLog;
  return areas;
}

test('registrableDomain strips port, www, keeps compound TLD', async () => {
  fresh();
  loadStorage();
  const { registrableDomain } = globalThis.RegLog.store;
  assert.equal(registrableDomain('www.shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('signup.example.com:8443'), 'example.com');
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.equal(registrableDomain('localhost'), 'localhost');
});

test('init on empty storage writes schemaVersion and defaults', async () => {
  fresh();
  loadStorage();
  await globalThis.RegLog.store.init();
  const settings = await globalThis.RegLog.store.getSettings();
  assert.equal(settings.loginStyle, 'words');
});

test('init migrates v1 snapshot: string secret -> object secret + needsReauth', async () => {
  const areas = fresh();
  areas.local.set('mailbox', { secret: 'eyJraWQi...jwt', entryHost: 'signup.example.com' });
  areas.local.set('rejected', { 'signup.example.com': ['mailtm'] });
  areas.local.set('entries', [{ id: '1', host: 'example.com' }]);
  loadStorage();
  await globalThis.RegLog.store.init();
  const sessionsVal = (await new Promise(r => globalThis.__mockChrome.storage.local.get('sessions', r)))['sessions'];
  assert.equal(sessionsVal['example.com'].needsReauth, true);
  assert.equal(typeof sessionsVal['example.com'].secret, 'object');
  const rejectedVal = (await new Promise(r => globalThis.__mockChrome.storage.local.get('rejected', r)))['rejected'];
  assert.deepEqual(rejectedVal['example.com'], ['mailtm']);
  const entriesVal = (await new Promise(r => globalThis.__mockChrome.storage.local.get('entries', r)))['entries'];
  assert.equal(entriesVal.length, 1); // entries не потеряны
});

test('init migrates rejected map merging two hostnames that collapse to the same registrable domain', async () => {
  const areas = fresh();
  areas.local.set('rejected', { 'signup.example.com': ['mailtm'], 'www.example.com': ['mailtm', 'maildrop'] });
  areas.local.set('entries', []);
  loadStorage();
  await globalThis.RegLog.store.init();
  const rejectedVal = (await new Promise(r => globalThis.__mockChrome.storage.local.get('rejected', r)))['rejected'];
  assert.deepEqual(new Set(rejectedVal['example.com']), new Set(['mailtm', 'maildrop']));
  assert.equal(Object.keys(rejectedVal).length, 1); // оба старых ключа схлопнулись в один registrableDomain
});

test('init with schemaVersion newer than current leaves data untouched and sets banner', async () => {
  const areas = fresh();
  areas.local.set('schemaVersion', 99);
  areas.local.set('entries', [{ id: 'x' }]);
  loadStorage();
  await globalThis.RegLog.store.init();
  const banner = globalThis.RegLog.store.getMigrationBanner();
  assert.equal(banner.kind, 'newer');
  const entriesVal = (await new Promise(r => globalThis.__mockChrome.storage.local.get('entries', r)))['entries'];
  assert.equal(entriesVal.length, 1);
});

test('draft eviction only removes drafts that already have entryId', async () => {
  fresh();
  loadStorage();
  const store = globalThis.RegLog.store;
  for (let i = 0; i < 20; i++) await store.setDraft(`saved${i}.com`, { entryId: `e${i}`, password: 'x' });
  await store.setDraft('unsaved.com', { entryId: null, password: 'y' });
  const drafts = await store.listDrafts();
  assert.equal(Object.keys(drafts).length, 20); // одна старая saved-запись вытеснена
  assert.ok(drafts['unsaved.com']);
});

test('draft eviction does not delete anything when all 20 are unsaved', async () => {
  fresh();
  loadStorage();
  const store = globalThis.RegLog.store;
  for (let i = 0; i < 20; i++) await store.setDraft(`d${i}.com`, { entryId: null, password: 'x' });
  await store.setDraft('d20.com', { entryId: null, password: 'y' });
  const drafts = await store.listDrafts();
  assert.equal(Object.keys(drafts).length, 21);
});

test('addEntry/removeEntry roundtrip without lock', async () => {
  fresh();
  loadStorage();
  const store = globalThis.RegLog.store;
  await store.init();
  const e = await store.addEntry({ host: 'example.com', username: 'u', password: 'p' });
  let entries = await store.getEntries();
  assert.equal(entries.length, 1);
  await store.removeEntry(e.id);
  entries = await store.getEntries();
  assert.equal(entries.length, 0);
});

test('touchSession bumps touchedAt on disk and keeps the rest of the session intact', async () => {
  const areas = fresh();
  loadStorage();
  const store = globalThis.RegLog.store;
  await store.init();
  await store.setSession('example.com', { provider: 'mailtm', address: 'a@b.tld', secret: { token: 't' } });

  // Отматываем touchedAt назад: Date.now() внутри одного теста может вернуть ту же
  // миллисекунду, и «стало больше» было бы недоказуемо.
  const map = areas.local.get('sessions');
  map['example.com'].touchedAt = 1000;
  areas.local.set('sessions', map);

  const touchedAt = await store.touchSession('example.com');
  assert.ok(touchedAt > 1000);
  const after = await store.getSession('example.com');
  assert.equal(after.touchedAt, touchedAt);
  assert.equal(after.address, 'a@b.tld');
  assert.equal(after.secret.token, 't'); // остальные поля не потеряны
});

test('touchSession does not resurrect a cleared session', async () => {
  fresh();
  loadStorage();
  const store = globalThis.RegLog.store;
  await store.init();
  await store.setSession('gone.com', { provider: 'mailtm', address: 'a@b.tld' });
  await store.clearSession('gone.com');

  const res = await store.touchSession('gone.com');
  assert.equal(res, null);
  assert.equal(await store.getSession('gone.com'), null);
  assert.equal(await store.touchSession('never-existed.com'), null);
});

test('session LRU evicts the least recently touched, not the oldest created', async () => {
  const areas = fresh();
  loadStorage();
  const store = globalThis.RegLog.store;
  await store.init();
  for (let i = 0; i < 20; i++) await store.setSession(`s${i}.com`, { provider: 'mailtm', address: `s${i}@b.tld` });

  // s0 создан раньше всех, s19 — позже всех.
  const map = areas.local.get('sessions');
  for (let i = 0; i < 20; i++) map[`s${i}.com`].touchedAt = 1000 + i;
  areas.local.set('sessions', map);

  // s0 активно опрашивается — poll продлевает его touchedAt.
  await store.touchSession('s0.com');
  await store.setSession('new.com', { provider: 'mailtm', address: 'new@b.tld' });

  assert.ok(await store.getSession('s0.com'), 's0 продлён, вытеснять его нельзя');
  assert.equal(await store.getSession('s1.com'), null, 's1 — самый давно не тронутый');
  assert.ok(await store.getSession('new.com'));
});
