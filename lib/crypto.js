(function (global) {
  'use strict';
  const RegLog = global.RegLog = global.RegLog || {};
  const rcrypto = RegLog.crypto = {};

  const ITER = 310000;
  const SALT_LEN = 16;
  const IV_LEN = 12;

  function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
  function unb64(str) { return Uint8Array.from(atob(str), c => c.charCodeAt(0)).buffer; }

  async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  let activeKey = null; // CryptoKey, живёт только в памяти текущего документа popup/panel

  rcrypto.isUnlocked = function () { return activeKey !== null; };

  function areaSession() {
    if (global.chrome && global.chrome.storage) return global.chrome.storage.session;
    return global.__mockChrome.storage.session;
  }

  // Т.к. CryptoKey нельзя положить в chrome.storage как есть, но раздел 6.6 требует
  // "ключ живёт в chrome.storage.session" — используем extractable-ключ и
  // сериализуем через crypto.subtle.exportKey('raw', ...) в storage.session,
  // импортируя обратно при каждом открытии popup/panel в рамках того же запуска браузера.
  // storage.session чистится при перезапуске браузера — это и даёт требуемое поведение
  // "при перезапуске браузера пропадает и просится заново".
  async function persistKeyToSession(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    await new Promise((resolve, reject) => areaSession().set({ __cryptoKey: b64(raw) }, () => resolve()));
  }
  async function restoreKeyFromSession() {
    const got = await new Promise((resolve) => areaSession().get('__cryptoKey', resolve));
    if (!got.__cryptoKey) return null;
    return crypto.subtle.importKey('raw', unb64(got.__cryptoKey), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  }
  async function forgetSessionKey() {
    await new Promise((resolve) => areaSession().set({ __cryptoKey: null }, () => resolve()));
  }

  rcrypto.encryptEntries = async function (entries) {
    if (!activeKey) throw new Error('нет активного ключа шифрования');
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const enc = new TextEncoder();
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, activeKey, enc.encode(JSON.stringify(entries)));
    const { salt } = await getSaltRecord();
    return { __encrypted: true, salt: b64(salt), iv: b64(iv), data: b64(ct) };
  };

  rcrypto.decryptEntries = async function (blob) {
    if (!activeKey) throw new Error('нет активного ключа шифрования');
    const dec = new TextDecoder();
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, activeKey, unb64(blob.data));
    return JSON.parse(dec.decode(pt));
  };

  function areaLocal() {
    if (global.chrome && global.chrome.storage) return global.chrome.storage.local;
    return global.__mockChrome.storage.local;
  }
  async function getSaltRecord() {
    const got = await new Promise((resolve) => areaLocal().get('__lockSalt', resolve));
    if (got.__lockSalt) return { salt: unb64(got.__lockSalt) };
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    await new Promise((resolve) => areaLocal().set({ __lockSalt: b64(salt) }, resolve));
    return { salt };
  }

  RegLog.store = RegLog.store || {};

  RegLog.store.isLocked = function () {
    return !!(RegLog._settingsCache && RegLog._settingsCache.lockEnabled) && !rcrypto.isUnlocked();
  };
  // isLocked полагается на кэш настроек, который выставляет popup.js при старте (Task 13);
  // если кэша нет — считаем незалоченным, чтобы не блокировать чтение до первого init().
  RegLog.store.__setLockEnabledCache = function (v) {
    RegLog._settingsCache = RegLog._settingsCache || {};
    RegLog._settingsCache.lockEnabled = v;
  };

  RegLog.store.unlock = async function (pass) {
    const { salt } = await getSaltRecord();
    const key = await deriveKey(pass, salt);
    const { entries } = await new Promise((resolve) => areaLocal().get('entries', resolve));
    if (entries && entries.__encrypted) {
      activeKey = key;
      try {
        await rcrypto.decryptEntries(entries); // пробный расшифровка — проверка правильности пароля
      } catch (e) {
        activeKey = null;
        throw new Error('неверный пароль');
      }
    } else {
      activeKey = key;
    }
    await persistKeyToSession(key);
    return true;
  };

  RegLog.store.lock = async function () {
    activeKey = null;
    await forgetSessionKey();
  };

  RegLog.store.enableLock = async function (pass) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    await new Promise((resolve) => areaLocal().set({ __lockSalt: b64(salt) }, resolve));
    const key = await deriveKey(pass, salt);
    activeKey = key;
    const { entries } = await new Promise((resolve) => areaLocal().get('entries', resolve));
    const plainEntries = Array.isArray(entries) ? entries : [];
    await RegLog.store.setSettings({ lockEnabled: true });
    RegLog.store.__setLockEnabledCache(true);
    await RegLog.store.writeEntries(plainEntries); // теперь шифрует, т.к. lockEnabled=true и activeKey установлен
    await persistKeyToSession(key);
  };

  RegLog.store.disableLock = async function (pass) {
    const { salt } = await getSaltRecord();
    const key = await deriveKey(pass, salt);
    const { entries } = await new Promise((resolve) => areaLocal().get('entries', resolve));
    activeKey = key;
    let plain;
    try {
      plain = entries && entries.__encrypted ? await rcrypto.decryptEntries(entries) : (entries || []);
    } catch (e) {
      activeKey = null;
      throw new Error('неверный пароль');
    }
    await RegLog.store.setSettings({ lockEnabled: false });
    RegLog.store.__setLockEnabledCache(false);
    await new Promise((resolve) => areaLocal().set({ entries: plain }, resolve));
    activeKey = null;
    await forgetSessionKey();
  };

  rcrypto.tryRestoreFromSession = async function () {
    const key = await restoreKeyFromSession();
    if (key) activeKey = key;
    return !!key;
  };

  // Патч поверх store.getEntries из storage.js — переопределяем целиком с учётом шифрования.
  const _origGetEntries = RegLog.store.getEntries;
  RegLog.store.getEntries = async function () {
    const settings = await RegLog.store.getSettings();
    const got = await new Promise((resolve) => areaLocal().get('entries', resolve));
    const entries = got.entries;
    if (settings.lockEnabled && entries && entries.__encrypted) {
      if (!rcrypto.isUnlocked()) {
        const restored = await rcrypto.tryRestoreFromSession();
        if (!restored) return { __locked: true };
      }
      return rcrypto.decryptEntries(entries);
    }
    return Array.isArray(entries) ? entries : [];
  };

})(typeof window !== 'undefined' ? window : globalThis);
