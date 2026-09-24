/* Готовые правила для известных сайтов.
 *
 * Все селекторы ниже построены на стабильных атрибутах (data-testid, qa-*),
 * которые Яндекс использует как тестовые хуки и не обфусцирует.
 * Случайные классы вида .qotZC25wki5T0siGB / #qisQB2Jg_lvvqqSA / .fd4459410
 * меняются при каждой сборке, поэтому в правилах не участвуют.
 *
 * `on: true` — правило включается автоматически при первом заходе на сайт.
 */
var PAGE_TIDY_PRESETS = {
  'mail.yandex.ru': [
    {
      id: 'ya-ad-column',
      label: 'Рекламная колонка справа',
      selector: '[data-testid="page-layout_right-column_container_v1"]',
      on: true
    },
    {
      id: 'ya-aside-promo',
      label: 'Промо-карусель в левой колонке',
      selector: '[data-testid="aside_promo_carousel_banner"]',
      on: true
    },
    {
      id: 'ya-neurofilter-banner',
      label: 'Баннер Нейрофильтра над письмами',
      selector: '[data-testid="yagpt-neurofilter-banner-portal"]',
      on: true
    },
    {
      id: 'ya-monetization',
      label: 'Кнопка «+1 ТБ» (Яндекс 360)',
      selector: '[data-testid="orb-global-bar-monetization-item"]',
      on: false
    },
    {
      id: 'ya-footer-promo',
      label: 'Промо-ссылка в подвале левой колонки',
      selector: '.qa-LeftColumn-Footer-Promo',
      on: false
    },
    {
      id: 'ya-left-footer',
      label: 'Весь подвал левой колонки (язык, приложения, справка)',
      selector: '[data-testid="left-column_footer"]',
      on: false
    },
    {
      id: 'ya-subscriptions',
      label: 'Блок подписок в списке писем',
      selector: '[data-testid="messages-list_subscription-container"]',
      on: false
    },
    {
      id: 'ya-neuroexpert',
      label: 'Кнопка «Нейроэксперт»',
      selector: '[class*="NeuroexpertButton-m__btn"]',
      on: false
    }
  ]
};

// Домены-синонимы: правила mail.yandex.ru действуют и здесь.
var PAGE_TIDY_HOST_ALIASES = {
  'mail.yandex.by': 'mail.yandex.ru',
  'mail.yandex.kz': 'mail.yandex.ru',
  'mail.yandex.com': 'mail.yandex.ru',
  'mail.yandex.com.tr': 'mail.yandex.ru',
  'mail360.yandex.ru': 'mail.yandex.ru'
};

if (typeof globalThis !== 'undefined') {
  globalThis.PAGE_TIDY_PRESETS = PAGE_TIDY_PRESETS;
  globalThis.PAGE_TIDY_HOST_ALIASES = PAGE_TIDY_HOST_ALIASES;
}
