import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installMockChrome } from './_mockChrome.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mailsDir = join(here, '..', 'mails');

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

test('extract matches expect on all 10 sample mails, with at most one low-confidence correct code', async () => {
  const RegLog = await freshMail();
  const { extract } = RegLog.mail;
  const files = readdirSync(mailsDir).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 10);
  let lowConfidenceCount = 0;
  for (const f of files) {
    const sample = JSON.parse(readFileSync(join(mailsDir, f), 'utf8'));
    const result = extract({ text: sample.text, html: sample.html });
    assert.equal(result.code, sample.expect.code, `code mismatch in ${f}`);
    assert.equal(result.link, sample.expect.link, `link mismatch in ${f}`);
    if (result.code && result.confidence === 'low') lowConfidenceCount++;
  }
  assert.ok(lowConfidenceCount <= 1, `too many low-confidence correct codes: ${lowConfidenceCount}`);
});

test('extract never returns a javascript: or data: link', async () => {
  const RegLog = await freshMail();
  const { extract } = RegLog.mail;
  const sample = JSON.parse(readFileSync(join(mailsDir, '08-javascript-link.json'), 'utf8'));
  const result = extract({ text: sample.text, html: sample.html });
  assert.equal(result.link, null);
});
