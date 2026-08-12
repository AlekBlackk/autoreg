// test/node/package-manifest.test.mjs
//
// Regression test for the "there is no package.json" finding. The repo is a browser
// extension, not an npm package, so it had no manifest at all — which meant there was
// no canonical `npm test`, and the obvious guess (`node --test test/node/`) dies with
//
//   Error: Cannot find module 'C:\...\autoreg\test\node'  { code: 'MODULE_NOT_FOUND' }
//
// because a bare directory argument is resolved as a single module entry point, not
// expanded into the test files inside it. The working invocation is a quoted glob, which
// Node itself expands (quoted so neither sh nor cmd.exe eats it first).
//
// Two things are pinned here:
//   1. scripts.test must pass a glob that actually matches every *.test.mjs in this
//      directory — not a directory (the original bug) and not a hand-written file list
//      (which would silently skip whatever test file someone adds next).
//   2. "type" must not be "module". lib/*.js and popup.js are classic browser scripts
//      (globals hung off RegLog, no import/export) that the tests load via readFileSync +
//      new Function. Declaring the package ESM would mislabel them and break any plain
//      .js tooling added later; the .mjs tests are ESM on their own extension.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = relPath => fileURLToPath(new URL(`../../${relPath}`, import.meta.url));

function manifest() {
  return JSON.parse(readFileSync(repoFile('package.json'), 'utf8'));
}

// Minimal glob -> RegExp: only `*` (no slash crossing) is needed for the patterns a
// test script would plausibly use.
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

test('package.json exists, is valid JSON, and is marked private', () => {
  const pkg = manifest();
  assert.equal(pkg.private, true,
    'the extension is never published to a registry, so package.json must set "private": true');
});

test('package.json does not declare the package as ESM', () => {
  assert.notEqual(manifest().type, 'module',
    'lib/*.js and popup.js are classic browser scripts; "type": "module" would mislabel them');
});

test('scripts.test runs node --test over a glob that matches every test file', () => {
  const script = manifest().scripts?.test;
  assert.equal(typeof script, 'string', 'package.json must define scripts.test');
  assert.match(script, /\bnode\b.*--test\b/, 'scripts.test must invoke node --test');

  const patterns = [...script.matchAll(/"([^"]+)"|'([^']+)'/g)].map(m => m[1] ?? m[2]);
  assert.ok(patterns.length > 0,
    'the path argument must be quoted so the shell (sh or cmd.exe) leaves glob expansion to Node');

  for (const pattern of patterns) {
    assert.ok(pattern.includes('*'),
      `"${pattern}" is a bare path — a directory argument makes node --test fail with MODULE_NOT_FOUND`);
  }

  const testFiles = readdirSync(repoFile('test/node')).filter(f => f.endsWith('.test.mjs'));
  assert.ok(testFiles.length > 1, 'sanity check: expected several *.test.mjs files in test/node');

  const matchers = patterns.map(globToRegExp);
  for (const file of testFiles) {
    assert.ok(matchers.some(re => re.test(`test/node/${file}`)),
      `test/node/${file} is not matched by scripts.test (${script}) — it would never run`);
  }
});
