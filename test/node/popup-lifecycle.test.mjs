// test/node/popup-lifecycle.test.mjs
//
// Поведенческие тесты popup.js на фейковом DOM (test/node/_popupDom.mjs):
//   1) утечка ttlTimer при переключении вкладок в режиме панели;
//   2) отсутствие обработки ошибок в openMail и в удалении записи журнала.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPopup } from './_popupDom.mjs';

test('в панели уход с «Ящика» гасит TTL-таймер, но не поллинг', async () => {
  const h = await loadPopup({ panel: true });

  await h.clickTab('inbox');
  assert.equal(h.activeIntervals(), 1, 'вход на «Ящик» должен запустить один TTL-таймер');
  assert.equal(h.state.pollStarts, 1);

  await h.clickTab('log');
  assert.equal(h.activeIntervals(), 0, 'TTL-таймер обязан гаситься при уходе с «Ящика» и в панели');
  assert.equal(h.state.pollStops, 0, 'в панели поллинг живёт, пока панель открыта');

  await h.clickTab('inbox');
  assert.equal(h.activeIntervals(), 1, 'повторный вход не должен плодить второй TTL-таймер');

  await h.clickTab('log');
  await h.clickTab('inbox');
  await h.clickTab('log');
  await h.clickTab('inbox');
  assert.equal(h.activeIntervals(), 1, 'сколько бы раз ни ходили Ящик→Журнал→Ящик, тикает ровно один таймер');
});

test('в попапе уход с «Ящика» гасит и TTL-таймер, и поллинг', async () => {
  const h = await loadPopup({ panel: false });

  await h.clickTab('inbox');
  assert.equal(h.activeIntervals(), 1);

  await h.clickTab('log');
  assert.equal(h.activeIntervals(), 0);
  assert.equal(h.state.pollStops, 1, 'в попапе поллинг останавливается при уходе с вкладки');
});

test('повторный клик по уже активному «Ящику» не добавляет второй таймер', async () => {
  const h = await loadPopup({ panel: true });

  await h.clickTab('inbox');
  await h.clickTab('inbox');
  await h.clickTab('inbox');
  assert.equal(h.activeIntervals(), 1);
});

test('без TTL у провайдера таймер вообще не создаётся', async () => {
  const h = await loadPopup({ panel: true });
  h.adapter.sessionTtlMs = 0;

  await h.clickTab('inbox');
  assert.equal(h.activeIntervals(), 0);
});

test('упавшее чтение письма показывает ошибку, а не роняет промис', async () => {
  const h = await loadPopup();
  await h.clickTab('inbox');
  await h.emitMail([{ id: 'm1', from: 'noreply@site.test', subject: 'Код', intro: 'ваш код', date: Date.now() }]);

  h.adapter.read = async () => { throw new Error('network down'); };

  const [row] = h.mailRows();
  assert.ok(row, 'письмо должно быть отрисовано строкой');
  await h.click(row);

  assert.deepEqual(h.unhandled, [], 'ошибка чтения не должна становиться unhandled rejection');
  assert.equal(h.el('mail-body').hidden, true, 'тело письма не открывается, если чтение не удалось');
  assert.match(h.toastText(), /Не удалось открыть письмо/, 'пользователю нужна обратная связь');
});

test('истёкший ящик при открытии письма показывает экран истечения', async () => {
  const h = await loadPopup();
  await h.clickTab('inbox');
  await h.emitMail([{ id: 'm1', from: 'noreply@site.test', subject: 'Код', intro: 'ваш код', date: Date.now() }]);

  h.adapter.read = async () => { const e = new Error('gone'); e.reason = 'expired'; throw e; };

  await h.click(h.mailRows()[0]);

  assert.deepEqual(h.unhandled, []);
  assert.match(h.el('mail-list').textContent, /истёк/, 'должен появиться экран «ящик истёк»');
  assert.equal(h.el('mail-body').hidden, true);
});

test('успешное открытие письма показывает текст', async () => {
  const h = await loadPopup();
  await h.clickTab('inbox');
  await h.emitMail([{ id: 'm1', from: 'noreply@site.test', subject: 'Код', intro: 'ваш код', date: Date.now() }]);

  await h.click(h.mailRows()[0]);

  assert.equal(h.el('mail-body').hidden, false);
  assert.match(h.el('mail-body').textContent, /привет/);
});

const ENTRY = {
  id: 'e1', host: 'shop.test', url: 'https://shop.test/reg', name: 'Иван Иванов',
  username: 'ivan', email: 'ivan@dust.test', provider: 'dustmail', password: 'pass1234',
  note: '', createdAt: Date.now()
};

function delButton(row) { return row.children[row.children.length - 1]; }

// Удаление записи двухшаговое: кнопка ✕ открывает инлайн-плашку подтверждения,
// удаление происходит только по «Удалить» в ней.
async function askDelete(h, row) {
  await h.click(delButton(row));
  const [bar] = h.confirmBars();
  assert.ok(bar, 'кнопка ✕ должна открыть плашку подтверждения');
  return bar;
}

async function deleteRow(h, row) {
  const bar = await askDelete(h, row);
  await h.click(h.barButton(bar, 'Удалить'));
}

test('удаление записи спрашивает подтверждение инлайн, а не нативным confirm()', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }] });

  await h.clickTab('log');
  const bar = await askDelete(h, h.logRows()[0]);

  assert.equal(h.state.confirmCalls, 0, 'нативный confirm() в попапе расширения недопустим');
  assert.equal(h.state.removeEntryCalls, 0, 'до подтверждения ничего не удаляется');
  assert.match(bar.textContent, /Удалить запись\?/);
  assert.ok(h.barButton(bar, 'Удалить'), 'в плашке нужна кнопка подтверждения');
  assert.ok(h.barButton(bar, 'Отмена'), 'в плашке нужна кнопка отказа');
});

test('отказ от подтверждения ничего не удаляет и убирает плашку', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }] });

  await h.clickTab('log');
  const [row] = h.logRows();
  const bar = await askDelete(h, row);
  await h.click(h.barButton(bar, 'Отмена'));

  assert.equal(h.state.removeEntryCalls, 0);
  assert.equal(row.hidden, false);
  assert.equal(h.confirmBars().length, 0, 'после отказа плашка обязана исчезнуть');
});

test('повторный ✕ не плодит вторую плашку подтверждения', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }, { ...ENTRY, id: 'e2' }] });

  await h.clickTab('log');
  const rows = h.logRows();
  await h.click(delButton(rows[0]));
  await h.click(delButton(rows[1]));

  assert.equal(h.confirmBars().length, 1, 'одновременно живёт максимум одна плашка подтверждения');
});

test('неудачное удаление записи оставляет строку на месте и сообщает об этом', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }] });
  h.store.removeEntry = async () => { throw new Error('журнал заблокирован'); };

  await h.clickTab('log');
  const [row] = h.logRows();
  assert.ok(row, 'запись журнала должна быть отрисована');

  await deleteRow(h, row);

  assert.deepEqual(h.unhandled, [], 'отказ removeEntry не должен становиться unhandled rejection');
  assert.equal(row.hidden, false, 'строка не должна исчезать, если запись не удалилась');
  assert.match(h.toastText(), /Не удалось удалить/, 'пользователю нужна обратная связь');

  // Запись обязана остаться и в модели, а не только на экране: перерисовка по фильтру
  // берёт данные из logAllEntries/logFiltered.
  await h.el('log-search').dispatch('input', { target: h.el('log-search') });
  assert.equal(h.logRows().length, 1, 'запись должна остаться в журнале после неудачного удаления');
});

test('успешное удаление скрывает строку и предлагает отмену', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }] });

  await h.clickTab('log');
  const [row] = h.logRows();
  await deleteRow(h, row);

  assert.deepEqual(h.unhandled, []);
  assert.equal(h.state.removeEntryCalls, 1);
  assert.equal(row.hidden, true);
  assert.equal(h.confirmBars().length, 0, 'плашка подтверждения уходит вместе с удалением');
  assert.equal(h.undoBars().length, 1, 'должна появиться панель отмены');
  assert.match(h.el('log-list').textContent, /Запись удалена/);
});

test('два удаления подряд оставляют ровно одну живую плашку отмены', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }, { ...ENTRY, id: 'e2', username: 'petr' }] });

  await h.clickTab('log');
  const rows = h.logRows();
  await deleteRow(h, rows[0]);
  await deleteRow(h, rows[1]);

  assert.equal(h.state.removeEntryCalls, 2);
  assert.equal(h.undoBars().length, 1, 'первая плашка отмены обязана уйти из DOM, а не только потерять таймер');

  // Оставшаяся плашка отменяет своё удаление, а не чужое, и после этого исчезает.
  const [bar] = h.undoBars();
  await h.click(h.barButton(bar, 'Отменить'));

  assert.deepEqual(h.unhandled, []);
  assert.equal(h.state.addEntryCalls, 1, 'отмена возвращает ровно одну запись');
  assert.equal(h.undoBars().length, 0, 'после отмены плашка исчезает');
});

test('истёкший таймер убирает плашку отмены', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }] });

  await h.clickTab('log');
  await deleteRow(h, h.logRows()[0]);
  assert.equal(h.undoBars().length, 1);

  h.runTimeouts();
  assert.equal(h.undoBars().length, 0, 'по истечении таймера плашка обязана исчезнуть');
});

test('провалившаяся отмена сообщает тостом, а не unhandled rejection', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }] });
  await h.clickTab('log');
  await deleteRow(h, h.logRows()[0]);

  h.store.addEntry = async () => { throw new Error('журнал заблокирован'); };
  await h.click(h.barButton(h.undoBars()[0], 'Отменить'));

  assert.deepEqual(h.unhandled, [], 'отказ addEntry не должен становиться unhandled rejection');
  assert.match(h.toastText(), /Не удалось восстановить/, 'пользователю нужна обратная связь');
});

test('очистка журнала подтверждается инлайн-формой, а не нативным confirm()', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }] });

  await h.clickTab('settings');
  await h.click(h.el('set-clear-entries'));

  assert.equal(h.state.confirmCalls, 0, 'нативный confirm() в попапе расширения недопустим');
  assert.equal(h.state.clearEntriesCalls, 0, 'до подтверждения журнал не трогаем');
  assert.equal(h.el('set-clear-form').hidden, false, 'должна раскрыться инлайн-форма подтверждения');

  await h.click(h.el('set-clear-apply'));

  assert.deepEqual(h.unhandled, []);
  assert.equal(h.state.clearEntriesCalls, 1);
  assert.equal(h.el('set-clear-form').hidden, true, 'после очистки форма закрывается');
});

test('отмена очистки журнала не трогает записи', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }] });

  await h.clickTab('settings');
  await h.click(h.el('set-clear-entries'));
  await h.click(h.el('set-clear-cancel'));

  assert.equal(h.state.clearEntriesCalls, 0);
  assert.equal(h.el('set-clear-form').hidden, true);
});

test('заблокированный журнал при очистке сообщает тостом', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }] });
  h.store.clearEntries = async () => { throw new Error('журнал заблокирован'); };

  await h.clickTab('settings');
  await h.click(h.el('set-clear-entries'));
  await h.click(h.el('set-clear-apply'));

  assert.deepEqual(h.unhandled, []);
  assert.match(h.toastText(), /заблокирован/);
  assert.equal(h.el('set-clear-form').hidden, true);
});

// Разблокировка: «Неверный пароль» — единственный диагноз, который popup ставил на
// ЛЮБУЮ ошибку unlock. С параметрами KDF внутри блоба (crypto.js) появился второй,
// принципиально другой случай: блоб описан параметрами, которые мы не принимаем.
// Человек, которому на это ответили «Неверный пароль», будет перебирать верный
// пароль вместо того, чтобы понять, что журналу нужно другое вмешательство.
test('неверный пароль при разблокировке остаётся «Неверный пароль»', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }] });
  h.store.unlock = async () => { throw new Error('неверный пароль'); };

  await h.clickTab('log');
  await h.click(h.el('log-unlock-btn'));

  assert.deepEqual(h.unhandled, []);
  assert.equal(h.el('log-unlock-error').hidden, false);
  assert.equal(h.el('log-unlock-error').textContent, 'Неверный пароль');
});

test('техническая ошибка разблокировки не маскируется под неверный пароль', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }] });
  h.store.unlock = async () => { throw new Error('неподдерживаемые параметры KDF в зашифрованном журнале'); };

  await h.clickTab('log');
  await h.click(h.el('log-unlock-btn'));

  assert.deepEqual(h.unhandled, []);
  assert.equal(h.el('log-unlock-error').hidden, false);
  const text = h.el('log-unlock-error').textContent;
  assert.match(text, /KDF/, 'настоящая причина обязана дойти до пользователя');
  assert.doesNotMatch(text, /^Неверный пароль$/);
});

test('техническая ошибка отключения защиты не маскируется под неверный пароль', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }] });
  h.store.disableLock = async () => { throw new Error('неподдерживаемые параметры KDF в зашифрованном журнале'); };

  await h.clickTab('settings');
  h.el('set-lockEnabled').checked = false;
  await h.el('set-lockEnabled').dispatch('change', { target: h.el('set-lockEnabled') });
  await h.click(h.el('set-disable-lock-apply'));

  assert.deepEqual(h.unhandled, []);
  assert.equal(h.el('set-disable-lock-error').hidden, false);
  const text = h.el('set-disable-lock-error').textContent;
  assert.match(text, /KDF/);
  assert.doesNotMatch(text, /^Неверный пароль/);
});

test('неверный пароль при отключении защиты оставляет защиту включённой', async () => {
  const h = await loadPopup({ entries: [{ ...ENTRY }] });
  h.store.disableLock = async () => { throw new Error('неверный пароль'); };

  await h.clickTab('settings');
  h.el('set-lockEnabled').checked = false;
  await h.el('set-lockEnabled').dispatch('change', { target: h.el('set-lockEnabled') });
  await h.click(h.el('set-disable-lock-apply'));

  assert.deepEqual(h.unhandled, []);
  assert.match(h.el('set-disable-lock-error').textContent, /Неверный пароль/);
  assert.equal(h.el('set-disable-lock-form').hidden, false, 'форма остаётся для повторной попытки');
});
