(function (global) {
  'use strict';
  const RegLog = global.RegLog = global.RegLog || {};
  const rcrypto = RegLog.crypto = {};

  // Параметры KDF ездят ВНУТРИ блоба (поле kdf), а не хардкодом в этом файле.
  // Иначе поднять число итераций нельзя никогда: уже записанные на диск журналы
  // начали бы выводить ключ с новым числом итераций, AES-GCM не сошёлся бы, и
  // пользователь получил бы «неверный пароль» на верном пароле — необратимо, т.к.
  // старое значение больше нигде не записано. Блоб обязан быть самоописывающимся.
  const KDF_V = 1;
  const KDF_HASH = 'SHA-256';
  const KDF_ITER = 600000;         // текущая рекомендация OWASP для PBKDF2-SHA256
  const KDF_LEGACY_ITER = 310000;  // блобы без поля kdf записаны прежним ITER
  // Границы для параметров, прочитанных с диска. Снизу — защита от подмены блоба
  // на kdf.iter: 1 (перебор пароля становится бесплатным); сверху — от подвешивания
  // документа на деривации ключа. Кто может писать в storage.local, тот может и
  // подсунуть блоб, так что «свои» данные тут не доверенные.
  const KDF_ITER_MIN = 100000;
  const KDF_ITER_MAX = 10000000;
  const KDF_HASHES = ['SHA-256', 'SHA-512'];

  const SALT_LEN = 16;
  const IV_LEN = 12;

  function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
  function unb64(str) { return Uint8Array.from(atob(str), c => c.charCodeAt(0)); }

  function defaultKdf() { return { v: KDF_V, iter: KDF_ITER, hash: KDF_HASH }; }

  // Параметры для расшифровки существующего блоба: из самого блоба, а для журналов
  // прежних версий (поля нет) — историческое значение 310000.
  function kdfFromBlob(blob) {
    const kdf = blob && blob.kdf;
    if (kdf === undefined || kdf === null) return { v: KDF_V, iter: KDF_LEGACY_ITER, hash: KDF_HASH };
    if (typeof kdf !== 'object'
      || kdf.v !== KDF_V
      || !Number.isInteger(kdf.iter) || kdf.iter < KDF_ITER_MIN || kdf.iter > KDF_ITER_MAX
      || !KDF_HASHES.includes(kdf.hash)) {
      throw new Error('неподдерживаемые параметры KDF в зашифрованном журнале');
    }
    return { v: kdf.v, iter: kdf.iter, hash: kdf.hash };
  }

  async function deriveKey(password, salt, kdf) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: kdf.iter, hash: kdf.hash },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  // Ключ живёт только в памяти текущего документа popup/panel — вместе с солью и
  // параметрами KDF, из которых он выведен. Раньше соль для блоба перечитывалась из
  // storage в момент шифрования через getSaltRecord(), а тот при пропавшей записи
  // __lockSalt МОЛЧА СОЗДАВАЛ новую: блоб уезжал с солью, не соответствующей ключу,
  // и после перезапуска расшифровать его было уже нельзя. Соль запоминается ровно в
  // момент деривации и с тех пор не перечитывается.
  let activeKey = null;
  let activeSalt = null;
  let activeKdf = null;

  function setActive(key, salt, kdf) { activeKey = key; activeSalt = salt; activeKdf = kdf; }
  function clearActive() { activeKey = null; activeSalt = null; activeKdf = null; }

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
  // Соль и параметры KDF кладутся рядом с ключом: восстановленный ключ обязан писать
  // блоб с теми же salt/kdf, иначе следующая запись рассогласует блоб с ключом.
  async function persistKeyToSession(key, salt, kdf) {
    const raw = await crypto.subtle.exportKey('raw', key);
    await new Promise((resolve) => areaSession().set({
      __cryptoKey: b64(raw), __cryptoSalt: b64(salt), __cryptoKdf: kdf
    }, () => resolve()));
  }
  async function restoreKeyFromSession() {
    const got = await new Promise((resolve) => areaSession().get(['__cryptoKey', '__cryptoSalt', '__cryptoKdf'], resolve));
    if (!got.__cryptoKey) return null;
    const key = await crypto.subtle.importKey('raw', unb64(got.__cryptoKey), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    if (got.__cryptoSalt && got.__cryptoKdf) {
      // Параметры из session валидируем тем же путём, что и дисковые: если запись
      // почему-то испорчена, лучше уйти в фолбэк ниже, чем бросить исключение из
      // tryRestoreFromSession — её зовут из getEntries/writeEntries, где ожидается
      // ответ «ключа нет», а не отказ промиса.
      try {
        return { key, salt: unb64(got.__cryptoSalt), kdf: kdfFromBlob({ kdf: got.__cryptoKdf }) };
      } catch (e) { /* фолбэк на параметры из блоба */ }
    }
    // Сессия от прежней версии: ключ есть, salt/kdf рядом с ним не лежат. Берём их
    // из самого блоба на диске — он этими параметрами и зашифрован, значит запись
    // тем же ключом останется согласованной.
    const blob = await readAnyBlob();
    if (!blob || !blob.salt) return null;
    return { key, salt: unb64(blob.salt), kdf: kdfFromBlob(blob) };
  }
  async function forgetSessionKey() {
    await new Promise((resolve) => areaSession().set({ __cryptoKey: null, __cryptoSalt: null, __cryptoKdf: null }, () => resolve()));
  }

  rcrypto.encryptEntries = async function (entries) {
    if (!activeKey) throw new Error('нет активного ключа шифрования');
    if (!activeSalt || !activeKdf) throw new Error('нет параметров KDF активного ключа — требуется повторная разблокировка');
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const enc = new TextEncoder();
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, activeKey, enc.encode(JSON.stringify(entries)));
    return { __encrypted: true, kdf: { ...activeKdf }, salt: b64(activeSalt), iv: b64(iv), data: b64(ct) };
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

  async function readStoredSalt() {
    const got = await new Promise((resolve) => areaLocal().get('__lockSalt', resolve));
    return got.__lockSalt ? unb64(got.__lockSalt) : null;
  }
  async function writeStoredSalt(salt) {
    await new Promise((resolve) => areaLocal().set({ __lockSalt: b64(salt) }, resolve));
  }
  // Читает первый попавшийся зашифрованный блоб — источник salt/kdf и материал для
  // пробной расшифровки. entries и drafts всегда шифруются одним ключом (enableLock
  // пишет оба одним set), так что любой из них описывает крипто одинаково.
  async function readAnyBlob() {
    const got = await new Promise((resolve) => areaLocal().get(['entries', 'drafts'], resolve));
    if (got.entries && got.entries.__encrypted) return got.entries;
    if (got.drafts && got.drafts.__encrypted) return got.drafts;
    return null;
  }

  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  async function canDecrypt(key, blob) {
    try {
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.data));
      return true;
    } catch (e) {
      return false;
    }
  }

  // Единая точка вывода ключа для УЖЕ существующего замка (unlock/disableLock).
  // Возвращает null только если ни один кандидат соли не расшифровал блоб — то есть
  // пароль действительно неверный. Кривые параметры KDF бросают исключение отдельно:
  // «неверный пароль» на испорченном блобе — самое вредное из возможных сообщений.
  async function deriveForExistingLock(pass) {
    const blob = await readAnyBlob();
    const storedSalt = await readStoredSalt();
    if (!blob) {
      // Расшифровывать нечего (замок только включается либо данные ещё плоские) —
      // проверить пароль не на чем, поэтому просто выводим ключ текущим KDF.
      let salt = storedSalt;
      if (!salt) {
        salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
        await writeStoredSalt(salt);
      }
      const kdf = defaultKdf();
      return { key: await deriveKey(pass, salt, kdf), salt, kdf };
    }
    const kdf = kdfFromBlob(blob);
    // Соль из блоба — первый кандидат: крипто-конверт самодостаточен, и журнал
    // остаётся расшифровываемым даже если __lockSalt потерян. __lockSalt — второй
    // кандидат, для журналов прежней версии, где в блоб могла попасть чужая соль.
    const candidates = [];
    if (blob.salt) candidates.push(unb64(blob.salt));
    if (storedSalt && !candidates.some(c => sameBytes(c, storedSalt))) candidates.push(storedSalt);
    for (const salt of candidates) {
      const key = await deriveKey(pass, salt, kdf);
      if (await canDecrypt(key, blob)) return { key, salt, kdf };
    }
    return null;
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
    const derived = await deriveForExistingLock(pass);
    if (!derived) throw new Error('неверный пароль');
    setActive(derived.key, derived.salt, derived.kdf);
    // Соль, из которой ключ реально вывелся, становится каноничной: если __lockSalt
    // потерян или разошёлся с блобом, он тут же починится. Соль не секрет.
    await writeStoredSalt(derived.salt);
    await persistKeyToSession(derived.key, derived.salt, derived.kdf);
    return true;
  };

  RegLog.store.lock = async function () {
    clearActive();
    await forgetSessionKey();
  };

  RegLog.store.enableLock = async function (pass) {
    const { entries, drafts } = await new Promise((resolve) => areaLocal().get(['entries', 'drafts'], resolve));
    // Prevent silent data loss: if entries or drafts are already encrypted, we can't
    // safely re-encrypt without the old password. Checked before anything else is
    // touched, so a throw here leaves storage completely untouched.
    if (entries && entries.__encrypted) {
      throw new Error('журнал уже зашифрован — сначала отключите шифрование');
    }
    if (drafts && drafts.__encrypted) {
      throw new Error('журнал уже зашифрован — сначала отключите шифрование');
    }
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    await writeStoredSalt(salt);
    const kdf = defaultKdf();
    const key = await deriveKey(pass, salt, kdf);
    const prevKey = activeKey, prevSalt = activeSalt, prevKdf = activeKdf;
    setActive(key, salt, kdf);
    const plainEntries = Array.isArray(entries) ? entries : [];
    const plainDrafts = (drafts && typeof drafts === 'object' && !Array.isArray(drafts)) ? drafts : {};

    // entries и drafts шифруются в памяти ПЕРЕД любой записью в storage и записываются
    // одним вызовом set({...}) — так enableLock не может оставить журнал в состоянии
    // "entries зашифрованы, drafts ещё в открытом виде" (или наоборот), если что-то
    // на середине операции пойдёт не так.
    let entriesBlob, draftsBlob;
    try {
      entriesBlob = await rcrypto.encryptEntries(plainEntries);
      draftsBlob = await rcrypto.encryptEntries(plainDrafts);
    } catch (e) {
      setActive(prevKey, prevSalt, prevKdf);
      throw e;
    }

    // Инвариант (фикс Finding 2, финальное ревью, исправлен в раунде 2 после повторного
    // ревью): lockEnabled в settings НИКОГДА не должен говорить "false", пока данные на
    // диске имеют форму зашифрованного блоба — иначе getEntries()/listDrafts() при
    // lockEnabled:false уйдут в нешифрующую ветку и отдадут блоб "как есть"
    // (`Array.isArray(blob) ? blob : []` → блоб не массив → пустой журнал), а следующий
    // addEntry/setDraft молча затрёт блоб плейн-данными — необратимая потеря.
    //
    // Этот инвариант требует от enableLock и disableLock ПРОТИВОПОЛОЖНОГО порядка двух
    // записей, а не одинакового: enableLock переводит данные из плоских в зашифрованные,
    // поэтому опасное для него — умереть между шифрованием и флипом флага, оставив
    // lockEnabled:false рядом с уже зашифрованным блобом на диске (та самая пустая-
    // журнал-ловушка выше). Значит здесь флаг должен флипаться ПЕРВЫМ, а блобы — вторым:
    // если процесс умрёт после флипа, но до записи блобов, entries/drafts на диске всё ещё
    // Array.isArray-плейн, getEntries() увидит lockEnabled:true и entries НЕ __encrypted —
    // это не тот locked-путь (не __locked-сентинел), а обычный нешифрующий возврат плейн-
    // массива как есть: то есть данные не теряются, максимум флаг временно "врёт" в
    // сторону "уже защищено", хотя блобы ещё не записаны — самоисправится следующим
    // enableLock-вызовом или просто безопасно для чтения. disableLock (ниже) идёт в
    // противоположном направлении данные→настройки по зеркальной причине — см. его
    // комментарий.
    await RegLog.store.setSettings({ lockEnabled: true });
    RegLog.store.__setLockEnabledCache(true);
    await new Promise((resolve) => areaLocal().set({ entries: entriesBlob, drafts: draftsBlob }, resolve));
    await persistKeyToSession(key, salt, kdf);
  };

  RegLog.store.disableLock = async function (pass) {
    const derived = await deriveForExistingLock(pass);
    if (!derived) throw new Error('неверный пароль');
    const { entries, drafts } = await new Promise((resolve) => areaLocal().get(['entries', 'drafts'], resolve));
    setActive(derived.key, derived.salt, derived.kdf);
    let plainEntries, plainDrafts;
    try {
      plainEntries = entries && entries.__encrypted ? await rcrypto.decryptEntries(entries) : (entries || []);
      plainDrafts = drafts && drafts.__encrypted ? await rcrypto.decryptEntries(drafts) : (drafts || {});
    } catch (e) {
      clearActive();
      throw new Error('неверный пароль');
    }
    // Данные пишутся ПЕРЕД тем, как lockEnabled станет false (порядок фикса Finding 2,
    // финальное ревью): если бы флаг флипался первым и этот set() потом не удался
    // (квота/ошибка storage), getEntries()/listDrafts() увидели бы lockEnabled:false
    // и ушли бы в нешифрующую ветку, отдав ещё-зашифрованный блоб как "как есть" —
    // не Array.isArray → выглядит как пустой журнал, а следующий addEntry молча
    // затёр бы блоб одноэлементным открытым массивом, необратимо потеряв остальное.
    // Тот же инвариант, что защищает enableLock выше (см. его развёрнутый комментарий),
    // но т.к. disableLock переводит данные из зашифрованных в плоские, а не наоборот,
    // порядок его двух записей — данные, затем настройки — намеренно противоположен
    // порядку enableLock (настройки, затем данные). Одна запись на оба ключа (entries +
    // drafts) — чтобы не оставить журнал наполовину расшифрованным при сбое посередине.
    await new Promise((resolve) => areaLocal().set({ entries: plainEntries, drafts: plainDrafts }, resolve));
    await RegLog.store.setSettings({ lockEnabled: false });
    RegLog.store.__setLockEnabledCache(false);
    clearActive();
    await forgetSessionKey();
  };

  rcrypto.tryRestoreFromSession = async function () {
    const restored = await restoreKeyFromSession();
    if (restored) setActive(restored.key, restored.salt, restored.kdf);
    return !!restored;
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

  // Патч поверх store.listDrafts из storage.js — тот же приём, что и для getEntries
  // выше: черновики содержат пароль в открытом виде, поэтому проходят через тот же
  // шифрующий шлюз. store.getDraft/setDraft/clearDraft в storage.js читают текущее
  // значение через store.listDrafts() динамически, так что переопределение здесь
  // подхватывается ими без отдельных патчей.
  const _origListDrafts = RegLog.store.listDrafts;
  RegLog.store.listDrafts = async function () {
    const settings = await RegLog.store.getSettings();
    const got = await new Promise((resolve) => areaLocal().get('drafts', resolve));
    const drafts = got.drafts;
    if (settings.lockEnabled && drafts && drafts.__encrypted) {
      if (!rcrypto.isUnlocked()) {
        const restored = await rcrypto.tryRestoreFromSession();
        if (!restored) return { __locked: true };
      }
      return rcrypto.decryptEntries(drafts);
    }
    return (drafts && typeof drafts === 'object' && !Array.isArray(drafts)) ? drafts : {};
  };

})(typeof window !== 'undefined' ? window : globalThis);
