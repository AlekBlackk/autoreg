// popup.js
//
// Точка входа. Вся логика живёт в popup/core.js (общая инфраструктура: вкладки,
// разделяемое состояние, утилиты, boot) и файлах по вкладкам — popup/new.js,
// popup/inbox.js, popup/log.js, popup/settings.js — которые popup.html подключает
// раньше этого файла и которые регистрируют себя в RegLog.popup через onEnter/onLeave.
// Здесь только запуск.
(function () {
  'use strict';
  RegLog.popup.boot();
})();
