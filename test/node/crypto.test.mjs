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
