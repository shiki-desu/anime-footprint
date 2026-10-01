/* ===== 动漫足迹 · 主逻辑 ===== */
'use strict';

const LS_KEY = 'animeFootprint:v1';
const DEFAULT_SETTINGS = { mode: 'auto', accent: '#6366f1', poster: 'm', view: 'grid', sort: 'added', bgmApi: '' };
const ACCENT_PRESETS = ['#6366f1', '#0ea5e9', '#14b8a6', '#8b5cf6', '#ec4899', '#f97316'];

let state = loadState();
const filters = { status: 'all', type: 'all', q: '' };
let editingId = null;   // 当前编辑条目 id；null = 新建
let importedPending = null;
let fillAbort = false;

/* ---------- 基础工具 ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/* 图片降级链：原图 → wsrv.nl 代理 → onFail 兜底 */
function proxiedImg(url) {
  return 'https://images.weserv.nl/?url=' + encodeURIComponent(String(url).replace(/^https?:\/\//, ''));
}
function smartImg(src, alt, onFail) {
  const img = new Image();
  img.loading = 'lazy';
  img.alt = alt || '';
  let stage = 0;
  img.onerror = () => {
    if (stage === 0 && src) {
      stage = 1;
      img.src = proxiedImg(src);
    } else if (onFail) {
      onFail();
    }
  };
  if (src) img.src = src;
  else if (onFail) onFail();
  return img;
}

function newEntryObj(data) {
  return Object.assign({
    id: uid(), title: '', group: '', type: 'anime', status: 'watching',
    score: null, currentEp: null, totalEp: null, poster: null,
    comment: '', bangumiId: null,
    addedAt: Date.now(), updatedAt: Date.now()
  }, data);
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      return { entries: Array.isArray(d.entries) ? d.entries : [], settings: Object.assign({}, DEFAULT_SETTINGS, d.settings || {}) };
    }
  } catch (e) { /* 损坏则重置 */ }
  return { entries: [], settings: Object.assign({}, DEFAULT_SETTINGS) };
}
function save() { localStorage.setItem(LS_KEY, JSON.stringify({ entries: state.entries, settings: state.settings })); }

let toastTimer = null;
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 2400);
}

/* ---------- 主题 / 外观 ---------- */
function applySettings() {
  const s = state.settings;
  const dark = s.mode === 'dark' || (s.mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.poster = s.poster;
  document.documentElement.style.setProperty('--accent', s.accent);
  $$('#setMode button').forEach(b => b.classList.toggle('on', b.dataset.v === s.mode));
  $$('#setPoster button').forEach(b => b.classList.toggle('on', b.dataset.v === s.poster));
  $$('#setSwatches .swatch').forEach(b => b.classList.toggle('on', b.dataset.c === s.accent));
  $('#btnView').classList.toggle('btn-primary', s.view === 'group');
  $('#btnView').textContent = s.view === 'group' ? '▦ 网格' : '🗂 分组';
  $('#sortSel').value = s.sort;
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySettings);

/* ---------- 渲染 ---------- */
function visibleEntries() {
  let list = [...state.entries];
  if (filters.status !== 'all') list = list.filter(e => e.status === filters.status);
  if (filters.type !== 'all') list = list.filter(e => (e.type || 'anime') === filters.type);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    list = list.filter(e => [e.title, e.group, e.comment].some(x => x && String(x).toLowerCase().includes(q)));
  }
  const s = state.settings.sort;
  if (s === 'score') list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  else if (s === 'title') list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  else if (s === 'updated') list.sort((a, b) => b.updatedAt - a.updatedAt);
  else list.sort((a, b) => a.addedAt - b.addedAt);
  return list;
}

function render() {
  renderChips();
  renderMain();
  applySettings();
}

function chip(label, count, active, onclick) {
  const b = el('button', 'chip' + (active ? ' active' : ''));
  b.append(label);
  if (count != null) {
    const c = el('b', null, String(count));
    b.appendChild(c);
  }
  b.onclick = onclick;
  return b;
}

function renderChips() {
  const es = state.entries;
  const cnt = k => es.filter(e => e.status === k).length;
  const sc = $('#statusChips');
  sc.textContent = '';
  sc.append(chip('全部', es.length, filters.status === 'all', () => { filters.status = 'all'; render(); }));
  for (const k of ['watching', 'finished', 'planned']) {
    sc.append(chip(STATUS_LABELS[k], cnt(k), filters.status === k, () => { filters.status = k; render(); }));
  }
  const tc = $('#typeChips');
  tc.textContent = '';
  tc.append(chip('全部类型', null, filters.type === 'all', () => { filters.type = 'all'; render(); }));
  const types = ['anime', 'movie', 'real', 'novel', 'manga'];
  for (const t of types) {
    const n = es.filter(e => (e.type || 'anime') === t).length;
    if (n === 0 && filters.type !== t) continue;
    tc.append(chip(TYPE_LABELS[t], n, filters.type === t, () => { filters.type = t; render(); }));
  }
}

function progressLine(e) {
  if (!e.currentEp || !e.totalEp) return null;
  const pct = Math.min(100, Math.round(e.currentEp / e.totalEp * 100));
  const wrap = el('div', 'progress-line');
  const bar = el('i');
  bar.style.width = pct + '%';
  wrap.appendChild(bar);
  return wrap;
}

function cardEl(e) {
  const card = el('article', 'card');
  const cover = el('div', 'cover');
  if (e.poster) {
    const img = smartImg(e.poster, e.title, () => { img.remove(); if (!cover.querySelector('img')) cover.appendChild(coverFallback(e)); });
    cover.appendChild(img);
  } else {
    cover.appendChild(coverFallback(e));
  }
  cover.appendChild(el('span', 'badge status-' + e.status, STATUS_LABELS[e.status] || '在看'));
  if (e.score != null && isFinite(+e.score)) {
    const v = +e.score;
    cover.appendChild(el('span', 'badge score', '★ ' + (Number.isInteger(v) ? v : v.toFixed(1))));
  }
  if (e.status === 'watching') {
    const b = el('button', 'ep-plus', '+1');
    b.title = '集数 +1';
    b.onclick = ev => { ev.stopPropagation(); bumpEp(e); };
    cover.appendChild(b);
  }
  const info = el('div', 'info');
  info.appendChild(el('h3', null, e.title));
  const meta = [];
  if (e.group) meta.push('#' + e.group);
  if (e.totalEp) meta.push(e.currentEp ? `${e.currentEp}/${e.totalEp}集` : `共${e.totalEp}集`);
  else if (e.currentEp) meta.push(`第${e.currentEp}集`);
  if (e.type && e.type !== 'anime') meta.push(TYPE_LABELS[e.type] || e.type);
  if (meta.length) info.appendChild(el('p', 'meta', meta.join(' · ')));
  const pl = progressLine(e);
  if (pl) info.appendChild(pl);
  card.append(cover, info);
  card.onclick = () => openEdit(e);
  return card;
}

function coverFallback(e) {
  const d = el('div', 'cover-fallback', (e.title || '？').trim().charAt(0));
  return d;
}

function bumpEp(e) {
  e.currentEp = (e.currentEp || 0) + 1;
  if (e.totalEp && e.currentEp > e.totalEp) e.currentEp = e.totalEp;
  e.updatedAt = Date.now();
  save(); render();
  if (e.totalEp && e.currentEp === e.totalEp) toast(`《${e.title}》已到最终集，看完记得标记！`);
}

function renderMain() {
  const main = $('#main');
  main.textContent = '';
  const list = visibleEntries();

  if (!state.entries.length) {
    const empty = el('div', 'empty');
    empty.appendChild(el('div', 'big', '🐾'));
    empty.appendChild(el('h2', null, '开始记录你的动漫足迹'));
    empty.appendChild(el('p', null, '添加看过的作品，打分、记录进度、自动匹配海报。'));
    const line = el('div', 'btn-line');
    const b1 = el('button', 'btn btn-primary', '＋ 添加作品');
    b1.onclick = openAdd;
    const b2 = el('button', 'btn btn-ghost', '导入作品记录');
    b2.onclick = openData;
    line.append(b1, b2);
    empty.appendChild(line);
    main.appendChild(empty);
    $('#stats').textContent = '';
    return;
  }

  if (!list.length) {
    main.appendChild(el('div', 'empty', '没有符合条件的作品'));
    $('#stats').textContent = '';
    return;
  }

  if (state.settings.view === 'group') {
    const groups = new Map();
    for (const e of list) {
      const g = e.group || '未分组';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(e);
    }
    const names = [...groups.keys()].sort((a, b) => {
      if (a === '未分组') return 1;
      if (b === '未分组') return -1;
      return a.localeCompare(b, 'zh-Hans-CN');
    });
    for (const name of names) {
      const sec = el('section', 'group-sec');
      const h = el('h2');
      h.appendChild(el('span', 'arrow', '▼'));
      h.appendChild(document.createTextNode(name));
      h.appendChild(el('span', 'cnt', `（${groups.get(name).length}）`));
      h.onclick = () => sec.classList.toggle('collapsed');
      sec.appendChild(h);
      const grid = el('div', 'grid');
      groups.get(name).forEach(e => grid.appendChild(cardEl(e)));
      sec.appendChild(grid);
      main.appendChild(sec);
    }
  } else {
    const grid = el('div', 'grid');
    list.forEach(e => grid.appendChild(cardEl(e)));
    main.appendChild(grid);
  }

  const done = state.entries.filter(e => e.status === 'finished').length;
  const watching = state.entries.filter(e => e.status === 'watching').length;
  const scored = state.entries.filter(e => e.score != null);
  const avg = scored.length ? (scored.reduce((s, e) => s + +e.score, 0) / scored.length).toFixed(1) : '—';
  $('#stats').textContent = `共 ${state.entries.length} 部 · 看完 ${done} · 在看 ${watching} · 平均评分 ${avg}`;
}

/* ---------- 弹窗通用 ---------- */
function openModal(id) { $('#' + id).classList.remove('hidden'); }
function closeModal(id) { $('#' + id).classList.add('hidden'); }
$$('.overlay').forEach(ov => {
  ov.addEventListener('mousedown', ev => { if (ev.target === ov) ov.classList.add('hidden'); });
});
$$('[data-close]').forEach(b => b.onclick = () => closeModal(b.dataset.close));
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') $$('.overlay').forEach(ov => ov.classList.add('hidden'));
});

function confirmDlg(title, msg, okText) {
  return new Promise(resolve => {
    $('#cfTitle').textContent = title;
    $('#cfMsg').textContent = msg;
    const ok = $('#cfOk');
    ok.textContent = okText || '确定';
    ok.className = okText === '删除' ? 'btn btn-danger' : 'btn btn-primary';
    openModal('modalConfirm');
    ok.onclick = () => { closeModal('modalConfirm'); resolve(true); };
    $('#cfCancel').onclick = () => { closeModal('modalConfirm'); resolve(false); };
  });
}

/* ---------- 编辑 / 新建 ---------- */
let edStatusVal = 'watching';
let edScoreVal = null;

function openEdit(entry, isNew) {
  editingId = isNew ? null : entry.id;
  const e = entry || {};
  $('#edHead').textContent = isNew ? '添加作品' : '编辑作品';
  $('#edTitle').value = e.title || '';
  $('#edGroup').value = e.group || '';
  $('#edType').value = e.type || 'anime';
  edStatusVal = e.status || 'watching';
  edScoreVal = (e.score != null && isFinite(+e.score)) ? +e.score : null;
  $('#edCur').value = e.currentEp != null ? e.currentEp : '';
  $('#edTotal').value = e.totalEp != null ? e.totalEp : '';
  $('#edComment').value = e.comment || '';
  $('#edPosterUrl').value = e.poster || '';
  $('#edDelete').classList.toggle('hidden', isNew);
  renderEdStatus();
  renderEdScore();
  renderEdPoster(e.title || '');
  $('#edSearchArea').classList.add('hidden');
  $('#edSearchResults').textContent = '';
  $('#edSearchName').value = '';
  refreshGroupList();
  openModal('modalEdit');
  if (isNew && !e.title) $('#edTitle').focus();
}

function renderEdStatus() {
  $$('#edStatus button').forEach(b => b.classList.toggle('on', b.dataset.v === edStatusVal));
}
function renderEdScore() {
  const slider = $('#edScore');
  slider.disabled = edScoreVal == null;
  slider.value = edScoreVal != null ? edScoreVal : 0;
  $('#edScoreVal').textContent = edScoreVal != null ? (Number.isInteger(edScoreVal) ? edScoreVal : edScoreVal.toFixed(1)) + ' 分' : '未评分';
}
function renderEdPoster(fallbackChar) {
  const box = $('#edPosterBox');
  box.textContent = '';
  const url = $('#edPosterUrl').value.trim();
  if (url) {
    const img = smartImg(url, '', () => { box.textContent = '封面加载失败'; });
    box.appendChild(img);
  } else {
    box.textContent = fallbackChar ? fallbackChar.trim().charAt(0) : '🖼';
  }
}

function refreshGroupList() {
  const dl = $('#groupList');
  dl.textContent = '';
  [...new Set(state.entries.map(e => e.group).filter(Boolean))].sort()
    .forEach(g => { const o = document.createElement('option'); o.value = g; dl.appendChild(o); });
}

$$('#edStatus button').forEach(b => b.onclick = () => { edStatusVal = b.dataset.v; renderEdStatus(); });
$('#edScore').addEventListener('input', () => { edScoreVal = +$('#edScore').value; renderEdScore(); });
$('#edScoreClear').onclick = () => { edScoreVal = null; renderEdScore(); };
$('#edPosterUrl').addEventListener('change', () => renderEdPoster($('#edTitle').value));

$('#edSearchToggle').onclick = () => $('#edSearchArea').classList.toggle('hidden');
$('#edSearchBtn').onclick = () => runEditSearch();
$('#edSearchName').addEventListener('keydown', ev => { if (ev.key === 'Enter') runEditSearch(); });

async function runEditSearch() {
  const kw = $('#edSearchName').value.trim();
  const box = $('#edSearchResults');
  if (!kw) return;
  box.textContent = '';
  box.appendChild(el('div', 'result-empty', '搜索中…'));
  const results = await bgSearch(kw, $('#edType').value || 'anime');
  renderResults(box, results, pick);
  async function pick(r) {
    $('#edPosterUrl').value = r.poster || '';
    renderEdPoster($('#edTitle').value);
    if (r.src === 'bangumi' && typeof r.id === 'number' && (!r.poster || r.eps == null)) {
      const sub = await bgSubject(r.id);
      if (sub) {
        if (!r.poster && sub.images) {
          $('#edPosterUrl').value = sub.images.large || sub.images.common || '';
          renderEdPoster($('#edTitle').value);
        }
        if (r.eps == null && sub.eps) $('#edTotal').value = sub.eps;
      }
    }
    if (r.eps != null && !$('#edTotal').value) $('#edTotal').value = r.eps;
    toast('封面已更新');
  }
}

$('#edSave').onclick = () => {
  const title = $('#edTitle').value.trim();
  if (!title) { toast('请填写标题'); $('#edTitle').focus(); return; }
  const data = {
    title,
    group: $('#edGroup').value.trim(),
    type: $('#edType').value,
    status: edStatusVal,
    score: edScoreVal,
    currentEp: $('#edCur').value ? Math.max(0, Math.floor(+$('#edCur').value)) : null,
    totalEp: $('#edTotal').value ? Math.max(0, Math.floor(+$('#edTotal').value)) : null,
    poster: $('#edPosterUrl').value.trim() || null,
    comment: $('#edComment').value.trim(),
    updatedAt: Date.now()
  };
  if (editingId) {
    const e = state.entries.find(x => x.id === editingId);
    Object.assign(e, data);
    toast('已保存');
  } else {
    state.entries.push(newEntryObj(data));
    toast('已添加《' + title + '》');
  }
  save(); render();
  closeModal('modalEdit');
};

$('#edDelete').onclick = async () => {
  const e = state.entries.find(x => x.id === editingId);
  if (!e) return;
  const ok = await confirmDlg('删除作品', `确定删除《${e.title}》吗？该操作无法撤销。`, '删除');
  if (!ok) return;
  state.entries = state.entries.filter(x => x.id !== editingId);
  save(); render();
  closeModal('modalEdit');
  toast('已删除');
};

/* ---------- 添加（搜索） ---------- */
function openAdd() {
  $('#addName').value = '';
  $('#addResults').textContent = '';
  openModal('modalAdd');
  $('#addName').focus();
}
$('#btnAdd').onclick = openAdd;
$('#addSearchBtn').onclick = runAddSearch;
$('#addName').addEventListener('keydown', ev => { if (ev.key === 'Enter') runAddSearch(); });

async function runAddSearch() {
  const kw = $('#addName').value.trim();
  if (!kw) return;
  const box = $('#addResults');
  box.textContent = '';
  box.appendChild(el('div', 'result-empty', '正在匹配海报与信息…'));
  let results = await bgSearch(kw, 'anime');
  if (!results.length) results = await bgSearch(bgCleanKeyword(kw), 'anime');
  renderResults(box, results, pick);
  async function pick(r) {
    closeModal('modalAdd');
    openEdit({
      title: r.title || kw,
      poster: r.poster,
      bangumiId: r.src === 'bangumi' && typeof r.id === 'number' ? r.id : null,
      totalEp: r.eps
    }, true);
    if (r.src === 'bangumi' && typeof r.id === 'number' && (!r.poster || r.eps == null)) {
      const sub = await bgSubject(r.id);
      if (sub) {
        if (!r.poster && sub.images) $('#edPosterUrl').value = sub.images.large || sub.images.common || '';
        if (r.eps == null && sub.eps) $('#edTotal').value = sub.eps;
      }
    }
  }
}

$('#addManual').onclick = ev => {
  ev.preventDefault();
  const kw = $('#addName').value.trim();
  closeModal('modalAdd');
  openEdit(kw ? { title: kw } : {}, true);
};

function renderResults(box, results, onPick) {
  box.textContent = '';
  if (!results.length) {
    box.appendChild(el('div', 'result-empty', '没有找到匹配结果，可以手动添加'));
    return;
  }
  for (const r of results.slice(0, 12)) {
    if (!r.poster) continue;
    const item = el('div', 'result-item');
    item.appendChild(smartImg(r.poster, r.title || ''));
    item.appendChild(el('div', 'rt', r.title || r.orig || ''));
    item.appendChild(el('div', 'ry', [r.year, r.eps ? r.eps + '集' : null].filter(Boolean).join(' · ')));
    item.onclick = () => onPick(r);
    box.appendChild(item);
  }
  if (!box.children.length) box.appendChild(el('div', 'result-empty', '没有带封面的结果，试试手动添加'));
}

/* ---------- 导入 / 导出 ---------- */
function openData() {
  importedPending = null;
  $('#importPreview').classList.add('hidden');
  $('#btnImportConfirm').classList.add('hidden');
  resetFillUI();
  openModal('modalData');
}
$('#btnData').onclick = openData;
$('#btnFill').onclick = () => { openData(); startFill(); };

$('#btnExport').onclick = () => {
  const blob = new Blob([JSON.stringify({ app: 'anime-footprint', version: 1, exportedAt: new Date().toISOString(), entries: state.entries }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'anime-footprint-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('备份已下载');
};

$('#btnImportPreview').onclick = () => {
  const text = $('#importText').value;
  if (!text.trim()) { toast('请先选择文件或粘贴内容'); return; }
  try {
    const res = parseImportAuto(text);
    if (!res.entries.length) {
      showImportPreview('没有解析到任何条目，请检查格式。' + (res.warnings || []).join('；'));
      return;
    }
    importedPending = res.entries;
    const n = res.entries.length;
    const done = res.entries.filter(e => e.status === 'finished').length;
    const watching = res.entries.filter(e => e.status === 'watching').length;
    const groups = new Set(res.entries.map(e => e.group).filter(Boolean)).size;
    let html = `解析成功：<b>${n}</b> 条（看完 ${done} · 在看 ${watching} · 想看 ${n - done - watching}），分组 ${groups} 个`;
    if (res.warnings && res.warnings.length) {
      html += `<div class="warn">⚠ ${res.warnings.slice(0, 5).join('<br>⚠ ')}</div>`;
    }
    showImportPreview(html);
  } catch (err) {
    showImportPreview('<span class="warn">解析失败：' + (err.message || err) + '</span>');
  }
};

function showImportPreview(html) {
  const p = $('#importPreview');
  p.innerHTML = html;
  p.classList.remove('hidden');
  $('#btnImportConfirm').classList.remove('hidden');
}

$('#importFile').addEventListener('change', () => {
  const f = $('#importFile').files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    $('#importText').value = reader.result;
    toast('已读取 ' + f.name + '，点击"解析预览"');
  };
  reader.readAsText(f, 'utf-8');
});

$('#btnImportConfirm').onclick = () => {
  if (!importedPending) return;
  const mode = document.querySelector('input[name="importMode"]:checked').value;
  if (mode === 'replace' && state.entries.length) {
    confirmDlg('覆盖导入', `将删除现有 ${state.entries.length} 条记录并导入 ${importedPending.length} 条，确定吗？`, '覆盖').then(ok => {
      if (ok) doImport('replace');
    });
  } else {
    doImport('append');
  }
};

function doImport(mode) {
  if (mode === 'replace') state.entries = [];
  importedPending.forEach(e => state.entries.push(e));
  importedPending = null;
  save(); render();
  closeModal('modalData');
  $('#importText').value = '';
  toast(`导入完成，当前共 ${state.entries.length} 条记录`);
}

/* ---------- 一键补全封面 ---------- */
function resetFillUI() {
  fillAbort = false;
  $('#fillWrap').classList.add('hidden');
  $('#fillBar').style.width = '0';
  $('#fillText').textContent = '';
  $('#btnFillStop').classList.add('hidden');
  $('#btnFillPosters').classList.remove('hidden');
}
$('#btnFillStop').onclick = () => { fillAbort = true; };

async function startFill() {
  const missing = state.entries.filter(e => !e.poster);
  if (!missing.length) { toast('所有条目都有封面啦'); return; }
  const ok = await confirmDlg('自动补全封面', `将为 ${missing.length} 个缺少封面的条目自动搜索封面（约需 ${Math.ceil(missing.length * 1.6 / 60)} 分钟），过程中请保持网络畅通。`, '开始');
  if (!ok) return;
  fillAbort = false;
  $('#btnFillPosters').classList.add('hidden');
  $('#btnFillStop').classList.remove('hidden');
  $('#fillWrap').classList.remove('hidden');
  let done = 0, got = 0, missStreak = 0;
  for (const e of missing) {
    if (fillAbort) break;
    let results = await bgSearch(e.title, e.type || 'anime');
    if (!results.length) results = await bgSearch(bgCleanKeyword(e.title), e.type || 'anime');
    const hit = results.find(r => r.poster);
    if (hit) {
      e.poster = hit.poster;
      if (hit.src === 'bangumi' && typeof hit.id === 'number') e.bangumiId = hit.id;
      if (!e.totalEp && hit.eps) e.totalEp = hit.eps;
      e.updatedAt = Date.now();
      got++;
      missStreak = 0;
    } else {
      missStreak++;
    }
    done++;
    $('#fillBar').style.width = (done / missing.length * 100).toFixed(1) + '%';
    $('#fillText').textContent = `${done}/${missing.length} · 成功匹配 ${got} 张封面`;
    if (done % 12 === 0) { save(); render(); }
    // 公共代理有速率限制：匹配失败连续出现时退避，平时保持温和节奏
    if (missStreak >= 6) { missStreak = 0; await new Promise(r => setTimeout(r, 8000)); }
    else await new Promise(r => setTimeout(r, 1400));
  }
  save(); render();
  $('#btnFillStop').classList.add('hidden');
  $('#btnFillPosters').classList.remove('hidden');
  toast(fillAbort ? `已停止，本次匹配 ${got} 张封面` : `补全完成！成功匹配 ${got}/${missing.length} 张封面`);
}
$('#btnFillPosters').onclick = startFill;

/* ---------- 外观设置 ---------- */
$('#btnSettings').onclick = () => {
  $('#setCustomColor').value = state.settings.accent;
  $('#setMirror').value = state.settings.bgmApi || '';
  openModal('modalSettings');
};
$('#btnMore').onclick = ev => { ev.stopPropagation(); $('#moreMenu').classList.toggle('hidden'); };
document.addEventListener('click', ev => {
  if (!ev.target.closest('.more-wrap')) $('#moreMenu').classList.add('hidden');
});

const sw = $('#setSwatches');
ACCENT_PRESETS.forEach(c => {
  const b = el('button', 'swatch');
  b.style.background = c;
  b.dataset.c = c;
  b.title = c;
  b.onclick = () => { state.settings.accent = c; save(); applySettings(); renderMain(); };
  sw.appendChild(b);
});
$('#setCustomColor').addEventListener('input', ev => {
  state.settings.accent = ev.target.value;
  save(); applySettings();
});
$('#setMirror').addEventListener('change', ev => {
  state.settings.bgmApi = ev.target.value.trim();
  save();
  delete bgHealth.bangumi;
  delete bgHealth.allorigins;
  if (state.settings.bgmApi) toast('镜像已保存，下次搜索生效');
  else toast('已清除镜像设置');
});
$$('#setMode button').forEach(b => b.onclick = () => { state.settings.mode = b.dataset.v; save(); applySettings(); });
$$('#setPoster button').forEach(b => b.onclick = () => { state.settings.poster = b.dataset.v; save(); applySettings(); });

/* ---------- 顶栏交互 ---------- */
$('#searchBox').addEventListener('input', () => {
  clearTimeout($('#searchBox')._t);
  $('#searchBox')._t = setTimeout(() => {
    filters.q = $('#searchBox').value.trim();
    renderMain();
  }, 180);
});
$('#sortSel').addEventListener('change', () => { state.settings.sort = $('#sortSel').value; save(); renderMain(); });
$('#btnView').onclick = () => {
  state.settings.view = state.settings.view === 'grid' ? 'group' : 'grid';
  save(); render();
};

$('#btnClear').onclick = async () => {
  if (!state.entries.length) { toast('记录已经是空的啦'); return; }
  const ok = await confirmDlg('清空全部数据', `确定删除全部 ${state.entries.length} 条记录吗？建议先导出备份。`, '删除');
  if (!ok) return;
  state.entries = [];
  save(); render();
  toast('已清空');
};

/* ---------- 启动 ---------- */
render();
