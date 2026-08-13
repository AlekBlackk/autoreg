// test/node/popup-inbox-view.test.mjs
//
// Переключение «Ящика» между списком писем и открытым письмом:
//   1) открытие письма прячет список, показывает письмо; «Назад» — обратно;
//   2) повторный вход на вкладку и дохлые экраны (истёк/неизвестный провайдер)
//      всегда возвращают список, даже если письмо было открыто;
//   3) чип из splitLinkChips кликается и открывает именно свой url, а не текст лейбла.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPopup } from './_popupDom.mjs';

function descendants(el) {
  const out = [];
  for (const c of el.children) { out.push(c); if (c.children) out.push(...descendants(c)); }
  return out;
}
function buttons(el) { return descendants(el).filter(n => n.tagName === 'BUTTON'); }

test('открытие письма прячет список и показывает mail-view', async () => {
  const h = await loadPopup();
  await h.clickTab('inbox');
  await h.emitMail([{ id: 'm1', from: 'noreply@site.test', subject: 'Код', intro: '', date: Date.now() }]);

  assert.equal(h.el('mail-list').hidden, false);
  assert.equal(h.el('mail-view').hidden, true);

  await h.click(h.mailRows()[0]);

  assert.equal(h.el('mail-list').hidden, true, 'список прячется при открытии письма');
  assert.equal(h.el('mail-view').hidden, false, 'mail-view показывается');
  assert.equal(h.el('mail-body').hidden, false);
});

test('«Назад к списку» возвращает список и прячет mail-view', async () => {
  const h = await loadPopup();
  await h.clickTab('inbox');
  await h.emitMail([{ id: 'm1', from: 'noreply@site.test', subject: 'Код', intro: '', date: Date.now() }]);
  await h.click(h.mailRows()[0]);
  assert.equal(h.el('mail-view').hidden, false);

  await h.click(h.el('btn-mail-back'));

  assert.equal(h.el('mail-view').hidden, true);
  assert.equal(h.el('mail-list').hidden, false);
});

test('повторный вход на вкладку «Ящик» после открытого письма показывает список', async () => {
  const h = await loadPopup({ panel: true });
  await h.clickTab('inbox');
  await h.emitMail([{ id: 'm1', from: 'noreply@site.test', subject: 'Код', intro: '', date: Date.now() }]);
  await h.click(h.mailRows()[0]);
  assert.equal(h.el('mail-view').hidden, false);

  await h.clickTab('log');
  await h.clickTab('inbox');

  assert.equal(h.el('mail-view').hidden, true, 'новый заход на вкладку не должен показывать старое письмо');
  assert.equal(h.el('mail-list').hidden, false);
});

test('истёкший ящик, обнаруженный пока письмо открыто, возвращает список поверх письма', async () => {
  const h = await loadPopup();
  await h.clickTab('inbox');
  await h.emitMail([{ id: 'm1', from: 'noreply@site.test', subject: 'Код', intro: '', date: Date.now() }]);
  await h.click(h.mailRows()[0]);
  assert.equal(h.el('mail-view').hidden, false, 'письмо открыто перед истечением ящика');

  const err = new Error('gone'); err.reason = 'expired';
  await h.emitBatch({ ok: false, error: err });

  assert.equal(h.el('mail-view').hidden, true, 'дохлый экран обязан перекрыть открытое письмо');
  assert.equal(h.el('mail-list').hidden, false);
  assert.match(h.el('mail-list').textContent, /истёк/);
});

test('клик по чипу из splitLinkChips открывает url чипа, а не текст лейбла', async () => {
  const CHIP_URL = 'https://example.com/redirect?to=marketing';
  const h = await loadPopup({
    splitLinkChips: (text) => [
      { type: 'text', value: 'привет ' },
      { type: 'link', url: CHIP_URL, label: 'LinkedIn' }
    ]
  });
  await h.clickTab('inbox');
  await h.emitMail([{ id: 'm1', from: 'noreply@site.test', subject: 'Рассылка', intro: '', date: Date.now() }]);
  await h.click(h.mailRows()[0]);

  const chip = buttons(h.el('mail-body')).find(b => b.textContent === 'LinkedIn');
  assert.ok(chip, 'чип с лейблом LinkedIn должен быть отрисован в mail-body');

  await h.click(chip);

  assert.deepEqual(h.state.createdTabs, [{ url: CHIP_URL }]);
});

test('чип с не-http(s) url из splitLinkChips не рендерится кликабельным и не открывается', async () => {
  const h = await loadPopup({
    splitLinkChips: () => [{ type: 'link', url: 'javascript:alert(1)', label: 'плохая ссылка' }]
  });
  await h.clickTab('inbox');
  await h.emitMail([{ id: 'm1', from: 'noreply@site.test', subject: 'x', intro: '', date: Date.now() }]);
  await h.click(h.mailRows()[0]);

  for (const b of buttons(h.el('mail-body'))) await h.click(b);

  assert.deepEqual(h.state.createdTabs, [], 'непригодная схема не должна уходить в chrome.tabs.create');
  assert.ok(h.el('mail-body').textContent.includes('javascript:alert(1)'),
    'отброшенная ссылка остаётся видимой как текст, а не пропадает молча');
});
