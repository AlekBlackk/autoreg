import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installMockChrome } from './_mockChrome.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mailsDir = join(here, '..', 'mails');

const generatePath = fileURLToPath(new URL('../../lib/generate.js', import.meta.url));
const storagePath = fileURLToPath(new URL('../../lib/storage.js', import.meta.url));
const mailPath = fileURLToPath(new URL('../../lib/mail.js', import.meta.url));
const generateSource = readFileSync(generatePath, 'utf8');
const storageSource = readFileSync(storagePath, 'utf8');
const mailSource = readFileSync(mailPath, 'utf8');

function loadModules() {
  new Function(generateSource)();
  new Function(storageSource)();
  new Function(mailSource)();
}

async function freshMail() {
  installMockChrome();
  delete globalThis.RegLog;
  loadModules();
  await globalThis.RegLog.store.init();
  return globalThis.RegLog;
}

test('extract matches expect on all 10 sample mails, with at most one low-confidence correct code', async () => {
  const RegLog = await freshMail();
  const { extract } = RegLog.mail;
  const files = readdirSync(mailsDir).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 10);
  let lowConfidenceCount = 0;
  for (const f of files) {
    const sample = JSON.parse(readFileSync(join(mailsDir, f), 'utf8'));
    const result = extract({ text: sample.text, html: sample.html });
    assert.equal(result.code, sample.expect.code, `code mismatch in ${f}`);
    assert.equal(result.link, sample.expect.link, `link mismatch in ${f}`);
    if (result.code && result.confidence === 'low') lowConfidenceCount++;
  }
  assert.ok(lowConfidenceCount <= 1, `too many low-confidence correct codes: ${lowConfidenceCount}`);
});

test('extract never returns a javascript: or data: link', async () => {
  const RegLog = await freshMail();
  const { extract } = RegLog.mail;
  const sample = JSON.parse(readFileSync(join(mailsDir, '08-javascript-link.json'), 'utf8'));
  const result = extract({ text: sample.text, html: sample.html });
  assert.equal(result.link, null);
});

// В node глобального DOMParser нет, поэтому по умолчанию extract идёт регэксп-ветвью.
// Стаб включает вторую (браузерную) ветвь: он умеет ровно то, чем extract пользуется —
// querySelectorAll('a[href]') и getAttribute('href'), уже с раскрытыми сущностями,
// как настоящий DOM. Обе ветви обязаны отдавать наружу одинаково безопасный адрес.
function withFakeDOMParser(fn) {
  const decode = (s) => s.replace(/&amp;/gi, '&').replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)));
  globalThis.DOMParser = class {
    parseFromString(html) {
      const anchors = [];
      const re = /<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const href = decode(m[1]);
        anchors.push({ getAttribute: (k) => (k === 'href' ? href : null) });
      }
      return {
        body: { textContent: html.replace(/<[^>]+>/g, ' ') },
        querySelectorAll: (sel) => (sel === 'a[href]' ? anchors : [])
      };
    }
  };
  try { return fn(); } finally { delete globalThis.DOMParser; }
}

const BRANCHES = [
  ['регэксп-ветвь', (fn) => fn()],
  ['DOMParser-ветвь', withFakeDOMParser]
];

for (const [branchName, inBranch] of BRANCHES) {
  test(`extract (${branchName}) не отдаёт относительный href: открыть его нечем`, async () => {
    const RegLog = await freshMail();
    inBranch(() => {
      const html = '<p>Подтвердите</p><p><a href="/confirm?token=abc123">Подтвердить</a></p>';
      assert.equal(RegLog.mail.extract({ text: 'Подтвердите почту', html }).link, null);
      const protoRelative = '<p><a href="//example.com/confirm?token=abc">Подтвердить</a></p>';
      assert.equal(RegLog.mail.extract({ text: 'Подтвердите почту', html: protoRelative }).link, null);
    });
  });

  test(`extract (${branchName}) отбирает схему по белому списку, не по чёрному`, async () => {
    const RegLog = await freshMail();
    inBranch(() => {
      for (const href of ['vbscript:confirm()', 'file:///etc/passwd', 'chrome://settings/?confirm=1', 'blob:https://a.test/confirm']) {
        const html = `<p><a href="${href}">Подтвердить</a></p>`;
        assert.equal(RegLog.mail.extract({ text: 'Подтвердите', html }).link, null, `пропущено: ${href}`);
      }
    });
  });

  test(`extract (${branchName}) отдаёт href с раскрытыми сущностями`, async () => {
    const RegLog = await freshMail();
    inBranch(() => {
      const html = '<p><a href="https://a.test/confirm?token=1&amp;u=2">Подтвердить</a></p>';
      assert.equal(RegLog.mail.extract({ text: 'Подтвердите', html }).link, 'https://a.test/confirm?token=1&u=2');
    });
  });

  test(`extract (${branchName}) не даёт табу/переводу строки склеить схему обратно`, async () => {
    const RegLog = await freshMail();
    inBranch(() => {
      const html = '<p><a href="java\tscript:confirmAccount()">Подтвердить</a></p>';
      assert.equal(RegLog.mail.extract({ text: 'Подтвердите', html }).link, null);
    });
  });

  test(`extract (${branchName}): любой возвращённый link — абсолютный http(s) URL`, async () => {
    const RegLog = await freshMail();
    inBranch(() => {
      const htmls = [
        ...readdirSync(mailsDir).filter(f => f.endsWith('.json'))
          .map(f => JSON.parse(readFileSync(join(mailsDir, f), 'utf8'))),
        { text: 'Подтвердите', html: '<a href="/confirm?token=a">x</a>' },
        { text: 'Подтвердите', html: '<a href="confirm?token=a">x</a>' },
        { text: 'Подтвердите', html: '<a href="  https://a.test/confirm?token=a  ">x</a>' },
        { text: 'Подтвердите', html: '<a href="javascript:confirm()">x</a>' }
      ];
      for (const sample of htmls) {
        const { link } = RegLog.mail.extract({ text: sample.text, html: sample.html });
        if (link === null) continue;
        const url = new URL(link); // абсолютный — иначе бросит, и тест упадёт по делу
        assert.ok(url.protocol === 'https:' || url.protocol === 'http:', `схема ${url.protocol} в ${link}`);
        assert.equal(link, url.href, 'наружу должен уходить нормализованный URL, а не сырой href');
      }
    });
  });
}
