import { test } from 'node:test';
import assert from 'node:assert/strict';

function csvEscapeCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  s = s.replace(/"/g, '""');
  return `"${s}"`;
}

test('formula injection prefixes get a leading apostrophe', () => {
  assert.equal(csvEscapeCell('=1+1'), '"\'=1+1"');
  assert.equal(csvEscapeCell('+HYPERLINK()'), '"\'+HYPERLINK()"');
  assert.equal(csvEscapeCell('-cmd'), '"\'-cmd"');
  assert.equal(csvEscapeCell('@sum'), '"\'@sum"');
});

test('quotes are doubled and value is wrapped in quotes', () => {
  assert.equal(csvEscapeCell('he said "hi", ok'), '"he said ""hi"", ok"');
});

test('plain value round-trips unchanged aside from quoting', () => {
  assert.equal(csvEscapeCell('example.com'), '"example.com"');
});
