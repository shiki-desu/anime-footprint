/* ===== 网络搜索：Bangumi（直连/镜像/公共代理）→ 中文索引+AniList → Kitsu 兜底 =====
   国内网络 bgm.tv 常不可达：
   - API 走 allorigins.win 公共 CORS 代理（旧版 GET 搜索接口）
   - 动漫类作品优先走 bgindex.js 的本地中文索引 + AniList 封面（不依赖 bgm.tv）
   - 图片加载失败时自动经 images.weserv.nl 代理重试（见 app.js 的 smartImg） */
const BG_TYPE = { anime: 2, movie: 2, novel: 1, manga: 1, real: 3 };

function proxiedImg(url) {
  return 'https://images.weserv.nl/?url=' + encodeURIComponent(String(url).replace(/^https?:\/\//, ''));
}

async function fetchT(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 6500);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/* 会话级健康记忆：某来源失败后 10 分钟内跳过，避免每次搜索都干等超时 */
const bgHealth = {};
function healthSkipped(key) {
  const v = bgHealth[key];
  return !!(v && v.ok === false && Date.now() - v.t < 10 * 60 * 1000);
}
function setHealth(key, ok) { bgHealth[key] = { ok, t: Date.now() }; }

/* 自定义 Bangumi 镜像（外观设置里可配，如 Cloudflare Worker 反代地址） */
function bgMirror() {
  try {
    const raw = localStorage.getItem('animeFootprint:v1');
    if (!raw) return '';
    return (JSON.parse(raw).settings && JSON.parse(raw).settings.bgmApi || '').trim().replace(/\/+$/, '');
  } catch (e) { return ''; }
}

function normalizeBangumiSubject(x) {
  return {
    id: x.id,
    title: x.name_cn || x.name,
    orig: x.name,
    poster: (x.images && (x.images.large || x.images.common || x.images.medium)) || x.image || null,
    year: String(x.date || x.air_date || '').slice(0, 4) || null,
    eps: x.eps != null ? x.eps : (x.total_episodes != null ? x.total_episodes : null),
    src: 'bangumi'
  };
}

async function searchBangumiDirect(keyword, bt) {
  return searchBangumiBase('https://api.bgm.tv', keyword, bt, 'bangumi');
}

async function searchBangumiProxy(keyword, bt) {
  try {
    const api = 'https://api.bgm.tv/search/subject/' + encodeURIComponent(keyword) + '?type=' + bt + '&max_results=12';
    const r = await fetchT('https://api.allorigins.win/raw?url=' + encodeURIComponent(api), {}, 12000);
    if (r.ok) {
      const d = await r.json();
      if (d && Array.isArray(d.list) && d.list.length) {
        setHealth('allorigins', true);
        return d.list.map(normalizeBangumiSubject);
      }
    }
    setHealth('allorigins', false);
  } catch (e) { setHealth('allorigins', false); }
  return null;
}

async function searchKitsu(keyword, kind) {
  try {
    const r = await fetchT('https://kitsu.app/api/edge/' + kind + '?filter[text]=' + encodeURIComponent(keyword) + '&page[limit]=10', {}, 8000);
    if (r.ok) {
      const d = await r.json();
      return (d.data || []).map(m => {
        const a = m.attributes || {};
        const t = a.titles || {};
        return {
          id: 'kitsu-' + m.id,
          title: t.zh || t.zh_cn || a.canonicalTitle || t.en || t.en_jp || '',
          orig: t.ja_jp || a.canonicalTitle || '',
          poster: (a.posterImage && (a.posterImage.large || a.posterImage.medium)) || null,
          year: a.startDate ? String(a.startDate).slice(0, 4) : null,
          eps: a.episodeCount != null ? a.episodeCount : null,
          src: 'kitsu'
        };
      }).filter(x => x.poster);
    }
  } catch (e) { /* 忽略 */ }
  return [];
}

/* ---------- IMDb 建议接口（真人影视） ---------- */
/* v2.sg.media-imdb.com 无 CORS 头，经公共代理尽力而为；图床 m.media-amazon.com 可直连 */
const IMDB_BAD_TYPES = ['video game', 'music artist', 'music video', 'podcast series', 'podcast episode'];

async function imdbSuggest(keyword) {
  if (healthSkipped('imdb')) return [];
  const kw = (keyword || '').trim();
  if (!kw) return [];
  const first = kw.charAt(0).toLowerCase().replace(/[^\w]/, '') || 'x';
  const api = 'https://v2.sg.media-imdb.com/suggestion/' + encodeURIComponent(first) + '/' + encodeURIComponent(kw) + '.json';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchT('https://api.allorigins.win/raw?url=' + encodeURIComponent(api), {}, 9000);
      if (r.ok) {
        const d = await r.json();
        const results = ((d && d.d) || [])
          .filter(x => x.l && x.i && x.i.imageUrl && !IMDB_BAD_TYPES.includes(x.q))
          .map(x => ({
            id: x.id,
            title: x.l,
            orig: x.l,
            poster: x.i.imageUrl,
            year: x.y ? String(x.y) : null,
            eps: null,
            src: 'imdb'
          }));
        if (results.length) {
          setHealth('imdb', true);
          return results;
        }
      }
    } catch (e) { /* 公共代理不稳定，重试一次 */ }
  }
  setHealth('imdb', false);
  return [];
}

async function bgSearch(keyword, type) {
  type = type || 'anime';
  const bt = BG_TYPE[type] || 2;

  // 0) 用户配置的镜像优先（国内网络推荐，见 README）；配置镜像后跳过直连与公共代理
  const mirror = bgMirror();
  if (mirror) {
    const r0 = await searchBangumiBase(mirror, keyword, bt, 'mirror');
    if (r0) return r0;
    if (type === 'anime' || type === 'manga') {
      const rk = await searchKitsu(keyword, type === 'manga' ? 'manga' : 'anime');
      if (rk && rk.length) return rk;
    }
    return [];
  }

  // 两个 Bangumi 通道都失败时，每 10 分钟重置一次缓存，给网络恢复一个机会
  if (healthSkipped('bangumi') && healthSkipped('allorigins')) {
    if (!bgHealth._resetAt || Date.now() - bgHealth._resetAt > 10 * 60 * 1000) {
      delete bgHealth.bangumi;
      delete bgHealth.allorigins;
      bgHealth._resetAt = Date.now();
    }
  }

  // 1) 中文索引本地匹配 + AniList 封面（动漫/剧场版，不依赖 bgm.tv）
  if (type === 'anime' || type === 'movie') {
    const r1 = await searchViaIndex(keyword, type);
    if (r1) return r1;
  }
  // 2) Bangumi 直连
  if (!healthSkipped('bangumi')) {
    const r2 = await searchBangumiDirect(keyword, bt);
    if (r2) return r2;
  }
  // 3) IMDb（真人影视； Bangumi 被墙时的主力来源）
  if (type === 'real') {
    const r3 = await imdbSuggest(keyword);
    if (r3.length) return r3;
  }
  // 4) Bangumi 经公共代理
  if (!healthSkipped('allorigins')) {
    const r4 = await searchBangumiProxy(keyword, bt);
    if (r4) return r4;
  }
  // 5) Kitsu 兜底（动漫/漫画）
  if (type === 'anime' || type === 'manga') {
    const r5 = await searchKitsu(keyword, type === 'manga' ? 'manga' : 'anime');
    if (r5 && r5.length) return r5;
  }
  return [];
}

/* 索引命中则用 AniList 补封面和集数；完全没命中返回 null 继续走网络搜索 */
async function searchViaIndex(keyword, type) {
  const kw = bgCleanKeyword(keyword);
  let hits;
  try {
    hits = await bgdSearch(kw, 8);
  } catch (e) {
    return null;
  }
  if (!hits.length) return null;
  const mids = hits.map(h => h.mid).filter(Boolean);
  const { covers, eps } = await anilistCoversByMal(mids);
  const results = hits.map(h => ({
    id: h.bid || (h.mid ? 'mal-' + h.mid : 'idx-' + bgdNorm(h.jp)),
    title: h.cn || h.jp,
    orig: h.jp,
    /* AniList 封面用原图：其图床国内可直连，且 wsrv 拒绝代理该域名 */
    poster: (h.mid && covers[h.mid]) ? covers[h.mid] : null,
    year: h.year,
    eps: (h.mid && eps[h.mid]) || null,
    src: 'index'
  }));
  // AniList 不可用时，用索引里的日文名去 Kitsu 补封面
  if (!results.some(r => r.poster)) {
    for (let i = 0; i < Math.min(3, hits.length); i++) {
      if (!hits[i].jp) continue;
      const k = (await searchKitsu(hits[i].jp, 'anime')) || [];
      const withPic = k.find(x => x.poster);
      if (withPic && results[i]) {
        results[i].poster = withPic.poster;
        results[i].src = 'kitsu';
      }
    }
  }
  // 至少有一个带封面才算成功，否则回落到网络搜索
  return results.some(r => r.poster) ? results : null;
}

async function searchBangumiBase(base, keyword, bt, healthKey) {
  try {
    const r = await fetchT(base + '/v0/search/subjects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, filter: { type: [bt] } })
    });
    if (r.ok) {
      const d = await r.json();
      if (d && Array.isArray(d.data) && d.data.length) {
        setHealth(healthKey, true);
        return d.data.map(normalizeBangumiSubject);
      }
    }
    setHealth(healthKey, false);
  } catch (e) { setHealth(healthKey, false); }
  return null;
}

// 补全条目详情（总集数 / 高清封面）
async function bgSubject(id) {
  if (typeof id !== 'number') return null;
  const bases = [];
  const mirror = bgMirror();
  if (mirror) bases.push(mirror);
  bases.push('https://api.bgm.tv');
  for (const base of bases) {
    try {
      const r = await fetchT(base + '/v0/subjects/' + id, {}, 5000);
      if (r.ok) return await r.json();
    } catch (e) { /* 下一个来源 */ }
  }
  return null;
}

// 搜索关键词清理：去掉季数/剧场版等修饰，提高命中率
function bgCleanKeyword(title) {
  const t = title
    .replace(/第[一二三四五六七八九十0-9]+\s*[季部].*$/, '')
    .replace(/(剧场版|OVA|OAD|SP|总集篇|外传|后日谈|完结篇|始动篇|第一季|第二季|第三季|第四季|第五季)/gi, '')
    .replace(/(全|共)\d+集/g, '')
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || title;
}
