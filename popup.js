(function () {
  'use strict';

  const panes = { new: '#pane-new', inbox: '#pane-inbox', log: '#pane-log', settings: '#pane-settings' };
  const tabs = { new: '#tab-new', inbox: '#tab-inbox', log: '#tab-log', settings: '#tab-settings' };

  function selectTab(name) {
    for (const key of Object.keys(panes)) {
      document.querySelector(panes[key]).hidden = key !== name;
      document.querySelector(tabs[key]).setAttribute('aria-selected', String(key === name));
    }
    RegLog.store.setSessionState({ activeTab: name });
  }

  for (const key of Object.keys(tabs)) {
    document.querySelector(tabs[key]).addEventListener('click', () => selectTab(key));
  }

  const isPanel = new URLSearchParams(location.search).get('panel') === '1';
  if (isPanel) document.body.classList.add('panel');
  document.getElementById('btn-panel').hidden = isPanel;

  async function boot() {
    document.body.setAttribute('aria-busy', 'true');
    await RegLog.store.init();
    const state = await RegLog.store.getSessionState();
    selectTab(state.activeTab || 'new');
    document.body.removeAttribute('aria-busy');
    // Остальная инициализация вкладок добавляется в Tasks 10-14.
  }

  boot();
})();
