/* Page Tidy — service worker.
 *
 * Главная задача: вставить CSS ещё до отрисовки страницы, чтобы скрытые
 * блоки не мигали при загрузке. Content script делает то же самое, но его
 * чтение storage асинхронно, поэтому дублируем инъекцию отсюда.
 */

importScripts('presets.js');

const MARK = 'data-page-tidy-hidden';

async function cssForHost(host) {
  const { enabled, sites } = await chrome.storage.local.get(['enabled', 'sites']);
  if (enabled === false) return null;

  let site = (sites || {})[host];
  if (!site) {
    // Сайт ещё не настраивали — используем включённые по умолчанию пресеты.
    const presetHost = PAGE_TIDY_HOST_ALIASES[host] || host;
    const presets = (PAGE_TIDY_PRESETS[presetHost] || []).filter(p => p.on);
    if (!presets.length) return null;
    site = { suspended: false, rules: presets.map(p => ({ selector: p.selector, fallbacks: [], enabled: true })) };
  }
  if (site.suspended) return null;

  const sels = [];
  for (const r of site.rules || []) {
    if (r.enabled === false) continue;
    if (r.selector) sels.push(r.selector);
    for (const f of r.fallbacks || []) sels.push(f);
  }
  if (!sels.length) return null;
  sels.push(`[${MARK}]`);
  return sels.join(',\n') + ' { display: none !important; }';
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  let host;
  try { host = new URL(details.url).hostname; } catch { return; }
  if (!host) return;

  const css = await cssForHost(host);
  if (!css) return;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: details.tabId, frameIds: [0] },
      css
    });
  } catch {
    // Служебные страницы (chrome://, Web Store) — инъекция запрещена, это нормально.
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (command === 'toggle-picker') {
    chrome.tabs.sendMessage(tab.id, { type: 'toggle-picker' }).catch(() => {});
    return;
  }

  if (command === 'toggle-suspend') {
    let host;
    try { host = new URL(tab.url).hostname; } catch { return; }
    const { sites } = await chrome.storage.local.get(['sites']);
    const all = sites || {};
    const site = all[host] || { suspended: false, rules: [] };
    site.suspended = !site.suspended;
    all[host] = site;
    await chrome.storage.local.set({ sites: all });
    // insertCSS не отзывается через storage — нужна перезагрузка вкладки.
    chrome.tabs.reload(tab.id);
  }
});

// Значок с числом правил для текущего сайта.
async function updateBadge(tabId, url) {
  let host;
  try { host = new URL(url).hostname; } catch { host = null; }
  const { sites, enabled } = await chrome.storage.local.get(['sites', 'enabled']);
  const site = host ? (sites || {})[host] : null;
  const n = site && enabled !== false && !site.suspended
    ? (site.rules || []).filter(r => r.enabled !== false).length
    : 0;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b4256' }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.url) updateBadge(tabId, tab.url);
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tab.url) updateBadge(tabId, tab.url);
});
