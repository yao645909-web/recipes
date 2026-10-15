'use strict';

// ---------- 設定與儲存 ----------
const KEY_URL = 'recipes.sourceUrl';
const KEY_DATA = 'recipes.cache.v2';
const KEY_SYNCED = 'recipes.syncedAt';
const SAMPLE_URL = 'sample-recipes.csv';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// 試算表欄位名稱 → 內部欄位（可接受幾種常見寫法）
const COLUMNS = {
  name: ['名稱', '品名', '食譜', '名字', 'name'],
  category: ['分類', '類別', '種類', 'category'],
  temp: ['烤溫', '溫度', '烤溫/時間', '烘烤溫度', 'temp'],
  cols: ['倍數', '份量欄', 'columns'],
  ingredients: ['材料', '食材', 'ingredients'],
  steps: ['步驟', '作法', '做法', '製作方式', 'steps'],
  image: ['圖片', '照片', '圖', 'image'],
  notes: ['備註', '筆記', '心得', 'notes'],
  source: ['來源', 'source'],
};

let recipes = [];
let filter = { q: '', cat: '' };
let wakeLock = null;

// ---------- CSV 解析（支援引號與儲存格內換行） ----------
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

// 材料一行：「名稱 | 重量 | 倍數1 | 倍數2」，或簡寫「名稱 100g」；「#分區」是分區標題
function parseIngredient(line) {
  if (line.startsWith('#')) return { group: line.slice(1).trim() };
  if (line.includes('|')) {
    const [name, ...values] = line.split('|').map(s => s.trim());
    return { name, values };
  }
  const m = line.match(/^(.*?)\s+(\d[\d.~]*\S*)$/);
  return m ? { name: m[1], values: [m[2]] } : { name: line, values: [] };
}

function rowsToRecipes(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    idx[key] = header.findIndex(h => names.some(n => n.toLowerCase() === h));
  }
  if (idx.name < 0) throw new Error('找不到「名稱」欄位，請確認試算表第一列是標題');
  const lines = s => (s || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return rows.slice(1).map(r => {
    const get = k => (idx[k] >= 0 ? (r[idx[k]] || '').trim() : '');
    const cols = get('cols').split('|').map(s => s.trim()).filter(Boolean);
    return {
      name: get('name'),
      category: get('category'),
      temp: get('temp'),
      cols: cols.length ? cols : ['重量'],
      ingredients: lines(get('ingredients')).map(parseIngredient),
      steps: lines(get('steps')),
      image: driveImage(get('image')),
      notes: get('notes'),
      source: get('source'),
    };
  }).filter(r => r.name);
}

// 把 Google 雲端硬碟分享連結轉成可直接顯示的圖片網址
function driveImage(url) {
  if (!url) return '';
  const m = url.match(/\/file\/d\/([\w-]+)/) || url.match(/[?&]id=([\w-]+)/);
  return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000` : url;
}

// ---------- 載入資料 ----------
async function sync({ silent = false } = {}) {
  const url = store.get(KEY_URL) || SAMPLE_URL;
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spin');
  try {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(url + sep + '_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('取得的是網頁而不是 CSV，請確認發佈格式選了 CSV');
    recipes = rowsToRecipes(parseCSV(text));
    store.set(KEY_DATA, JSON.stringify(recipes));
    store.set(KEY_SYNCED, new Date().toISOString());
    if (!silent) showStatus(`已同步 ${recipes.length} 道食譜`, 2500);
  } catch (err) {
    showStatus(navigator.onLine
      ? `同步失敗：${err.message}，先顯示上次存下的食譜`
      : '目前離線，顯示上次存下的食譜', 5000);
  } finally {
    btn.classList.remove('spin');
    render();
  }
}

function loadCache() {
  try { recipes = JSON.parse(store.get(KEY_DATA)) || []; } catch { recipes = []; }
}

// ---------- 重量與倍數 ----------
// 「60」「60(二顆)」算得出數字；「適量」「45~75」「6片」不算
const weightOf = v => { const m = /^(\d+(?:\.\d+)?)\s*(?:$|\()/.exec(v || ''); return m ? parseFloat(m[1]) : null; };
const fmt = n => String(Math.round(n * 100) / 100);

// 各倍數欄相對於第一欄的比例（取中位數），用來補齊 Excel 裡沒填的格子
function columnRatios(r) {
  return r.cols.map((_, c) => {
    if (c === 0) return 1;
    const ratios = r.ingredients
      .filter(i => i.values)
      .map(i => [weightOf(i.values[0]), weightOf(i.values[c])])
      .filter(([a, b]) => a && b).map(([a, b]) => b / a).sort((x, y) => x - y);
    return ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  });
}

// 回傳 { text, weight }：優先用 Excel 上的數字，沒有才用比例推算（前面加 ≈）
function cellValue(ing, scale, ratios) {
  const base = ing.values[0] || '';
  if (scale.col > 0) {
    const own = ing.values[scale.col];
    if (own) return { text: own, weight: weightOf(own) };
    const w = weightOf(base), k = ratios[scale.col];
    if (w === null || !k) return { text: base, weight: null };
    return { text: '≈' + fmt(w * k), weight: w * k };
  }
  const w = weightOf(base);
  if (scale.factor === 1 || w === null) return { text: base, weight: w };
  // 「60(二顆)」換算後顆數就不對了，只留數字並標 ≈
  const approx = base !== String(w);
  return { text: (approx ? '≈' : '') + fmt(w * scale.factor), weight: w * scale.factor };
}

// ---------- 畫面 ----------
const $app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICONS = { 蛋糕: '🎂', 餅乾: '🍪', 麵包: '🍞', 塔派: '🥧', 甜點: '🍮', 內餡: '🥣', 其他: '🍬' };
const iconFor = cat => ICONS[cat] || '🥐';

let statusTimer;
function showStatus(msg, ms) {
  const el = document.getElementById('status');
  el.textContent = msg; el.hidden = false;
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function setHeader(title, showBack) {
  document.getElementById('title').textContent = title;
  document.getElementById('backBtn').hidden = !showBack;
  document.title = title;
}

function render() {
  releaseWakeLock();
  const hash = location.hash;
  if (hash.startsWith('#/r/')) return renderDetail(decodeURIComponent(hash.slice(4)));
  if (hash === '#/settings') return renderSettings();
  renderList();
}

function renderList() {
  setHeader('烘焙食譜', false);
  const cats = [...new Set(recipes.map(r => r.category).filter(Boolean))];
  const q = filter.q.toLowerCase();
  const shown = recipes.filter(r =>
    (!filter.cat || r.category === filter.cat) &&
    (!q || r.name.toLowerCase().includes(q) ||
      r.ingredients.some(i => i.name && i.name.toLowerCase().includes(q))));

  $app.innerHTML = `
    <input class="search" type="search" placeholder="搜尋食譜或材料…" value="${esc(filter.q)}">
    <div class="chips">
      <button class="chip ${!filter.cat ? 'active' : ''}" data-cat="">全部 ${recipes.length}</button>
      ${cats.map(c => `<button class="chip ${filter.cat === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    <div class="list">
      ${shown.map(r => `
        <a class="card" href="#/r/${encodeURIComponent(r.name)}">
          <div class="thumb" ${r.image ? `style="background-image:url('${esc(r.image)}')"` : ''}>${r.image ? '' : iconFor(r.category)}</div>
          <div class="card-body">
            <h2>${esc(r.name)}</h2>
            <div class="meta">${[r.category, r.temp.split('；')[0]].filter(Boolean).map(esc).join(' · ')}</div>
          </div>
        </a>`).join('')}
    </div>
    ${shown.length ? '' : `<p class="empty">${recipes.length ? '找不到符合的食譜' : '還沒有食譜，請到 ⚙ 設定連接你的試算表'}</p>`}
  `;

  $app.querySelector('.search').addEventListener('input', e => {
    filter.q = e.target.value;
    const pos = e.target.selectionStart;
    renderList();
    const s = $app.querySelector('.search');
    s.focus(); s.setSelectionRange(pos, pos);
  });
  $app.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
    filter.cat = b.dataset.cat; renderList();
  }));
}

// 材料名稱開頭的 A/B/C 分組字母另外標示
function ingredientName(name) {
  const m = name.match(/^([A-F])(?![A-Za-z0-9%])(.+)$/);
  return m ? `<span class="letter">${m[1]}</span>${esc(m[2])}` : esc(name);
}

function renderDetail(name) {
  const r = recipes.find(x => x.name === name);
  if (!r) { location.hash = ''; return; }
  setHeader(r.name, true);
  const ratios = columnRatios(r);
  const hasCols = r.cols.length > 1;
  let scale = { col: 0, factor: 1 };

  const scaleOptions = hasCols
    ? r.cols.map((label, c) => ({ label, col: c, factor: 1 }))
    : [0.5, 1, 2, 3].map(f => ({ label: '×' + f, col: 0, factor: f }));

  // 依分區產生材料表，每區最後加上合計
  const ingredientsHTML = () => {
    const out = [];
    let total = 0, count = 0;
    const flush = () => {
      if (count > 1) out.push(`<li class="total"><span>合計</span><span>${fmt(total)}</span></li>`);
      total = 0; count = 0;
    };
    for (const ing of r.ingredients) {
      if (ing.group !== undefined) {
        flush();
        out.push(`<li class="group">${esc(ing.group)}</li>`);
        continue;
      }
      const v = cellValue(ing, scale, ratios);
      if (v.weight !== null) { total += v.weight; count++; }
      out.push(`<li class="ing"><span class="name">${ingredientName(ing.name)}</span><span class="qty">${esc(v.text)}</span></li>`);
    }
    flush();
    return out.join('');
  };

  const stepsHTML = r.steps.map(s => {
    if (s.startsWith('#')) return `<li class="group">${esc(s.slice(1).trim())}</li>`;
    // 「1.xxx」或漏了點的「1A材…」都當成第 1 步
    const m = s.match(/^(\d+)(?:\s*[.、．]\s*|(?=[A-F]材))(.*)$/);
    return m
      ? `<li class="step"><span class="num">${m[1]}</span><span>${esc(m[2])}</span></li>`
      : `<li class="step plain"><span class="num"></span><span>${esc(s)}</span></li>`;
  }).join('');

  $app.innerHTML = `
    <article class="detail">
      ${r.image ? `<img class="hero" src="${esc(r.image)}" alt="${esc(r.name)}" loading="lazy">` : ''}
      <h2>${esc(r.name)}</h2>
      <div class="tags">
        ${r.category ? `<span>${esc(r.category)}</span>` : ''}
        ${r.temp ? r.temp.split('；').map(t => `<span>🔥 ${esc(t)}</span>`).join('') : ''}
      </div>

      ${r.ingredients.length ? `
      <div class="section">
        <h3>材料</h3>
        <div class="scale">
          ${scaleOptions.map((o, i) => `<button class="chip ${i === (hasCols ? 0 : 1) ? 'active' : ''}" data-i="${i}">${esc(o.label)}</button>`).join('')}
        </div>
        <ul class="ingredients">${ingredientsHTML()}</ul>
        <p class="hint">${hasCols ? '「≈」是 Excel 上沒填、依比例推算的數字' : '點材料可以劃掉已經秤好的'}</p>
      </div>` : ''}

      ${r.steps.length ? `
      <div class="section">
        <h3>製作方式</h3>
        <ol class="steps">${stepsHTML}</ol>
      </div>` : ''}

      ${r.notes ? `<div class="section"><h3>備註</h3><div class="notes">${esc(r.notes)}</div></div>` : ''}

      ${'wakeLock' in navigator ? `<label class="toggle"><input type="checkbox" id="wake"> 做的時候保持螢幕常亮</label>` : ''}
      ${r.source ? `<p class="source">來源：${esc(r.source)}</p>` : ''}
    </article>
  `;

  const list = $app.querySelector('.ingredients');
  $app.querySelectorAll('.scale .chip').forEach(b => b.addEventListener('click', () => {
    const o = scaleOptions[b.dataset.i];
    scale = { col: o.col, factor: o.factor };
    $app.querySelectorAll('.scale .chip').forEach(x => x.classList.toggle('active', x === b));
    list.innerHTML = ingredientsHTML();
  }));
  const wake = document.getElementById('wake');
  if (wake) wake.addEventListener('change', async () => {
    if (wake.checked) {
      try { wakeLock = await navigator.wakeLock.request('screen'); }
      catch { wake.checked = false; showStatus('這個裝置不支援螢幕常亮', 3000); }
    } else releaseWakeLock();
  });
  window.scrollTo(0, 0);
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function renderSettings() {
  setHeader('設定', true);
  const url = store.get(KEY_URL) || '';
  const synced = store.get(KEY_SYNCED);
  $app.innerHTML = `
    <div class="form">
      <label for="url">Google 試算表 CSV 網址</label>
      <input id="url" type="url" placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?output=csv" value="${esc(url)}">
      <button class="btn" id="save">儲存並同步</button>
      <button class="btn secondary" id="sample">改用範例食譜</button>
      <p class="help">目前：${url ? '你的試算表' : '範例食譜'}，共 ${recipes.length} 道${synced ? `，上次同步 ${new Date(synced).toLocaleString('zh-TW')}` : ''}</p>

      <div class="help">
        <h3>怎麼取得網址</h3>
        <ol>
          <li>打開「食譜總表」試算表，選「檔案 → 共用 → 發佈到網路」</li>
          <li>選要發佈的工作表，格式選「逗號分隔值 (.csv)」，按「發佈」</li>
          <li>複製產生的網址，貼到上面</li>
        </ol>
        <h3>新增或修改食譜</h3>
        <p>直接在「食譜總表」裡改，改完在 App 按 ⟳ 同步。一列一道食譜，欄位：<code>名稱</code> <code>分類</code> <code>烤溫</code> <code>倍數</code> <code>材料</code> <code>步驟</code> <code>圖片</code> <code>備註</code> <code>來源</code></p>
        <p><b>材料</b>：一行一樣，寫成 <code>A高粉 | 385 | 192.5</code>（名稱 | 重量 | 其他倍數）。開頭加 <code>#</code> 是分區，例如 <code>#主麵團</code>。</p>
        <p><b>倍數</b>：材料每一欄的名稱，例如 <code>重量 | 3倍 | 5倍</code>。只有一欄時，App 會提供 ×0.5～×3 自動換算。</p>
        <p><b>步驟</b>：一行一步，開頭加 <code>#</code> 是分區。同一格裡換行用 Alt+Enter（手機上直接換行）。</p>
        <p><b>圖片</b>：貼雲端硬碟圖片的分享連結（要設成「知道連結的任何人」可檢視）。</p>
      </div>
    </div>
  `;
  document.getElementById('save').addEventListener('click', () => {
    const v = document.getElementById('url').value.trim();
    if (v) store.set(KEY_URL, v); else store.del(KEY_URL);
    location.hash = ''; sync();
  });
  document.getElementById('sample').addEventListener('click', () => {
    store.del(KEY_URL); location.hash = ''; sync();
  });
}

// ---------- 啟動 ----------
document.getElementById('backBtn').addEventListener('click', () => {
  if (history.length > 1) history.back(); else location.hash = '';
});
document.getElementById('settingsBtn').addEventListener('click', () => { location.hash = '#/settings'; });
document.getElementById('refreshBtn').addEventListener('click', () => sync());
window.addEventListener('hashchange', render);
// 點一下劃掉已完成的材料／步驟
$app.addEventListener('click', e => {
  const li = e.target.closest('.ingredients li.ing, .steps li.step');
  if (li) li.classList.toggle('done');
});
document.addEventListener('visibilitychange', () => {
  // 螢幕常亮在切到背景時會被系統釋放，回來時重新申請
  const wake = document.getElementById('wake');
  if (document.visibilityState === 'visible' && wake && wake.checked && !wakeLock) {
    navigator.wakeLock.request('screen').then(l => { wakeLock = l; }).catch(() => {});
  }
});

loadCache();
render();
sync({ silent: recipes.length > 0 });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
