// popup/settings.js
//
// Вкладка «Настройки»: генерация, порядок и включение почтовых сервисов, доступ
// к фреймам, защита журнала мастер-паролем, очистка журнала. Регистрируется в
// popup/core.js через onEnter.
(function () {
  'use strict';

  const P = RegLog.popup;

  async function initSettingsTab() {
    const settings = await RegLog.store.getSettings();
    document.getElementById('set-loginStyle').value = settings.loginStyle;
    document.getElementById('set-passPreset').value = settings.passPreset;
    document.getElementById('set-passLength').value = settings.passLength;
    document.getElementById('set-passLength-val').textContent = settings.passLength;
    document.getElementById('set-symbols').checked = settings.symbols;
    document.getElementById('set-autoSave').checked = settings.autoSave;
    document.getElementById('set-slowType').checked = settings.slowType;
    document.getElementById('set-lockEnabled').checked = settings.lockEnabled;

    renderProvidersList(settings);
    renderOriginsSettings();
    renderRejectedCount();
  }

  function bindSettingField(id, key, transform) {
    document.getElementById(id).addEventListener('change', async (e) => {
      const raw = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      const value = transform ? transform(raw) : raw;
      await RegLog.store.setSettings({ [key]: value });
      if (id === 'set-passLength') document.getElementById('set-passLength-val').textContent = value;
    });
  }
  bindSettingField('set-loginStyle', 'loginStyle');
  bindSettingField('set-passPreset', 'passPreset');
  bindSettingField('set-passLength', 'passLength', Number);
  bindSettingField('set-symbols', 'symbols');
  bindSettingField('set-autoSave', 'autoSave');
  bindSettingField('set-slowType', 'slowType');

  function renderProvidersList(settings) {
    const ul = document.getElementById('set-providers-list');
    ul.textContent = '';
    settings.providers.forEach((id, idx) => {
      const adapter = RegLog.mail.adapters.find(a => a.id === id);
      const li = document.createElement('li');
      if (adapter && adapter.disabled) li.classList.add('disabled');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !settings.providersOff.includes(id);
      checkbox.disabled = !adapter || adapter.disabled;
      checkbox.addEventListener('change', async () => {
        const s = await RegLog.store.getSettings();
        const off = new Set(s.providersOff);
        checkbox.checked ? off.delete(id) : off.add(id);
        await RegLog.store.setSettings({ providersOff: Array.from(off) });
      });

      const label = document.createElement('span');
      label.textContent = (adapter ? adapter.label : id) + (adapter && adapter.disabled ? ' (адаптер не реализован)' : '');
      if (adapter && adapter.publicInbox) label.textContent += ' · публичный ящик';
      if (adapter && adapter.sessionTtlMs > 0) label.textContent += ` · живёт ${P.ttlMinutes(adapter)} мин`;

      const upBtn = document.createElement('button'); upBtn.type = 'button'; upBtn.setAttribute('aria-label', `Переместить ${id} вверх`); upBtn.textContent = '↑';
      upBtn.disabled = idx === 0;
      upBtn.addEventListener('click', () => moveProvider(idx, -1));

      const downBtn = document.createElement('button'); downBtn.type = 'button'; downBtn.setAttribute('aria-label', `Переместить ${id} вниз`); downBtn.textContent = '↓';
      downBtn.disabled = idx === settings.providers.length - 1;
      downBtn.addEventListener('click', () => moveProvider(idx, 1));

      li.append(checkbox, label, upBtn, downBtn);
      ul.appendChild(li);
    });
  }

  async function moveProvider(idx, dir) {
    const settings = await RegLog.store.getSettings();
    const list = [...settings.providers];
    const target = idx + dir;
    if (target < 0 || target >= list.length) return;
    [list[idx], list[target]] = [list[target], list[idx]];
    await RegLog.store.setSettings({ providers: list });
    initSettingsTab();
  }

  async function renderRejectedCount() {
    const rejected = await RegLog.store.getRejected();
    document.getElementById('set-rejected-count').textContent = `Сайтов с отказами: ${Object.keys(rejected).length}`;
  }
  document.getElementById('set-reset-all-rejected').addEventListener('click', async () => {
    await RegLog.store.clearRejected();
    renderRejectedCount();
  });

  async function renderOriginsSettings() {
    const ul = document.getElementById('set-origins-list');
    ul.textContent = '';
    const origins = await RegLog.frames.listGrantedOrigins();
    if (origins.length === 0) {
      const li = document.createElement('li'); li.textContent = 'доступ к встроенным фреймам не выдавался'; ul.appendChild(li);
      return;
    }
    for (const origin of origins) {
      const li = document.createElement('li');
      const span = document.createElement('span'); span.className = 'mono'; span.textContent = origin;
      const revokeBtn = document.createElement('button'); revokeBtn.type = 'button'; revokeBtn.textContent = 'Отозвать';
      revokeBtn.addEventListener('click', async () => { await RegLog.frames.revokeOrigin(origin); renderOriginsSettings(); });
      li.append(span, revokeBtn); ul.appendChild(li);
    }
  }
  document.getElementById('set-revoke-webnav').addEventListener('click', async () => {
    await RegLog.frames.revokeWebNavigation();
  });

  document.getElementById('set-lockEnabled').addEventListener('change', (e) => {
    document.getElementById('set-lock-form').hidden = !e.target.checked;
    if (!e.target.checked) disableLockFlow();
  });

  document.getElementById('set-lock-apply').addEventListener('click', async () => {
    const p1 = document.getElementById('set-lock-pass1').value;
    const p2 = document.getElementById('set-lock-pass2').value;
    const errEl = document.getElementById('set-lock-error');
    errEl.hidden = true;
    if (p1 !== p2 || p1.length < 4) {
      errEl.textContent = 'Пароли не совпадают или слишком короткие';
      errEl.hidden = false;
      return;
    }
    try {
      await RegLog.store.enableLock(p1);
    } catch (e) {
      // Достижимо, когда журнал уже зашифрован (например, попытка включить защиту
      // заново после неудачного disableLockFlow) — enableLock бросает по дизайну и
      // не трогает данные; без этого catch получался необработанный reject и форма
      // молча зависала без обратной связи.
      errEl.textContent = 'Не удалось включить защиту: ' + (e && e.message ? e.message : 'неизвестная ошибка');
      errEl.hidden = false;
      return;
    }
    document.getElementById('set-lock-pass1').value = '';
    document.getElementById('set-lock-pass2').value = '';
    document.getElementById('set-lock-form').hidden = true;
  });

  // Инлайн-форма отключения защиты вместо prompt()/alert() (Finding 6, финальное ревью):
  // нативные диалоги в попапе расширения могут не пережить потерю фокуса, не маскируют
  // ввод предсказуемо и не дают инлайновой обратной связи. Паттерн — как у #log-unlock
  // (поле пароля + кнопка + role="alert").
  function disableLockFlow() {
    document.getElementById('set-disable-lock-pass').value = '';
    document.getElementById('set-disable-lock-error').hidden = true;
    document.getElementById('set-disable-lock-form').hidden = false;
  }

  function cancelDisableLockFlow() {
    document.getElementById('set-disable-lock-form').hidden = true;
    document.getElementById('set-disable-lock-pass').value = '';
    document.getElementById('set-disable-lock-error').hidden = true;
    // Отражает поведение прежнего prompt()-отказа (pass == null): чекбокс возвращается
    // в отмеченное состояние, журнал остаётся защищённым.
    document.getElementById('set-lockEnabled').checked = true;
  }

  document.getElementById('set-disable-lock-apply').addEventListener('click', async () => {
    const pass = document.getElementById('set-disable-lock-pass').value;
    const errEl = document.getElementById('set-disable-lock-error');
    errEl.hidden = true;
    try {
      await RegLog.store.disableLock(pass);
      document.getElementById('set-disable-lock-pass').value = '';
      document.getElementById('set-disable-lock-form').hidden = true;
    } catch (e) {
      // Неверный пароль остаётся здесь же для повторной попытки — форма никуда не
      // прыгает, в отличие от прежнего alert()+возврата к форме включения.
      errEl.textContent = P.isWrongPassword(e)
        ? 'Неверный пароль, защита осталась включена'
        : `Не удалось отключить защиту: ${P.errText(e)}`;
      errEl.hidden = false;
    }
  });

  document.getElementById('set-disable-lock-cancel').addEventListener('click', cancelDisableLockFlow);

  // Очистка журнала подтверждается инлайн-формой по той же причине, что и отключение
  // защиты: нативный confirm() в попапе не гарантированно доживает до ответа, а действие
  // необратимо — «подтвердил и не увидел результата» здесь недопустимо.
  document.getElementById('set-clear-entries').addEventListener('click', () => {
    document.getElementById('set-clear-form').hidden = false;
  });

  document.getElementById('set-clear-cancel').addEventListener('click', () => {
    document.getElementById('set-clear-form').hidden = true;
  });

  document.getElementById('set-clear-apply').addEventListener('click', async () => {
    document.getElementById('set-clear-form').hidden = true;
    try {
      await RegLog.store.clearEntries();
    } catch (e) {
      P.showToast('Журнал заблокирован — сначала разблокируйте его на вкладке «Журнал»');
      return;
    }
    P.showToast('Журнал очищен');
  });

  P.onEnter('settings', initSettingsTab);

})();
