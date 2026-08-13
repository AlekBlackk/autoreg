// popup/log.js
//
// Вкладка «Журнал»: поиск, порционный рендер, удаление с отменой, разблокировка,
// экспорт в JSON/CSV. Регистрируется в popup/core.js через onEnter.
//
// downloadJson экспортируется на RegLog.popup.log: popup/core.js вызывает его из
// кнопки «Выгрузить резервную копию» на баннере несовместимой схемы (renderSchemaBanner),
// который живёт вне вкладки «Журнал», но переиспользует тот же механизм скачивания.
(function () {
  'use strict';

  const P = RegLog.popup;
  const LOG = P.log = {};

  let logAllEntries = [];
  let logFiltered = [];
  let logRenderedCount = 0;
  const LOG_PAGE = 100;

  async function initLogTab() {
    const entries = await RegLog.store.getEntries();
    if (entries && entries.__locked) {
      document.getElementById('log-unlock').hidden = false;
      document.getElementById('log-list').textContent = '';
      document.getElementById('log-more').hidden = true;
      return;
    }
    document.getElementById('log-unlock').hidden = true;
    logAllEntries = entries;
    applyLogFilter(document.getElementById('log-search').value);
  }

  function applyLogFilter(query) {
    // Перерисовка стирает #log-list целиком, унося с ним транзиентные плашки, поэтому их
    // учёт закрывается здесь: иначе таймер отмены тикал бы по осиротевшему узлу, а
    // await askInline() не дождался бы ответа никогда.
    closePendingConfirm();
    dismissPendingUndo();
    const q = query.trim().toLowerCase();
    logFiltered = !q ? logAllEntries : logAllEntries.filter(e =>
      (e.host || '').toLowerCase().includes(q) || (e.username || '').toLowerCase().includes(q) ||
      (e.email || '').toLowerCase().includes(q) || (e.note || '').toLowerCase().includes(q)
    );
    logRenderedCount = 0;
    document.getElementById('log-list').textContent = '';
    renderMoreLogEntries();
  }

  function renderMoreLogEntries() {
    const list = document.getElementById('log-list');
    if (logFiltered.length === 0 && logRenderedCount === 0) {
      const p = document.createElement('p');
      p.textContent = 'Пока пусто. Сгенерируй комплект на вкладке «Новый» и заполни им форму.';
      list.appendChild(p);
    }
    const slice = logFiltered.slice(logRenderedCount, logRenderedCount + LOG_PAGE);
    for (const entry of slice) list.appendChild(renderLogRow(entry));
    logRenderedCount += slice.length;
    document.getElementById('log-more').hidden = logRenderedCount >= logFiltered.length;
  }

  document.getElementById('log-search').addEventListener('input', (e) => applyLogFilter(e.target.value));
  document.getElementById('log-more').addEventListener('click', renderMoreLogEntries);

  function renderLogRow(entry) {
    const row = document.createElement('div');
    row.className = 'log-row';
    const domain = document.createElement('span'); domain.className = 'mono'; domain.textContent = entry.host;
    const date = document.createElement('span'); date.className = 'mono'; date.textContent = formatDateDDMMYY(entry.createdAt);
    const provider = document.createElement('span'); provider.textContent = P.labelFor(entry.provider);

    const userChip = makeChip('логин', entry.username);
    const mailChip = makeChip('почта', entry.email);
    const passChip = makeMaskedPassChip(entry.password);

    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.setAttribute('aria-label', 'Удалить запись');
    delBtn.textContent = '✕';
    // Промис намеренно не возвращается наружу: confirmDelete ждёт ответа в инлайн-плашке
    // и до клика пользователя не завершается. Все отказы store внутри обработаны.
    delBtn.addEventListener('click', () => { confirmDelete(entry, row); });

    row.append(domain, date, provider, userChip, mailChip, passChip, delBtn);
    return row;
  }

  function formatDateDDMMYY(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
  }

  function makeChip(label, value) {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'chip'; chip.textContent = label;
    chip.addEventListener('click', async () => { await P.copyText(value || ''); P.showToast('Скопировано'); });
    return chip;
  }

  // Маскированный чип пароля: обычный клик/Enter копирует пароль, Alt+клик/Alt+Enter
  // раскрывает его текстом на 5 секунд. Один обработчик на событие с веткой по altKey —
  // чтобы клик с зажатым Alt не запускал одновременно и копирование, и раскрытие.
  function makeMaskedPassChip(password) {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'chip mono'; chip.textContent = '••••••••';
    let revealTimer = null;
    function reveal() {
      chip.textContent = password;
      clearTimeout(revealTimer);
      revealTimer = setTimeout(() => { chip.textContent = '••••••••'; }, 5000);
    }
    chip.addEventListener('click', async (e) => {
      if (e.altKey) { reveal(); return; }
      await P.copyText(password || ''); P.showToast('Скопировано');
    });
    chip.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && e.altKey) { e.preventDefault(); reveal(); }
      else if (e.key === 'Enter') { e.preventDefault(); await P.copyText(password || ''); P.showToast('Скопировано'); }
    });
    return chip;
  }

  let pendingUndo = null;
  let pendingConfirm = null;

  // Инлайн-подтверждение вместо confirm(). Нативный диалог в попапе расширения может
  // уехать вместе с самим попапом при потере фокуса: пользователь нажал «ОК», а
  // результата не увидел — по этой же причине prompt()/alert() в lock-флоу заменены
  // на #set-disable-lock-form. Плашка встаёт в поток страницы под своей строкой,
  // поэтому подтверждение всегда видно вместе с тем, что подтверждаешь.
  //
  // Одновременно открыта максимум одна плашка: новая просьба закрывает предыдущую,
  // резолвя её промис как отказ. Иначе в DOM копились бы мёртвые плашки, а их
  // await'ы висели бы вечно.
  function askInline(anchor, message, confirmLabel) {
    closePendingConfirm();
    return new Promise(resolve => {
      const bar = document.createElement('div');
      bar.className = 'confirm-bar';
      bar.setAttribute('role', 'alert');
      const text = document.createElement('span');
      text.textContent = message + ' ';
      const yes = document.createElement('button');
      yes.type = 'button'; yes.className = 'danger'; yes.textContent = confirmLabel;
      const no = document.createElement('button');
      no.type = 'button'; no.textContent = 'Отмена';

      let done = false;
      const finish = (answer) => {
        if (done) return; // защита от второго клика по уже отвеченной плашке
        done = true;
        if (pendingConfirm && pendingConfirm.bar === bar) pendingConfirm = null;
        bar.remove();
        resolve(answer);
      };
      yes.addEventListener('click', () => finish(true));
      no.addEventListener('click', () => finish(false));

      bar.append(text, yes, no);
      anchor.after(bar);
      pendingConfirm = { bar, cancel: () => finish(false) };
      if (typeof yes.focus === 'function') yes.focus();
    });
  }

  function closePendingConfirm() {
    if (pendingConfirm) pendingConfirm.cancel();
  }

  // Снимает плашку отмены целиком — и узел, и таймер. Раньше гасился только таймер,
  // и после двух удалений подряд первая плашка оставалась в DOM навсегда.
  function dismissPendingUndo() {
    if (!pendingUndo) return;
    clearTimeout(pendingUndo.timer);
    pendingUndo.bar.remove();
    pendingUndo = null;
  }

  async function confirmDelete(entry, row) {
    if (!(await askInline(row, 'Удалить запись?', 'Удалить'))) return;
    // removeEntry обязателен к await'у ДО правки logAllEntries/logFiltered и скрытия
    // строки: при залоченном журнале он реджектится, а раньше строка уже исчезала из
    // DOM и запись — из модели, то есть на экране «удалено», а на диске нет.
    try {
      await RegLog.store.removeEntry(entry.id);
    } catch (e) {
      P.showToast('Не удалось удалить запись — журнал заблокирован');
      return;
    }
    logAllEntries = logAllEntries.filter(e => e.id !== entry.id);
    logFiltered = logFiltered.filter(e => e.id !== entry.id);
    row.hidden = true;

    dismissPendingUndo();
    const undoBar = document.createElement('div');
    undoBar.className = 'undo-bar';
    undoBar.textContent = 'Запись удалена. ';
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button'; undoBtn.textContent = 'Отменить';
    undoBar.appendChild(undoBtn);
    row.after(undoBar);

    const timer = setTimeout(() => {
      undoBar.remove();
      if (pendingUndo && pendingUndo.bar === undoBar) pendingUndo = null;
    }, 5000);
    pendingUndo = { bar: undoBar, timer };

    let undone = false;
    undoBtn.addEventListener('click', async () => {
      // Своя плашка и свой таймер — из замыкания, а не из pendingUndo: к моменту клика
      // pendingUndo может описывать уже другое удаление, и чтение оттуда гасило бы
      // чужой таймер, оставляя чужую плашку висеть навсегда.
      if (undone) return;
      undone = true;
      clearTimeout(timer);
      if (pendingUndo && pendingUndo.bar === undoBar) pendingUndo = null;
      undoBar.remove();
      try {
        await RegLog.store.addEntry(entry);
      } catch (e) {
        P.showToast('Не удалось восстановить запись — журнал заблокирован');
        return;
      }
      await initLogTab();
    });
  }

  document.getElementById('btn-export-json').addEventListener('click', () => openExportModal('json'));
  document.getElementById('btn-export-csv').addEventListener('click', () => openExportModal('csv'));

  let pendingExportKind = null;
  function openExportModal(kind) {
    pendingExportKind = kind;
    document.getElementById('export-modal').hidden = false;
  }
  document.getElementById('export-cancel').addEventListener('click', () => { document.getElementById('export-modal').hidden = true; });
  document.getElementById('export-confirm').addEventListener('click', async () => {
    document.getElementById('export-modal').hidden = true;
    const entries = await RegLog.store.getEntries();
    if (entries && entries.__locked) {
      P.showToast('Разблокируйте журнал перед экспортом');
      return;
    }
    if (pendingExportKind === 'json') downloadJson(entries); else downloadCsv(entries);
  });

  function todayStamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadJson(entries) {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    triggerDownload(blob, `reglog-${todayStamp()}.json`);
  }

  // Экранирование ячейки CSV: оборачивает в кавычки, удваивает внутренние кавычки и
  // добавляет ведущий апостроф перед формуло-опасными символами (=+-@ и табуляция/CR),
  // чтобы Excel/Google Sheets не интерпретировали значение как формулу при открытии файла.
  function csvEscapeCell(value) {
    let s = value == null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    s = s.replace(/"/g, '""');
    return `"${s}"`;
  }

  function downloadCsv(entries) {
    const headers = ['host', 'url', 'name', 'username', 'email', 'provider', 'password', 'note', 'createdAt'];
    const lines = [headers.join(',')];
    for (const e of entries) {
      const row = headers.map(h => csvEscapeCell(h === 'createdAt' ? formatDateDDMMYY(e.createdAt) : e[h]));
      lines.push(row.join(','));
    }
    const csv = '﻿' + lines.join('\r\n') + '\r\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, `reglog-${todayStamp()}.csv`);
  }

  document.getElementById('log-unlock-btn').addEventListener('click', async () => {
    const pass = document.getElementById('log-unlock-pass').value;
    const errEl = document.getElementById('log-unlock-error');
    errEl.hidden = true;
    try {
      await RegLog.store.unlock(pass);
      document.getElementById('log-unlock-pass').value = '';
      initLogTab();
    } catch (e) {
      errEl.textContent = P.isWrongPassword(e) ? 'Неверный пароль' : `Не удалось разблокировать: ${P.errText(e)}`;
      errEl.hidden = false;
    }
  });

  P.onEnter('log', initLogTab);

  LOG.downloadJson = downloadJson;

})();
