/* ===== 导入解析：足迹格式文本 / JSON ===== */
const TYPE_LABELS = { anime: '动漫', movie: '剧场版', real: '真人影视', novel: '小说', manga: '漫画' };
const STATUS_LABELS = { watching: '在看', finished: '看完', planned: '想看' };

const IMPORT_REAL_KEYWORDS = ['西部世界', '神探夏洛', '黑袍纠察队', '鱿鱼游戏', '让子弹飞', '星际穿越',
  '肖申克', '流浪地球', '霍比特人', 'John Wick', '奥本海默', '爆裂鼓手', '南京照相馆',
  '那个男人来自地球', '天国王朝', '小丑', '蝙蝠侠', '猩球崛起', '科洛弗', '漫威', '沙赞', '海王'];
const IMPORT_NOVEL_KEYWORDS = ['银河帝国', '十日终焉'];
const IMPORT_MANGA_KEYWORDS = ['藤本树'];

function cnToInt(s) {
  s = String(s).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const D = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if (s in D) return D[s];
  if (s === '十') return 10;
  const m = s.match(/^([一二两三四五六七八九]?)十([一二三四五六七八九]?)$/);
  if (m) {
    const tens = m[1] ? D[m[1].replace('两', '二')] : 1;
    const ones = m[2] ? D[m[2]] : 0;
    return tens * 10 + ones;
  }
  return null;
}

function detectImportType(t) {
  const low = t.toLowerCase();
  if (/漫画/.test(t) || IMPORT_MANGA_KEYWORDS.some(k => low.includes(k.toLowerCase()))) return 'manga';
  if (/剧场/.test(t)) return 'movie';
  if (/卷|章|小说/.test(t) || IMPORT_NOVEL_KEYWORDS.some(k => t.includes(k))) return 'novel';
  if (IMPORT_REAL_KEYWORDS.some(k => low.includes(k.toLowerCase()))) return 'real';
  return 'anime';
}

/* 足迹格式：
   # 分组名          <- 可选；之后的条目归入该分组，空行结束分组
   标题 | 状态 | 评分 | 备注 */
function parseFootprintText(text) {
  const res = { entries: [], warnings: [] };
  let group = null;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) { group = null; return; }
    if (line.startsWith('#') || line.startsWith('＃')) {
      group = line.slice(1).trim() || null;
      return;
    }
    const parts = line.split('|').map(s => s.trim());
    const title = (parts[0] || '').replace(/^[-－\s]+/, '');
    if (!title) { res.warnings.push(`第 ${i + 1} 行缺少标题，已跳过`); return; }
    const e = newEntryObj({ title, group: group || '' });
    const st = parts[1] || '';
    if (st.includes('完')) e.status = 'finished';
    else if (/想看|未看|计划/.test(st)) e.status = 'planned';
    else if (/在看/.test(st) || st.match(/第?\s*[0-9一二三四五六七八九十]{1,3}\s*[集话]/)) e.status = 'watching';
    else e.status = 'finished';   // 无状态标记：默认视为已看完
    const pm = st.match(/第?\s*([0-9一二三四五六七八九十]{1,3})\s*[集话]/);
    if (pm) e.currentEp = cnToInt(pm[1]);
    if (parts[2]) {
      const v = parseFloat(parts[2]);
      if (!isNaN(v)) e.score = Math.min(10, Math.max(0, v));
    }
    if (parts[3]) e.comment = parts[3];
    e.type = detectImportType(title);
    const tm = (title + ' ' + (e.comment || '')).match(/(?:全|共)\s*(\d{1,3})\s*集/);
    if (tm) e.totalEp = parseInt(tm[1], 10);
    if (e.status === 'finished' && e.currentEp != null) {
      e.comment = (e.comment ? e.comment + '，' : '') + '看到第' + e.currentEp + '集';
      e.currentEp = null;
    }
    res.entries.push(e);
  });
  return res;
}

function parseImportJSON(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch (e) {
    throw new Error('JSON 解析失败：' + e.message);
  }
  const arr = Array.isArray(d) ? d : (d && Array.isArray(d.entries) ? d.entries : null);
  if (!arr) throw new Error('JSON 结构不正确：需要条目数组或 { "entries": [...] }');
  const valid = ['anime', 'movie', 'real', 'novel', 'manga'];
  const validStatus = ['watching', 'finished', 'planned'];
  return arr.map(x => newEntryObj({
    title: String((x && x.title) || '').trim(),
    group: x && x.group ? String(x.group) : '',
    type: valid.includes(x && x.type) ? x.type : 'anime',
    status: validStatus.includes(x && x.status) ? x.status : 'watching',
    score: (x && isFinite(+x.score)) ? Math.min(10, Math.max(0, +x.score)) : null,
    currentEp: (x && isFinite(+x.currentEp) && +x.currentEp > 0) ? Math.floor(+x.currentEp) : null,
    totalEp: (x && isFinite(+x.totalEp) && +x.totalEp > 0) ? Math.floor(+x.totalEp) : null,
    poster: (x && x.poster) ? String(x.poster) : null,
    comment: (x && x.comment) ? String(x.comment) : '',
    bangumiId: (x && x.bangumiId) || null
  })).filter(e => e.title);
}

function parseImportAuto(text) {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    return { entries: parseImportJSON(t), warnings: [], json: true };
  }
  return parseFootprintText(t);
}
