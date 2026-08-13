// popup/new.js
//
// Вкладка «Новый»: домен активной вкладки, комплект (имя/логин/почта/пароль),
// сканирование и заполнение формы, переключение почтового провайдера, запрос
// прав на кросс-доменные фреймы. Регистрируется в popup/core.js через onEnter.
(function () {
  'use strict';

  const P = RegLog.popup;
  const NEW = P.new = {};

  let currentDraft = null;

  async function initNewTab() {
    const tab = await P.currentTab();
    let host;
    try { host = new URL(tab.url).hostname; } catch (e) { host = ''; }
    P.state.currentDomain = host ? RegLog.store.registrableDomain(host) : '';
    document.getElementById('host-label').textContent = P.state.currentDomain || '(страница расширения недоступна)';

    currentDraft = await RegLog.store.getDraft(P.state.currentDomain);
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

    RegLog.store.getSession(P.state.currentDomain).then(session => {
      if (session) {
        mailBtn.textContent = session.address;
        providerLabel.textContent = P.labelFor(session.provider);
        providerLabel.className = 'kit-provider';
        const adapter = RegLog.mail.adapters.find(a => a.id === session.provider);
        if (adapter && adapter.publicInbox) {
          providerLabel.textContent += ' · публичный ящик';
          providerLabel.title = 'инбокс читает любой, кто знает адрес';
          providerLabel.style.color = 'var(--warn)';
        }
        if (adapter && adapter.sessionTtlMs > 0) providerLabel.textContent += ` · живёт ${P.ttlMinutes(adapter)} мин`;
      } else {
        mailBtn.textContent = '—';
        providerLabel.textContent = '';
      }
    });
  }

  for (const id of ['kit-name', 'kit-user', 'kit-mail', 'kit-pass']) {
    document.getElementById(id).addEventListener('click', async (e) => {
      const text = e.target.textContent;
      if (!text || text === '—') return;
      await P.copyText(text);
      P.showToast('Скопировано');
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
      url: (await P.currentTab()).url, name: person.full, username, password, note: currentDraft?.note || '',
      entryId: currentDraft?.entryId || null
    };

    try {
      await RegLog.store.setDraft(P.state.currentDomain, draft);
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

    const outcome = await RegLog.mail.acquire(P.state.currentDomain, { localPart: username });
    if (!outcome) {
      const diag = await RegLog.mail.acquireDiagnostics(P.state.currentDomain);
      if (diag.allManuallyRejected) {
        showNoticeWithAction('Все сервисы для этого сайта отмечены как отклонённые', 'Сбросить отказы для ' + P.state.currentDomain,
          async () => { await RegLog.store.clearRejectedFor(P.state.currentDomain); hideNotice(); });
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
    await RegLog.store.setDraft(P.state.currentDomain, currentDraft);
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
    const tab = await P.currentTab();
    const session = await RegLog.store.getSession(P.state.currentDomain);
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
      // Прежний код срабатывал на ЛЮБОЕ обрезанное поле, но всегда говорил «пароль»
      // и брал result.limits.password. Если сайт обрезал логин, а у пароля maxLength
      // нет, limits.password === 0 — получалось «вместило только 0 символов», а кнопка
      // звала gen.password(0, true) и подставляла пустой пароль.
      // Теперь: про лимит пароля говорим только когда обрезан именно пароль, и когда
      // длину реально знаем — из maxLength или из фактически влезшего значения.
      const actualPass = result.actual && result.actual.password;
      const passLimit = result.truncated.includes('password')
        ? (result.limits.password > 0 ? result.limits.password : (actualPass ? actualPass.length : 0))
        : 0;
      if (passLimit > 0) {
        showNoticeWithAction(
          `Поле «пароль» вместило только ${passLimit} символов. В журнал записан фактический пароль.`,
          'Сгенерировать под лимит',
          async () => {
            currentDraft.password = RegLog.gen.password(passLimit, true); // gen.password уже режет до len
            await RegLog.store.setDraft(P.state.currentDomain, currentDraft);
            renderKit(currentDraft);
            document.getElementById('btn-fill').click();
          }
        );
      } else {
        const names = result.truncated.map(fieldLabel).join(', ');
        showNotice(`Сайт обрезал поля: ${names}. В журнал записаны фактические значения.`);
      }
      notice_setKind('warn');
    } else {
      hideNotice();
    }

    if (settings.autoSave) await saveEntryFromActual(result.actual, session);
  });

  function notice_setKind(kind) { document.getElementById('notice').className = kind; }

  async function saveEntryFromActual(actual, session) {
    const entryData = {
      host: P.state.currentDomain, url: currentDraft.url, name: currentDraft.name,
      username: actual.username || currentDraft.username, email: actual.email || session?.address,
      provider: session?.provider, password: actual.password || currentDraft.password, note: currentDraft.note || ''
    };
    if (currentDraft.entryId) {
      await RegLog.store.updateEntry(currentDraft.entryId, entryData);
    } else {
      const entry = await RegLog.store.addEntry(entryData);
      currentDraft.entryId = entry.id;
      await RegLog.store.setDraft(P.state.currentDomain, currentDraft);
    }
  }

  async function switchToOtherDomain() {
    const session = await RegLog.store.getSession(P.state.currentDomain);
    const outcome = session
      ? await RegLog.mail.next(P.state.currentDomain, session.provider)
      : await RegLog.mail.acquire(P.state.currentDomain, { localPart: currentDraft?.username || RegLog.gen.username('words') });
    document.getElementById('btn-other').classList.remove('warn-outline');
    if (!outcome) {
      const diag = await RegLog.mail.acquireDiagnostics(P.state.currentDomain);
      if (diag.allManuallyRejected) {
        showNoticeWithAction(
          'Все сервисы для этого сайта отмечены как отклонённые',
          'Сбросить отказы для ' + P.state.currentDomain,
          async () => {
            await RegLog.store.clearRejectedFor(P.state.currentDomain);
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
    const tab = await P.currentTab();
    const settings = await RegLog.store.getSettings();
    const payload = { mode: 'fillEmail', data: { email: outcome.session.address }, opts: { slowType: settings.slowType, watchMs: 3000 } };
    const fillOutcome = await RegLog.frames.runOnBestFrame(tab.id, payload);
    if (currentDraft.entryId && fillOutcome && fillOutcome.result) {
      await RegLog.store.updateEntry(currentDraft.entryId, { email: outcome.session.address, provider: outcome.provider.id });
    }
  }

  document.getElementById('btn-other').addEventListener('click', switchToOtherDomain);

  document.getElementById('btn-rescan').addEventListener('click', async () => {
    const tab = await P.currentTab();
    const scanResult = await RegLog.frames.runOnBestFrame(tab.id, { mode: 'scan', data: {}, opts: {} });
    renderScanSummary(scanResult);
  });

  document.getElementById('btn-save').addEventListener('click', async () => {
    if (!currentDraft) return;
    const session = await RegLog.store.getSession(P.state.currentDomain);
    await saveEntryFromActual({ username: currentDraft.username, email: session?.address, password: currentDraft.password }, session);
    P.showToast('Записано в журнал');
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

  // booted-гейт: boot() в popup/core.js уже вызывает initNewTab() напрямую перед первым
  // selectTab(...), чтобы currentDomain был готов для «Ящика», если восстанавливаемая
  // вкладка — 'inbox'. Без гейта тот же вызов initNewTab() повторился бы здесь секундой
  // позже, если восстанавливаемая вкладка — 'new'.
  P.onEnter('new', () => { if (P.state.booted) initNewTab(); });

  NEW.init = initNewTab;

})();
