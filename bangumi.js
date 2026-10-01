/* ===== 网络搜索：Bangumi（直连→公共代理）→ Kitsu 兜底 =====
   国内网络 bgm.tv 常不可达：
   - API 走 allorigins.win 公共 CORS 代理（旧版 GET 搜索接口）
   - 图片加载失败时自动经 images.weserv.nl 代理重试（见 app.js 的 smartImg） */
const BG_TYPE = { anime: 2, movie: 2, novel: 1, manga: 1, real: 3 };

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
  return null;
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

  // 1) Bangumi 直连
  if (!healthSkipped('bangumi')) {
    const r1 = await searchBangumiDirect(keyword, bt);
    if (r1) return r1;
  }
  // 2) Bangumi 经公共代理（不稳定，尽力而为）
  if (!healthSkipped('allorigins')) {
    const r2 = await searchBangumiProxy(keyword, bt);
    if (r2) return r2;
  }
  // 3) Kitsu 兜底（动漫/漫画）
  if (type === 'anime' || type === 'manga') {
    const r3 = await searchKitsu(keyword, type === 'manga' ? 'manga' : 'anime');
    if (r3 && r3.length) return r3;
  }
  return [];
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
    .replace(/(剧场版|OVA|OAD|SP|完结篇|始动篇|第一季|第二季|第三季|第四季|第五季)/gi, '')
    .replace(/(全|共)\d+集/g, '')
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || title;
}
