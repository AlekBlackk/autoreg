import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
