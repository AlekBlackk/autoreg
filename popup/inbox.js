// popup/inbox.js
//
// Вкладка «Ящик»: адрес, TTL-отсчёт, поллинг входящих, извлечение кода/ссылки
// подтверждения. Регистрируется в popup/core.js через onEnter/onLeave.
(function () {
  'use strict';

  const P = RegLog.popup;

  let stopPolling = null;
  let ttlTimer = null;
  let knownMailIds = null;
  let seeded = false;
  let unreadCount = 0;
  let inboxKey = null;
  let inboxFailStreak = 0;

  // Единственная точка, где решается видимость «список vs письмо» — было 5 отдельных
  // мест, синхронизировать руками, и один уже расходился (see git history).
  function showMailList() {
    document.getElementById('mail-view').hidden = true;
    document.getElementById('mail-list').hidden = false;
    document.getElementById('btn-refresh-inbox').hidden = false;
  }

  function showMailView() {
    document.getElementById('mail-list').hidden = true;
    document.getElementById('btn-refresh-inbox').hidden = true;
    document.getElementById('mail-view').hidden = false;
  }

  async function initInboxTab() {
    // Вход на вкладку не всегда идёт через «уход с вкладки» (повторный клик по уже
    // активному «Ящику», восстановление вкладки на boot) — поэтому старый интервал
    // гасим здесь же, а не только в stopInboxIfNeeded.
    if (ttlTimer) { clearInterval(ttlTimer); ttlTimer = null; }
    showMailList();
    const session = await RegLog.store.getSession(P.state.currentDomain);
    const key = session ? `${P.state.currentDomain}|${session.address}` : null;
    if (key !== inboxKey) {
      inboxKey = key;
      knownMailIds = new Set();
      seeded = false;
      unreadCount = 0;
    }
    updateInboxBadge();
    const addressBtn = document.getElementById('inbox-address');
    const providerSpan = document.getElementById('inbox-provider');
    const ttlSpan = document.getElementById('inbox-ttl');
    const list = document.getElementById('mail-list');
    list.textContent = '';
    clearInboxError();

    if (!session) {
      addressBtn.textContent = '';
      providerSpan.textContent = '';
      list.textContent = '';
      const p = document.createElement('p');
      p.textContent = 'Сначала возьми адрес на вкладке «Новый».';
      list.appendChild(p);
      return;
    }

    addressBtn.textContent = session.address;
    providerSpan.textContent = P.labelFor(session.provider);
    const adapter = RegLog.mail.adapters.find(a => a.id === session.provider);

    // Сессия от сервиса, которого в сборке больше нет (адаптер выпилен, переименован,
    // сессия приехала из более новой версии). Раньше следующая строка читала
    // adapter.sessionTtlMs у undefined и вкладка «Ящик» умирала TypeError'ом.
    if (!adapter) {
      ttlSpan.textContent = '';
      if (stopPolling) { stopPolling(); stopPolling = null; }
      showUnknownProvider(session.provider);
      return;
    }

    if (adapter.sessionTtlMs > 0) {
      const updateTtl = () => {
        const remain = Math.max(0, session.touchedAt + adapter.sessionTtlMs - Date.now());
        const mins = Math.floor(remain / 60000), secs = Math.floor((remain % 60000) / 1000);
        ttlSpan.textContent = `живёт ${P.ttlMinutes(adapter)} мин без обращений · осталось ${mins}:${String(secs).padStart(2, '0')}`;
      };
      updateTtl();
      ttlTimer = setInterval(updateTtl, 1000);
    } else {
      ttlSpan.textContent = '';
    }

    startInboxPolling(P.state.currentDomain, session);
  }

  function startInboxPolling(domain, session) {
    if (stopPolling) stopPolling();
    // domain передаётся, чтобы poll продлевал touchedAt и на диске, а не только в
    // этом объекте session (на него замкнут живой счётчик остатка TTL выше).
    stopPolling = RegLog.mail.poll(domain, session, (batch) => {
      if (!batch.ok) {
        const err = batch.error;
        if (err && err.reason === 'expired') {
          showInboxExpired(session.provider);
          return;
        }
        if (err && err.reason === 'shape' && !RegLog.mail.adapters.find(a => a.id === session.provider)) {
          showUnknownProvider(session.provider);
          return;
        }
        // Всё остальное (сеть, таймаут, 5xx, rate-limit, мусор в ответе) раньше уходило
        // в тишину: renderMailList не звался, и человек смотрел на пустую область, не
        // понимая, письма не идут или расширение сломалось. Писем со экрана не стираем —
        // поллинг сам продолжит попытки, строка состояния лишь называет причину.
        showInboxError(err);
        return;
      }
      clearInboxError();
      renderMailList(batch.messages);
    });
  }

  // Человеческие названия причин MailError. Незнакомая причина (и вообще не MailError,
  // например TypeError из адаптера) не должна давать пустую строку — отсюда фолбэк.
  function inboxErrorText(err) {
    const reason = err && err.reason;
    const byReason = {
      network: 'нет связи с сервисом почты',
      timeout: 'сервис почты не отвечает',
      rate: 'сервис просит подождать: слишком часто',
      auth: 'сервис отклонил доступ к ящику',
      server: 'сервис почты отвечает ошибкой',
      shape: 'непонятный ответ сервиса почты'
    };
    return byReason[reason] || 'не удалось получить письма';
  }

  function showInboxError(err) {
    inboxFailStreak++;
    const box = document.getElementById('inbox-error');
    const tail = inboxFailStreak > 1 ? ` · неудач подряд: ${inboxFailStreak}` : '';
    box.textContent = `${inboxErrorText(err)}${tail} · пробуем снова`;
    box.hidden = false;
  }

  function clearInboxError() {
    inboxFailStreak = 0;
    const box = document.getElementById('inbox-error');
    box.textContent = '';
    box.hidden = true;
  }

  // Тупик: адрес есть, читать его нечем. Единственный выход — новый ящик, поэтому
  // кнопка ведёт туда же, куда экран истечения.
  function showUnknownProvider(providerId) {
    showMailList();
    const list = document.getElementById('mail-list');
    list.textContent = '';
    unreadCount = 0;
    updateInboxBadge();
    clearInboxError();
    const p = document.createElement('p');
    p.textContent = `сессия от неизвестного сервиса (${providerId}) — читать её нечем, возьми новый адрес`;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = 'Взять новый адрес';
    btn.addEventListener('click', () => document.getElementById('btn-generate').click());
    list.appendChild(p); list.appendChild(btn);
  }

  // providerId передаётся, а не хардкодится: раньше в тексте стоял «DropMail»,
  // хотя истечь может любой сервис с sessionTtlMs > 0, а сам DropMail отключён.
  function showInboxExpired(providerId) {
    showMailList();
    const list = document.getElementById('mail-list');
    list.textContent = '';
    unreadCount = 0;
    updateInboxBadge();
    clearInboxError(); // у истечения свой экран с выходом: строка «пробуем снова» тут врёт
    const p = document.createElement('p');
    p.textContent = `ящик ${P.labelFor(providerId)} истёк, письма удалены`;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = 'Взять новый адрес';
    btn.addEventListener('click', () => document.getElementById('btn-generate').click());
    list.appendChild(p); list.appendChild(btn);
  }

  function updateInboxBadge() {
    const badge = document.getElementById('inbox-badge');
    const tabBtn = document.getElementById('tab-inbox');
    if (!badge) return;
    if (unreadCount > 0) {
      badge.textContent = String(unreadCount);
      badge.hidden = false;
      if (tabBtn) tabBtn.setAttribute('aria-label', `Ящик, новых писем: ${unreadCount}`);
    } else {
      badge.textContent = '';
      badge.hidden = true;
      if (tabBtn) tabBtn.removeAttribute('aria-label');
    }
  }

  function renderMailList(messages) {
    const list = document.getElementById('mail-list');
    list.textContent = '';

    let newIds = [];
    let newIdSet = new Set();
    if (!seeded) {
      knownMailIds = new Set(messages.map(m => m.id));
      seeded = true;
    } else {
      newIds = messages.filter(m => !knownMailIds.has(m.id)).map(m => m.id);
      newIdSet = new Set(newIds);
      for (const id of newIds) knownMailIds.add(id);
    }

    if (messages.length === 0) {
      const p = document.createElement('p');
      p.textContent = 'Писем пока нет. Отправь письмо с сайта и нажми «Обновить».';
      list.appendChild(p);
      return;
    }

    const newRows = [];
    for (const msg of messages) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mail-row' + (newIdSet.has(msg.id) ? ' is-new' : '');

      const meta = document.createElement('div'); meta.className = 'mail-row-meta';
      const from = document.createElement('span'); from.textContent = RegLog.mail.decodeEntities(msg.from);
      const time = document.createElement('span'); time.className = 'mail-time'; time.textContent = new Date(msg.date).toLocaleTimeString();
      meta.append(from, time);

      const body = document.createElement('div'); body.className = 'mail-row-body';
      const subj = document.createElement('span'); subj.className = 'mail-row-subject'; subj.textContent = RegLog.mail.decodeEntities(msg.subject);
      const intro = document.createElement('span'); intro.className = 'mail-row-intro'; intro.textContent = RegLog.mail.decodeEntities(msg.intro);
      body.append(subj, intro);

      row.append(meta, body);
      row.addEventListener('click', () => openMail(msg));
      list.appendChild(row);
      if (newIdSet.has(msg.id)) newRows.push(row);
    }

    if (newIds.length > 0) {
      unreadCount += newIds.length;
      updateInboxBadge();
      P.showToast(newIds.length === 1 ? 'Новое письмо' : `Новых писем: ${newIds.length}`);
      setTimeout(() => {
        for (const row of newRows) row.classList.remove('is-new');
      }, 4000);
    }
  }

  // Строит DOM тела письма из сегментов splitLinkChips: текстовые куски как есть
  // (перенос строк рисует CSS white-space:pre-wrap на #mail-body), ссылки — маленькой
  // кнопкой-чипом вместо сырого URL. safeExternalUrl — тот же второй барьер, что и у
  // extracted.link ниже: непригодная схема не рендерится кликабельной, но и не
  // пропадает — остаётся видимой как обычный текст `[url]`.
  function renderMailBody(container, text) {
    container.textContent = '';
    for (const seg of RegLog.mail.splitLinkChips(text)) {
      if (seg.type === 'text') {
        if (seg.value) container.appendChild(document.createTextNode(seg.value));
        continue;
      }
      const url = safeExternalUrl(seg.url);
      if (!url) { container.appendChild(document.createTextNode(`[${seg.url}]`)); continue; }
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'chip mail-body-link';
      btn.textContent = seg.label; btn.title = url;
      btn.addEventListener('click', () => chrome.tabs.create({ url }));
      container.appendChild(btn);
    }
  }

  async function openMail(msg) {
    const session = await RegLog.store.getSession(P.state.currentDomain);
    if (!session) return;
    const adapter = RegLog.mail.adapters.find(a => a.id === session.provider);
    if (!adapter) { showUnknownProvider(session.provider); return; }
    let full;
    try {
      full = await adapter.read(session, msg.id);
    } catch (e) {
      // Раньше отсюда уходил необработанный reject: сеть отвалилась или ящик истёк —
      // письмо просто не открывалось, без единого слова пользователю. Ветка 'expired'
      // повторяет обработчик «Обновить» (btn-refresh-inbox), остальное — тост, а не
      // #notice: #notice лежит в pane-new и на вкладке «Ящик» его не видно. Список
      // сюда не трогаем — он и так виден, показывать было нечего.
      if (e && e.reason === 'expired') showInboxExpired(session.provider);
      else P.showToast('Не удалось открыть письмо');
      return;
    }

    document.getElementById('mail-meta-subject').textContent = RegLog.mail.decodeEntities(msg.subject);
    document.getElementById('mail-meta-from').textContent = RegLog.mail.decodeEntities(msg.from);

    const bodyEl = document.getElementById('mail-body');
    const bodyText = RegLog.mail.decodeEntities(full.text) || (full.html ? stripHtmlToTextClientSide(full.html) : '');
    renderMailBody(bodyEl, bodyText);
    bodyEl.hidden = false;
    if (unreadCount > 0) { unreadCount--; updateInboxBadge(); }

    // Чтение состоялось — теперь есть что показывать; список прячем именно тут,
    // а не в начале функции, чтобы неудачное чтение (catch выше) не оставляло
    // экран пустым между спрятанным списком и непоказанным письмом.
    showMailView();

    const extracted = RegLog.mail.extract(full);
    const codeEl = document.getElementById('mail-code');
    codeEl.textContent = '';
    codeEl.hidden = true;

    if (extracted.code) {
      codeEl.hidden = false;
      const codeSpan = document.createElement('span'); codeSpan.className = 'mono'; codeSpan.textContent = extracted.code;
      const copyBtn = document.createElement('button'); copyBtn.type = 'button'; copyBtn.textContent = 'Копировать';
      copyBtn.addEventListener('click', async () => { await P.copyText(extracted.code); P.showToast('Скопировано'); });
      codeEl.append(codeSpan, copyBtn);
      if (extracted.confidence === 'low') {
        const note = document.createElement('span'); note.className = 'muted'; note.textContent = 'возможно, это код';
        codeEl.appendChild(note);
      }
    }
    if (extracted.link) {
      // Показывать один хост нельзя: путь и query письмо контролирует целиком, и
      // `example.com` ничего не говорит про `/redirect?to=evil`. Кликабелен сам URL —
      // открывается ровно то, что человек прочитал; обрезает адрес CSS (ellipsis
      // с конца, хост остаётся виден), полный текст в title и выделяется мышью.
      const url = safeExternalUrl(extracted.link);
      if (url) {
        const linkRow = document.createElement('div');
        linkRow.className = 'mail-link-row';
        const label = document.createElement('span'); label.className = 'muted'; label.textContent = 'Ссылка из письма:';
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'mail-link mono';
        openBtn.textContent = url;
        openBtn.title = url;
        openBtn.addEventListener('click', () => chrome.tabs.create({ url }));
        linkRow.append(label, openBtn);
        codeEl.hidden = false;
        codeEl.appendChild(linkRow);
      }
    }
  }

  // Второй барьер перед chrome.tabs.create. extract уже отдаёт только абсолютный
  // http(s)-URL, но popup — та точка, где адрес из письма покидает расширение, и
  // держать её зависимой от одной проверки в другом файле незачем: непригодный адрес
  // здесь не рендерится вовсе, вместо падения tabs.create на клике.
  function safeExternalUrl(raw) {
    let url;
    try { url = new URL(String(raw || '')); } catch (e) { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href;
  }

  // HTML письма НИКОГДА не вставляется в DOM попапа (раздел 8.2) — используем DOMParser
  // на отсоединённом документе только для извлечения текста, не для рендера.
  function stripHtmlToTextClientSide(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('style, script').forEach(n => n.remove());
    return doc.body ? doc.body.textContent : '';
  }

  document.getElementById('inbox-address').addEventListener('click', async () => {
    const session = await RegLog.store.getSession(P.state.currentDomain);
    if (session) { await P.copyText(session.address); P.showToast('Скопировано'); }
  });

  document.getElementById('btn-refresh-inbox').addEventListener('click', async () => {
    const session = await RegLog.store.getSession(P.state.currentDomain);
    if (!session) return;
    const adapter = RegLog.mail.adapters.find(a => a.id === session.provider);
    if (!adapter) { showUnknownProvider(session.provider); return; }
    try {
      const list = await adapter.list(session);
      clearInboxError();
      renderMailList(list);
    } catch (e) {
      // Ручное «Обновить» молчать не имеет права тем более: человек нажал и ждёт ответа.
      if (e && e.reason === 'expired') showInboxExpired(session.provider);
      else showInboxError(e);
    }
  });

  document.getElementById('btn-mail-back').addEventListener('click', () => {
    showMailList();
  });

  function stopInboxIfNeeded() {
    // ttlTimer гасим ВСЕГДА, включая режим панели: интервал замкнут на конкретный
    // объект session, и в панели переходы Ящик→Журнал→Ящик раньше плодили по живому
    // интервалу за переход (каждый со своим устаревшим session). Гейт isPanel касается
    // только поллинга — он в панели живёт, пока панель открыта.
    if (ttlTimer) { clearInterval(ttlTimer); ttlTimer = null; }
    if (P.isPanel) return;
    if (stopPolling) { stopPolling(); stopPolling = null; }
  }

  addEventListener('pagehide', () => { if (stopPolling) stopPolling(); if (ttlTimer) clearInterval(ttlTimer); });

  P.onEnter('inbox', initInboxTab);
  P.onLeave('inbox', stopInboxIfNeeded);

})();
