// ===== НАСТРОЙКИ — меняйте только здесь =====
window.NABOR_CONFIG = {
  // Адрес сервера (функция в Яндекс Облаке). Записывается автоматически при развёртывании.
  API_URL: 'https://functions.yandexcloud.net/d4eejuc9hi2iil13mta7',
  // Адрес главной страницы набора (GitHub Pages) — на него ведут реф-ссылки партнёров.
  SITE_URL: 'https://qrstol.ru/',
  // Ваш телефон / MAX — показывается клиентам.
  PHONE: '+7 900 000-00-00',
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
