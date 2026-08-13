// popup/core.js
//
// Общая инфраструктура попапа: переключение вкладок, разделяемое состояние
// (currentDomain, режим панели, признак «загрузка завершена»), утилиты, нужные
// более чем одной вкладке (копирование, тост, подписи провайдера/TTL, разбор
// ошибок разблокировки), и boot().
//
// Каждая вкладка — отдельный файл (popup/new.js, popup/inbox.js, popup/log.js,
// popup/settings.js), который регистрируется здесь через onEnter/onLeave вместо
// того, чтобы патчить чужую функцию поверх (тем приёмом раньше была собрана
// selectTab, и порядок загрузки становился скрытым контрактом — тот же риск,
// от которого страдает порядок lib/*.js, см. script-order.test.mjs).
//
// popup.html подключает этот файл первым среди popup/*.js: остальные читают
// RegLog.popup.* при регистрации своих обработчиков.
(function () {
  'use strict';

  const P = RegLog.popup = RegLog.popup || {};

  P.panes = { new: '#pane-new', inbox: '#pane-inbox', log: '#pane-log', settings: '#pane-settings' };
  P.tabs = { new: '#tab-new', inbox: '#tab-inbox', log: '#tab-log', settings: '#tab-settings' };

  // currentDomain читают «Новый» (пишет) и «Ящик» (читает своя сессия домена).
  // currentDraft остаётся приватным для popup/new.js — ни «Ящик», ни «Журнал»,
  // ни «Настройки» его не используют.
  P.state = { currentDomain: null, booted: false };

  P.isPanel = new URLSearchParams(location.search).get('panel') === '1';
  if (P.isPanel) document.body.classList.add('panel');
  document.getElementById('btn-panel').hidden = P.isPanel;

  const enterHandlers = {};
  const leaveHandlers = {};
  P.onEnter = function (name, fn) { enterHandlers[name] = fn; };
  P.onLeave = function (name, fn) { leaveHandlers[name] = fn; };

  let activeTabName = 'new'; // соответствует aria-selected="true" на #tab-new в разметке
  P.activeTab = function activeTab() { return activeTabName; };
  P.selectTab = function selectTab(name) {
    if (!Object.prototype.hasOwnProperty.call(P.tabs, name)) return;
    if (activeTabName !== name && leaveHandlers[activeTabName]) leaveHandlers[activeTabName]();
    for (const key of Object.keys(P.panes)) {
      document.querySelector(P.panes[key]).hidden = key !== name;
      const tab = document.querySelector(P.tabs[key]);
      tab.setAttribute('aria-selected', String(key === name));
      tab.tabIndex = key === name ? 0 : -1;
    }
    activeTabName = name;
    RegLog.store.setSessionState({ activeTab: name });
    if (enterHandlers[name]) enterHandlers[name]();
  };

  for (const key of Object.keys(P.tabs)) {
    const tab = document.querySelector(P.tabs[key]);
    tab.addEventListener('click', () => P.selectTab(key));
    tab.addEventListener('keydown', event => {
      const keys = Object.keys(P.tabs);
      const index = keys.indexOf(key);
      let target;
      if (event.key === 'Home') target = keys[0];
      else if (event.key === 'End') target = keys[keys.length - 1];
      else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = keys[(index + 1) % keys.length];
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = keys[(index - 1 + keys.length) % keys.length];
      else return;
      event.preventDefault();
      P.selectTab(target);
      document.querySelector(P.tabs[target]).focus();
    });
  }

  P.currentTab = async function currentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  };

  P.labelFor = function labelFor(providerId) {
    const a = RegLog.mail.adapters.find(x => x.id === providerId);
    return a ? a.label : providerId;
  };

  // Подпись TTL считается из adapter.sessionTtlMs, а не пишется цифрой: у dustmail
  // 30 минут, и раньше все три подписи хардкодили «10 мин» от старого DropMail.
  P.ttlMinutes = function ttlMinutes(adapter) {
    return Math.round(adapter.sessionTtlMs / 60000);
  };

  P.copyText = async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  };

  // Общий busy-хелпер для любой вкладки: запоминает исходную подпись кнопки в
  // dataset (переживает повторные вызовы setBusy(true) без потери исходного текста),
  // блокирует её и ставит aria-busy, чтобы состояние было видно и в разметке, и
  // скринридеру, не только через disabled.
  P.setBusy = function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
      button.disabled = true;
      button.classList.add('is-loading');
      button.setAttribute('aria-busy', 'true');
      if (label) button.textContent = label;
      return;
    }
    button.disabled = false;
    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
  };

  P.showToast = function showToast(text) {
    const toast = document.getElementById('toast');
    toast.textContent = text; toast.hidden = false;
    document.getElementById('live').textContent = text;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, 1200);
  };

  // store.unlock/store.disableLock бросают ровно «неверный пароль», когда пароль не
  // подошёл, и что-то другое, когда сломан сам замок — например параметры KDF в блобе
  // вне принимаемого диапазона (crypto.js). Раньше popup показывал «Неверный пароль» на
  // оба случая: человек перебирал верный пароль, не понимая, что дело не в пароле.
  // Общие для «Журнала» (разблокировка) и «Настроек» (отключение защиты).
  P.isWrongPassword = function isWrongPassword(err) {
    return /неверный пароль/i.test(String((err && err.message) || ''));
  };
  P.errText = function errText(err) {
    return String((err && err.message) || 'неизвестная ошибка');
  };

  document.getElementById('btn-panel').addEventListener('click', async () => {
    const tab = await P.currentTab();
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
        RegLog.popup.log.downloadJson(snapshot);
      });
      el.appendChild(btn);
    } else if (banner.kind === 'quota') {
      el.appendChild(document.createTextNode('Хранилище почти заполнено (свыше 80% квоты). Освободи место — удали старые записи журнала или выгрузи и очисти его.'));
    }
  }

  P.boot = async function boot() {
    document.body.setAttribute('aria-busy', 'true');
    await RegLog.store.init();
    renderSchemaBanner();
    const state = await RegLog.store.getSessionState();
    // currentDomain должен быть разрешён ДО selectTab(...): если восстанавливаемая
    // вкладка — 'inbox', её onEnter безусловно вызывает initInboxTab(), которому нужен
    // уже установленный P.state.currentDomain (иначе getSession(null) вернёт null и
    // покажет "нет адреса" вместо реального ящика — см. фикс-раунд Task 11).
    await RegLog.popup.new.init();
    P.selectTab(state.activeTab || 'new');
    P.state.booted = true;
    document.body.removeAttribute('aria-busy');
  };

})();
