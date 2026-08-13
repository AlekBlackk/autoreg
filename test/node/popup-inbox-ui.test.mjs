// test/node/popup-inbox-ui.test.mjs
//
// Вкладка «Ящик» в Operational Grid: текстовая метка нового письма (не только цвет),
// видимое busy-состояние ручного «Обновить», и вынесенный вперёд код подтверждения.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPopup } from './_popupDom.mjs';

const message = { id: 'm1', from: 'noreply@site.test', subject: 'Код входа', intro: 'Ваш код', date: Date.now() };

test('new mail has a textual marker in addition to color', async () => {
  const h = await loadPopup();
  await h.clickTab('inbox');
  await h.emitMail([]);
  await h.emitMail([message]);
  const row = h.mailRows()[0];
  assert.ok(row.children.some(child => child.className === 'mail-new-label'));
  assert.match(row.textContent, /Новое/);
});

test('manual refresh exposes busy state and restores its label', async () => {
  let release;
  const h = await loadPopup();
  h.adapter.list = () => new Promise(resolve => { release = resolve; });
  const button = h.el('btn-refresh-inbox');
  const pending = button.click();
  await h.tick();
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.disabled, true);
  release([]);
  await pending;
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(button.disabled, false);
});

test('verification code is first, explicit, and copyable', async () => {
  const h = await loadPopup({ extract: () => ({ code: '482913', link: null, confidence: 'high' }) });
  await h.clickTab('inbox');
  await h.emitMail([message]);
  await h.click(h.mailRows()[0]);
  assert.match(h.el('mail-code').className, /verification-card/);
  const copy = h.el('mail-code').children.find(child => child.tagName === 'BUTTON');
  await h.click(copy);
  assert.deepEqual(h.state.clipboardWrites, ['482913']);
});
