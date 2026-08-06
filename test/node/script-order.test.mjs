// test/node/script-order.test.mjs
//
// Regression test for Task 16 finding F1: popup.html used to load lib/crypto.js
// BEFORE lib/storage.js. crypto.js attaches isLocked/__setLockEnabledCache/unlock/
// lock/enableLock/disableLock/getEntries onto RegLog.store; storage.js used to do
// `const store = RegLog.store = {}` — a destructive reassignment that wiped out
// whatever crypto.js had just attached if crypto.js ran first.
//
// This test loads the lib files in the exact order popup.html uses them (see
// <script> tags in popup.html) and asserts every method crypto.js attaches to
// RegLog.store is still present afterwards. It fails if either the script order
// in popup.html regresses, or storage.js's `RegLog.store = {}` regresses back to
// a destructive reassignment instead of `RegLog.store = RegLog.store || {}`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installMockChrome } from './_mockChrome.mjs';

const LIB_ORDER = ['generate.js', 'storage.js', 'crypto.js', 'frames.js', 'agent.js', 'mail.js'];

function loadSource(name) {
  const p = fileURLToPath(new URL(`../../lib/${name}`, import.meta.url));
  return readFileSync(p, 'utf8');
}

const sources = LIB_ORDER.map(loadSource);

test('lib files load in popup.html order without crypto.js load-order destroying RegLog.store', () => {
  installMockChrome();
  delete globalThis.RegLog;
  for (const src of sources) new Function(src)();

  const store = globalThis.RegLog && globalThis.RegLog.store;
  assert.ok(store, 'RegLog.store must exist after loading all lib files');

  for (const method of ['isLocked', '__setLockEnabledCache', 'unlock', 'lock', 'enableLock', 'disableLock']) {
    assert.equal(typeof store[method], 'function', `RegLog.store.${method} must be a function`);
  }
});
