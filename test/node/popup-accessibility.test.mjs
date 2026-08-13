import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPopup } from './_popupDom.mjs';

const source = rel => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

test('tabs and panes expose complete ARIA relationships', () => {
  const html = source('popup.html');
  for (const name of ['new', 'inbox', 'log', 'settings']) {
    assert.match(html, new RegExp(`id="tab-${name}"[^>]*aria-controls="pane-${name}"`));
    assert.match(html, new RegExp(`id="pane-${name}"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-${name}"`));
  }
});

test('arrow keys move selection and focus through tabs', async () => {
  const h = await loadPopup();
  const current = h.el('tab-new');
  current.focus();
  await h.keydown(current, 'ArrowRight');
  assert.equal(h.el('tab-inbox').getAttribute('aria-selected'), 'true');
  assert.equal(h.doc.activeElement, h.el('tab-inbox'));
  assert.equal(h.el('tab-new').tabIndex, -1);
  assert.equal(h.el('tab-inbox').tabIndex, 0);
  assert.equal(h.RegLog.popup.activeTab(), 'inbox');
});

test('Home and End select and focus the first and last tab', async () => {
  const h = await loadPopup();
  await h.keydown(h.el('tab-new'), 'End');
  assert.equal(h.el('tab-settings').getAttribute('aria-selected'), 'true');
  assert.equal(h.doc.activeElement, h.el('tab-settings'));
  await h.keydown(h.el('tab-settings'), 'Home');
  assert.equal(h.el('tab-new').getAttribute('aria-selected'), 'true');
  assert.equal(h.doc.activeElement, h.el('tab-new'));
});

test('reverse arrow navigation wraps from the first tab to the last', async () => {
  const h = await loadPopup();
  await h.keydown(h.el('tab-new'), 'ArrowUp');
  assert.equal(h.el('tab-settings').getAttribute('aria-selected'), 'true');
  assert.equal(h.doc.activeElement, h.el('tab-settings'));
});

test('selectTab ignores unknown tab names', async () => {
  const h = await loadPopup();
  h.RegLog.popup.selectTab('missing');
  assert.equal(h.RegLog.popup.activeTab(), 'new');
  assert.equal(h.el('pane-new').hidden, false);
});

test('Operational Grid CSS defines the complete semantic token set', () => {
  const css = source('popup.css');
  const tokens = [
    '--canvas', '--surface', '--surface-raised', '--surface-hover', '--text', '--text-muted',
    '--border', '--border-strong', '--accent', '--accent-hover', '--accent-text', '--warning',
    '--danger', '--focus', '--radius-sm', '--radius-md', '--space-1', '--space-2', '--space-3',
    '--space-4', '--control'
  ];
  for (const token of tokens) assert.match(css, new RegExp(`${token}\\s*:`));
});

test('Operational Grid CSS defines themes, targets, panel layout, and reduced motion', () => {
  const css = source('popup.css');
  assert.match(css, /color-scheme:\s*light dark/);
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /body\s*\{[^}]*width:\s*372px/);
  assert.match(css, /body\.panel\s*\{[^}]*width:\s*100%[^}]*min-width:\s*372px/);
  assert.match(css, /@media\s*\(min-width:\s*480px\)\s*\{[\s\S]*body\.panel\s+\.app-shell\s*\{[^}]*grid-template-columns:\s*176px minmax\(0,\s*1fr\)/);
  assert.match(css, /--control:\s*44px/);
  assert.match(css, /button[^{}]*\{[^}]*min-height:\s*var\(--control\)/);
  assert.match(css, /:focus-visible[^{}]*\{[^}]*outline:\s*2px solid var\(--focus\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*button:active:not\(:disabled\)\s*\{[^}]*transform:\s*none/);
});

test('popup CSS does not import external assets', () => {
  const css = source('popup.css');
  assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/i);
});

test('popup CSS and scripts no longer reference legacy visual tokens', () => {
  const popupDir = fileURLToPath(new URL('../../popup/', import.meta.url));
  const files = ['popup.css', ...readdirSync(popupDir).filter(name => name.endsWith('.js')).map(name => `popup/${name}`)];
  for (const file of files) {
    assert.doesNotMatch(source(file), /var\(--(?:paper|card|ink|muted|line|warn)\)/, file);
  }
});
