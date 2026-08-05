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

test('passwordForPolicy legacy has exactly one upper and one digit, length 12', () => {
  const p = gen.passwordForPolicy('legacy');
  assert.equal(p.length, 12);
  assert.equal((p.match(/[A-Z]/g) || []).length, 1);
  assert.equal((p.match(/[2-9]/g) || []).length, 1);
});

test('username styles produce expected shapes', () => {
  assert.match(gen.username('words'), /^[a-z]+-[a-z]+-\d{2}$/);
  assert.match(gen.username('short'), /^[a-z]+[A-Z][a-z]+\d{2}$/);
  assert.match(gen.username('random'), /^[a-z2-9]{12}$/);
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
