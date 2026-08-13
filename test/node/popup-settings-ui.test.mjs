// test/node/popup-settings-ui.test.mjs
//
// Вкладка «Настройки» в Operational Grid: именованные секции, статус защиты
// журнала, явный статус сервиса почты (включая пользовательское отключение).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPopup } from './_popupDom.mjs';

const html = () => readFileSync(fileURLToPath(new URL('../../popup.html', import.meta.url)), 'utf8');

test('settings markup has four named sections and a danger zone', () => {
  const source = html();
  for (const name of ['Генерация', 'Почта', 'Доступ к сайтам', 'Защита данных']) assert.match(source, new RegExp(name));
  assert.match(source, /class="[^"]*danger-zone/);
});

test('lock status reflects disabled protection', async () => {
  const h = await loadPopup({ settings: { lockEnabled: false } });
  await h.clickTab('settings');
  assert.equal(h.el('lock-status').textContent, 'Не защищён');
});

test('provider row distinguishes user-disabled provider', async () => {
  const h = await loadPopup({ settings: { providersOff: ['dustmail'] } });
  await h.clickTab('settings');
  assert.match(h.el('set-providers-list').textContent, /Выключен/);
});
