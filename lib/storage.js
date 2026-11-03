(function (global) {
  'use strict';
  const RegLog = global.RegLog = global.RegLog || {};
  const store = RegLog.store = RegLog.store || {};

  function chromeApi() {
    if (global.chrome && global.chrome.storage) return global.chrome;
    if (global.__mockChrome) return global.__mockChrome; // только для Node-тестов
    throw new Error('chrome.storage недоступен');
  }

  function area(name) {
    const c = chromeApi();
    return {
      get: (keys) => new Promise((resolve, reject) => {
        c.storage[name].get(keys, (res) => c.runtime?.lastError ? reject(c.runtime.lastError) : resolve(res));
      }),
      set: (obj) => new Promise((resolve, reject) => {
        c.storage[name].set(obj, () => c.runtime?.lastError ? reject(c.runtime.lastError) : resolve());
      }),
      getBytesInUse: (keys) => new Promise((resolve, reject) => {
        if (!c.storage[name].getBytesInUse) return resolve(0);
        c.storage[name].getBytesInUse(keys, (n) => c.runtime?.lastError ? reject(c.runtime.lastError) : resolve(n));
      })
    };
  }

  // registrableDomain — единый ключ для sessions/drafts/rejected.
  // Живёт здесь (а не в mail.js), чтобы не создавать циклическую зависимость
  // storage.js → mail.js; mail.js (Task 7) переиспользует через алиас
  // RegLog.mail.registrableDomain = RegLog.store.registrableDomain.
  const COMPOUND_TLD = new Set([
    'co.uk','org.uk','ac.uk','com.au','net.au','co.nz','co.jp','co.kr','com.br','com.mx',
    'com.ar','co.za','com.cn','com.hk','co.il','co.in','com.ua','com.sg','com.my','com.ph','co.th',
    'com.tr','gov.uk','net.uk','or.jp','ne.jp','co.id','com.tw','com.vn','com.pk','com.bd'
  ]);

  const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

  store.registrableDomain = function registrableDomain(host) {
    let h = String(host || '').toLowerCase().trim();
    h = h.replace(/:\d+$/, '');
    if (h === 'localhost' || IP_RE.test(h) || h.includes(':')) return h;
    if (h.startsWith('www.')) h = h.slice(4);
    const parts = h.split('.').filter(Boolean);
    if (parts.length <= 2) return h;
    const lastTwo = parts.slice(-2).join('.');
    if (COMPOUND_TLD.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
    return lastTwo;
  };

  // --- schemaVersion + init + миграция 1→2 -------------------------------

  const CURRENT_SCHEMA = 2;

  function migrate1to2(snapshot) {
    const out = { ...snapshot };

    if (out.mailbox && typeof out.mailbox.secret === 'string') {
      out.mailbox = {
        ...out.mailbox,
        secret: { token: out.mailbox.secret, password: null, accountId: null },
        needsReauth: true
      };
    }
    if (out.mailbox && typeof out.mailbox === 'object' && !out.sessions) {
      const domain = store.registrableDomain(out.mailbox.entryHost || 'unknown');
      out.sessions = { [domain]: out.mailbox };
      delete out.mailbox;
    }
    if (out.rejected && typeof out.rejected === 'object') {
      const merged = {};
      for (const [host, list] of Object.entries(out.rejected)) {
        const domain = store.registrableDomain(host);
        merged[domain] = Array.from(new Set([...(merged[domain] || []), ...list]));
      }
      out.rejected = merged;
    }
    // entries — без изменений, переносятся как есть.
    out.settings = { ...defaultSettings(), ...(out.settings || {}) };
    return out;
  }

  const MIGRATIONS = { 2: migrate1to2 }; // ключ — целевая версия

  function defaultSettings() {
    return {
      loginStyle: 'words', passPreset: 'strong', passLength: 20, symbols: true,
      autoSave: true, slowType: false,
      providers: ['mailtm', 'mailgw', 'maildrop', 'guerrilla', 'dustmail', 'mailcx', 'tempmaillol', 'tempmailio', 'tempmailplus'], // dropmail исключён из порядка по умолчанию — адаптер disabled (см. lib/mail.js)
      providersOff: [], lockEnabled: false
    };
  }

  let migrationBanner = null; // { kind: 'newer' | 'migration-failed' | 'quota' } | null, читается popup.js

  store.getMigrationBanner = function () { return migrationBanner; };

  // Тот же access point, которым init() читает снэпшот перед миграцией
  // (area('local').get(null)) — используется popup.js для аварийного экспорта
  // "как есть", когда schemaVersion не совпадает с CURRENT_SCHEMA и текущий код
  // не может гарантированно интерпретировать форму данных (banner.kind
  // 'newer'/'migration-failed', Task 16 fix round 2 F3-доп.).
  store.getRawSnapshot = async function () {
    return area('local').get(null);
  };

  store.init = async function init() {
    const local = area('local');
    const all = await local.get(null);
    const version = all.schemaVersion;

    if (version === undefined && Object.keys(all).length === 0) {
      await local.set({ schemaVersion: CURRENT_SCHEMA, settings: defaultSettings(), entries: [], drafts: {}, sessions: {}, rejected: {} });
      return;
    }

    if (version !== undefined && version > CURRENT_SCHEMA) {
      migrationBanner = { kind: 'newer' };
      return; // ничего не трогаем, ни одной записи в local.set
    }

    // Единая ветка миграции: version === undefined с непустым хранилищем
    // считается версией 1 (v1.1), version < CURRENT_SCHEMA — явные более
    // ранние схемы. Обе раньше жили в раздельных if с разной обработкой
    // ошибок (try/catch только на первой) — по итогам ревью Task 3 слиты
    // в один путь, чтобы гарантия "миграция не роняет init() без баннера"
    // была одинаковой для обеих исходных версий.
    if (version === undefined || version < CURRENT_SCHEMA) {
      const fromVersion = version === undefined ? 1 : version;
      try {
        let snapshot = { ...all };
        for (let v = fromVersion + 1; v <= CURRENT_SCHEMA; v++) snapshot = MIGRATIONS[v](snapshot);
        snapshot.schemaVersion = CURRENT_SCHEMA;
        await local.set(snapshot);
      } catch (e) {
        migrationBanner = { kind: 'migration-failed' };
        return; // данные не тронуты (local.set не вызван), но quota всё равно стоит проверить ниже
      }
    }

    await reconcileProviders();
    await checkQuota();
  };

  // settings.providers хранится целиком, а getSettings сливает его с дефолтами
  // поверхностным spread — значит снимок настроек, записанный до появления нового
  // адаптера, навсегда перекрывает defaultSettings() и новый провайдер не
  // появляется в списке (так пропал dustmail у пользователей, чьи настройки хоть
  // раз сохранялись раньше). Чиним на старте, а не на чтении: getSettings обязан
  // отдавать ровно то, что записали (тесты и код полагаются на сужение списка
  // через setSettings). Порядок пользователя сохраняем, недостающие id дописываем
  // в хвост, id без адаптера выкидываем, чтобы настройки не рисовали строки-призраки.
  // Список адаптеров читается лениво: в Node-тестах storage.js поднимается без
  // lib/mail.js, тогда фильтр по adapters пропускается.
  async function reconcileProviders() {
    const local = area('local');
    const { settings } = await local.get('settings');
    if (!settings) return;
    const defaults = defaultSettings().providers;
    const known = RegLog.mail && Array.isArray(RegLog.mail.adapters)
      ? new Set(RegLog.mail.adapters.map(a => a.id))
      : null;
    const seen = new Set();
    const next = [];
    for (const id of Array.isArray(settings.providers) ? settings.providers : defaults) {
      if (seen.has(id) || (known && !known.has(id))) continue;
      seen.add(id);
      next.push(id);
    }
    for (const id of defaults) {
      if (!seen.has(id)) { seen.add(id); next.push(id); }
    }
    const same = Array.isArray(settings.providers)
      && settings.providers.length === next.length
      && settings.providers.every((id, i) => id === next[i]);
    if (same) return;
    await local.set({ settings: { ...settings, providers: next } });
  }

  async function checkQuota() {
    const local = area('local');
    const used = await local.getBytesInUse(null);
    const QUOTA = 10 * 1024 * 1024;
    if (used / QUOTA > 0.8) migrationBanner = migrationBanner || { kind: 'quota' };
  }

  // --- settings / drafts / sessions / rejected / cooldown CRUD -----------

  store.getSettings = async function () {
    const { settings } = await area('local').get('settings');
    return { ...defaultSettings(), ...(settings || {}) };
  };
  store.setSettings = async function (patch) {
    const current = await store.getSettings();
    await area('local').set({ settings: { ...current, ...patch } });
  };

  const MAX_DRAFTS = 20, MAX_SESSIONS = 20;

  // writeDrafts — та же lockEnabled/isUnlocked ветка, что и writeEntries ниже;
  // черновики содержат сгенерированный пароль в открытом виде, поэтому обязаны
  // проходить через тот же крипто-шлюз, что и entries (см. Task 16 F2).
  async function writeDrafts(drafts) {
    const settings = await store.getSettings();
    if (settings.lockEnabled && RegLog.crypto) {
      // Зеркалит getEntries/listDrafts из crypto.js: перед проверкой isUnlocked() сначала
      // пробуем восстановить ключ из storage.session (например, после того как popup был
      // закрыт и открыт заново в рамках того же запуска браузера). Без этого запись могла
      // ложно считать журнал заблокированным, хотя ключ доступен, просто ещё не подтянут
      // в память этого документа (Finding 4, финальное ревью).
      if (RegLog.crypto.isUnlocked && !RegLog.crypto.isUnlocked() && RegLog.crypto.tryRestoreFromSession) {
        await RegLog.crypto.tryRestoreFromSession();
      }
      if (RegLog.crypto.isUnlocked && RegLog.crypto.isUnlocked()) {
        const blob = await RegLog.crypto.encryptEntries(drafts);
        await area('local').set({ drafts: blob });
      } else {
        throw new Error('журнал заблокирован — запись невозможна без разблокировки');
      }
    } else if (settings.lockEnabled) {
      throw new Error('журнал заблокирован — запись невозможна без разблокировки');
    } else {
      await area('local').set({ drafts });
    }
  }
  store.writeDrafts = writeDrafts;

  store.listDrafts = async function () {
    const { drafts } = await area('local').get('drafts');
    return drafts || {};
  };
  store.getDraft = async function (domain) {
    const drafts = await store.listDrafts();
    if (drafts && drafts.__locked) return null;
    return drafts[domain] || null;
  };
  store.setDraft = async function (domain, draft) {
    const drafts = await store.listDrafts();
    const map = (drafts && drafts.__locked) ? {} : drafts;
    map[domain] = { ...(map[domain] || {}), ...draft, savedAt: Date.now() };
    const keys = Object.keys(map);
    if (keys.length > MAX_DRAFTS) {
      const evictable = keys.filter(k => map[k].entryId != null && k !== domain)
        .sort((a, b) => map[a].savedAt - map[b].savedAt);
      if (evictable.length > 0) delete map[evictable[0]];
      // если все несохранённые — ничего не удаляем, карта временно превышает лимит.
    }
    await writeDrafts(map);
  };
  store.clearDraft = async function (domain) {
    const drafts = await store.listDrafts();
    const map = (drafts && drafts.__locked) ? {} : drafts;
    delete map[domain];
    await writeDrafts(map);
  };

  store.getSession = async function (domain) {
    const { sessions } = await area('local').get('sessions');
    return (sessions || {})[domain] || null;
  };
  store.setSession = async function (domain, session) {
    const { sessions } = await area('local').get('sessions');
    const map = sessions || {};
    map[domain] = { ...session, touchedAt: Date.now() };
    const keys = Object.keys(map);
    if (keys.length > MAX_SESSIONS) {
      const oldest = keys.sort((a, b) => map[a].touchedAt - map[b].touchedAt)[0];
      if (oldest !== domain) delete map[oldest];
    }
    await area('local').set({ sessions: map });
  };
  // Продлевает «последнее обращение» к ящику на диске. Нужно двум читателям
  // touchedAt: счётчику остатка TTL в попапе (иначе после переоткрытия попапа он
  // считает от момента создания и показывает 0:00 у живого ящика) и LRU-вытеснению
  // в setSession выше (иначе оно сортирует по времени создания и выбрасывает
  // активно опрашиваемый ящик вместо давно забытого).
  // Пишет только существующую сессию: воскрешать удалённую нельзя.
  store.touchSession = async function (domain) {
    const { sessions } = await area('local').get('sessions');
    const map = sessions || {};
    if (!map[domain]) return null;
    const touchedAt = Date.now();
    map[domain] = { ...map[domain], touchedAt };
    await area('local').set({ sessions: map });
    return touchedAt;
  };

  store.clearSession = async function (domain) {
    const { sessions } = await area('local').get('sessions');
    const map = sessions || {};
    delete map[domain];
    await area('local').set({ sessions: map });
  };

  store.getRejected = async function () {
    const { rejected } = await area('local').get('rejected');
    return rejected || {};
  };
  store.addRejected = async function (domain, providerId) {
    const rejected = await store.getRejected();
    rejected[domain] = Array.from(new Set([...(rejected[domain] || []), providerId]));
    await area('local').set({ rejected });
  };
  store.clearRejected = async function () {
    await area('local').set({ rejected: {} });
  };
  store.clearRejectedFor = async function (domain) {
    const rejected = await store.getRejected();
    delete rejected[domain];
    await area('local').set({ rejected });
  };

  store.getCooldown = async function () {
    const s = area('session');
    const { cooldown } = await s.get('cooldown');
    return cooldown || {};
  };
  store.setCooldown = async function (providerId, untilTs) {
    const cooldown = await store.getCooldown();
    cooldown[providerId] = untilTs;
    await area('session').set({ cooldown });
  };
  store.isCooling = async function (providerId) {
    const cooldown = await store.getCooldown();
    const until = cooldown[providerId];
    return typeof until === 'number' && until > Date.now();
  };

  // Health-check (SPEC 5.4) делается один раз на провайдера за сессию браузера,
  // поэтому отметка живёт в session-области рядом с кулдаунами: закрытие попапа
  // её не сбрасывает, перезапуск браузера — сбрасывает. Пишутся только успехи;
  // провал провайдера и так фиксируется кулдауном (см. mail.acquire).
  store.getHealthVerified = async function () {
    const { healthVerified } = await area('session').get('healthVerified');
    return healthVerified || {};
  };
  store.isHealthVerified = async function (providerId) {
    const verified = await store.getHealthVerified();
    return verified[providerId] === true;
  };
  store.markHealthVerified = async function (providerId) {
    const verified = await store.getHealthVerified();
    verified[providerId] = true;
    await area('session').set({ healthVerified: verified });
  };

  store.getSessionState = async function () {
    const { uiState } = await area('session').get('uiState');
    return uiState || {};
  };
  store.setSessionState = async function (patch) {
    const current = await store.getSessionState();
    await area('session').set({ uiState: { ...current, ...patch } });
  };

  // --- entries + writeEntries ---------------------------------------------
  // Единая точка записи журнала; учитывает lockEnabled из Task 4 (crypto.js).

  store.getEntries = async function () {
    const settings = await store.getSettings();
    const { entries } = await area('local').get('entries');
    if (!settings.lockEnabled) return entries || [];
    if (!Array.isArray(entries)) return entries; // ещё зашифровано, вызывающая сторона обязана проверить isLocked()
    return entries;
  };

  async function writeEntries(entries) {
    const settings = await store.getSettings();
    if (settings.lockEnabled && RegLog.crypto) {
      // См. комментарий в writeDrafts выше — та же симметрия с getEntries/listDrafts
      // из crypto.js (Finding 4, финальное ревью).
      if (RegLog.crypto.isUnlocked && !RegLog.crypto.isUnlocked() && RegLog.crypto.tryRestoreFromSession) {
        await RegLog.crypto.tryRestoreFromSession();
      }
      if (RegLog.crypto.isUnlocked && RegLog.crypto.isUnlocked()) {
        const blob = await RegLog.crypto.encryptEntries(entries);
        await area('local').set({ entries: blob });
      } else {
        throw new Error('журнал заблокирован — запись невозможна без разблокировки');
      }
    } else if (settings.lockEnabled) {
      throw new Error('журнал заблокирован — запись невозможна без разблокировки');
    } else {
      await area('local').set({ entries });
    }
  }
  store.writeEntries = writeEntries; // экспортируется явно, чтобы crypto-таск мог переиспользовать при enable/disable lock

  store.addEntry = async function (entry) {
    const entries = await store.getEntries();
    const list = Array.isArray(entries) ? entries : [];
    const full = { id: crypto.randomUUID(), createdAt: Date.now(), ...entry };
    list.unshift(full);
    await writeEntries(list);
    return full;
  };
  store.updateEntry = async function (id, patch) {
    const entries = await store.getEntries();
    const list = Array.isArray(entries) ? entries : [];
    const idx = list.findIndex(e => e.id === id);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...patch };
    await writeEntries(list);
    return list[idx];
  };
  store.removeEntry = async function (id) {
    const entries = await store.getEntries();
    const list = Array.isArray(entries) ? entries : [];
    const next = list.filter(e => e.id !== id);
    await writeEntries(next);
  };
  store.clearEntries = async function () {
    await writeEntries([]);
  };

  // lock/unlock/isLocked/enableLock/disableLock реализуются в Task 4
  // (crypto.js) и присваиваются на RegLog.store оттуда. storage.js только
  // резервирует точку расширения (RegLog.crypto используется выше в
  // writeEntries/getEntries) — намеренно не определены здесь.

})(typeof window !== 'undefined' ? window : globalThis);
