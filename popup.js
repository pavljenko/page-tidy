/* Page Tidy — popup. */

const $ = (id) => document.getElementById(id);

let tab = null;
let host = '';
let presetHost = '';
let state = { enabled: true, site: { suspended: false, rules: [] } };

async function getSites() {
  const { sites } = await chrome.storage.local.get(['sites']);
  return sites || {};
}

async function saveSite(site) {
  const sites = await getSites();
  sites[host] = site;
  await chrome.storage.local.set({ sites });
  state.site = site;
  render();
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { host = new URL(tab.url).hostname; } catch { host = ''; }
  presetHost = (PAGE_TIDY_HOST_ALIASES[host] || host);

  const { enabled } = await chrome.storage.local.get(['enabled']);
  state.enabled = enabled !== false;

  const sites = await getSites();
  state.site = sites[host] || { suspended: false, rules: [] };

  $('host').textContent = host || 'Служебная страница';
  render();
}

function render() {
  const rules = state.site.rules || [];
  const manual = rules.filter(r => !r.preset);
  const activeCount = rules.filter(r => r.enabled !== false).length;

  $('sub').textContent = host
    ? `${activeCount} ${plural(activeCount, 'правило', 'правила', 'правил')} активно`
    : 'Здесь расширение не работает';
  $('suspend').checked = !!state.site.suspended;
  $('enabled').checked = state.enabled;

  // Вручную скрытое
  const ul = $('rules');
  ul.innerHTML = '';
  $('rules-empty').hidden = manual.length > 0;
  for (const r of manual) {
    const li = document.createElement('li');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = r.enabled !== false;
    cb.addEventListener('change', async () => {
      r.enabled = cb.checked;
      await saveSite(state.site);
    });

    const name = document.createElement('span');
    name.className = 'name' + (r.enabled === false ? ' off' : '');
    name.textContent = r.label || r.selector;
    name.title = r.selector || '';
    name.addEventListener('click', () => {
      chrome.tabs.sendMessage(tab.id, { type: 'highlight', selector: r.selector }).catch(() => {});
    });

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Удалить правило';
    del.addEventListener('click', async () => {
      state.site.rules = rules.filter(x => x.id !== r.id);
      await saveSite(state.site);
    });

    li.append(cb, name, del);
    ul.append(li);
  }

  // Готовые правила для этого сайта
  const presets = PAGE_TIDY_PRESETS[presetHost] || [];
  $('presets-title').hidden = presets.length === 0;
  const pul = $('presets');
  pul.innerHTML = '';
  for (const p of presets) {
    const existing = rules.find(r => r.id === p.id);
    const li = document.createElement('li');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!existing && existing.enabled !== false;
    cb.addEventListener('change', async () => {
      if (cb.checked) {
        if (existing) existing.enabled = true;
        else state.site.rules.push({
          id: p.id, label: p.label, selector: p.selector,
          fallbacks: [], sig: null, preset: true, enabled: true, createdAt: 0
        });
      } else if (existing) {
        existing.enabled = false;
      }
      await saveSite(state.site);
    });

    const name = document.createElement('span');
    name.className = 'name' + (cb.checked ? '' : ' off');
    name.textContent = p.label;
    name.title = p.selector;

    li.append(cb, name);
    pul.append(li);
  }
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/* ---------- действия ---------- */

$('pick').addEventListener('click', async () => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'start-picker' });
    window.close();
  } catch {
    $('sub').textContent = 'Обновите страницу — расширение ещё не загрузилось';
  }
});

$('suspend').addEventListener('change', async () => {
  state.site.suspended = $('suspend').checked;
  await saveSite(state.site);
  chrome.tabs.reload(tab.id);
});

$('enabled').addEventListener('change', async () => {
  state.enabled = $('enabled').checked;
  await chrome.storage.local.set({ enabled: state.enabled });
  chrome.tabs.reload(tab.id);
});

$('export').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'page-tidy-backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('import').addEventListener('click', () => $('file').click());

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || typeof data !== 'object' || !('sites' in data)) throw new Error('bad');
    await chrome.storage.local.set(data);
    await init();
    chrome.tabs.reload(tab.id);
  } catch {
    $('sub').textContent = 'Не удалось прочитать файл';
  }
});

$('reset').addEventListener('click', async () => {
  const sites = await getSites();
  delete sites[host];
  await chrome.storage.local.set({ sites });
  state.site = { suspended: false, rules: [] };
  render();
  chrome.tabs.reload(tab.id);
});

init();
