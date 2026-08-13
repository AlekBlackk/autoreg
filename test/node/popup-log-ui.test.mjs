// test/node/popup-log-ui.test.mjs
//
// Вкладка «Журнал» в Operational Grid: пароль скрыт до явного раскрытия, явные
// кнопки вместо чипов/Alt+клика, видимый счётчик результатов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPopup } from './_popupDom.mjs';

const entry = {
  id: 'e1', host: 'shop.test', url: 'https://shop.test/reg', name: 'Иван Иванов',
  username: 'ivan', email: 'ivan@dust.test', provider: 'dustmail', password: 'secret', note: '', createdAt: Date.now()
};

function button(row, label) {
  const queue = [...row.children];
  while (queue.length) {
    const node = queue.shift();
    if (node.tagName === 'BUTTON' && (node.textContent === label || node.getAttribute('aria-label') === label)) return node;
    queue.push(...(node.children || []));
  }
  return null;
}

test('журнал keeps password hidden until explicit reveal', async () => {
  const h = await loadPopup({ entries: [entry] });
  await h.clickTab('log');
  const row = h.logRows()[0];
  assert.doesNotMatch(row.textContent, /secret/);
  const reveal = button(row, 'Показать пароль');
  assert.ok(reveal);
  await h.click(reveal);
  assert.match(row.textContent, /secret/);
  assert.equal(reveal.getAttribute('aria-pressed'), 'true');
});

test('copy set emits a readable account block', async () => {
  const h = await loadPopup({ entries: [entry] });
  await h.clickTab('log');
  await h.click(button(h.logRows()[0], 'Копировать набор'));
  assert.deepEqual(h.state.clipboardWrites, ['Сайт: shop.test\nИмя: Иван Иванов\nЛогин: ivan\nПочта: ivan@dust.test\nПароль: secret']);
});

test('журнал reports result count', async () => {
  const h = await loadPopup({ entries: [entry, { ...entry, id: 'e2', host: 'forum.test' }] });
  await h.clickTab('log');
  assert.equal(h.el('log-result-count').textContent, 'Записей: 2');
});
