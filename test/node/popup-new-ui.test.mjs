// test/node/popup-new-ui.test.mjs
//
// Вкладка «Новый» в Operational Grid: явные кнопки копирования комплекта,
// читаемые подписи/pressed-состояние пресетов пароля, видимая сводка сканирования.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPopup } from './_popupDom.mjs';

test('kit copy control copies the complete value', async () => {
  const h = await loadPopup({ draft: { name: 'Иван Иванов', username: 'ivan', password: 'secret', note: '' } });
  await h.click(h.el('copy-kit-mail'));
  assert.deepEqual(h.state.clipboardWrites, ['ivan@dust.test']);
});

test('password preset exposes readable labels and pressed state', async () => {
  const h = await loadPopup({ settings: { passPreset: 'safe' }, draft: { name: 'Иван', username: 'ivan', password: 'secret', note: '' } });
  const buttons = ['strong', 'safe', 'legacy'].map(name => h.el(`preset-${name}`));
  assert.deepEqual(buttons.map(button => button.textContent), ['Надёжный', 'Совместимый', 'Устаревший']);
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'true');
});

test('scan summary is visible next to the primary action', async () => {
  const h = await loadPopup();
  assert.match(h.el('scan-status').textContent, /Найдено:/i);
  assert.match(h.el('scan-status').textContent, /Не найдено:/i);
});
