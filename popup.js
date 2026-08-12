(function () {
  'use strict';

  const panes = { new: '#pane-new', inbox: '#pane-inbox', log: '#pane-log', settings: '#pane-settings' };
  const tabs = { new: '#tab-new', inbox: '#tab-inbox', log: '#tab-log', settings: '#tab-settings' };

  let booted = false;

  let selectTab = function (name) {
    for (const key of Object.keys(panes)) {
      document.querySelector(panes[key]).hidden = key !== name;
      document.querySelector(tabs[key]).setAttribute('aria-selected', String(key === name));
    }
    RegLog.store.setSessionState({ activeTab: name });
  };

  for (const key of Object.keys(tabs)) {
    document.querySelector(tabs[key]).addEventListener('click', () => selectTab(key));
  }

  const isPanel = new URLSearchParams(location.search).get('panel') === '1';
  if (isPanel) document.body.classList.add('panel');
  document.getElementById('btn-panel').hidden = isPanel;

  async function currentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  let currentDomain = null;
  let currentDraft = null;

  async function initNewTab() {
    const tab = await currentTab();
    let host;
    try { host = new URL(tab.url).hostname; } catch (e) { host = ''; }
    currentDomain = host ? RegLog.store.registrableDomain(host) : '';
    document.getElementById('host-label').textContent = currentDomain || '(страница расширения недоступна)';

    currentDraft = await RegLog.store.getDraft(currentDomain);
    renderKit(currentDraft);

    if (isRestrictedUrl(tab.url)) {
      showNotice('На этой странице расширение работать не может.', 'danger');
      setActionsDisabled(true);
      return;
    }
    setActionsDisabled(false);

    // Early signal for the locked-but-not-yet-unlocked case (e.g. right after a browser
    // restart): getDraft() above already silently returned null for this case (Task 16
    // F2 patch), which is indistinguishable from "no draft yet" on its own. Surfacing it
    // here up front means the user sees the reason before clicking «Сгенерировать» and
    // hitting the try/catch notice there. Checked directly against settings/isUnlocked()
    // rather than RegLog.store.isLocked()'s cache, since that cache is only populated by
    // enableLock/disableLock within the current session and defaults to "unlocked" — it
    // would miss exactly this right-after-restart scenario.
    if (await isJournalLockedNow()) {
      showNotice('Журнал заблокирован — разблокируй его на вкладке «Журнал», прежде чем генерировать новый комплект.');
    }

    const scanResult = await RegLog.frames.runOnBestFrame(tab.id, { mode: 'scan', data: {}, opts: {} });
    renderScanSummary(scanResult);
  }

  async function isJournalLockedNow() {
    const settings = await RegLog.store.getSettings();
    // Раньше это "работало" только потому, что getDraft() выше (строка ~40) уже успевал
    // восстановить ключ сессии как побочный эффект (через crypto.js-патч listDrafts).
    // Явный вызов здесь убирает эту хрупкую зависимость от порядка вызовов — переставить
    // эти две строки раньше означало бы ложную вспышку "журнал заблокирован" при каждом
    // открытии попапа (Finding 4, финальное ревью).
    if (RegLog.crypto && RegLog.crypto.tryRestoreFromSession && RegLog.crypto.isUnlocked && !RegLog.crypto.isUnlocked()) {
      await RegLog.crypto.tryRestoreFromSession();
    }
    return !!(settings.lockEnabled && !(RegLog.crypto && RegLog.crypto.isUnlocked && RegLog.crypto.isUnlocked()));
  }

  function isRestrictedUrl(url) {
    return /^(chrome|chrome-extension|about|view-source):/.test(url || '') || /^https:\/\/chromewebstore\.google\.com/.test(url || '');
  }

  function setActionsDisabled(disabled) {
    for (const id of ['btn-generate', 'btn-fill', 'btn-rescan', 'btn-other', 'btn-save']) {
      document.getElementById(id).disabled = disabled;
    }
  }

  function renderKit(draft) {
    const nameBtn = document.getElementById('kit-name');
    const userBtn = document.getElementById('kit-user');
    const mailBtn = document.getElementById('kit-mail');
    const passBtn = document.getElementById('kit-pass');
    const providerLabel = document.getElementById('kit-provider');

    nameBtn.textContent = (draft && draft.name) || '—';
    userBtn.textContent = (draft && draft.username) || '—';
    passBtn.textContent = (draft && draft.password) || '—';

    RegLog.store.getSession(currentDomain).then(session => {
      if (session) {
        mailBtn.textContent = session.address;
        providerLabel.textContent = labelFor(session.provider);
        providerLabel.className = 'kit-provider';
        const adapter = RegLog.mail.adapters.find(a => a.id === session.provider);
        if (adapter && adapter.publicInbox) {
          providerLabel.textContent += ' · публичный ящик';
          providerLabel.title = 'инбокс читает любой, кто знает адрес';
          providerLabel.style.color = 'var(--warn)';
        }
        if (adapter && adapter.sessionTtlMs > 0) providerLabel.textContent += ' · живёт 10 мин';
      } else {
        mailBtn.textContent = '—';
        providerLabel.textContent = '';
      }
    });
  }

  function labelFor(providerId) {
    const a = RegLog.mail.adapters.find(x => x.id === providerId);
    return a ? a.label : providerId;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  function showToast(text) {
    const toast = document.getElementById('toast');
    toast.textContent = text; toast.hidden = false;
    document.getElementById('live').textContent = text;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, 1200);
  }

  for (const id of ['kit-name', 'kit-user', 'kit-mail', 'kit-pass']) {
    document.getElementById(id).addEventListener('click', async (e) => {
      const text = e.target.textContent;
      if (!text || text === '—') return;
      await copyText(text);
      showToast('Скопировано');
    });
  }

  function showNotice(text, kind) {
    const notice = document.getElementById('notice');
    notice.textContent = text;
    notice.className = kind || '';
    notice.hidden = false;
  }
  function hideNotice() {
    document.getElementById('notice').hidden = true;
  }

  function renderScanSummary(scanResult) {
    if (!scanResult || !scanResult.result) return;
    const f = scanResult.result.found;
    const foundList = Object.entries(f).filter(([, v]) => v).map(fieldLabel);
    const missingList = Object.entries(f).filter(([, v]) => !v).map(fieldLabel);
    let text = '';
    if (foundList.length) text += `найдено: ${foundList.join(', ')}`;
    if (missingList.length) text += (text ? ' · ' : '') + `нет: ${missingList.join(', ')}`;
    document.getElementById('live').textContent = text;
  }
  function fieldLabel(key) {
    return { name: 'имя', username: 'логин', email: 'почта', password: 'пароль', confirm: 'подтверждение' }[key] || key;
  }

  async function generateNew() {
    setActionsDisabled(true);
    document.getElementById('kit-mail').textContent = 'беру адрес…';
    hideNotice();

    const settings = await RegLog.store.getSettings();
    const person = RegLog.gen.personName();
    const username = RegLog.gen.username(settings.loginStyle);
    const password = settings.passPreset === 'strong'
      ? RegLog.gen.password(settings.passLength, settings.symbols)
      : RegLog.gen.passwordForPolicy(settings.passPreset);

    const draft = {
      url: (await currentTab()).url, name: person.full, username, password, note: currentDraft?.note || '',
      entryId: currentDraft?.entryId || null
    };

    try {
      await RegLog.store.setDraft(currentDomain, draft);
    } catch (e) {
      // Журнал защищён мастер-паролем и ещё не разблокирован в этой сессии (например,
      // сразу после перезапуска браузера) — setDraft бросает по дизайну (Task 16 F2).
      // currentDraft НЕ переприсваиваем: он остаётся тем, что реально лежит в storage.
      showNotice('Журнал заблокирован — разблокируй его на вкладке «Журнал», прежде чем генерировать новый комплект.');
      renderKit(currentDraft);
      setActionsDisabled(false);
      return;
    }
    currentDraft = draft;
    renderKit(draft);

    const outcome = await RegLog.mail.acquire(currentDomain, { localPart: username });
    if (!outcome) {
      const diag = await RegLog.mail.acquireDiagnostics(currentDomain);
      if (diag.allManuallyRejected) {
        showNoticeWithAction('Все сервисы для этого сайта отмечены как отклонённые', 'Сбросить отказы для ' + currentDomain,
          async () => { await RegLog.store.clearRejectedFor(currentDomain); hideNotice(); });
      } else {
        showNoticeWithAction('Сервисы временно недоступны, попробуй через несколько минут', 'Повторить',
          () => document.getElementById('btn-generate').click());
      }
    } else {
      hideNotice();
    }
    renderKit(draft);
    setActionsDisabled(false);
  }

  document.getElementById('btn-generate').addEventListener('click', generateNew);

  function showNoticeWithAction(text, actionLabel, onAction) {
    const notice = document.getElementById('notice');
    notice.textContent = '';
    notice.appendChild(document.createTextNode(text + ' '));
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = actionLabel;
    btn.addEventListener('click', onAction);
    notice.appendChild(btn);
    notice.hidden = false;
  }

  async function regeneratePasswordOnly(preset) {
    // Без комплекта на карточке спред `{...currentDraft, password}` дал бы черновик без
    // name/username/url — соберём обычный комплект в этом случае так же, как это уже
    // делает btn-fill (см. Finding 1 выше), и не продолжаем, если журнал заблокирован.
    if (!currentDraft) await generateNew();
    if (!currentDraft) return;
    await RegLog.store.setSettings({ passPreset: preset });
    const settings = await RegLog.store.getSettings();
    const password = preset === 'strong' ? RegLog.gen.password(settings.passLength, settings.symbols) : RegLog.gen.passwordForPolicy(preset);
    currentDraft = { ...currentDraft, password };
    await RegLog.store.setDraft(currentDomain, currentDraft);
    renderKit(currentDraft);
  }

  for (const btn of document.querySelectorAll('.kit-preset-btn')) {
    btn.addEventListener('click', () => regeneratePasswordOnly(btn.dataset.preset));
  }

  document.getElementById('btn-fill').addEventListener('click', async () => {
    if (!currentDraft) await generateNew();
    // generateNew()'s own catch (Task 16 F2) deliberately leaves currentDraft null when
    // the journal is locked-but-not-yet-unlocked this session, and already shows a notice
    // explaining why — bail here rather than dereferencing currentDraft.name below.
    if (!currentDraft) return;
    const tab = await currentTab();
    const session = await RegLog.store.getSession(currentDomain);
    const settings = await RegLog.store.getSettings();
    const payload = {
      mode: 'fill',
      data: { name: currentDraft.name, username: currentDraft.username, email: session?.address, password: currentDraft.password },
      opts: { slowType: settings.slowType, watchMs: 3000 }
    };
    const outcome = await RegLog.frames.runOnBestFrame(tab.id, payload);
    if (!outcome || outcome.error || outcome.result.score === 0) {
      const needsFrames = await RegLog.frames.needsFrameAccess(tab.id);
      document.getElementById('frames-block').hidden = !needsFrames;
      if (needsFrames) renderFramesBlock(tab.id);
      return;
    }
    document.getElementById('frames-block').hidden = true;
    const result = outcome.result;

    if (result.emailRejected) {
      showNoticeWithAction(result.rejectText || 'Похоже, почта отклонена сайтом', 'Другой домен',
        () => document.getElementById('btn-other').click());
      document.getElementById('btn-other').classList.add('warn-outline');
    } else if (result.truncated.length > 0) {
      const limit = result.limits.password;
      showNoticeWithAction(
        `Поле «пароль» вместило только ${limit} символов. В журнал записан фактический пароль.`,
        'Сгенерировать под лимит',
        async () => {
          currentDraft.password = RegLog.gen.password(limit, true).slice(0, limit);
          await RegLog.store.setDraft(currentDomain, currentDraft);
          renderKit(currentDraft);
          document.getElementById('btn-fill').click();
        }
      );
      notice_setKind('warn');
    } else {
      hideNotice();
    }

    if (settings.autoSave) await saveEntryFromActual(result.actual, session);
  });

  function notice_setKind(kind) { document.getElementById('notice').className = kind; }

  async function saveEntryFromActual(actual, session) {
    const entryData = {
      host: currentDomain, url: currentDraft.url, name: currentDraft.name,
      username: actual.username || currentDraft.username, email: actual.email || session?.address,
      provider: session?.provider, password: actual.password || currentDraft.password, note: currentDraft.note || ''
    };
    if (currentDraft.entryId) {
      await RegLog.store.updateEntry(currentDraft.entryId, entryData);
    } else {
      const entry = await RegLog.store.addEntry(entryData);
      currentDraft.entryId = entry.id;
      await RegLog.store.setDraft(currentDomain, currentDraft);
    }
  }

  async function switchToOtherDomain() {
    const session = await RegLog.store.getSession(currentDomain);
    const outcome = session
      ? await RegLog.mail.next(currentDomain, session.provider)
      : await RegLog.mail.acquire(currentDomain, { localPart: currentDraft?.username || RegLog.gen.username('words') });
    document.getElementById('btn-other').classList.remove('warn-outline');
    if (!outcome) {
      const diag = await RegLog.mail.acquireDiagnostics(currentDomain);
      if (diag.allManuallyRejected) {
        showNoticeWithAction(
          'Все сервисы для этого сайта отмечены как отклонённые',
          'Сбросить отказы для ' + currentDomain,
          async () => {
            await RegLog.store.clearRejectedFor(currentDomain);
            hideNotice();
            await switchToOtherDomain();
          }
        );
      } else {
        showNoticeWithAction(
          'Сервисы временно недоступны, попробуй через несколько минут',
          'Повторить',
          () => switchToOtherDomain()
        );
      }
      renderKit(currentDraft);
      return;
    }
    renderKit(currentDraft);
    const tab = await currentTab();
    const settings = await RegLog.store.getSettings();
    const payload = { mode: 'fillEmail', data: { email: outcome.session.address }, opts: { slowType: settings.slowType, watchMs: 3000 } };
    const fillOutcome = await RegLog.frames.runOnBestFrame(tab.id, payload);
    if (currentDraft.entryId && fillOutcome && fillOutcome.result) {
      await RegLog.store.updateEntry(currentDraft.entryId, { email: outcome.session.address, provider: outcome.provider.id });
    }
  }

  document.getElementById('btn-other').addEventListener('click', switchToOtherDomain);

  document.getElementById('btn-rescan').addEventListener('click', async () => {
    const tab = await currentTab();
    const scanResult = await RegLog.frames.runOnBestFrame(tab.id, { mode: 'scan', data: {}, opts: {} });
    renderScanSummary(scanResult);
  });

  document.getElementById('btn-save').addEventListener('click', async () => {
    if (!currentDraft) return;
    const session = await RegLog.store.getSession(currentDomain);
    await saveEntryFromActual({ username: currentDraft.username, email: session?.address, password: currentDraft.password }, session);
    showToast('Записано в журнал');
  });

  function renderFramesBlock(tabId) {
    const block = document.getElementById('frames-block');
    block.textContent = '';
    const p = document.createElement('p');
    p.textContent = 'Форма, похоже, во встроенном фрейме';
    const step1Btn = document.createElement('button');
    step1Btn.type = 'button'; step1Btn.textContent = 'Найти фреймы';
    step1Btn.addEventListener('click', async () => {
      const granted = await RegLog.frames.requestWebNavigation();
      if (!granted) return;
      const origins = await RegLog.frames.listChildOrigins(tabId);
      renderOriginList(block, tabId, origins);
    });
    block.appendChild(p); block.appendChild(step1Btn);
    block.hidden = false;
  }

  function renderOriginList(block, tabId, origins) {
    block.textContent = '';
    const list = document.createElement('ul');
    for (const o of origins) { const li = document.createElement('li'); li.textContent = o; list.appendChild(li); }
    const step2Btn = document.createElement('button');
    step2Btn.type = 'button'; step2Btn.textContent = 'Разрешить';
    step2Btn.addEventListener('click', async () => {
      const granted = await RegLog.frames.requestOrigins(origins);
      if (!granted) return;
      block.hidden = true;
      document.getElementById('btn-fill').click();
    });
    block.appendChild(list); block.appendChild(step2Btn);
  }

  let stopPolling = null;
  let ttlTimer = null;
  let knownMailIds = null;
  let seeded = false;
  let unreadCount = 0;
  let inboxKey = null;

  async function initInboxTab() {
    const session = await RegLog.store.getSession(currentDomain);
    const key = session ? `${currentDomain}|${session.address}` : null;
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
    providerSpan.textContent = labelFor(session.provider);
    const adapter = RegLog.mail.adapters.find(a => a.id === session.provider);

    if (adapter.sessionTtlMs > 0) {
      const updateTtl = () => {
        const remain = Math.max(0, session.touchedAt + adapter.sessionTtlMs - Date.now());
        const mins = Math.floor(remain / 60000), secs = Math.floor((remain % 60000) / 1000);
        ttlSpan.textContent = `живёт 10 мин без обращений · осталось ${mins}:${String(secs).padStart(2, '0')}`;
      };
      updateTtl();
      ttlTimer = setInterval(updateTtl, 1000);
    } else {
      ttlSpan.textContent = '';
    }

    startInboxPolling(session);
  }

  function startInboxPolling(session) {
    if (stopPolling) stopPolling();
    stopPolling = RegLog.mail.poll(session, (batch) => {
      if (!batch.ok) {
        if (batch.error && batch.error.reason === 'expired') {
          showInboxExpired();
        }
        return;
      }
      renderMailList(batch.messages);
    });
  }

  function showInboxExpired() {
    const list = document.getElementById('mail-list');
    list.textContent = '';
    unreadCount = 0;
    updateInboxBadge();
    const p = document.createElement('p');
    p.textContent = 'ящик DropMail истёк, письма удалены';
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
      row.addEventListener('click', () => openMail(msg.id));
      list.appendChild(row);
      if (newIdSet.has(msg.id)) newRows.push(row);
    }

    if (newIds.length > 0) {
      unreadCount += newIds.length;
      updateInboxBadge();
      showToast(newIds.length === 1 ? 'Новое письмо' : `Новых писем: ${newIds.length}`);
      setTimeout(() => {
        for (const row of newRows) row.classList.remove('is-new');
      }, 4000);
    }
  }

  async function openMail(msgId) {
    const session = await RegLog.store.getSession(currentDomain);
    const adapter = RegLog.mail.adapters.find(a => a.id === session.provider);
    const full = await adapter.read(session, msgId);
    const bodyEl = document.getElementById('mail-body');
    bodyEl.textContent = RegLog.mail.decodeEntities(full.text) || (full.html ? stripHtmlToTextClientSide(full.html) : '');
    bodyEl.hidden = false;
    if (unreadCount > 0) { unreadCount--; updateInboxBadge(); }

    const extracted = RegLog.mail.extract(full);
    const codeEl = document.getElementById('mail-code');
    codeEl.textContent = '';
    codeEl.hidden = true;

    if (extracted.code) {
      codeEl.hidden = false;
      const codeSpan = document.createElement('span'); codeSpan.className = 'mono'; codeSpan.textContent = extracted.code;
      const copyBtn = document.createElement('button'); copyBtn.type = 'button'; copyBtn.textContent = 'Копировать';
      copyBtn.addEventListener('click', async () => { await copyText(extracted.code); showToast('Скопировано'); });
      codeEl.append(codeSpan, copyBtn);
      if (extracted.confidence === 'low') {
        const note = document.createElement('span'); note.className = 'muted'; note.textContent = 'возможно, это код';
        codeEl.appendChild(note);
      }
    }
    if (extracted.link) {
      const linkRow = document.createElement('div');
      const host = document.createElement('span'); host.className = 'mono muted';
      try { host.textContent = new URL(extracted.link).host; } catch (e) { host.textContent = extracted.link; }
      const openBtn = document.createElement('button'); openBtn.type = 'button'; openBtn.textContent = 'Открыть ссылку';
      openBtn.addEventListener('click', () => chrome.tabs.create({ url: extracted.link }));
      linkRow.append(host, openBtn);
      codeEl.hidden = false;
      codeEl.appendChild(linkRow);
    }
  }

  // HTML письма НИКОГДА не вставляется в DOM попапа (раздел 8.2) — используем DOMParser
  // на отсоединённом документе только для извлечения текста, не для рендера.
  function stripHtmlToTextClientSide(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('style, script').forEach(n => n.remove());
    return doc.body ? doc.body.textContent : '';
  }

  document.getElementById('inbox-address').addEventListener('click', async () => {
    const session = await RegLog.store.getSession(currentDomain);
    if (session) { await copyText(session.address); showToast('Скопировано'); }
  });

  document.getElementById('btn-refresh-inbox').addEventListener('click', async () => {
    const session = await RegLog.store.getSession(currentDomain);
    if (!session) return;
    const adapter = RegLog.mail.adapters.find(a => a.id === session.provider);
    try {
      const list = await adapter.list(session);
      renderMailList(list);
    } catch (e) {
      if (e.reason === 'expired') showInboxExpired();
    }
  });

  function stopInboxIfNeeded() {
    if (isPanel) return; // в панели поллинг живёт, пока панель открыта
    if (stopPolling) { stopPolling(); stopPolling = null; }
    if (ttlTimer) { clearInterval(ttlTimer); ttlTimer = null; }
  }

  addEventListener('pagehide', () => { if (stopPolling) stopPolling(); if (ttlTimer) clearInterval(ttlTimer); });

  // --- вкладка «Журнал»: поиск, порционный рендер, удаление с отменой, экспорт --------

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
    const provider = document.createElement('span'); provider.textContent = labelFor(entry.provider);

    const userChip = makeChip('логин', entry.username);
    const mailChip = makeChip('почта', entry.email);
    const passChip = makeMaskedPassChip(entry.password);

    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.setAttribute('aria-label', 'Удалить запись');
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => confirmDelete(entry, row));

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
    chip.addEventListener('click', async () => { await copyText(value || ''); showToast('Скопировано'); });
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
      await copyText(password || ''); showToast('Скопировано');
    });
    chip.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && e.altKey) { e.preventDefault(); reveal(); }
      else if (e.key === 'Enter') { e.preventDefault(); await copyText(password || ''); showToast('Скопировано'); }
    });
    return chip;
  }

  let pendingUndo = null;
  function confirmDelete(entry, row) {
    if (!confirm('Удалить запись?')) return;
    RegLog.store.removeEntry(entry.id);
    logAllEntries = logAllEntries.filter(e => e.id !== entry.id);
    logFiltered = logFiltered.filter(e => e.id !== entry.id);
    row.hidden = true;
    if (pendingUndo) clearTimeout(pendingUndo.timer);
    const undoBar = document.createElement('div');
    undoBar.textContent = 'Запись удалена. ';
    const undoBtn = document.createElement('button'); undoBtn.type = 'button'; undoBtn.textContent = 'Отменить';
    undoBtn.addEventListener('click', async () => {
      await RegLog.store.addEntry(entry);
      clearTimeout(pendingUndo.timer);
      undoBar.remove();
      initLogTab();
    });
    undoBar.appendChild(undoBtn);
    row.after(undoBar);
    pendingUndo = { timer: setTimeout(() => undoBar.remove(), 5000) };
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
      showToast('Разблокируйте журнал перед экспортом');
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
      errEl.textContent = 'Неверный пароль';
      errEl.hidden = false;
    }
  });

  // --- вкладка «Настройки»: генерация, сервисы почты, доступ к фреймам, защита журнала --------

  async function initSettingsTab() {
    const settings = await RegLog.store.getSettings();
    document.getElementById('set-loginStyle').value = settings.loginStyle;
    document.getElementById('set-passPreset').value = settings.passPreset;
    document.getElementById('set-passLength').value = settings.passLength;
    document.getElementById('set-passLength-val').textContent = settings.passLength;
    document.getElementById('set-symbols').checked = settings.symbols;
    document.getElementById('set-autoSave').checked = settings.autoSave;
    document.getElementById('set-slowType').checked = settings.slowType;
    document.getElementById('set-lockEnabled').checked = settings.lockEnabled;

    renderProvidersList(settings);
    renderOriginsSettings();
    renderRejectedCount();
  }

  function bindSettingField(id, key, transform) {
    document.getElementById(id).addEventListener('change', async (e) => {
      const raw = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      const value = transform ? transform(raw) : raw;
      await RegLog.store.setSettings({ [key]: value });
      if (id === 'set-passLength') document.getElementById('set-passLength-val').textContent = value;
    });
  }
  bindSettingField('set-loginStyle', 'loginStyle');
  bindSettingField('set-passPreset', 'passPreset');
  bindSettingField('set-passLength', 'passLength', Number);
  bindSettingField('set-symbols', 'symbols');
  bindSettingField('set-autoSave', 'autoSave');
  bindSettingField('set-slowType', 'slowType');

  function renderProvidersList(settings) {
    const ul = document.getElementById('set-providers-list');
    ul.textContent = '';
    settings.providers.forEach((id, idx) => {
      const adapter = RegLog.mail.adapters.find(a => a.id === id);
      const li = document.createElement('li');
      if (adapter && adapter.disabled) li.classList.add('disabled');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !settings.providersOff.includes(id);
      checkbox.disabled = !adapter || adapter.disabled;
      checkbox.addEventListener('change', async () => {
        const s = await RegLog.store.getSettings();
        const off = new Set(s.providersOff);
        checkbox.checked ? off.delete(id) : off.add(id);
        await RegLog.store.setSettings({ providersOff: Array.from(off) });
      });

      const label = document.createElement('span');
      label.textContent = (adapter ? adapter.label : id) + (adapter && adapter.disabled ? ' (адаптер не реализован)' : '');
      if (adapter && adapter.publicInbox) label.textContent += ' · публичный ящик';
      if (adapter && adapter.sessionTtlMs > 0) label.textContent += ' · живёт 10 мин';

      const upBtn = document.createElement('button'); upBtn.type = 'button'; upBtn.setAttribute('aria-label', `Переместить ${id} вверх`); upBtn.textContent = '↑';
      upBtn.disabled = idx === 0;
      upBtn.addEventListener('click', () => moveProvider(idx, -1));

      const downBtn = document.createElement('button'); downBtn.type = 'button'; downBtn.setAttribute('aria-label', `Переместить ${id} вниз`); downBtn.textContent = '↓';
      downBtn.disabled = idx === settings.providers.length - 1;
      downBtn.addEventListener('click', () => moveProvider(idx, 1));

      li.append(checkbox, label, upBtn, downBtn);
      ul.appendChild(li);
    });
  }

  async function moveProvider(idx, dir) {
    const settings = await RegLog.store.getSettings();
    const list = [...settings.providers];
    const target = idx + dir;
    if (target < 0 || target >= list.length) return;
    [list[idx], list[target]] = [list[target], list[idx]];
    await RegLog.store.setSettings({ providers: list });
    initSettingsTab();
  }

  async function renderRejectedCount() {
    const rejected = await RegLog.store.getRejected();
    document.getElementById('set-rejected-count').textContent = `Сайтов с отказами: ${Object.keys(rejected).length}`;
  }
  document.getElementById('set-reset-all-rejected').addEventListener('click', async () => {
    await RegLog.store.clearRejected();
    renderRejectedCount();
  });

  async function renderOriginsSettings() {
    const ul = document.getElementById('set-origins-list');
    ul.textContent = '';
    const origins = await RegLog.frames.listGrantedOrigins();
    if (origins.length === 0) {
      const li = document.createElement('li'); li.textContent = 'доступ к встроенным фреймам не выдавался'; ul.appendChild(li);
      return;
    }
    for (const origin of origins) {
      const li = document.createElement('li');
      const span = document.createElement('span'); span.className = 'mono'; span.textContent = origin;
      const revokeBtn = document.createElement('button'); revokeBtn.type = 'button'; revokeBtn.textContent = 'Отозвать';
      revokeBtn.addEventListener('click', async () => { await RegLog.frames.revokeOrigin(origin); renderOriginsSettings(); });
      li.append(span, revokeBtn); ul.appendChild(li);
    }
  }
  document.getElementById('set-revoke-webnav').addEventListener('click', async () => {
    await RegLog.frames.revokeWebNavigation();
  });

  document.getElementById('set-lockEnabled').addEventListener('change', (e) => {
    document.getElementById('set-lock-form').hidden = !e.target.checked;
    if (!e.target.checked) disableLockFlow();
  });

  document.getElementById('set-lock-apply').addEventListener('click', async () => {
    const p1 = document.getElementById('set-lock-pass1').value;
    const p2 = document.getElementById('set-lock-pass2').value;
    const errEl = document.getElementById('set-lock-error');
    errEl.hidden = true;
    if (p1 !== p2 || p1.length < 4) {
      errEl.textContent = 'Пароли не совпадают или слишком короткие';
      errEl.hidden = false;
      return;
    }
    try {
      await RegLog.store.enableLock(p1);
    } catch (e) {
      // Достижимо, когда журнал уже зашифрован (например, попытка включить защиту
      // заново после неудачного disableLockFlow) — enableLock бросает по дизайну и
      // не трогает данные; без этого catch получался необработанный reject и форма
      // молча зависала без обратной связи.
      errEl.textContent = 'Не удалось включить защиту: ' + (e && e.message ? e.message : 'неизвестная ошибка');
      errEl.hidden = false;
      return;
    }
    document.getElementById('set-lock-pass1').value = '';
    document.getElementById('set-lock-pass2').value = '';
    document.getElementById('set-lock-form').hidden = true;
  });

  // Инлайн-форма отключения защиты вместо prompt()/alert() (Finding 6, финальное ревью):
  // нативные диалоги в попапе расширения могут не пережить потерю фокуса, не маскируют
  // ввод предсказуемо и не дают инлайновой обратной связи. Паттерн — как у #log-unlock
  // (поле пароля + кнопка + role="alert").
  function disableLockFlow() {
    document.getElementById('set-disable-lock-pass').value = '';
    document.getElementById('set-disable-lock-error').hidden = true;
    document.getElementById('set-disable-lock-form').hidden = false;
  }

  function cancelDisableLockFlow() {
    document.getElementById('set-disable-lock-form').hidden = true;
    document.getElementById('set-disable-lock-pass').value = '';
    document.getElementById('set-disable-lock-error').hidden = true;
    // Отражает поведение прежнего prompt()-отказа (pass == null): чекбокс возвращается
    // в отмеченное состояние, журнал остаётся защищённым.
    document.getElementById('set-lockEnabled').checked = true;
  }

  document.getElementById('set-disable-lock-apply').addEventListener('click', async () => {
    const pass = document.getElementById('set-disable-lock-pass').value;
    const errEl = document.getElementById('set-disable-lock-error');
    errEl.hidden = true;
    try {
      await RegLog.store.disableLock(pass);
      document.getElementById('set-disable-lock-pass').value = '';
      document.getElementById('set-disable-lock-form').hidden = true;
    } catch (e) {
      // Неверный пароль остаётся здесь же для повторной попытки — форма никуда не
      // прыгает, в отличие от прежнего alert()+возврата к форме включения.
      errEl.textContent = 'Неверный пароль, защита осталась включена';
      errEl.hidden = false;
    }
  });

  document.getElementById('set-disable-lock-cancel').addEventListener('click', cancelDisableLockFlow);

  document.getElementById('set-clear-entries').addEventListener('click', async () => {
    if (!confirm('Очистить весь журнал? Это необратимо.')) return;
    try {
      await RegLog.store.clearEntries();
    } catch (e) {
      showToast('Журнал заблокирован — сначала разблокируйте его на вкладке «Журнал»');
    }
  });

  // Патч selectTab (Task 1) — вызывать stopInboxIfNeeded при уходе с вкладки «Ящик»,
  // и initInboxTab() при входе на неё. booted-гейт для 'new' сохранён из фикса Task 10
  // (перенесён сюда из тела исходной selectTab, чтобы initNewTab() не вызывался дважды при boot()).
  const _origSelectTab = selectTab;
  selectTab = function (name) {
    if (document.getElementById('tab-inbox').getAttribute('aria-selected') === 'true' && name !== 'inbox') {
      stopInboxIfNeeded();
    }
    _origSelectTab(name);
    if (name === 'new' && booted) initNewTab();
    if (name === 'inbox') initInboxTab();
    if (name === 'log') initLogTab();
    if (name === 'settings') initSettingsTab();
  };

  document.getElementById('btn-panel').addEventListener('click', async () => {
    const tab = await currentTab();
    await chrome.sidePanel.open({ tabId: tab.id });
  });

  function renderSchemaBanner() {
    const banner = RegLog.store.getMigrationBanner();
    const el = document.getElementById('schema-banner');
    el.textContent = '';
    if (!banner) { el.hidden = true; return; }
    el.hidden = false;

    if (banner.kind === 'newer' || banner.kind === 'migration-failed') {
      const msg = banner.kind === 'newer'
        ? 'Журнал сохранён более новой версией расширения и не может быть прочитан этой версией. Данные не тронуты.'
        : 'Не удалось обновить формат журнала до текущей версии. Данные не тронуты.';
      el.appendChild(document.createTextNode(msg + ' '));
      const btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = 'Выгрузить резервную копию';
      btn.addEventListener('click', async () => {
        // Намеренно НЕ RegLog.store.getEntries(): при banner.kind 'newer'/'migration-failed'
        // текущий код не гарантированно понимает форму данных на диске (или журнал может
        // быть в __locked-состоянии) — getEntries() рискует отдать пустой/заглушечный
        // результат вместо реальной резервной копии. getRawSnapshot() читает то же самое,
        // что init() читает перед миграцией — то, что реально лежит на диске, как есть.
        const snapshot = await RegLog.store.getRawSnapshot();
        downloadJson(snapshot);
      });
      el.appendChild(btn);
    } else if (banner.kind === 'quota') {
      el.appendChild(document.createTextNode('Хранилище почти заполнено (свыше 80% квоты). Освободи место — удали старые записи журнала или выгрузи и очисти его.'));
    }
  }

  async function boot() {
    document.body.setAttribute('aria-busy', 'true');
    await RegLog.store.init();
    renderSchemaBanner();
    const state = await RegLog.store.getSessionState();
    // currentDomain должен быть разрешён ДО selectTab(...): если восстанавливаемая
    // вкладка — 'inbox', wrapper selectTab безусловно вызывает initInboxTab(), которому
    // нужен уже установленный currentDomain (иначе getSession(null) вернёт null и
    // покажет "нет адреса" вместо реального ящика — см. фикс-раунд Task 11).
    await initNewTab();
    selectTab(state.activeTab || 'new');
    booted = true;
    document.body.removeAttribute('aria-busy');
    // Остальная инициализация вкладок добавляется в Tasks 11-14.
  }

  boot();
})();
