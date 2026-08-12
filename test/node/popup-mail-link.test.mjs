// test/node/popup-mail-link.test.mjs
//
// Ссылка из письма — недоверенный ввод. Тесты фиксируют два требования:
//   1) человек видит перед кликом ПОЛНЫЙ URL, а не только хост (хост example.com
//      ничего не говорит про /redirect?to=evil), и открывается ровно тот URL,
//      по которому он кликнул;
//   2) непригодный для chrome.tabs.create адрес (относительный, не-http) в UI
//      не появляется вообще — вместо падения на клике.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPopup } from './_popupDom.mjs';

// Хост безобидный, назначение — нет: ровно тот случай, который прятал показ одного хоста.
const LINK = 'https://example.com/redirect?to=https://evil.tld/steal';

function descendants(el) {
  const out = [];
  for (const c of el.children) { out.push(c); if (c.children) out.push(...descendants(c)); }
  return out;
}

function buttons(el) {
  return descendants(el).filter(n => n.tagName === 'BUTTON');
}

// Элемент, который показывает URL целиком, — единственный законный триггер открытия.
function urlTargets(el, url) {
  return descendants(el).filter(n => n.textContent === url);
}

async function openMailWith(extracted) {
  const h = await loadPopup({ extract: () => extracted });
  await h.clickTab('inbox');
  await h.emitMail([{ id: 'm1', from: 'noreply@site.test', subject: 'Подтвердите', intro: '', date: Date.now() }]);
  await h.click(h.mailRows()[0]);
  return h;
}

test('ссылка из письма показана полным URL, а не одним хостом', async () => {
  const h = await openMailWith({ code: null, link: LINK, confidence: 'high' });

  assert.equal(h.el('mail-code').hidden, false);
  assert.ok(
    h.el('mail-code').textContent.includes(LINK),
    `в #mail-code должен быть весь URL, а не хост; сейчас: ${h.el('mail-code').textContent}`
  );
});

test('у показанного URL есть title с полным адресом — обрезка визуальная, не смысловая', async () => {
  const h = await openMailWith({ code: null, link: LINK, confidence: 'high' });

  const [target] = urlTargets(h.el('mail-code'), LINK);
  assert.ok(target, 'должен быть элемент, чей текст — весь URL');
  assert.equal(target.title, LINK);
});

test('открывается ровно тот URL, по которому кликнули', async () => {
  const h = await openMailWith({ code: null, link: LINK, confidence: 'high' });

  const [target] = urlTargets(h.el('mail-code'), LINK);
  await h.click(target);

  assert.deepEqual(h.state.createdTabs, [{ url: LINK }]);
});

test('кнопки, открывающей ссылку без показа URL, в письме нет', async () => {
  const h = await openMailWith({ code: null, link: LINK, confidence: 'high' });

  for (const b of buttons(h.el('mail-code'))) {
    if (b.textContent === LINK) continue;
    await h.click(b);
  }
  assert.deepEqual(h.state.createdTabs, [], 'открывать ссылку должен только элемент с видимым URL');
});

test('относительная ссылка не рендерится и не уходит в tabs.create', async () => {
  const h = await openMailWith({ code: null, link: '/confirm?token=abc123', confidence: 'high' });

  assert.equal(h.el('mail-code').hidden, true, 'нечего показывать: адрес непригоден для открытия');
  for (const b of buttons(h.el('mail-code'))) await h.click(b);
  assert.deepEqual(h.state.createdTabs, []);
});

test('не-http схема не рендерится и не уходит в tabs.create', async () => {
  const h = await openMailWith({ code: null, link: 'javascript:confirmAccount()', confidence: 'high' });

  assert.equal(h.el('mail-code').hidden, true);
  for (const b of buttons(h.el('mail-code'))) await h.click(b);
  assert.deepEqual(h.state.createdTabs, []);
});

test('код письма показывается, даже если ссылка отброшена', async () => {
  const h = await openMailWith({ code: '483920', link: 'file:///etc/passwd', confidence: 'high' });

  assert.equal(h.el('mail-code').hidden, false);
  assert.match(h.el('mail-code').textContent, /483920/);
  assert.ok(!h.el('mail-code').textContent.includes('file:'), 'отброшенный адрес не должен светиться в UI');
  for (const b of buttons(h.el('mail-code'))) {
    if (b.textContent === 'Копировать') continue;
    await h.click(b);
  }
  assert.deepEqual(h.state.createdTabs, [], 'кроме «Копировать» открывать нечего');
});
