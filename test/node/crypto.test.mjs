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
