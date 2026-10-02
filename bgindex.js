/* ===== bangumi-data 中文索引 + AniList 封面 =====
   解决国内网络无法直连 api.bgm.tv 时的封面匹配：
   - 索引：unpkg.com 上的 bangumi-data（约 8MB，首次下载后 IndexedDB 缓存 7 天），本地匹配中文标题
   - 封面：用索引里的 MAL id 经 AniList GraphQL 批量查询封面图，图片经 images.weserv.nl 代理加载 */

const BGD_INDEX_URL = 'https://unpkg.com/bangumi-data@0.3/dist/data.json';
const BGD_TTL = 7 * 24 * 3600 * 1000;
let bgdIndexPromise = null;

/* ---------- IndexedDB 简易缓存 ---------- */
function bgdIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('animeFootprintCache', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function bgdCacheGet(key) {
  try {
    const db = await bgdIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      tx.onsuccess = () => resolve(tx.result || null);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { return null; }
}
async function bgdCacheSet(key, val) {
  try {
    const db = await bgdIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
      tx.onsuccess = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* 缓存失败不影响功能 */ }
}

/* ---------- 索引构建 ---------- */
function bgdNorm(s) {
  return String(s || '').toLowerCase().replace(/[^\w\u4e00-\u9fff\u3040-\u30ff]+/g, '');
}

function bgdBuild(items) {
  const list = [];
  for (const it of items) {
    const tt = it.titleTranslate || {};
    const aliasSet = new Set();
    for (const v of (tt['zh-Hans'] || [])) aliasSet.add(v);
    for (const v of (tt['zh-Hant'] || [])) aliasSet.add(v);
    if (it.title) aliasSet.add(it.title);
    const sites = it.sites || [];
    const bid = sites.find(s => s.site === 'bangumi');
    const mal = sites.find(s => s.site === 'mal');
    list.push({
      cn: (tt['zh-Hans'] || [])[0] || it.title || '',
      jp: it.title || '',
      keys: [...aliasSet].map(bgdNorm).filter(Boolean),
      bid: bid ? +bid.id : null,
      mid: mal ? +mal.id : null,
      type: it.type || '',
      year: it.begin ? String(it.begin).slice(0, 4) : ''
    });
  }
  return list;
}

async function bgdIndex() {
  if (!bgdIndexPromise) {
    bgdIndexPromise = (async () => {
      const cached = await bgdCacheGet('bgdIndex');
      if (cached && Date.now() - cached.t < BGD_TTL && Array.isArray(cached.data) && cached.data.length) {
        return cached.data;
      }
      const r = await fetchT(BGD_INDEX_URL, {}, 60000);
      if (!r.ok) throw new Error('index http ' + r.status);
      const data = await r.json();
      const index = bgdBuild(data.items || []);
      if (index.length) bgdCacheSet('bgdIndex', { t: Date.now(), data: index });
      return index;
    })();
    bgdIndexPromise.catch(() => { bgdIndexPromise = null; });
  }
  return bgdIndexPromise;
}

/* ---------- 本地中文搜索 ---------- */
/* 返回 [{cn, jp, bid, mid, type, year}]，按相关度排序 */
function bgdBigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
function bgdDice(a, b) {
  const A = bgdBigrams(a), B = bgdBigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return 2 * inter / (A.size + B.size);
}

async function bgdSearch(keyword, limit) {
  limit = limit || 8;
  let index;
  try {
    index = await bgdIndex();
  } catch (e) {
    return [];
  }
  const q = bgdNorm(keyword);
  if (!q) return [];
  const tiers = { 4: [], 3: [], 2: [], 1: [], 0: [] };
  for (const it of index) {
    let score = 0, dice = 0;
    for (const k of it.keys) {
      if (k === q) { score = 4; break; }
      if (k.startsWith(q)) { score = Math.max(score, 3); continue; }
      if (k.includes(q)) { score = Math.max(score, 2); continue; }
      if (q.includes(k) && k.length >= 3) { score = Math.max(score, 1); continue; }
      // 字符二元组模糊匹配：容忍错别字和译名差异（"玲芽之旅"→"铃芽之旅"）
      if (q.length >= 4 && k.length >= 4) {
        const d = bgdDice(q, k);
        if (d >= 0.52) {
          score = Math.max(score, 0.5 + d / 2);
          dice = Math.max(dice, d);
        }
      }
    }
    if (score) {
      it._score = score;
      it._dice = dice;
      tiers[score >= 4 ? 4 : score >= 3 ? 3 : score >= 2 ? 2 : score >= 1 ? 1 : 0].push({ it, score });
    }
  }
  tiers[0].sort((a, b) => b.score - a.score);
  return [...tiers[4], ...tiers[3], ...tiers[2], ...tiers[1], ...tiers[0]].map(x => {
    const r = x.it;
    r.score = x.score;
    r.dice = r._dice || 0;
    return r;
  }).slice(0, limit);
}

/* ---------- AniList 封面（按 MAL id 批量） ---------- */
/* 返回 { covers: {malId: url}, eps: {malId: n} } */
async function anilistCoversByMal(ids) {
  const clean = [...new Set(ids.filter(x => typeof x === 'number'))].slice(0, 50);
  if (!clean.length) return { covers: {}, eps: {} };
  const query = 'query($ids:[Int]){Page(perPage:50){media(idMal_in:$ids,type:ANIME){idMal episodes coverImage{large}}}}';
  try {
    const r = await fetchT('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { ids: clean } })
    }, 15000);
    if (!r.ok) return { covers: {}, eps: {} };
    const d = await r.json();
    const covers = {}, eps = {};
    for (const m of (d.data && d.data.Page && d.data.Page.media) || []) {
      if (!m.idMal) continue;
      if (m.coverImage && m.coverImage.large) covers[m.idMal] = m.coverImage.large;
      if (m.episodes) eps[m.idMal] = m.episodes;
    }
    return { covers, eps };
  } catch (e) {
    return { covers: {}, eps: {} };
  }
}
