/* ===== 动漫足迹 · 主逻辑 ===== */
'use strict';

const LS_KEY = 'animeFootprint:v1';
const DEFAULT_SETTINGS = { mode: 'auto', accent: '#b4532a', poster: 'm', view: 'series', sort: 'added', bgmApi: '' };
const ACCENT_PRESETS = ['#b4532a', '#3a6b7d', '#5d7a4e', '#8c5a2b', '#5b5e9e', '#a83a5e'];
const TYPE_ICONS = { anime: 'tv', movie: 'film', real: 'users', novel: 'book', manga: 'pen' };

let state = loadState();
const filters = { status: 'all', type: 'all', q: '' };
let editingId = null;   // 当前编辑条目 id；null = 新建
let importedPending = null;
let fillAbort = false;
let currentSeriesName = null;   // 系列目录弹窗当前展示的系列

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

/* 图片降级链：原图 → wsrv.nl 代理 → onFail 兜底（proxiedImg 定义在 bangumi.js） */
function smartImg(src, alt, onFail) {
  const img = new Image();
  img.loading = 'lazy';
  img.alt = alt || '';
  img.addEventListener('load', () => img.classList.add('loaded'));
  const alreadyProxied = /^https?:\/\/images\.weserv\.nl/.test(src || '');
  let stage = 0;
  img.onerror = () => {
    if (stage === 0 && src && !alreadyProxied) {
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
      const settings = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
      // 旧版默认色与旧视图迁移
      if (settings.accent === '#6366f1') settings.accent = DEFAULT_SETTINGS.accent;
      if (settings.view === 'grid' || settings.view === 'group') settings.view = 'series';
      return { entries: Array.isArray(d.entries) ? d.entries : [], settings };
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
  $('#btnView').classList.toggle('btn-primary', false);
  const use = $('#btnView use');
  if (use) use.setAttribute('href', s.view === 'series' ? '#i-list' : '#i-grid');
  $('#btnViewText').textContent = s.view === 'series' ? '条目' : '作品';
  $('#sortSel').value = s.sort;
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySettings);

/* ---------- 渲染 ---------- */
function entryMatches(e) {
  if (filters.status !== 'all' && e.status !== filters.status) return false;
  if (filters.type !== 'all' && (e.type || 'anime') !== filters.type) return false;
  if (filters.q) {
    const q = filters.q.toLowerCase();
    if (![e.title, e.group, e.comment].some(x => x && String(x).toLowerCase().includes(q))) return false;
  }
  return true;
}

function sortCmp(a, b) {
  const s = state.settings.sort;
  if (s === 'score') return (b.score ?? -1) - (a.score ?? -1);
  if (s === 'title') return String(a.sortTitle || a.title).localeCompare(String(b.sortTitle || b.title), 'zh-Hans-CN');
  if (s === 'updated') return b.updatedAt - a.updatedAt;
  return a.addedAt - b.addedAt;
}

function visibleEntries() {
  const list = state.entries.filter(entryMatches);
  list.sort(sortCmp);
  return list;
}

/* ----- 系列归拢：同系列作品聚合成一张“作品卡”，点进去看内部条目 ----- */

// 去掉季数/剧场版/卷数等修饰，得到系列名
function baseTitleOf(title) {
  const base = String(title || '')
    .replace(/\s*第[一二三四五六七八九十0-9]+\s*[季部].*$/, '')
    .replace(/\s*(最终季|完结篇|始动篇|总集篇|剧场版|OVA\s?\d*|OAD|SP|Part\s?\d+).*$/i, '')
    .replace(/\s*[\[［【（(][^\]】）)]*[\]】）)]\s*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s+＋\-—·、,，]+$/, '')
    .trim();
  return base || String(title || '');
}

// 系列内部条目显示名：去掉系列名前缀
function innerTitle(e, name) {
  let t = String(e.title || '');
  if (name && t.startsWith(name)) t = t.slice(name.length);
  t = t.replace(/^[\s+＋\-—·、,，：:]+/, '').trim();
  return t || (t === '' && name === e.title ? '本篇' : e.title);
}

function computeSeries() {
  const groups = new Map();     // 导入时的分组
  const derived = new Map();    // 从标题推断的系列
  const standalone = [];

  for (const e of state.entries) {
    if (e.group) {
      const k = 'g:' + e.group;
      if (!groups.has(k)) groups.set(k, { key: k, name: e.group, items: [] });
      groups.get(k).items.push(e);
      continue;
    }
    const base = baseTitleOf(e.title);
    if (base && base !== e.title) {
      // 标题推断出的系列名若与已有分组同名，归入该分组
      const gk = 'g:' + base;
      if (groups.has(gk)) { groups.get(gk).items.push(e); continue; }
      if (!derived.has('t:' + base)) derived.set('t:' + base, { key: 't:' + base, name: base, items: [] });
      derived.get('t:' + base).items.push(e);
      continue;
    }
    standalone.push(e);
  }

  const enrich = (s) => {
    s.items.sort((a, b) => a.addedAt - b.addedAt);
    const withPoster = s.items.find(e => e.poster);
    s.poster = withPoster ? withPoster.poster : null;
    s.addedAt = Math.min(...s.items.map(e => e.addedAt));
    s.updatedAt = Math.max(...s.items.map(e => e.updatedAt));
    s.maxScore = Math.max(...s.items.map(e => e.score != null ? +e.score : -1));
    s.anyWatching = s.items.some(e => e.status === 'watching');
    s.allFinished = s.items.every(e => e.status === 'finished');
    s.anyPlanned = s.items.some(e => e.status === 'planned');
    s.aggStatus = s.anyWatching ? 'watching' : (s.allFinished ? 'finished' : (s.anyPlanned ? 'planned' : 'watching'));
    const tc = {};
    s.items.forEach(e => { const t = e.type || 'anime'; tc[t] = (tc[t] || 0) + 1; });
    s.type = Object.entries(tc).sort((a, b) => b[1] - a[1])[0][0];
    s.sortTitle = s.name;
    return s;
  };

  const series = [...groups.values(), ...derived.values()].map(enrich);
  for (const s of series) {
    // 已有分组名与标题推断系列同名时合并
    s.key = s.key;
  }
  // 标题推断系列若与导入分组重名（理论上已并入），保险起见按名字合并
  const byName = new Map();
  for (const s of series) {
    if (byName.has(s.name)) {
      byName.get(s.name).items.push(...s.items);
    } else byName.set(s.name, s);
  }
  const merged = [...byName.values()].map(enrich);
  for (const e of standalone) { e.sortTitle = e.title; }
  return { series: merged, standalone };
}

/* -- 卡片入场交错动画：进入视口后上浮显现 -- */
const cardObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver(entries => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          cardObserver.unobserve(en.target);
        }
      }
    }, { rootMargin: '80px 0px' })
  : null;

function observeCards() {
  const cards = $$('.card:not(.in)');
  if (!cards.length) return;
  if (!cardObserver) {
    cards.forEach(c => c.classList.add('in'));
    return;
  }
  cards.forEach((c, i) => {
    c.style.setProperty('--d', (i % 7) * 45 + 'ms');
    cardObserver.observe(c);
  });
  // 兜底：个别环境 IntersectionObserver 不触发，1.6s 后全部显现
  setTimeout(() => $$('.card:not(.in)').forEach(c => c.classList.add('in')), 1600);
}

function render() {
  renderChips();
  renderMain();
  applySettings();
  observeCards();
}

function chip(label, count, active, onclick, icon) {
  const b = el('button', 'chip' + (active ? ' active' : ''));
  if (icon) {
    b.innerHTML = `<svg class="ic"><use href="#i-${icon}"/></svg>`;
    b.appendChild(document.createTextNode(label));
  } else {
    b.append(label);
  }
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
    tc.append(chip(TYPE_LABELS[t], n, filters.type === t, () => { filters.type = t; render(); }, TYPE_ICONS[t]));
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
    const ring = el('div', 'score-ring');
    ring.style.setProperty('--pct', Math.round(Math.min(100, Math.max(0, v / 10 * 100))));
    ring.appendChild(el('i', null, Number.isInteger(v) ? String(v) : v.toFixed(1)));
    cover.appendChild(ring);
  }
  if (e.status === 'watching') {
    const b = el('button', 'ep-plus', '+1');
    b.title = '集数 +1';
    b.onclick = ev => { ev.stopPropagation(); bumpEp(e); };
    cover.appendChild(b);
  }
  const tipText = e.comment || (e.group ? '#' + e.group : '');
  if (tipText) {
    const tip = el('div', 'cover-tip');
    tip.appendChild(document.createTextNode(e.comment ? '「' + e.comment + '」' : ''));
    if (!e.comment && e.group) tip.appendChild(el('b', null, '#' + e.group));
    cover.appendChild(tip);
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

  if (!state.entries.length) {
    const empty = el('div', 'empty');
    const big = el('div', 'big');
    big.innerHTML = '<svg aria-hidden="true"><use href="#i-paw"/></svg>';
    empty.appendChild(big);
    empty.appendChild(el('h2', null, '开始记录你的动漫足迹'));
    empty.appendChild(el('p', null, '添加看过的作品，打分、记录进度、自动匹配海报。'));
    const line = el('div', 'btn-line');
    const b1 = el('button', 'btn btn-primary', '添加作品');
    b1.onclick = openAdd;
    const b2 = el('button', 'btn btn-ghost', '导入作品记录');
    b2.onclick = openData;
    line.append(b1, b2);
    empty.appendChild(line);
    main.appendChild(empty);
    $('#stats').textContent = '';
    return;
  }

  const grid = el('div', 'grid');

  if (state.settings.view === 'series') {
    // 作品视图：同系列聚合成一张卡，点进去看内部条目
    const { series, standalone } = computeSeries();
    const unified = [];
    for (const s0 of series) {
      const items = s0.items.filter(entryMatches);
      if (!items.length) continue;
      const s = Object.assign({}, s0, { items });
      s.anyWatching = items.some(e => e.status === 'watching');
      s.allFinished = items.every(e => e.status === 'finished');
      s.anyPlanned = items.some(e => e.status === 'planned');
      s.aggStatus = s.anyWatching ? 'watching' : (s.allFinished ? 'finished' : (s.anyPlanned ? 'planned' : 'watching'));
      s.maxScore = Math.max(...items.map(e => e.score != null ? +e.score : -1));
      unified.push({ kind: 'series', obj: s });
    }
    for (const e of standalone) {
      if (entryMatches(e)) unified.push({ kind: 'entry', obj: e });
    }
    if (!unified.length) {
      main.appendChild(el('div', 'empty', '没有符合条件的作品'));
      $('#stats').textContent = '';
      return;
    }
    unified.sort((a, b) => sortCmp(a.obj, b.obj));
    for (const c of unified) grid.appendChild(c.kind === 'series' ? seriesCardEl(c.obj) : cardEl(c.obj));
  } else {
    // 条目视图：所有记录平铺
    const list = visibleEntries();
    if (!list.length) {
      main.appendChild(el('div', 'empty', '没有符合条件的作品'));
      $('#stats').textContent = '';
      return;
    }
    list.forEach(e => grid.appendChild(cardEl(e)));
  }

  main.appendChild(grid);

  const done = state.entries.filter(e => e.status === 'finished').length;
  const watching = state.entries.filter(e => e.status === 'watching').length;
  const scored = state.entries.filter(e => e.score != null);
  const avg = scored.length ? (scored.reduce((s, e) => s + +e.score, 0) / scored.length).toFixed(1) : '—';
  $('#stats').textContent = `共 ${state.entries.length} 条 · 看完 ${done} · 在看 ${watching} · 平均评分 ${avg}`;
}

/* 作品卡：聚合状态 + 悬停预览内部条目 */
function seriesCardEl(s) {
  const card = el('article', 'card');
  const cover = el('div', 'cover');
  if (s.poster) {
    const img = smartImg(s.poster, s.name, () => { img.remove(); if (!cover.querySelector('img')) cover.appendChild(coverFallback({ title: s.name })); });
    cover.appendChild(img);
  } else {
    cover.appendChild(coverFallback({ title: s.name }));
  }
  cover.appendChild(el('span', 'badge status-' + s.aggStatus, STATUS_LABELS[s.aggStatus]));
  if (s.maxScore >= 0) {
    const v = s.maxScore;
    const ring = el('div', 'score-ring');
    ring.style.setProperty('--pct', Math.round(Math.min(100, Math.max(0, v / 10 * 100))));
    ring.appendChild(el('i', null, Number.isInteger(v) ? String(v) : v.toFixed(1)));
    cover.appendChild(ring);
  }
  const names = s.items.map(e => innerTitle(e, s.name));
  if (names.length) {
    const tip = el('div', 'cover-tip');
    tip.textContent = names.slice(0, 3).join(' · ') + (names.length > 3 ? ` 等${names.length}条` : '');
    cover.appendChild(tip);
  }
  const info = el('div', 'info');
  info.appendChild(el('h3', null, s.name));
  const bits = [`${s.items.length} 条`, TYPE_LABELS[s.type] || ''];
  if (s.anyWatching) bits.push('在看 ' + s.items.filter(e => e.status === 'watching').length);
  info.appendChild(el('p', 'meta', bits.filter(Boolean).join(' · ')));
  card.append(cover, info);
  card.onclick = () => openSeries(s);
  return card;
}

/* 系列目录弹窗 */
function fmtScore(v) { return Number.isInteger(+v) ? String(+v) : (+v).toFixed(1); }

function openSeries(s) {
  currentSeriesName = s.name;
  $('#srTitle').textContent = s.name;
  const poster = $('#srPoster');
  poster.textContent = '';
  if (s.poster) poster.appendChild(smartImg(s.poster, s.name));
  else poster.textContent = s.name.charAt(0);
  const done = s.items.filter(e => e.status === 'finished').length;
  const watching = s.items.filter(e => e.status === 'watching').length;
  $('#srMeta').textContent = `${s.items.length} 条记录`;
  $('#srSummary').textContent = `看完 ${done} · 在看 ${watching} · 想看 ${s.items.length - done - watching}`
    + (s.maxScore >= 0 ? ` · 最高评分 ${fmtScore(s.maxScore)}` : '');
  const list = $('#srList');
  list.textContent = '';
  for (const e of s.items) {
    const row = el('div', 'sr-row');
    const th = el('div', 'sr-thumb');
    if (e.poster) th.appendChild(smartImg(e.poster, e.title));
    else th.textContent = (innerTitle(e, s.name) || e.title).charAt(0);
    const info = el('div', 'sr-info');
    info.appendChild(el('h4', null, innerTitle(e, s.name)));
    const bits = [STATUS_LABELS[e.status] + (e.status === 'watching' && e.currentEp ? ` 第${e.currentEp}集` : '')];
    if (e.totalEp) bits.push(`共${e.totalEp}集`);
    if (e.type && e.type !== 'anime') bits.push(TYPE_LABELS[e.type]);
    if (e.comment) bits.push(e.comment);
    info.appendChild(el('p', null, bits.join(' · ')));
    const right = el('div', 'sr-right');
    if (e.score != null) right.appendChild(el('span', 'sr-score', fmtScore(e.score)));
    right.appendChild(el('span', 'mini-badge ' + e.status, STATUS_LABELS[e.status]));
    row.append(th, info, right);
    row.onclick = () => openEdit(e);
    list.appendChild(row);
  }
  openModal('modalSeries');
}

function refreshSeriesModal() {
  if ($('#modalSeries').classList.contains('hidden') || !currentSeriesName) return;
  const s = computeSeries().series.find(x => x.name === currentSeriesName);
  if (s) openSeries(s);
  else { closeModal('modalSeries'); currentSeriesName = null; }
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
  refreshSeriesModal();
  closeModal('modalEdit');
};

$('#edDelete').onclick = async () => {
  const e = state.entries.find(x => x.id === editingId);
  if (!e) return;
  const ok = await confirmDlg('删除作品', `确定删除《${e.title}》吗？该操作无法撤销。`, '删除');
  if (!ok) return;
  state.entries = state.entries.filter(x => x.id !== editingId);
  save(); render();
  refreshSeriesModal();
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
  const ok = await confirmDlg('自动补全封面', `将为 ${missing.length} 个缺少封面的条目自动匹配海报（动漫类走本地中文索引，速度很快），过程中请保持网络畅通。`, '开始');
  if (!ok) return;
  fillAbort = false;
  $('#btnFillPosters').classList.add('hidden');
  $('#btnFillStop').classList.remove('hidden');
  $('#fillWrap').classList.remove('hidden');

  const isAni = e => e.type === 'anime' || e.type === 'movie';
  const aniEntries = missing.filter(isAni);
  const restEntries = missing.filter(e => !isAni(e));
  let got = 0;

  // —— 快路径：本地中文索引 + AniList 批量封面（动漫/剧场版）——
  if (aniEntries.length) {
    $('#fillText').textContent = '正在加载中文索引（首次约 8MB，之后有缓存）…';
    let indexOk = true;
    try {
      await bgdIndex();
    } catch (e) {
      indexOk = false;
    }
    if (indexOk) {
      try {
        const pairs = [];
        for (const e of aniEntries) {
          if (fillAbort) break;
          const hits = await bgdSearch(bgCleanKeyword(e.title), 1);
          const hit = hits[0];
          // 模糊匹配容易误伤，只在明确等级或相似度足够高时才采用
          if (hit && hit.mid && (hit.score >= 1 || hit.dice >= 0.62)) pairs.push([e, hit]);
        }
        for (let i = 0; i < pairs.length; i += 40) {
          if (fillAbort) break;
          const batch = pairs.slice(i, i + 40);
          const { covers, eps } = await anilistCoversByMal(batch.map(([, h]) => h.mid));
          for (const [e, hit] of batch) {
            if (covers[hit.mid]) {
              e.poster = covers[hit.mid];
              e.bangumiId = hit.bid;
              if (!e.totalEp && eps[hit.mid]) e.totalEp = eps[hit.mid];
              e.updatedAt = Date.now();
              got++;
            }
          }
          $('#fillBar').style.width = (Math.min(95, (i + batch.length) / missing.length * 100)).toFixed(1) + '%';
          $('#fillText').textContent = `索引匹配 ${got} 张封面…`;
          save();
        }
      } catch (e) { /* 索引或封面服务异常，落到慢路径 */ }
      if (!got) $('#fillText').textContent = '快速匹配暂时不可用（索引或封面服务失败），改用备用渠道…';
    } else {
      $('#fillText').textContent = '中文索引加载失败，改用备用渠道…';
    }
    render();
  }

  // —— 慢路径：逐条网络搜索（小说/漫画/真人影视，或索引失败的）——
  const slowList = restEntries.concat(aniEntries.filter(e => !e.poster));
  let done = 0, missStreak = 0;
  for (const e of slowList) {
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
    $('#fillBar').style.width = (95 + done / slowList.length * 5).toFixed(1) + '%';
    $('#fillText').textContent = `完成 ${done}/${slowList.length} · 成功匹配 ${got} 张封面`;
    if (done % 12 === 0) { save(); render(); }
    if (missStreak >= 6) { missStreak = 0; await new Promise(r => setTimeout(r, 8000)); }
    else await new Promise(r => setTimeout(r, 1400));
  }
  // —— 收尾：小说/漫画复用同分组系列封面（如"无职转生 全24卷"借用无职转生动画的封面）——
  for (const e of state.entries) {
    if (e.poster || (e.type !== 'novel' && e.type !== 'manga') || !e.group) continue;
    const sib = state.entries.find(x => x.group === e.group && x.poster && (x.type === 'anime' || x.type === 'movie'));
    if (sib) {
      e.poster = sib.poster;
      e.updatedAt = Date.now();
      got++;
    }
  }

  save(); render();
  $('#fillBar').style.width = '100%';
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
window.addEventListener('scroll', () => {
  document.querySelector('.topbar').classList.toggle('scrolled', window.scrollY > 8);
}, { passive: true });

$('#searchBox').addEventListener('input', () => {
  clearTimeout($('#searchBox')._t);
  $('#searchBox')._t = setTimeout(() => {
    filters.q = $('#searchBox').value.trim();
    renderMain();
  }, 180);
});
$('#sortSel').addEventListener('change', () => { state.settings.sort = $('#sortSel').value; save(); renderMain(); });
$('#btnView').onclick = () => {
  state.settings.view = state.settings.view === 'series' ? 'flat' : 'series';
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
// 应用标题修正表：重命名条目与分组（幂等，每次加载静默执行）
(async () => {
  try {
    if (!window.TITLE_CORRECTIONS || !state.entries.length) return;
    let renamed = 0;
    const lower = t => String(t || '').toLowerCase();
    for (const e of state.entries) {
      for (const key of Object.keys(window.TITLE_CORRECTIONS)) {
        const val = window.TITLE_CORRECTIONS[key];
        if (val == null) continue;
        const k = lower(key);
        if (lower(e.title).startsWith(k)) {
          const nt = val + e.title.slice(key.length);
          if (nt !== e.title) { e.title = nt; e.updatedAt = Date.now(); renamed++; }
        }
        if (e.group && lower(e.group).startsWith(k)) {
          const ng = val + e.group.slice(key.length);
          if (ng !== e.group) { e.group = ng; renamed++; }
        }
      }
    }
    if (renamed) { save(); render(); }
  } catch (e) { /* 静默 */ }
})();

render();
