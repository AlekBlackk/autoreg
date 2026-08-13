// test/node/_popupDom.mjs
//
// Минимальный фейковый DOM + фейковый RegLog, чтобы popup-код можно было выполнить
// в node без браузера и jsdom и проверять его поведение (а не исходник регэкспами,
// как это делает script-order.test.mjs — тот приём не видит утечек таймеров и
// необработанных reject'ов).
//
// Код попапа живёт в popup/core.js + popup/{new,inbox,log,settings}.js + popup.js —
// тех же файлах и в том же порядке, что подключает popup.html (см. POPUP_FILES ниже).
// Каждый файл — IIFE со 'use strict' внутри, поэтому все глобальные имена, которые они
// читают (document/location/chrome/RegLog/таймеры/confirm/addEventListener), можно
// подсунуть параметрами одного общего new Function на все файлы разом — точно так же,
// как в браузере несколько <script> подряд делят один и тот же глобальный объект.
// URL/URLSearchParams/Date намеренно НЕ подменяются — берутся настоящие из node.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Элементы, которые в popup.html размечены hidden: авто-создаваемый элемент иначе
// стартовал бы видимым и тесты на «осталось скрытым» ничего бы не проверяли.
const HIDDEN_IN_MARKUP = new Set([
  'schema-banner', 'notice', 'frames-block', 'mail-body', 'mail-code', 'log-more',
  'export-modal', 'log-unlock', 'log-unlock-error', 'inbox-error', 'set-lock-form', 'set-lock-error',
  'set-disable-lock-form', 'set-disable-lock-error', 'set-clear-form', 'toast', 'inbox-badge',
  'pane-inbox', 'pane-log', 'pane-settings'
]);

class FakeElement {
  constructor(tagName, id) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.id = id || '';
    this.children = [];
    this.parentNode = null;
    this.hidden = HIDDEN_IN_MARKUP.has(this.id);
    this.className = '';
    this.type = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.title = '';
    this.href = '';
    this.download = '';
    this.style = {};
    this.dataset = {};
    this._text = '';
    this._attrs = new Map();
    this._listeners = new Map();
    const self = this;
    this.classList = {
      add(...cs) {
        for (const c of cs) if (!self._classes().includes(c)) self.className = (self.className ? self.className + ' ' : '') + c;
      },
      remove(...cs) { self.className = self._classes().filter(c => !cs.includes(c)).join(' '); },
      contains(c) { return self._classes().includes(c); }
    };
  }

  _classes() { return this.className ? this.className.split(/\s+/).filter(Boolean) : []; }

  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }

  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  removeChild(node) { this.children = this.children.filter(c => c !== node); node.parentNode = null; return node; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  after(node) {
    const p = this.parentNode;
    if (!p) return;
    node.parentNode = p;
    p.children.splice(p.children.indexOf(this) + 1, 0, node);
  }

  setAttribute(k, v) { this._attrs.set(k, String(v)); }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  removeAttribute(k) { this._attrs.delete(k); }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  // Возвращает promise на случай async-обработчика, но popup.js часто вешает
  // `() => someAsyncFn()` и промис никто не ждёт — именно поэтому тестам нужен
  // ещё и учёт unhandledRejection (см. loadPopup).
  dispatch(type, init) {
    const ev = { type, target: this, altKey: false, preventDefault() {}, stopPropagation() {}, ...(init || {}) };
    return Promise.all((this._listeners.get(type) || []).map(fn => fn(ev)));
  }
  click() { return this.dispatch('click'); }
  querySelectorAll() { return []; }
}

function makeDocument() {
  const byId = new Map();
  const doc = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeElement('div', id));
      return byId.get(id);
    },
    querySelector(sel) { return sel.startsWith('#') ? doc.getElementById(sel.slice(1)) : null; },
    querySelectorAll() { return []; },
    createElement(tag) { return new FakeElement(tag, ''); },
    createTextNode(s) { return { nodeType: 3, textContent: String(s), children: [], parentNode: null }; },
    body: new FakeElement('body', '')
  };
  return doc;
}

const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

const tick = () => new Promise(r => setImmediate(r));

export async function loadPopup(opts = {}) {
  unhandled.length = 0;

  const doc = makeDocument();
  const session = opts.session === undefined
    ? { address: 'ivan@dust.test', provider: 'dustmail', touchedAt: Date.now() }
    : opts.session;
  const settings = {
    loginStyle: 'words', passPreset: 'strong', passLength: 20, symbols: true,
    autoSave: false, slowType: false, lockEnabled: false,
    providers: ['dustmail'], providersOff: [], ...(opts.settings || {})
  };
  let entries = opts.entries || [];

  const adapter = {
    id: 'dustmail', label: 'DustMail', sessionTtlMs: 30 * 60000, publicInbox: false,
    async list() { return opts.messages || []; },
    async read() { return { text: 'привет', html: '' }; }
  };

  // Учёт таймеров: фейковые setInterval/setTimeout ничего не выполняют (иначе тесты
  // зависели бы от реального времени), но остаются наблюдаемыми — размер intervals
  // и есть «сколько тикающих таймеров живёт прямо сейчас».
  let nextTimerId = 1;
  const intervals = new Map();
  const timeouts = new Map();

  const state = {
    pollStarts: 0, pollStops: 0, pollCb: null,
    // confirmAnswer/confirmCalls: нативный confirm() из попапа выпилен (может умереть
    // вместе с попапом при потере фокуса), но заглушка остаётся — тесты проверяют
    // именно то, что popup.js её НЕ зовёт.
    confirmAnswer: true, confirmCalls: 0,
    removeEntryCalls: 0, addEntryCalls: 0, clearEntriesCalls: 0,
    createdTabs: []
  };

  const store = {
    async init() {},
    getMigrationBanner() { return null; },
    async getSessionState() { return { activeTab: opts.activeTab || 'new' }; },
    setSessionState() {},
    registrableDomain(host) { return host; },
    async getDraft() { return opts.draft || null; },
    async setDraft() {},
    async getSettings() { return { ...settings }; },
    async setSettings(patch) { Object.assign(settings, patch); },
    async getSession() { return session; },
    async touchSession() {},
    async getEntries() { return entries; },
    async addEntry(e) { state.addEntryCalls++; entries = [{ ...e, id: e.id || 'gen-id' }, ...entries]; return entries[0]; },
    async updateEntry() {},
    async removeEntry(id) { state.removeEntryCalls++; entries = entries.filter(e => e.id !== id); },
    async getRejected() { return {}; },
    async clearRejected() {},
    async clearRejectedFor() {},
    async clearEntries() { state.clearEntriesCalls++; entries = []; },
    isLocked() { return false; },
    async unlock() {},
    async enableLock() {},
    async disableLock() {}
  };

  const RegLog = {
    store,
    crypto: { isUnlocked: () => true, async tryRestoreFromSession() {} },
    gen: {
      personName: () => ({ full: 'Иван Иванов' }),
      username: () => 'ivan',
      password: (len) => 'p'.repeat(len || 20),
      passwordForPolicy: () => 'pass1234'
    },
    frames: {
      async runOnBestFrame() { return { result: { found: { name: true, username: true, email: true, password: true, confirm: false } } }; },
      async needsFrameAccess() { return false; },
      async listGrantedOrigins() { return []; },
      async requestWebNavigation() { return false; },
      async listChildOrigins() { return []; },
      async requestOrigins() { return false; },
      async revokeOrigin() {},
      async revokeWebNavigation() {}
    },
    mail: {
      adapters: [adapter],
      decodeEntities: (s) => (s == null ? '' : String(s)),
      extract: opts.extract || (() => ({ code: null, link: null, confidence: 'high' })),
      async acquire() { return null; },
      async next() { return null; },
      async acquireDiagnostics() { return { allManuallyRejected: false }; },
      poll(domain, sess, cb) {
        state.pollStarts++;
        state.pollCb = cb;
        return () => { state.pollStops++; };
      }
    },
    ...(opts.regLog || {})
  };

  const chrome = {
    tabs: {
      async query() { return [{ id: 1, url: opts.url || 'https://example.com/signup' }]; },
      // Записываем аргументы: «что именно попап отправил в новую вкладку» — предмет
      // проверки в тестах про ссылку из письма (открыться должно ровно то, что видно).
      create(o) { state.createdTabs.push(o); }
    },
    sidePanel: { async open() {} }
  };

  const injected = {
    document: doc,
    location: { search: opts.panel ? '?panel=1' : '' },
    chrome,
    RegLog,
    navigator: { clipboard: { async writeText() {} } },
    confirm: () => { state.confirmCalls++; return state.confirmAnswer; },
    alert: () => {},
    addEventListener: () => {},
    setInterval: (fn, ms) => { const id = nextTimerId++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    setTimeout: (fn, ms) => { const id = nextTimerId++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
    DOMParser: class { parseFromString() { return { body: { textContent: '' }, querySelectorAll: () => [] }; } },
    Blob: class {}
  };

  const POPUP_FILES = [
    'popup/core.js', 'popup/new.js', 'popup/inbox.js', 'popup/log.js', 'popup/settings.js', 'popup.js'
  ];
  const src = POPUP_FILES
    .map(f => readFileSync(fileURLToPath(new URL(`../../${f}`, import.meta.url)), 'utf8'))
    .join('\n;\n');
  const names = Object.keys(injected);
  new Function(...names, src)(...names.map(n => injected[n]));

  // boot() снимает aria-busy последним делом — ждём именно этого, а не «пары тиков».
  for (let i = 0; i < 200 && doc.body.getAttribute('aria-busy') !== null; i++) await tick();

  return {
    doc,
    state,
    adapter,
    store,
    unhandled,
    tick,
    el: (id) => doc.getElementById(id),
    activeIntervals: () => intervals.size,
    pendingTimeouts: () => timeouts.size,
    // Прогоняет отложенный колбэк setTimeout вручную (фейковые таймеры сами не тикают).
    runTimeouts() {
      const pending = [...timeouts.entries()];
      timeouts.clear();
      for (const [, t] of pending) t.fn();
    },
    async clickTab(name) { await doc.getElementById(`tab-${name}`).click(); await tick(); await tick(); },
    async click(el, init) { await el.dispatch('click', init); await tick(); await tick(); },
    async emitBatch(batch) { state.pollCb(batch); await tick(); },
    async emitMail(messages) { state.pollCb({ ok: true, messages }); await tick(); },
    toastText: () => doc.getElementById('toast').textContent,
    liveText: () => doc.getElementById('live').textContent,
    mailRows: () => doc.getElementById('mail-list').children.filter(c => c.className && c.className.includes('mail-row')),
    logRows: () => doc.getElementById('log-list').children.filter(c => c.className === 'log-row'),
    // Транзиентные плашки журнала: подтверждение удаления и «Отменить». Ищем по классу
    // среди детей #log-list — количество плашек и есть предмет проверки в тестах
    // (две плашки одного вида = утечка DOM).
    confirmBars: () => doc.getElementById('log-list').children.filter(c => c.className === 'confirm-bar'),
    undoBars: () => doc.getElementById('log-list').children.filter(c => c.className === 'undo-bar'),
    // Кнопка внутри плашки по её подписи: плашки собираются в popup.js, стабильных id у них нет.
    barButton: (bar, label) => bar.children.find(c => c.tagName === 'BUTTON' && c.textContent === label)
  };
}
