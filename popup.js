(function () {
  'use strict';

  const panes = { new: '#pane-new', inbox: '#pane-inbox', log: '#pane-log', settings: '#pane-settings' };
  const tabs = { new: '#tab-new', inbox: '#tab-inbox', log: '#tab-log', settings: '#tab-settings' };

  let booted = false;

  function selectTab(name) {
    for (const key of Object.keys(panes)) {
      document.querySelector(panes[key]).hidden = key !== name;
      document.querySelector(tabs[key]).setAttribute('aria-selected', String(key === name));
    }
    RegLog.store.setSessionState({ activeTab: name });
    if (name === 'new' && booted) initNewTab();
  }

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

  async function boot() {
    document.body.setAttribute('aria-busy', 'true');
    await RegLog.store.init();
    const state = await RegLog.store.getSessionState();
    selectTab(state.activeTab || 'new');
    await initNewTab();
    booted = true;
    document.body.removeAttribute('aria-busy');
    // Остальная инициализация вкладок добавляется в Tasks 11-14.
  }

  boot();
})();
