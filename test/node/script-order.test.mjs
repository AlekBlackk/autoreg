// test/node/script-order.test.mjs
//
// Regression test for Task 16 finding F1: popup.html used to load lib/crypto.js
// BEFORE lib/storage.js. crypto.js attaches isLocked/__setLockEnabledCache/unlock/
// lock/enableLock/disableLock/getEntries/listDrafts onto RegLog.store; storage.js
// used to do `const store = RegLog.store = {}` — a destructive reassignment that
// wiped out whatever crypto.js had just attached if crypto.js ran first.
//
// Fix-round-2 note: the first version of this file (a) hardcoded the load order
// as a literal array instead of reading popup.html, so it couldn't detect the
// order regressing back, and (b) only checked that the six lock/unlock-family
// methods *exist*, which stays true even when getEntries/listDrafts are the
// crypto-unaware storage.js originals (property-assignment order, not object
// identity, decides which of two same-named functions "wins" when both files
// define store.getEntries/store.listDrafts). Both gaps are fixed below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installMockChrome } from './_mockChrome.mjs';

function loadSource(relPath) {
  const p = fileURLToPath(new URL(`../../${relPath}`, import.meta.url));
  return readFileSync(p, 'utf8');
}

// Extract the real <script src="lib/...js"> load order straight out of popup.html
// instead of a hardcoded array, so this test can never silently drift from what the
// browser actually loads: if popup.html's order regresses, this test exercises the
// regressed order for real, and the assertions below catch the fallout.
function popupLibScriptOrder() {
  const html = loadSource('popup.html');
  const re = /<script\s+src="([^"]+\.js)"><\/script>/g;
  const paths = [];
  let m;
  while ((m = re.exec(html))) paths.push(m[1]);
  const libOnly = paths.filter(p => p.startsWith('lib/'));
  if (libOnly.length === 0) throw new Error('could not find any lib/*.js <script> tags in popup.html — did the markup change?');
  return libOnly;
}

// Returns both the store and the raw mock storage Maps (same shape storage.test.mjs
// uses: areas.local.set(key, value), not the chrome-callback-style wrapper).
function loadInOrder(paths) {
  const areas = installMockChrome();
  delete globalThis.RegLog;
  for (const relPath of paths) new Function(loadSource(relPath))();
  return { store: globalThis.RegLog.store, areas };
}

test('lib files load in the real popup.html order, and getEntries/listDrafts end up crypto-patched', async () => {
  const order = popupLibScriptOrder();
  const { store, areas } = loadInOrder(order);
  assert.ok(store, 'RegLog.store must exist after loading all lib files');

  for (const method of ['isLocked', '__setLockEnabledCache', 'unlock', 'lock', 'enableLock', 'disableLock']) {
    assert.equal(typeof store[method], 'function', `RegLog.store.${method} must be a function`);
  }

  // Locked + encrypted, with no active/session key: the one state where storage.js's
  // own (crypto-unaware) getEntries/listDrafts and crypto.js's patched versions behave
  // observably differently. The unpatched originals just return whatever raw value sits
  // in storage (the encrypted blob itself); the patched versions recognize the locked
  // shape and return the `{ __locked: true }` sentinel. This makes "did the patch
  // actually take effect" testable by behavior, not merely "does a same-named property
  // exist" (which is true for both the patched and unpatched version).
  areas.local.set('settings', { lockEnabled: true, providers: [], providersOff: [] });
  areas.local.set('entries', { __encrypted: true, salt: 'x', iv: 'y', data: 'z' });
  areas.local.set('drafts', { __encrypted: true, salt: 'x', iv: 'y', data: 'z' });

  const entries = await store.getEntries();
  const drafts = await store.listDrafts();
  assert.deepEqual(entries, { __locked: true },
    "getEntries must be crypto.js's patched version (returns the __locked sentinel), not storage.js's crypto-unaware original");
  assert.deepEqual(drafts, { __locked: true },
    "listDrafts must be crypto.js's patched version (returns the __locked sentinel), not storage.js's crypto-unaware original");
});

test("defense in depth: storage.js's non-destructive RegLog.store merge survives crypto.js loading first", async () => {
  // Deliberately the OLD, wrong order — independent of whatever popup.html currently
  // says — to pin down storage.js:4's own contract (`RegLog.store = RegLog.store || {}`)
  // in isolation. Property-assignment order still decides which of getEntries/listDrafts
  // "wins" (storage.js's plain versions do, in this deliberately-wrong order — that part
  // is expected, and is popup.html's job to get right, covered by the test above). What
  // must NOT happen, in any load order, is the six crypto-only methods below vanishing —
  // storage.js never defines them, so their survival here is purely a test of the merge
  // not being a destructive reassignment.
  const { store } = loadInOrder(['lib/generate.js', 'lib/crypto.js', 'lib/storage.js']);
  assert.ok(store, 'RegLog.store must exist');
  for (const method of ['isLocked', '__setLockEnabledCache', 'unlock', 'lock', 'enableLock', 'disableLock']) {
    assert.equal(typeof store[method], 'function', `RegLog.store.${method} must survive storage.js loading after crypto.js`);
  }
});
