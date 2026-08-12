// test/node/popup-inbox-errors.test.mjs
//
// Видимость сбоев «Ящика»:
//   1) неудачный батч поллинга обязан оставлять след на экране (#inbox-error,
//      role="alert") со счётчиком подряд идущих неудач — раньше сеть/500/rate-limit
//      уходили в тишину, пользователь видел пустую область без единого слова;
//   2) сессия от сервиса, которого нет в сборке, не должна убивать вкладку:
//      её распознают до adapter.list и предлагают взять новый адрес.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPopup } from './_popupDom.mjs';

const MSG = { id: 'm1', from: 'noreply@site.test', subject: 'Код', intro: 'ваш код', date: Date.now() };

test('#inbox-error размечен в popup.html как role="alert" и скрыт по умолчанию', () => {
  const html = readFileSync(fileURLToPath(new URL('../../popup.html', import.meta.url)), 'utf8');
  const tag = html.match(/<[^>]*id="inbox-error"[^>]*>/);
  assert.ok(tag, 'в pane-inbox нужна строка состояния #inbox-error');
  assert.match(tag[0], /role="alert"/, 'сбой обязан объявляться скринридером');
  assert.match(tag[0], /\bhidden\b/, 'до первой ошибки строка состояния скрыта');
});

test('сетевой сбой поллинга показывает строку состояния, а не тишину', async () => {
  const h = await loadPopup();
  await h.clickTab('inbox');
  assert.equal(h.el('inbox-error').hidden, true, 'до сбоя строка состояния скрыта');

  await h.emitBatch({ ok: false, error: { reason: 'network' } });

  assert.deepEqual(h.unhandled, []);
  assert.equal(h.el('inbox-error').hidden, false, 'сбой обязан быть виден');
  assert.match(h.el('inbox-error').textContent, /связ/i, 'причина сбоя называется словами');
});

test('строка состояния считает подряд идущие неудачи', async () => {
  const h = await loadPopup();
  await h.clickTab('inbox');

  await h.emitBatch({ ok: false, error: { reason: 'server', status: 500 } });
  const first = h.el('inbox-error').textContent;
  await h.emitBatch({ ok: false, error: { reason: 'server', status: 500 } });
  const second = h.el('inbox-error').textContent;

  assert.match(second, /2/, 'вторая неудача подряд обязана быть посчитана');
  assert.notEqual(first, second, 'счётчик должен обновлять текст, а не повторять его');
});

test('удачный батч гасит строку состояния и сбрасывает счётчик', async () => {
  const h = await loadPopup();
  await h.clickTab('inbox');

  await h.emitBatch({ ok: false, error: { reason: 'rate', retryAfter: 30 } });
  assert.equal(h.el('inbox-error').hidden, false);

  await h.emitMail([MSG]);
  assert.equal(h.el('inbox-error').hidden, true, 'после успеха сбой с экрана уходит');
  assert.equal(h.mailRows().length, 1, 'письма рисуются как обычно');

  await h.emitBatch({ ok: false, error: { reason: 'network' } });
  assert.doesNotMatch(h.el('inbox-error').textContent, /2/, 'счётчик обязан сброситься на успехе');
});

test('истёкший ящик показывает свой экран, а не строку состояния', async () => {
  const h = await loadPopup();
  await h.clickTab('inbox');

  await h.emitBatch({ ok: false, error: { reason: 'expired' } });

  assert.match(h.el('mail-list').textContent, /истёк/);
  assert.equal(h.el('inbox-error').hidden, true, 'у истечения свой экран с кнопкой');
});

test('сессия от неизвестного сервиса не запускает поллинг и объясняет, что делать', async () => {
  const h = await loadPopup({ session: { address: 'ivan@ghost.test', provider: 'ghostmail', touchedAt: Date.now() } });

  await h.clickTab('inbox');

  assert.deepEqual(h.unhandled, [], 'неизвестный провайдер не должен ронять промис');
  assert.equal(h.state.pollStarts, 0, 'поллить нечем: адаптера нет');
  assert.equal(h.activeIntervals(), 0, 'TTL неизвестен — таймер не нужен');
  assert.match(h.el('mail-list').textContent, /неизвестн/i);
  assert.match(h.el('mail-list').textContent, /новый адрес/i, 'нужен выход: взять новый адрес');
});

test('«Обновить» с неизвестным провайдером не роняет промис', async () => {
  const h = await loadPopup({ session: { address: 'ivan@ghost.test', provider: 'ghostmail', touchedAt: Date.now() } });
  await h.clickTab('inbox');

  await h.click(h.el('btn-refresh-inbox'));

  assert.deepEqual(h.unhandled, []);
  assert.match(h.el('mail-list').textContent, /неизвестн/i);
});

test('«Обновить» с упавшим адаптером показывает строку состояния', async () => {
  const h = await loadPopup();
  await h.clickTab('inbox');
  h.adapter.list = async () => { const e = new Error('down'); e.reason = 'network'; throw e; };

  await h.click(h.el('btn-refresh-inbox'));

  assert.deepEqual(h.unhandled, []);
  assert.equal(h.el('inbox-error').hidden, false);
  assert.match(h.el('inbox-error').textContent, /связ/i);
});
