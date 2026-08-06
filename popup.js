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

    const scanResult = await RegLog.frames.runOnBestFrame(tab.id, { mode: 'scan', data: {}, opts: {} });
    renderScanSummary(scanResult);
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
    currentDraft = draft;
    await RegLog.store.setDraft(currentDomain, draft);
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
    await RegLog.store.setSettings({ passPreset: preset });
    const settings = await RegLog.store.getSettings();
    const password = preset === 'strong' ? RegLog.gen.password(settings.passLength, settings.symbols) : RegLog.gen.passwordForPolicy(preset);
    currentDraft = { ...currentDraft, password };
    await RegLog.store.setDraft(currentDomain, currentDraft);
    renderKit(currentDraft);
  }

  document.getElementById('btn-fill').addEventListener('click', async () => {
    if (!currentDraft) await generateNew();
    const tab = await currentTab();
    const session = await RegLog.store.getSession(currentDomain);
    const settings = await RegLog.store.getSettings();
    const payload = {
      mode: 'fill',
      data: { name: currentDraft.name, username: currentDraft.username, email: session?.address, password: currentDraft.password },
      opts: { slowType: settings.slowType, watchMs: 3000 }
    };
    const outcome = await RegLog.frames.runOnBestFrame(tab.id, payload);
    if (!outcome || outcome.error) {
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

  document.getElementById('btn-other').addEventListener('click', async () => {
    const session = await RegLog.store.getSession(currentDomain);
    const outcome = await RegLog.mail.next(currentDomain, session?.provider);
    document.getElementById('btn-other').classList.remove('warn-outline');
    if (!outcome) { hideNotice(); renderKit(currentDraft); return; }
    renderKit(currentDraft);
    const tab = await currentTab();
    const settings = await RegLog.store.getSettings();
    const payload = { mode: 'fillEmail', data: { email: outcome.session.address }, opts: { slowType: settings.slowType, watchMs: 3000 } };
    const fillOutcome = await RegLog.frames.runOnBestFrame(tab.id, payload);
    if (currentDraft.entryId && fillOutcome && fillOutcome.result) {
      await RegLog.store.updateEntry(currentDraft.entryId, { email: outcome.session.address, provider: outcome.provider.id });
    }
  });

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

  async function initInboxTab() {
    const session = await RegLog.store.getSession(currentDomain);
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
    const p = document.createElement('p');
    p.textContent = 'ящик DropMail истёк, письма удалены';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = 'Взять новый адрес';
    btn.addEventListener('click', () => document.getElementById('btn-generate').click());
    list.appendChild(p); list.appendChild(btn);
  }

  function renderMailList(messages) {
    const list = document.getElementById('mail-list');
    list.textContent = '';
    if (messages.length === 0) {
      const p = document.createElement('p');
      p.textContent = 'Писем пока нет. Отправь письмо с сайта и нажми «Обновить».';
      list.appendChild(p);
      return;
    }
    for (const msg of messages) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'mail-row';
      const from = document.createElement('span'); from.textContent = msg.from;
      const subj = document.createElement('span'); subj.textContent = msg.subject;
      const time = document.createElement('span'); time.className = 'mono'; time.textContent = new Date(msg.date).toLocaleTimeString();
      const intro = document.createElement('span'); intro.className = 'muted'; intro.textContent = msg.intro;
      row.append(from, subj, time, intro);
      row.addEventListener('click', () => openMail(msg.id));
      list.appendChild(row);
    }
  }

  async function openMail(msgId) {
    const session = await RegLog.store.getSession(currentDomain);
    const adapter = RegLog.mail.adapters.find(a => a.id === session.provider);
    const full = await adapter.read(session, msgId);
    const bodyEl = document.getElementById('mail-body');
    bodyEl.textContent = full.text || (full.html ? stripHtmlToTextClientSide(full.html) : '');
    bodyEl.hidden = false;

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
  };

  document.getElementById('btn-panel').addEventListener('click', async () => {
    const tab = await currentTab();
    await chrome.sidePanel.open({ tabId: tab.id });
  });

  async function boot() {
    document.body.setAttribute('aria-busy', 'true');
    await RegLog.store.init();
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
