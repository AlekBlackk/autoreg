// test/node/docs-consistency.test.mjs
//
// For this extension the README is a promise about the network: "no telemetry, no
// requests except the temp-mail APIs listed below". A provider that ships enabled,
// with a host permission in the manifest, and no line in the README breaks that
// promise silently — which is exactly how DustMail shipped (default provider in
// storage.js, host permission in manifest.json, absent from a README that claimed
// "four active services" and then listed four other ones).
//
// The other direction matters too: a host permission that no enabled adapter uses
// is a permission the user grants for nothing (dropmail.me was held for an adapter
// marked `disabled: true`).
//
// So this file pins the three-way agreement between lib/mail.js (what the code
// talks to), manifest.json (what Chrome allows it to talk to) and README.md (what
// the user was told).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installMockChrome } from './_mockChrome.mjs';

const repoFile = relPath => fileURLToPath(new URL(`../../${relPath}`, import.meta.url));
const readme = readFileSync(repoFile('README.md'), 'utf8');
const manifest = JSON.parse(readFileSync(repoFile('manifest.json'), 'utf8'));

function adapters() {
  installMockChrome();
  delete globalThis.RegLog;
  for (const file of ['lib/generate.js', 'lib/storage.js', 'lib/mail.js']) {
    new Function(readFileSync(repoFile(file), 'utf8'))();
  }
  return globalThis.RegLog.mail.adapters;
}

test('README documents every enabled mail adapter', () => {
  for (const adapter of adapters()) {
    if (adapter.disabled) continue;
    assert.ok(readme.includes(adapter.label),
      `adapter "${adapter.id}" ships enabled but its label "${adapter.label}" is nowhere in README.md`);
  }
});

test('README names every host the manifest lets the extension reach', () => {
  for (const origin of manifest.host_permissions) {
    const host = origin.replace(/^\w+:\/\//, '').replace(/\/.*$/, '');
    assert.ok(readme.includes(host),
      `host_permissions grants ${host} but README.md never mentions it — the "no other network requests" claim is unverifiable`);
  }
});

test('manifest grants no host permission for a disabled adapter', () => {
  // Hostname per adapter is not introspectable from the adapter object (the URLs are
  // inline in create/list/read), so the mapping lives here, next to the assertion.
  const HOSTS = {
    mailtm: 'api.mail.tm', mailgw: 'api.mail.gw', maildrop: 'api.maildrop.cc',
    dropmail: 'dropmail.me', guerrilla: 'api.guerrillamail.com', dustmail: 'dustmail.net', mailcx: 'mail.cx',
    tempmaillol: 'api.tempmail.lol', tempmailio: 'api.internal.temp-mail.io',
    tempmailplus: 'tempmail.plus'
  };
  const granted = manifest.host_permissions.map(o => o.replace(/^\w+:\/\//, '').replace(/\/.*$/, ''));
  for (const adapter of adapters()) {
    const host = HOSTS[adapter.id];
    assert.ok(host, `no host recorded for adapter "${adapter.id}" — add it to this test`);
    if (adapter.disabled) {
      assert.ok(!granted.includes(host),
        `adapter "${adapter.id}" is disabled, so host permission ${host} buys the user nothing`);
    } else {
      assert.ok(granted.includes(host),
        `adapter "${adapter.id}" is enabled but ${host} is not in host_permissions — every request would fail`);
    }
  }
});
