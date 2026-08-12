// test/node/crypto.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installMockChrome } from './_mockChrome.mjs';

const storagePath = fileURLToPath(new URL('../../lib/storage.js', import.meta.url));
const cryptoPath = fileURLToPath(new URL('../../lib/crypto.js', import.meta.url));
const storageSource = readFileSync(storagePath, 'utf8');
const cryptoSource = readFileSync(cryptoPath, 'utf8');

function loadModules() {
  new Function(storageSource)();
  new Function(cryptoSource)();
}

async function freshModules() {
  installMockChrome();
  delete globalThis.RegLog;
  loadModules();
  return globalThis.RegLog.store;
}

// Перезагрузка модулей БЕЗ переустановки mock chrome: имитирует новый документ
// popup/panel в рамках того же запуска браузера — chrome.storage.session жив,
// а module-level activeKey/activeSalt/activeKdf в crypto.js пропали.
function reloadModules() {
  delete globalThis.RegLog;
  loadModules();
  return globalThis.RegLog.store;
}

const b64 = buf => Buffer.from(new Uint8Array(buf)).toString('base64');
const unb64 = str => new Uint8Array(Buffer.from(str, 'base64'));

// Собирает крипто-блоб вручную, минуя crypto.js — нужно, чтобы проверить чтение
// чужих/старых параметров KDF, которые сам crypto.js уже не производит.
async function makeBlob(pass, salt, iter, plain, extra) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(plain)));
  return { __encrypted: true, salt: b64(salt), iv: b64(iv), data: b64(ct), ...extra };
}

function localGet(key) {
  return new Promise((resolve) => globalThis.__mockChrome.storage.local.get(key, resolve));
}
function localSet(obj) {
  return new Promise((resolve) => globalThis.__mockChrome.storage.local.set(obj, resolve));
}

test('enableLock encrypts existing entries; local storage no longer holds plaintext', async () => {
  const store = await freshModules();
  await store.init();
  await store.addEntry({ host: 'example.com', username: 'u', password: 'super-secret-pw' });
  await store.enableLock('correct horse battery staple');
  const raw = await new Promise((resolve) => globalThis.__mockChrome.storage.local.get('entries', resolve));
  assert.equal(raw.entries.__encrypted, true);
  assert.ok(!JSON.stringify(raw.entries).includes('super-secret-pw'));
});

test('unlock with correct password decrypts entries', async () => {
  const store = await freshModules();
  await store.init();
  await store.addEntry({ host: 'example.com', username: 'u', password: 'super-secret-pw' });
  await store.enableLock('hunter2-hunter2');
  await store.lock();
  await store.unlock('hunter2-hunter2');
  const entries = await store.getEntries();
  assert.equal(entries[0].password, 'super-secret-pw');
});

test('unlock with wrong password throws and does not unlock', async () => {
  const store = await freshModules();
  await store.init();
  await store.addEntry({ host: 'example.com', username: 'u', password: 'x' });
  await store.enableLock('right-password-123');
  await store.lock();
  await assert.rejects(() => store.unlock('wrong-password-000'));
});

test('disableLock restores plaintext entries in storage', async () => {
  const store = await freshModules();
  await store.init();
  await store.addEntry({ host: 'example.com', username: 'u', password: 'plain-again' });
  await store.enableLock('pw-1234567890');
  await store.disableLock('pw-1234567890');
  const raw = await new Promise((resolve) => globalThis.__mockChrome.storage.local.get('entries', resolve));
  assert.ok(Array.isArray(raw.entries));
  assert.equal(raw.entries[0].password, 'plain-again');
});

test('enableLock encrypts drafts too; no plaintext password in stored draft blob', async () => {
  const store = await freshModules();
  await store.init();
  await store.setDraft('example.com', { name: 'X', username: 'u', password: 'draft-secret-pw' });
  await store.enableLock('correct horse battery staple');
  const raw = await new Promise((resolve) => globalThis.__mockChrome.storage.local.get('drafts', resolve));
  assert.equal(raw.drafts.__encrypted, true);
  assert.ok(!JSON.stringify(raw.drafts).includes('draft-secret-pw'));
});

test('disableLock restores plaintext drafts in storage', async () => {
  const store = await freshModules();
  await store.init();
  await store.setDraft('example.com', { name: 'X', username: 'u', password: 'draft-secret-pw2' });
  await store.enableLock('pw-1234567890');
  await store.disableLock('pw-1234567890');
  const raw = await new Promise((resolve) => globalThis.__mockChrome.storage.local.get('drafts', resolve));
  assert.equal(raw.drafts['example.com'].password, 'draft-secret-pw2');
});

test('unlock with correct password decrypts drafts via getDraft', async () => {
  const store = await freshModules();
  await store.init();
  await store.setDraft('example.com', { name: 'X', username: 'u', password: 'draft-secret-pw3' });
  await store.enableLock('hunter2-hunter2');
  await store.lock();
  await store.unlock('hunter2-hunter2');
  const draft = await store.getDraft('example.com');
  assert.equal(draft.password, 'draft-secret-pw3');
});

// Regression guard for Finding 2 fix-round-2: an earlier "fix" made enableLock write the
// encrypted blob BEFORE flipping lockEnabled to true — the reverse of what's safe. If
// enableLock died between those two writes under that wrong order, lockEnabled would still
// say false while entries/drafts on disk were already the encrypted-blob shape; getEntries()
// /listDrafts() at lockEnabled:false take the non-crypto branch and return the blob "as is"
// (`Array.isArray(blob) ? blob : []` -> blob isn't an array -> silently `[]`), and the next
// addEntry/setDraft would overwrite the still-encrypted blob with plaintext, destroying the
// rest irrecoverably. The correct order (settings flipped first, blob written second) is the
// only one where a mid-operation failure leaves storage in a state getEntries() can still
// read correctly (entries stay a plain array, lockEnabled just optimistically says true a
// beat early). This test pins the actual write order via a spy, not just the end state,
// since the end state alone looks identical for either ordering in the success path.
test('enableLock writes lockEnabled:true to settings BEFORE writing the encrypted entries/drafts blob', async () => {
  const store = await freshModules();
  await store.init();
  await store.addEntry({ host: 'example.com', username: 'u', password: 'order-secret-pw' });

  const localArea = globalThis.__mockChrome.storage.local;
  const order = [];
  const originalSet = localArea.set.bind(localArea);
  localArea.set = (obj, cb) => {
    if ('settings' in obj) order.push('settings');
    if ('entries' in obj || 'drafts' in obj) order.push('data');
    originalSet(obj, cb);
  };
  try {
    await store.enableLock('order-check-pw-123');
  } finally {
    localArea.set = originalSet;
  }

  const settingsIdx = order.indexOf('settings');
  const dataIdx = order.indexOf('data');
  assert.ok(settingsIdx !== -1, 'settings write must have happened');
  assert.ok(dataIdx !== -1, 'entries/drafts write must have happened');
  assert.ok(settingsIdx < dataIdx,
    `settings (lockEnabled:true) must be written before the encrypted blob — got settings at index ${settingsIdx}, data at index ${dataIdx}`);

  // End state must also hold both halves of the invariant simultaneously.
  const settings = await store.getSettings();
  assert.equal(settings.lockEnabled, true);
  const raw = await new Promise((resolve) => localArea.get('entries', resolve));
  assert.equal(raw.entries.__encrypted, true);
});

// Mirrors the test above for disableLock, whose safe order is the OPPOSITE (data written
// before the settings flip to lockEnabled:false) — see that function's comment for why.
test('disableLock writes plaintext entries/drafts BEFORE flipping lockEnabled to false', async () => {
  const store = await freshModules();
  await store.init();
  await store.addEntry({ host: 'example.com', username: 'u', password: 'order-secret-pw-2' });
  await store.enableLock('order-check-pw-456');

  const localArea = globalThis.__mockChrome.storage.local;
  const order = [];
  const originalSet = localArea.set.bind(localArea);
  localArea.set = (obj, cb) => {
    if ('settings' in obj) order.push('settings');
    if ('entries' in obj || 'drafts' in obj) order.push('data');
    originalSet(obj, cb);
  };
  try {
    await store.disableLock('order-check-pw-456');
  } finally {
    localArea.set = originalSet;
  }

  const settingsIdx = order.indexOf('settings');
  const dataIdx = order.indexOf('data');
  assert.ok(settingsIdx !== -1, 'settings write must have happened');
  assert.ok(dataIdx !== -1, 'entries/drafts write must have happened');
  assert.ok(dataIdx < settingsIdx,
    `plaintext data must be written before settings (lockEnabled:false) — got data at index ${dataIdx}, settings at index ${settingsIdx}`);
});

test('enableLock on already-encrypted journal throws and does not wipe data', async () => {
  const store = await freshModules();
  await store.init();
  await store.addEntry({ host: 'example.com', username: 'u', password: 'secret-1' });
  await store.enableLock('password-1');
  // Second enableLock should throw and not wipe the encrypted data
  await assert.rejects(() => store.enableLock('password-2'), /уже зашифрован/);
  // Verify that the original encrypted entry is still recoverable
  await store.unlock('password-1');
  const entries = await store.getEntries();
  assert.equal(entries[0].password, 'secret-1');
});

// --- Параметры KDF внутри блоба -------------------------------------------------
// Раньше число итераций PBKDF2 было захардкожено в ITER, а блоб хранил только
// {__encrypted, salt, iv, data}. Значит поднять итерации до текущей рекомендации
// OWASP было нельзя НИКОГДА: уже записанные журналы выводили бы ключ с новым
// числом итераций, расшифровка падала бы, а пользователь видел бы «неверный
// пароль» на верном пароле. Параметры KDF обязаны ехать вместе с шифротекстом.

test('encrypted blob carries its own KDF parameters', async () => {
  const store = await freshModules();
  await store.init();
  await store.addEntry({ host: 'example.com', username: 'u', password: 'kdf-secret' });
  await store.enableLock('kdf-params-pw-1');
  const raw = await localGet('entries');
  assert.ok(raw.entries.kdf, 'блоб обязан содержать поле kdf');
  assert.equal(raw.entries.kdf.v, 1);
  assert.equal(raw.entries.kdf.hash, 'SHA-256');
  assert.ok(Number.isInteger(raw.entries.kdf.iter), 'kdf.iter обязан быть целым');
  // Минимум — текущая рекомендация OWASP для PBKDF2-SHA256. Понижать нельзя.
  assert.ok(raw.entries.kdf.iter >= 600000, `kdf.iter=${raw.entries.kdf.iter} ниже рекомендации OWASP 600000`);
});

test('unlock derives with the iteration count recorded in the blob, not the current default', async () => {
  const store = await freshModules();
  await store.init();
  await store.setSettings({ lockEnabled: true });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const blob = await makeBlob('older-journal-pw', salt, 150000,
    [{ id: 'e1', host: 'example.com', username: 'u', password: 'from-150k-blob' }],
    { kdf: { v: 1, iter: 150000, hash: 'SHA-256' } });
  await localSet({ entries: blob, __lockSalt: b64(salt) });

  await store.unlock('older-journal-pw');
  const entries = await store.getEntries();
  assert.equal(entries[0].password, 'from-150k-blob');
});

// Страховка для уже существующих на диске журналов: у них поля kdf нет вообще,
// и они были записаны прежним захардкоженным ITER = 310000. Этот тест — причина,
// по которой поле kdf вообще понадобилось: он должен продолжать проходить, когда
// дефолт для НОВЫХ замков поднимается.
test('legacy blob without a kdf field still decrypts at the historical 310000 iterations', async () => {
  const store = await freshModules();
  await store.init();
  await store.setSettings({ lockEnabled: true });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const blob = await makeBlob('legacy-journal-pw', salt, 310000,
    [{ id: 'e1', host: 'example.com', username: 'u', password: 'from-legacy-blob' }]);
  assert.equal(blob.kdf, undefined);
  await localSet({ entries: blob, __lockSalt: b64(salt) });

  await store.unlock('legacy-journal-pw');
  const entries = await store.getEntries();
  assert.equal(entries[0].password, 'from-legacy-blob');
});

test('unlock rejects a blob whose kdf.iter is below the accepted floor instead of blaming the password', async () => {
  const store = await freshModules();
  await store.init();
  await store.setSettings({ lockEnabled: true });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const blob = await makeBlob('downgrade-pw', salt, 1, [{ id: 'e1', password: 'x' }],
    { kdf: { v: 1, iter: 1, hash: 'SHA-256' } });
  await localSet({ entries: blob, __lockSalt: b64(salt) });

  await assert.rejects(() => store.unlock('downgrade-pw'), /KDF/);
});

test('unlock rejects an absurd kdf.iter rather than hanging on derivation', async () => {
  const store = await freshModules();
  await store.init();
  await store.setSettings({ lockEnabled: true });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const blob = await makeBlob('dos-pw', salt, 310000, [{ id: 'e1', password: 'x' }],
    { kdf: { v: 1, iter: 500000000, hash: 'SHA-256' } });
  await localSet({ entries: blob, __lockSalt: b64(salt) });

  await assert.rejects(() => store.unlock('dos-pw'), /KDF/);
});

test('unlock rejects an unknown kdf version', async () => {
  const store = await freshModules();
  await store.init();
  await store.setSettings({ lockEnabled: true });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const blob = await makeBlob('futurepw-123', salt, 310000, [{ id: 'e1', password: 'x' }],
    { kdf: { v: 99, iter: 310000, hash: 'SHA-256' } });
  await localSet({ entries: blob, __lockSalt: b64(salt) });

  await assert.rejects(() => store.unlock('futurepw-123'), /KDF/);
});

// --- Соль блоба должна соответствовать ключу ------------------------------------
// encryptEntries брал соль из getSaltRecord(), который при пропавшей записи
// __lockSalt МОЛЧА СОЗДАВАЛ новую. Блоб уезжал с солью, не соответствующей ключу,
// которым он зашифрован, и после перезапуска журнал становился нерасшифровываемым
// навсегда — при этом с сообщением «неверный пароль».

test('a write after __lockSalt disappears keeps the blob salt matching the active key', async () => {
  const store = await freshModules();
  await store.init();
  await store.enableLock('salt-pin-pw-123');
  const before = await localGet('entries');

  // Соль исчезла из local (сбой storage, чужая очистка, ручное вмешательство)
  await localSet({ __lockSalt: undefined });
  await store.addEntry({ host: 'example.com', username: 'u', password: 'after-salt-loss' });

  const after = await localGet('entries');
  assert.equal(after.entries.salt, before.entries.salt, 'соль блоба не должна меняться при записи тем же ключом');

  await store.lock();
  await store.unlock('salt-pin-pw-123');
  const entries = await store.getEntries();
  assert.equal(entries[0].password, 'after-salt-loss');
});

test('unlock recovers a journal whose __lockSalt was lost, using the salt inside the blob', async () => {
  const store = await freshModules();
  await store.init();
  await store.addEntry({ host: 'example.com', username: 'u', password: 'salt-only-in-blob' });
  await store.enableLock('recover-pw-4567');
  await store.lock();
  await localSet({ __lockSalt: undefined });

  await store.unlock('recover-pw-4567');
  const entries = await store.getEntries();
  assert.equal(entries[0].password, 'salt-only-in-blob');
});

test('a key restored from storage.session re-encrypts with the same salt and kdf', async () => {
  const store = await freshModules();
  await store.init();
  await store.addEntry({ host: 'example.com', username: 'u', password: 'session-restore-pw' });
  await store.enableLock('session-pw-891011');
  const before = await localGet('entries');

  // Новый документ popup: активный ключ в памяти пропал, storage.session жив.
  const store2 = reloadModules();
  assert.equal(globalThis.RegLog.crypto.isUnlocked(), false);
  assert.equal(await globalThis.RegLog.crypto.tryRestoreFromSession(), true);
  await store2.addEntry({ host: 'other.com', username: 'u2', password: 'written-after-restore' });

  const after = await localGet('entries');
  assert.ok(after.entries.kdf, 'блоб после восстановления ключа обязан содержать kdf');
  assert.equal(after.entries.salt, before.entries.salt);
  assert.deepEqual(after.entries.kdf, before.entries.kdf);

  await store2.lock();
  await store2.unlock('session-pw-891011');
  const entries = await store2.getEntries();
  assert.equal(entries[0].password, 'written-after-restore');
  assert.equal(entries[1].password, 'session-restore-pw');
});

test('disableLock reads KDF parameters from the blob too', async () => {
  const store = await freshModules();
  await store.init();
  await store.setSettings({ lockEnabled: true });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const blob = await makeBlob('disable-kdf-pw', salt, 150000,
    [{ id: 'e1', host: 'example.com', username: 'u', password: 'plain-from-150k' }],
    { kdf: { v: 1, iter: 150000, hash: 'SHA-256' } });
  await localSet({ entries: blob, __lockSalt: b64(salt) });

  await store.disableLock('disable-kdf-pw');
  const raw = await localGet('entries');
  assert.ok(Array.isArray(raw.entries));
  assert.equal(raw.entries[0].password, 'plain-from-150k');
});
