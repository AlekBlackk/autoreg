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

// Раньше энтропийный суффикс дописывался ПОСЛЕ обрезки базы до maxLen, а итоговый
// slice(0, maxLen) срезал именно суффикс. Для publicInbox-провайдеров (Maildrop, 5.x
// SPEC) имя ящика — единственный секрет, так что усечённый суффикс = публичный ящик
// с предсказуемым именем из нашего же открытого словаря.
test('sanitizeLocalPart keeps the full entropy suffix even when the base fills maxLen', () => {
  for (let i = 0; i < 50; i++) {
    const s = gen.sanitizeLocalPart('a'.repeat(64), { maxLen: 32, allowDot: false, minEntropyChars: 10 });
    assert.ok(s.length <= 32, `длина ${s.length} > maxLen 32: ${s}`);
    const suffix = s.slice(s.lastIndexOf('-') + 1);
    assert.ok(s.includes('-'), `нет разделителя суффикса: ${s}`);
    assert.equal(suffix.length, 10, `суффикс усечён до ${suffix.length}: ${s}`);
    assert.match(suffix, /^[a-z2-9]{10}$/);
  }
});

test('sanitizeLocalPart entropy suffix survives a base that is exactly at the reserved boundary', () => {
  const s = gen.sanitizeLocalPart('b'.repeat(21), { maxLen: 32, allowDot: false, minEntropyChars: 10 });
  assert.equal(s.length, 32);
  assert.equal(s.slice(0, 21), 'b'.repeat(21));
  assert.equal(s[21], '-');
  assert.match(s.slice(22), /^[a-z2-9]{10}$/);
});

test('sanitizeLocalPart never emits a doubled separator when truncation lands on one', () => {
  // baseMax = 22 - 10 - 1 = 11; slice(0, 11) заканчивается на '-'
  const s = gen.sanitizeLocalPart('abcdefghij-klmnopqrst', { maxLen: 22, allowDot: false, minEntropyChars: 10 });
  assert.ok(!s.includes('--'), `двойной разделитель: ${s}`);
  assert.ok(s.length <= 22);
  assert.match(s, /^[a-z0-9\-_]+$/);
  assert.equal(s.slice(s.lastIndexOf('-') + 1).length, 10);
});

test('sanitizeLocalPart throws when maxLen cannot hold minEntropyChars instead of silently truncating it', () => {
  assert.throws(() => gen.sanitizeLocalPart('amber-harbor', { maxLen: 10, minEntropyChars: 10 }), RangeError);
  assert.throws(() => gen.sanitizeLocalPart('amber-harbor', { maxLen: 11, minEntropyChars: 10 }), RangeError);
  // 12 = 1 символ базы + '-' + 10 символов суффикса — минимально допустимо
  assert.equal(gen.sanitizeLocalPart('amber-harbor', { maxLen: 12, minEntropyChars: 10 }).length, 12);
});

test('sanitizeLocalPart still truncates to maxLen when minEntropyChars is 0', () => {
  const s = gen.sanitizeLocalPart('c'.repeat(64), { maxLen: 32, minEntropyChars: 0 });
  assert.equal(s.length, 32);
});

test('personName returns full as "First Last"', () => {
  const n = gen.personName();
  assert.equal(n.full, `${n.first} ${n.last}`);
});
