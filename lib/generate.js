(function (global) {
  'use strict';
  const RegLog = global.RegLog = global.RegLog || {};
  const gen = RegLog.gen = {};

  const ADJ = ['swift','amber','harbor','pine','orbit','quiet','coral','maple','flint','cedar',
    'brisk','ember','glacier','ivory','jade','keen','lunar','marsh','nova','onyx',
    'plume','quartz','ridge','sable','tidal','umber','vivid','willow','xenon','yonder',
    'zephyr','ashen','birch','cobalt','drift','ferrous','granite','husk','indigo','juniper',
    'karst','lichen','mossy','nimbus','opal','petrel','quill','raven','slate','thistle',
    'ursine','vale','wren','xylem','yarrow','zinc','bramble','copse','dune','fenwick'];

  const NOUN = ['meadow','pine','orbit','ridge','marsh','cove','glen','ford','vale','birch',
    'cedar','delta','ember','fjord','grove','heath','islet','knoll','loch','mesa',
    'nook','oasis','peak','quay','reef','spire','tor','urn','vault','weir',
    'yard','zone','arch','bay','crag','thicket','eddy','field','gulf','holt',
    'isle','jetty','kiln','lagoon','moor','nave','oak','path','quarry','ravine',
    'shore','trail','upland','vista','well','yield','arbor','bluff','cape','dell'];

  const FIRST = ['Alex','Jordan','Taylor','Morgan','Casey','Riley','Avery','Quinn','Reese','Skyler',
    'Drew','Emerson','Rowan','Sawyer','Blake','Cameron','Dakota','Elliot','Finley','Harper',
    'Jamie','Kendall','Logan','Marley','Nico','Parker','Peyton','Robin','Sage','Tatum',
    'Adrian','Bailey','Carmen','Denver','Ellis','Frankie','Grey','Hollis','Ira','Jules'];

  const LAST = ['Bennett','Carter','Dawson','Ellison','Fletcher','Garrison','Hawthorne','Ingram','Jasper','Kestrel',
    'Lambert','Marsh','Norwood','Osgood','Prescott','Quincey','Ridgeway','Sutter','Thorne','Underwood',
    'Vance','Winslow','Yates','Ashford','Bramwell','Croft','Delaney','Everton','Farrow','Gable',
    'Holloway','Ives','Jennings','Kirby','Lockhart','Merrick','Nash','Orson','Pemberton','Quill'];

  gen.randomInt = function randomInt(max) {
    if (max <= 0 || max > 0x100000000) throw new RangeError('max');
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    let v;
    do { crypto.getRandomValues(buf); v = buf[0]; } while (v >= limit);
    return v % max;
  };

  gen.pick = function pick(array) {
    return array[gen.randomInt(array.length)];
  };

  gen.shuffle = function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = gen.randomInt(i + 1);
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  };

  const LOWER = 'abcdefghjkmnpqrstuvwxyz';        // без l
  const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';         // без I, O
  const DIGIT = '23456789';                        // без 0, 1
  const SYMBOL = '!@#$%^&*-_=+?';

  function buildAlphabetClasses(symbols) {
    const classes = [LOWER, UPPER, DIGIT];
    if (symbols) classes.push(SYMBOL);
    return classes;
  }

  gen.password = function password(len, symbols) {
    const classes = buildAlphabetClasses(symbols);
    const alphabet = classes.join('');
    const chars = [];
    // Гарантируем по одному символу на класс, но не больше len классов —
    // иначе при len меньше числа активных классов результат выходит длиннее len
    // (это был баг ревью Task 2: password(2,false) возвращал 3 символа вместо 2).
    const guaranteed = classes.slice(0, Math.min(classes.length, len));
    for (const cls of guaranteed) chars.push(cls[gen.randomInt(cls.length)]);
    while (chars.length < len) chars.push(alphabet[gen.randomInt(alphabet.length)]);
    return gen.shuffle(chars).slice(0, len).join('');
  };

  // Внутренние пресеты — не вешаются на RegLog.gen: публичный контракт модуля
  // ограничен восемью функциями из §4 спеки (randomInt/pick/shuffle/password/
  // passwordForPolicy/username/sanitizeLocalPart/personName), лишний экспорт
  // gen.PRESETS был снят по итогам ревью Task 2.
  const PRESETS = {
    strong: { len: 20, symbols: true },
    safe: { len: 16, symbols: false }
  };

  gen.passwordForPolicy = function passwordForPolicy(policy) {
    if (policy === 'legacy') {
      const chars = [UPPER[gen.randomInt(UPPER.length)], DIGIT[gen.randomInt(DIGIT.length)]];
      while (chars.length < 12) chars.push(LOWER[gen.randomInt(LOWER.length)]);
      return gen.shuffle(chars).join('');
    }
    const p = PRESETS[policy] || PRESETS.strong;
    return gen.password(p.len, p.symbols);
  };

  gen.username = function username(style) {
    const a = gen.pick(ADJ), n = gen.pick(NOUN), num = gen.randomInt(90) + 10;
    const cap = s => s[0].toUpperCase() + s.slice(1);
    if (style === 'words') return `${a}${n}${num}`;
    if (style === 'short') return `${a}${cap(n)}${num}`;
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 12; i++) s += alphabet[gen.randomInt(alphabet.length)];
    return s;
  };

  gen.sanitizeLocalPart = function sanitizeLocalPart(str, opts) {
    const { maxLen = 32, allowDot = true, minEntropyChars = 0 } = opts || {};
    const allowed = allowDot ? /[^a-z0-9.\-_]/g : /[^a-z0-9\-_]/g;
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    // Схлопнуть повторы разделителей и срезать их с краёв. Выделено в функцию,
    // потому что применяется дважды: до обрезки и после — обрезка базы может
    // приземлиться ровно на разделитель и дать 'foo-' + '-' + суффикс = 'foo--…'.
    const trimSeps = s => s.replace(/([.\-_])\1+/g, '$1').replace(/^[.\-_]+|[.\-_]+$/g, '');

    // Бюджет базовой части: место под '-' и энтропийный суффикс резервируется ДО
    // конкатенации. Раньше база резалась до maxLen, суффикс дописывался сверху, а
    // финальный slice(0, maxLen) срезал именно суффикс — то есть ровно ту энтропию,
    // которая у publicInbox-провайдеров (Maildrop, §5) единственная защита ящика:
    // читать его может любой, кто угадает имя, а словарь имён лежит в исходниках.
    const reserve = minEntropyChars > 0 ? minEntropyChars + 1 : 0; // +1 на разделитель
    const baseMax = maxLen - reserve;
    if (minEntropyChars > 0 && baseMax < 1) {
      throw new RangeError(`maxLen=${maxLen} не вмещает minEntropyChars=${minEntropyChars} (нужно минимум ${minEntropyChars + 2})`);
    }

    let s = trimSeps(String(str || '').toLowerCase().replace(allowed, ''));
    if (s.length > baseMax) s = trimSeps(s.slice(0, baseMax));
    // Добивка до минимальных 6 символов (§4.4) не имеет права съесть бюджет суффикса.
    const minBase = Math.min(6, baseMax);
    while (s.length < minBase) s += alphabet[gen.randomInt(alphabet.length)];
    if (minEntropyChars <= 0) return s;

    let suffix = '';
    for (let i = 0; i < minEntropyChars; i++) suffix += alphabet[gen.randomInt(alphabet.length)];
    const out = `${s}-${suffix}`;
    // Инвариант вместо тихой деградации: если арифметика бюджета когда-нибудь
    // разъедется, лучше упасть здесь, чем отдать наружу публичный ящик с
    // предсказуемым именем и обрезанной энтропией.
    if (out.length > maxLen || out.slice(-minEntropyChars) !== suffix) {
      throw new RangeError(`энтропийный суффикс усечён: длина ${out.length} при maxLen=${maxLen}`);
    }
    return out;
  };

  gen.personName = function personName() {
    const first = gen.pick(FIRST), last = gen.pick(LAST);
    return { first, last, full: `${first} ${last}` };
  };

})(typeof window !== 'undefined' ? window : globalThis);
