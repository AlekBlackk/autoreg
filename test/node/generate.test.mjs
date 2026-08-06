import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../lib/generate.js';
const { gen } = globalThis.RegLog;

test('randomInt stays within bounds and is not always the same value', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const v = gen.randomInt(7);
    assert.ok(v >= 0 && v < 7);
    seen.add(v);
  }
  assert.ok(seen.size > 1);
});

test('password respects length and required classes', () => {
  const p = gen.password(20, true);
  assert.equal(p.length, 20);
  assert.ok(/[a-z]/.test(p) && /[A-Z]/.test(p) && /[2-9]/.test(p) && /[!@#$%^&*\-_=+?]/.test(p));
});

test('password respects len even when len is smaller than the number of active classes', () => {
  assert.equal(gen.password(2, false).length, 2);
  assert.equal(gen.password(1, true).length, 1);
  assert.equal(gen.password(0, false).length, 0);
});

test('gen.PRESETS is not exported on the public namespace', () => {
  assert.equal(gen.PRESETS, undefined);
});

test('passwordForPolicy legacy has exactly one upper and one digit, length 12', () => {
  const p = gen.passwordForPolicy('legacy');
  assert.equal(p.length, 12);
  assert.equal((p.match(/[A-Z]/g) || []).length, 1);
  assert.equal((p.match(/[2-9]/g) || []).length, 1);
});

test('username styles generate only letters and digits', () => {
  assert.match(gen.username('words'), /^[a-z]+[a-z]+\d{2}$/);
  assert.match(gen.username('short'), /^[a-z]+[A-Z][a-z]+\d{2}$/);
  assert.match(gen.username('random'), /^[a-z2-9]{12}$/);

  for (const style of ['words', 'short', 'random']) {
    assert.match(gen.username(style), /^[A-Za-z0-9]+$/);
  }
});

test('sanitizeLocalPart lowercases, strips disallowed chars, pads short input', () => {
  assert.equal(gen.sanitizeLocalPart('Ab!!C', {}).length >= 6, true);
  assert.match(gen.sanitizeLocalPart('Ab!!C', {}), /^[a-z0-9.\-_]+$/);
});

test('sanitizeLocalPart minEntropyChars appends extra random suffix', () => {
  const s = gen.sanitizeLocalPart('amber-harbor-47', { maxLen: 32, allowDot: false, minEntropyChars: 10 });
  assert.ok(s.length <= 32);
  assert.match(s, /-[a-z2-9]+$/);
});

test('personName returns full as "First Last"', () => {
  const n = gen.personName();
  assert.equal(n.full, `${n.first} ${n.last}`);
});
