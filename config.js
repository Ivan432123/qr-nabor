// ===== НАСТРОЙКИ — меняйте только здесь =====
window.NABOR_CONFIG = {
  // Адрес сервера (функция в Яндекс Облаке). Записывается автоматически при развёртывании.
  API_URL: 'https://functions.yandexcloud.net/d4eejuc9hi2iil13mta7',
  // Адрес главной страницы набора (GitHub Pages) — на него ведут реф-ссылки партнёров.
  SITE_URL: 'https://qrstol.ru/',
  // Ваш телефон / MAX — показывается клиентам.
  PHONE: '+7 923 688-55-01',
  // Кнопки связи. Пустая ссылка = кнопка не показывается. WhatsApp и Telegram строятся из номера, если не заданы.
  CONTACTS: {
    whatsapp: '',   // например https://wa.me/79236885501
    telegram: '',   // лучше https://t.me/ваш_ник (по номеру работает, если в Telegram разрешён поиск по номеру)
    max: '',        // ссылка на ваш профиль в MAX
    avito: ''       // ссылка на ваш профиль на Авито
  },
  // Живой пример QR-меню.
  DEMO_URL: 'https://zerno.qrstol.ru/#5'
};

// Полный адрес запроса к серверу: naborApi('/api/lead') → https://functions.yandexcloud.net/<id>?r=/api/lead
window.naborApi = function (path) {
  var base = String(window.NABOR_CONFIG.API_URL || '').replace(/\/+$/, '');
  var parts = String(path).split('?');
  return base + '?r=' + encodeURIComponent(parts[0]) + (parts[1] ? '&' + parts[1] : '');
};

// Когда сайт переехал на свой домен — старые адреса на GitHub ведут туда же (…/qr-nabor/partner/ → qrstol.ru/partner/)
(function () {
  var site = String(window.NABOR_CONFIG.SITE_URL || '');
  if (/github\.io$/.test(location.hostname) && site.indexOf('github.io') === -1 && site) {
    var rest = location.pathname.replace(/^\/qr-nabor\/?/, '');
    location.replace(site.replace(/\/?$/, '/') + rest + location.search + location.hash);
  }
})();

// Кнопки связи: <div data-contact-buttons></div> на странице заполняется автоматически
window.addEventListener('DOMContentLoaded', function () {
  var C = window.NABOR_CONFIG, k = C.CONTACTS || {}, digits = String(C.PHONE || '').replace(/\D/g, '');
  var items = [
    ['WhatsApp', k.whatsapp || (digits && 'https://wa.me/' + digits), '#25D366', '#0B3D1E'],
    ['Telegram', k.telegram || (digits && 'https://t.me/+' + digits), '#2AABEE', '#06324A'],
    ['MAX', k.max, '#7B5CFF', '#fff'],
    ['Авито', k.avito, '#0AF', '#00324D']
  ].filter(function (x) { return x[1]; });
  Array.prototype.forEach.call(document.querySelectorAll('[data-contact-buttons]'), function (box) {
    box.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px';
    items.forEach(function (x) {
      var a = document.createElement('a');
      a.href = x[1]; a.target = '_blank'; a.rel = 'noopener'; a.textContent = x[0];
      a.style.cssText = 'display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:999px;font-weight:800;text-decoration:none;background:' + x[2] + ';color:' + x[3];
      box.appendChild(a);
    });
  });
});
