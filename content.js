/* Page Tidy — content script.
 *
 * Задачи:
 *  1) применять сохранённые правила и переприменять их после перерисовок SPA;
 *  2) режим выбора: наведение подсвечивает элемент, клик его прячет навсегда;
 *  3) строить селекторы, устойчивые к случайным классам и id.
 */
(() => {
  'use strict';
  if (window.__pageTidyInit) return;
  window.__pageTidyInit = true;

  const HOST = location.hostname;
  const PRESET_HOST = (globalThis.PAGE_TIDY_HOST_ALIASES || {})[HOST] || HOST;
  const PRESETS = (globalThis.PAGE_TIDY_PRESETS || {})[PRESET_HOST] || [];

  const STYLE_ID = 'page-tidy-style';
  const OVERLAY_ID = 'page-tidy-overlay-host';
  const MARK = 'data-page-tidy-hidden';

  let globalEnabled = true;
  let site = null; // { suspended: bool, rules: [] }
  let picker = null;
  const undoStack = [];

  /* ================= хранилище ================= */

  async function load() {
    const data = await chrome.storage.local.get(['enabled', 'sites']);
    globalEnabled = data.enabled !== false;
    const sites = data.sites || {};
    site = sites[HOST] || null;
    if (!site) {
      site = { suspended: false, rules: PRESETS.filter(p => p.on).map(presetToRule) };
      if (site.rules.length) await persist();
    }
    if (!Array.isArray(site.rules)) site.rules = [];
  }

  async function persist() {
    const data = await chrome.storage.local.get(['sites']);
    const sites = data.sites || {};
    sites[HOST] = site;
    await chrome.storage.local.set({ sites });
  }

  function presetToRule(p) {
    return {
      id: p.id,
      label: p.label,
      selector: p.selector,
      fallbacks: [],
      sig: null,
      preset: true,
      enabled: true,
      createdAt: 0
    };
  }

  /* ================= эвристики «стабильности» токенов =================
   *
   * Отсекаем сгенерированные идентификаторы, оставляем осмысленные.
   *   PageLayout-m__body--xjMc4  -> стабильная часть "PageLayout-m__body"
   *   qa-LeftColumn-Footer-Promo -> стабилен целиком
   *   qotZC25wki5T0siGB          -> мусор
   *   fd4459410 / re90919d7      -> мусор
   *   qisQB2Jg_lvvqqSA           -> мусор
   */

  const STATE_WORDS = /^(loading|active|selected|open|opened|closed|hover|hovered|focus|focused|visible|hidden|disabled|enabled|expanded|collapsed|checked|pressed|current|dragging|empty|error|first|last|even|odd)$/i;

  function isWordish(p) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(p)) return false;
    if (p.length > 28) return false;
    if (p.length <= 3) return true; // m, v1, ui, btn — нормальные части имён
    if (/^[a-f0-9]{6,}$/i.test(p)) return false; // hex-хвост
    const core = p.replace(/\d+$/, '') || p;
    const digits = (core.match(/\d/g) || []).length;
    if (digits > 2 || digits / core.length > 0.3) return false;
    if ((core.match(/[a-z][A-Z]/g) || []).length > 3) return false;
    // смесь регистра и цифр внутри слова — почти всегда хеш
    if (/\d/.test(core) && /[A-Z]/.test(core) && /[a-z]/.test(core)) return false;
    return true;
  }

  function looksStable(tok) {
    if (!tok || tok.length < 3 || tok.length > 64) return false;
    const parts = tok.split(/[-_]+/).filter(Boolean);
    return parts.length > 0 && parts.every(isWordish);
  }

  /** Возвращает устойчивый кусок класса для [class*="…"], либо null. */
  function classHint(tok) {
    // js-* — хуки поведения, а не опознавательный знак: висят на разных
    // несвязанных узлах, поэтому как примета не годятся.
    if (/^js[-_]/i.test(tok)) return null;
    const m = tok.match(/^(.+?)--[A-Za-z0-9_-]{4,}$/); // CSS-модули
    if (m && looksStable(m[1])) return trimState(m[1]);
    if (looksStable(tok)) return trimState(tok);
    return null;
  }

  /** Убирает хвост-состояние: UserWidget-Content_loading -> UserWidget-Content */
  function trimState(tok) {
    const parts = tok.split('_');
    while (parts.length > 1 && STATE_WORDS.test(parts[parts.length - 1])) parts.pop();
    return parts.join('_');
  }

  /**
   * aria-label годится как примета, только если это название элемента
   * управления, а не пересказ содержимого. У списка писем, например,
   * в aria-label лежит весь текст письма: такой селектор сломается на
   * следующем письме, да ещё и утащит переписку в хранилище правил.
   */
  function usableAria(el) {
    const v = el.getAttribute('aria-label');
    if (!v) return null;
    const s = v.trim();
    if (!s || s.length > 60) return null;
    if (/@|\bhttps?:/i.test(s)) return null; // адреса и ссылки — это данные
    return s;
  }

  function classTokens(el) {
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    return cls.split(/\s+/).filter(Boolean);
  }

  const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  /* ================= построение селектора ================= */

  /**
   * Кандидаты-селекторы для элемента.
   * strong — самостоятельная примета (её достаточно без якоря);
   * weak   — только классы: они повторяются на несвязанных узлах,
   *          поэтому применимы лишь в связке с якорем.
   */
  function candidatesFor(el) {
    const out = [];
    const tag = el.tagName.toLowerCase();
    const add = (sel, strong) => { if (sel) out.push({ sel, strong }); };

    const testid = el.getAttribute('data-testid');
    if (testid && looksStable(testid)) add(`[data-testid=${q(testid)}]`, true);

    const tokens = classTokens(el);

    const qa = tokens.filter(t => t.startsWith('qa-') && looksStable(t));
    if (qa.length) add('.' + qa.slice(0, 2).map(CSS.escape).join('.'), true);

    for (const attr of ['data-test-id', 'data-qa', 'data-id', 'name']) {
      const v = el.getAttribute(attr);
      if (v && looksStable(v)) add(`[${attr}=${q(v)}]`, true);
    }

    const aria = usableAria(el);
    if (aria) add(`${tag}[aria-label=${q(aria)}]`, true);

    if (el.id && looksStable(el.id)) add(`${tag}#${CSS.escape(el.id)}`, true);

    const hints = [...new Set(tokens.map(classHint).filter(Boolean))];
    if (hints.length) {
      add(tag + hints.slice(0, 2).map(h => `[class*=${q(h)}]`).join(''), false);
      if (hints.length > 1) add(tag + `[class*=${q(hints[0])}]`, false);
    }

    const role = el.getAttribute('role');
    if (role && aria) add(`[role=${q(role)}][aria-label=${q(aria)}]`, true);

    const seen = new Set();
    return out.filter(c => !seen.has(c.sel) && seen.add(c.sel));
  }

  function matches(sel) {
    try { return document.querySelectorAll(sel); } catch { return []; }
  }

  /** Ближайший предок с однозначным «сильным» селектором — точка отсчёта. */
  function anchorFor(el, maxUp = 12) {
    let n = el, up = 0;
    while (n && n !== document.documentElement && up < maxUp) {
      for (const c of candidatesFor(n)) {
        if (!c.strong) continue;
        const found = matches(c.sel);
        if (found.length === 1 && found[0] === n) return { el: n, selector: c.sel };
      }
      n = n.parentElement; up++;
    }
    return null;
  }

  function nthPath(el, stopAt) {
    const parts = [];
    let n = el;
    while (n && n !== stopAt && n.parentElement) {
      const p = n.parentElement;
      const i = Array.prototype.indexOf.call(p.children, n) + 1;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${i})`);
      n = p;
      if (parts.length > 8) break;
    }
    return parts;
  }

  /**
   * Строит правило для элемента: основной селектор + запасные + сигнатура,
   * по которой элемент можно найти, если разметка поедет.
   */
  function buildRule(el) {
    const cands = candidatesFor(el);
    const hits = (sel) => {
      const found = matches(sel);
      return found.length && found.length <= 3 && [...found].includes(el);
    };

    const strong = [], anchored = [], weak = [];

    // 1. Собственные приметы элемента.
    for (const c of cands) {
      if (hits(c.sel)) (c.strong ? strong : weak).push(c.sel);
    }

    // 2. Привязка к стабильному предку.
    const anchor = anchorFor(el.parentElement || el);
    if (anchor) {
      for (const c of cands) {
        const sel = `${anchor.selector} ${c.sel}`;
        if (hits(sel)) anchored.push(sel);
      }
      const path = nthPath(el, anchor.el);
      if (path.length) {
        const sel = `${anchor.selector} > ${path.join(' > ')}`;
        if ([...matches(sel)].includes(el)) anchored.push(sel);
      }
    }

    // Порядок важен: голый класс без якоря — крайний случай, он легко
    // цепляет посторонние узлы, поэтому уходит в самый хвост.
    const ordered = [...strong, ...anchored, ...weak];

    // 3. Последняя линия обороны — путь от документа.
    if (!ordered.length) {
      const sel = nthPath(el, document.body).join(' > ');
      if (sel) ordered.push(`body > ${sel}`);
    }

    const uniq = [...new Set(ordered)];
    return {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      label: labelFor(el),
      selector: uniq[0] || null,
      fallbacks: uniq.slice(1, 4),
      sig: signatureFor(el, anchor),
      preset: false,
      enabled: true,
      createdAt: Date.now()
    };
  }

  function signatureFor(el, anchor) {
    return {
      tag: el.tagName.toLowerCase(),
      testid: el.getAttribute('data-testid') || null,
      aria: usableAria(el),
      role: el.getAttribute('role') || null,
      classHints: [...new Set(classTokens(el).map(classHint).filter(Boolean))].slice(0, 3),
      text: shortText(el),
      anchor: anchor ? anchor.selector : null,
      path: anchor ? nthPath(el, anchor.el) : []
    };
  }

  /** Короткая подпись вроде «Отключить рекламу». Личные данные не сохраняем. */
  function shortText(el) {
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 40) return null;
    if (/@|\bhttps?:/i.test(t)) return null;
    return t;
  }

  function labelFor(el) {
    const testid = el.getAttribute('data-testid');
    const aria = usableAria(el);
    const qa = classTokens(el).find(t => t.startsWith('qa-'));
    const text = shortText(el);
    const r = el.getBoundingClientRect();
    const size = `${Math.round(r.width)}×${Math.round(r.height)}`;
    const name = aria || testid || qa || (text ? '«' + text.slice(0, 30) + '»' : null);
    return name ? `${name} · ${size}` : `${el.tagName.toLowerCase()} · ${size}`;
  }

  /* ================= применение правил ================= */

  function activeRules() {
    if (!globalEnabled || !site || site.suspended) return [];
    return site.rules.filter(r => r.enabled !== false);
  }

  function buildCss(rules) {
    const sels = [];
    for (const r of rules) {
      if (r.selector) sels.push(r.selector);
      for (const f of r.fallbacks || []) sels.push(f);
    }
    sels.push(`[${MARK}]`);
    return sels.join(',\n') + ' { display: none !important; }';
  }

  function styleEl() {
    let s = document.getElementById(STYLE_ID);
    if (!s) {
      s = document.createElement('style');
      s.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(s);
    } else if (s.parentNode !== (document.head || document.documentElement)) {
      (document.head || document.documentElement).appendChild(s);
    }
    return s;
  }

  function apply() {
    const rules = activeRules();
    styleEl().textContent = rules.length ? buildCss(rules) : '';
    if (!rules.length) clearMarks();
  }

  function clearMarks() {
    for (const el of document.querySelectorAll(`[${MARK}]`)) el.removeAttribute(MARK);
  }

  /**
   * Для правил, чьи селекторы больше ни во что не попадают, ищем элемент
   * по сигнатуре и помечаем атрибутом — его прячет то же правило в CSS.
   */
  function resolveFallbacks() {
    const rules = activeRules();
    if (!rules.length) return;
    for (const r of rules) {
      if (!r.sig) continue;
      const hit = r.selector && matches(r.selector).length;
      if (hit) continue;
      const el = findBySignature(r.sig);
      if (el && !el.hasAttribute(MARK)) el.setAttribute(MARK, r.id);
    }
  }

  function findBySignature(sig) {
    // а) точный путь от якоря
    if (sig.anchor && sig.path && sig.path.length) {
      const anchors = matches(sig.anchor);
      for (const a of anchors) {
        const el = a.querySelector(':scope > ' + sig.path.join(' > '));
        if (el && el.tagName.toLowerCase() === sig.tag) return el;
      }
    }
    // б) поиск по признакам внутри якоря (или по всему документу)
    const scopes = sig.anchor ? [...matches(sig.anchor)] : [document];
    const parts = [];
    if (sig.testid) parts.push(`[data-testid=${q(sig.testid)}]`);
    if (sig.aria) parts.push(`[aria-label=${q(sig.aria)}]`);
    if (sig.role) parts.push(`[role=${q(sig.role)}]`);
    for (const h of sig.classHints || []) parts.push(`[class*=${q(h)}]`);
    for (const scope of scopes) {
      for (const p of parts) {
        const el = scope.querySelector ? scope.querySelector(sig.tag + p) : null;
        if (el) return el;
      }
    }
    // в) по тексту — только если он достаточно характерный
    if (sig.text && sig.text.length >= 8) {
      for (const scope of scopes) {
        const root = scope.querySelectorAll ? scope : document;
        for (const el of root.querySelectorAll(sig.tag)) {
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40);
          if (t === sig.text) return el;
        }
      }
    }
    return null;
  }

  /* ================= наблюдение за SPA ================= */

  let pending = false, lastRun = 0;
  function schedule() {
    if (pending) return;
    pending = true;
    const wait = Math.max(0, 400 - (Date.now() - lastRun));
    setTimeout(() => {
      pending = false; lastRun = Date.now();
      styleEl(); // страховка: SPA мог вычистить head
      apply();
      resolveFallbacks();
    }, wait);
  }

  function observe() {
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    addEventListener('hashchange', schedule);
  }

  /* ================= режим выбора элемента ================= */

  const PICKER_CSS = `
    :host { all: initial; }
    .box {
      position: fixed; pointer-events: none;
      border: 2px solid #ff4757; background: rgba(255,71,87,.18);
      border-radius: 3px; transition: all .05s linear; z-index: 1;
    }
    .tag {
      position: fixed; pointer-events: none; z-index: 2;
      font: 12px/1.4 -apple-system, system-ui, sans-serif;
      background: #ff4757; color: #fff; padding: 3px 7px;
      border-radius: 4px; max-width: 340px; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
      box-shadow: 0 2px 8px rgba(0,0,0,.3);
    }
    .bar {
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
      pointer-events: auto; z-index: 3;
      font: 13px/1.5 -apple-system, system-ui, sans-serif;
      background: #1f2430; color: #e6e6e6; padding: 10px 16px;
      border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.45);
      display: flex; gap: 14px; align-items: center;
    }
    .bar b { color: #fff; }
    .bar kbd {
      background: #333a4a; border-radius: 4px; padding: 1px 6px;
      font-family: inherit; font-size: 12px;
    }
    .bar button {
      font: inherit; border: 0; color: #fff; background: #3b4256;
      padding: 5px 12px; border-radius: 6px; cursor: pointer;
    }
    .bar button:hover { background: #4b5470; }
    .toast {
      position: fixed; left: 50%; bottom: 78px; transform: translateX(-50%);
      pointer-events: none; z-index: 3;
      font: 13px/1.5 -apple-system, system-ui, sans-serif;
      background: #17381f; color: #b8f5c6; border: 1px solid #2c6b3c;
      padding: 8px 14px; border-radius: 8px; opacity: 0; transition: opacity .2s;
    }
    .toast.show { opacity: 1; }
  `;

  function startPicker() {
    if (picker) return;
    const host = document.createElement('div');
    host.id = OVERLAY_ID;
    host.style.cssText =
      'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      `<style>${PICKER_CSS}</style>` +
      `<div class="box"></div><div class="tag"></div><div class="toast"></div>` +
      `<div class="bar">
         <b>Выбор элемента</b>
         <span><kbd>клик</kbd> скрыть</span>
         <span><kbd>↑</kbd><kbd>↓</kbd> шире / уже</span>
         <span><kbd>⌘Z</kbd> вернуть</span>
         <button data-act="done">Готово</button>
       </div>`;
    document.documentElement.appendChild(host);

    picker = {
      host,
      shadow,
      box: shadow.querySelector('.box'),
      tag: shadow.querySelector('.tag'),
      toast: shadow.querySelector('.toast'),
      current: null
    };

    shadow.querySelector('[data-act="done"]').addEventListener('click', (e) => {
      e.stopPropagation(); stopPicker();
    });

    for (const ev of ['mousemove', 'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu']) {
      document.addEventListener(ev, onPickerEvent, true);
    }
    document.addEventListener('keydown', onPickerKey, true);
    addEventListener('scroll', redrawHighlight, true);
    addEventListener('resize', redrawHighlight, true);
    chrome.runtime.sendMessage({ type: 'picker-state', active: true }).catch(() => {});
  }

  function stopPicker() {
    if (!picker) return;
    for (const ev of ['mousemove', 'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu']) {
      document.removeEventListener(ev, onPickerEvent, true);
    }
    document.removeEventListener('keydown', onPickerKey, true);
    removeEventListener('scroll', redrawHighlight, true);
    removeEventListener('resize', redrawHighlight, true);
    picker.host.remove();
    picker = null;
    chrome.runtime.sendMessage({ type: 'picker-state', active: false }).catch(() => {});
  }

  function pickTarget(e) {
    let el = e.target;
    if (!el || el === picker.host || el.id === OVERLAY_ID) return null;
    if (el === document.documentElement || el === document.body) return null;
    return el;
  }

  function onPickerEvent(e) {
    if (!picker) return;
    // клик по панели подсказок обрабатывается своим слушателем
    if (e.target === picker.host) return;

    if (e.type === 'mousemove') {
      const el = pickTarget(e);
      if (el && el !== picker.current) { picker.current = el; redrawHighlight(); }
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click') {
      const el = picker.current || pickTarget(e);
      if (el) hideElement(el);
    }
  }

  function onPickerKey(e) {
    if (!picker) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === 'Escape') { stop(); stopPicker(); return; }
    if (e.key === 'ArrowUp') {
      stop();
      const p = picker.current && picker.current.parentElement;
      if (p && p !== document.body && p !== document.documentElement) {
        picker.current = p; redrawHighlight();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      stop();
      const c = picker.current && [...picker.current.children].find(
        (n) => n.getBoundingClientRect().width > 0
      );
      if (c) { picker.current = c; redrawHighlight(); }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { stop(); undo(); }
  }

  function redrawHighlight() {
    if (!picker || !picker.current) return;
    const el = picker.current;
    const r = el.getBoundingClientRect();
    Object.assign(picker.box.style, {
      left: r.left + 'px', top: r.top + 'px',
      width: r.width + 'px', height: r.height + 'px', display: 'block'
    });
    picker.tag.textContent = labelFor(el);
    const above = r.top > 26;
    Object.assign(picker.tag.style, {
      left: Math.max(4, r.left) + 'px',
      top: (above ? r.top - 24 : r.bottom + 4) + 'px',
      display: 'block'
    });
  }

  function flash(msg) {
    if (!picker) return;
    picker.toast.textContent = msg;
    picker.toast.classList.add('show');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => picker && picker.toast.classList.remove('show'), 1800);
  }

  async function hideElement(el) {
    const rule = buildRule(el);
    if (!rule.selector) { flash('Не удалось построить селектор'); return; }
    site.rules.push(rule);
    undoStack.push(rule.id);
    await persist();
    apply();
    if (picker) { picker.current = null; picker.box.style.display = 'none'; picker.tag.style.display = 'none'; }
    flash('Скрыто: ' + rule.label);
  }

  async function undo() {
    const id = undoStack.pop();
    if (!id) { flash('Нечего возвращать'); return; }
    site.rules = site.rules.filter(r => r.id !== id);
    for (const el of document.querySelectorAll(`[${MARK}="${id}"]`)) el.removeAttribute(MARK);
    await persist();
    apply();
    flash('Возвращено');
  }

  /* ================= связь с popup / background ================= */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'ping':
          sendResponse({ ok: true, host: HOST, count: site ? site.rules.length : 0 });
          break;
        case 'start-picker': startPicker(); sendResponse({ ok: true }); break;
        case 'stop-picker': stopPicker(); sendResponse({ ok: true }); break;
        case 'toggle-picker': picker ? stopPicker() : startPicker(); sendResponse({ ok: true }); break;
        case 'get-state':
          await load();
          sendResponse({ host: HOST, presetHost: PRESET_HOST, globalEnabled, site, presets: PRESETS });
          break;
        case 'highlight': {
          const el = msg.selector ? document.querySelector(msg.selector) : null;
          if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          sendResponse({ ok: !!el });
          break;
        }
        default: sendResponse({ ok: false });
      }
    })();
    return true; // ответ асинхронный
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (!changes.sites && !changes.enabled) return;
    await load();
    apply();
    resolveFallbacks();
  });

  /* ================= старт ================= */

  (async () => {
    await load();
    apply();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { apply(); resolveFallbacks(); observe(); });
    } else {
      resolveFallbacks();
      observe();
    }
  })();
})();
