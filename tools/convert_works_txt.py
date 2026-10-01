#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把旧版《作品.txt》转换成「动漫足迹」的导入格式（足迹格式）。

足迹格式（纯文本）：
    # 分组名            ← 可选；之后的条目都归入该分组，空行结束当前分组
    标题 | 状态 | 评分 | 备注
    状态：完 / 在看 第N集（可只写 第N集）/ 想看
    评分：0~10，支持一位小数；备注：任意文字

用法：
    python tools/convert_works_txt.py [源txt] [输出txt]
不带参数时默认：桌面上的 作品.txt -> examples/作品_足迹格式.txt
"""
import os
import re
import sys

CN_DIGITS = {'一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
             '六': 6, '七': 7, '八': 8, '九': 9}

# 真人影视关键词（标题包含即判定为真人影视）
REAL_KEYWORDS = ['西部世界', '神探夏洛', '黑袍纠察队', '鱿鱼游戏', '让子弹飞', '星际穿越',
                 '肖申克', '流浪地球', '霍比特人', 'John Wick', '奥本海默', '爆裂鼓手',
                 '南京照相馆', '那个男人来自地球', '天国王朝', '小丑', '蝙蝠侠', '猩球崛起',
                 '科洛弗', '漫威', '沙赞', '海王']
# 额外按小说/漫画处理的作品
NOVEL_EXTRA = ['银河帝国', '十日终焉']
MANGA_EXTRA = ['藤本树']

# 分组名归一：命中正则则改名为指定分组
GROUP_MAP = [(r'fate', 'Fate系列'), (r'overlo', 'Overlord'), (r're0', 'Re:0')]

PREFIX_RE = re.compile(r'^\s*(！！[^！]*！！|[（(]\s*神\s*[）)][★*]?|神[★*]+|神[-－]|♥|❤|★+)')
NUM_RE = re.compile(r'^[（(【\[]?\s*(\d{1,3})\s*[）)】\]]?')
REWATCH_RE = re.compile(r'[\[［【]\s*(\d{1,2})\s*[\]］】]')
EP_CN_RE = re.compile(r'第\s*([0-9一二三四五六七八九十]{1,3})\s*[集话]')
EP_NUM_RE = re.compile(r'(?<![0-9])(\d{1,3})\s*[集话]')
TOTAL_RE = re.compile(r'全\s*(\d{1,3})\s*集')
PAREN_RE = re.compile(r'（([^（）]*)）')
BRUSH_TAIL_RE = re.compile(r'(第\s*[一二三四五六七八九十0-9]{1,3}\s*[季部]?)?\s*([二三四五六七八九]刷)\s*[-－]?$')
EP_BEFORE_FINISH_RE = re.compile(r'(?<=[季部卷话集])\d{1,3}(?=\s*完)')
CHILD_PREFIX_RE = re.compile(r'^(OVA|SP|剧场版|外传|后日谈|完结篇|始动篇|动画|小说|第[一二三四五六七八九十0-9]{1,3}[集话章卷篇])', re.I)
STRIP_CHARS = ' \t\u3000-－—~～、，,.*+'


def cn_to_int(s):
    s = s.strip()
    if s.isdigit():
        return int(s)
    if s in CN_DIGITS:
        return CN_DIGITS[s]
    if s == '十':
        return 10
    m = re.fullmatch(r'([一二两三四五六七八九]?)十([一二三四五六七八九]?)', s)
    if m:
        tens = CN_DIGITS.get(m.group(1), 1) if m.group(1) else 1
        ones = CN_DIGITS.get(m.group(2), 0) if m.group(2) else 0
        return tens * 10 + ones
    return None


def parse_line(raw):
    """解析一行 -> 条目 dict；空行返回 None"""
    if not raw.strip():
        return None
    indent = len(raw) - len(raw.lstrip(' \t\u3000'))
    s = raw.strip()
    score, notes = None, []

    # 行首的评价标记：神★ / 神- / （神） / ！！强无敌！！ / ♥
    m = PREFIX_RE.match(s)
    if m:
        tag = m.group(1)
        if '神' in tag:
            score = 10
            notes.append('神作')
        if '！！' in tag:
            score = score or 9.5
            notes.append('强无敌')
        if '♥' in tag or '❤' in tag:
            score = score or 9.5
            notes.append('❤本命')
        s = s[m.end():]
    # 行中评价符号（不会出现在标题里）
    for ch, sc, note in (('👍', 9, '👍好评'), ('❤', 9.5, '❤'), ('♥', 9.5, '❤')):
        if ch in s:
            score = score if score is not None else sc
            if note not in notes:
                notes.append(note)
    for ch in ('👍', '❤', '♥', '★', '*', '♡'):
        s = s.replace(ch, '')

    # 行首序号（只去掉一次，避免误删 "86不存在的战区" 这类标题）
    m = NUM_RE.match(s)
    if m:
        s = s[m.end():]

    # 二刷标记 [2]/【2】/［4］ -> 已看完 + 备注
    rewatched = False
    m = REWATCH_RE.search(s)
    if m and int(m.group(1)) >= 2:
        notes.append(f'{int(m.group(1))}刷')
        rewatched = True
        s = s.replace(m.group(0), '')

    # 全N集 -> 总集数（转成备注，导入端再解析为总集数）
    m = TOTAL_RE.search(s)
    if m:
        notes.append(f"共{int(m.group(1))}集")
        s = s.replace(m.group(0), '')

    finished = ('完' in s) or rewatched
    had_ellipsis = bool(re.search(r'[。．]{2,}|…+|\.{3,}', s))
    progress = None
    if not finished:
        # 没看完：提取"看到第N集"
        m = EP_CN_RE.search(s)
        if m:
            progress = cn_to_int(m.group(1))
            s = s.replace(m.group(0), '')
        else:
            m = EP_NUM_RE.search(s)
            if m:
                progress = int(m.group(1))
                s = s.replace(m.group(0), '')
    else:
        # 已看完：集数信息从标题里清理掉
        s = EP_BEFORE_FINISH_RE.sub('', s)
        s = EP_CN_RE.sub('', s)
        s = EP_NUM_RE.sub('', s)

    # "不想看了" / 很大的"章"数 -> 备注
    for kw in ('不想看了',):
        if kw in s:
            notes.append(kw)
            s = s.replace(kw, '')
    m = re.search(r'(\d{3,})\s*多?章', s)
    if m:
        notes.append(m.group(0))
        s = s.replace(m.group(0), '')

    # （中文括注）-> 备注（如 "完（后面烂尾）"）
    def _paren(m2):
        inner = m2.group(1)
        if re.search(r'[\u4e00-\u9fff]', inner) and 1 <= len(inner) <= 15:
            notes.append(inner)
            return ''
        return m2.group(0)
    s = PAREN_RE.sub(_paren, s)

    # 最后一个"完"是看完标记：其后跟的文字是评论 -> 备注（如 "魔法使之夜 完 菌类我魔夜2呢！"）
    idx = s.rfind('完')
    if idx >= 0:
        tail = s[idx + 1:].strip(STRIP_CHARS).strip('（）()')
        if tail and re.search(r'[\u4e00-\u9fffA-Za-z0-9]', tail):
            notes.append(tail)
        s = s[:idx]

    s = re.sub(r'[。．]{2,}|…+|\.{3,}', '', s)
    s = s.replace('（）', '').replace('()', '')
    s = s.strip(STRIP_CHARS)

    # 行尾 "第一季二刷" 之类 -> 备注
    m = BRUSH_TAIL_RE.search(s)
    if m and m.group(0).strip():
        notes.append(m.group(0).strip(STRIP_CHARS))
        s = s[:m.start()]

    t = re.sub(r'-{2,}', ' ', s)
    t = re.sub(r'\s+', ' ', t).strip(STRIP_CHARS)
    if not t:
        return None
    # 状态判定：带"完"或[N刷] = 看完；带"。。。"或"第N集"（且没写完）= 在看；
    # 什么都没写 = 看完（这份文件是看过的作品流水账，未标记默认已看）
    watching = (not finished) and (had_ellipsis or progress is not None)
    return {'indent': indent, 'title': t,
            'status': 'watching' if watching else 'finished',
            'progress': progress, 'score': score, 'notes': notes}


def _common_suffix_len(a, b):
    n = 0
    while n < len(a) and n < len(b) and a[-1 - n] == b[-1 - n]:
        n += 1
    return n


def base_group(title):
    """从父条目标题推导分组名"""
    b = title.split(' ')[0].strip(' ，,·+')
    b = re.sub(r'剧场版.*$', '', b)
    b = re.sub(r'第[一二三四五六七八九十0-9]{1,3}\s*[季部卷].*$', '', b)
    b = re.sub(r'OVA.*$', '', b, flags=re.I)
    b = re.sub(r'全\d+卷.*$', '', b)
    b = b.strip(' ，,·-')
    if not b:
        b = title
    for pat, name in GROUP_MAP:
        if re.search(pat, b, re.I):
            return name
    b = b.replace('The Orign', 'The Origin')
    return b


def assign_groups(entries):
    """缩进行 = 上一条顶格条目的同系列作品，归入同一分组"""
    last_top = None
    for e in entries:
        if e['indent'] == 0:
            last_top = e
            e['_group'] = None
        else:
            if last_top is None:
                e['_group'] = None
                e['_parent_base'] = None
            else:
                e['_group'] = base_group(last_top['title'])
                e['_parent_base'] = e['_group']
                last_top['_has_children'] = True
    for e in entries:
        if e.get('_has_children'):
            e['group'] = e['_group'] or base_group(e['title'])
        else:
            e['group'] = e['_group']

    # 孤立的小标题（"剧场版""后日谈"等）补上系列前缀
    for e in entries:
        if e['indent'] > 0 and e.get('_parent_base'):
            base, t = e['_parent_base'], e['title']
            if t.startswith('动漫'):
                e['title'] = f'{base} 动画' + t[2:].strip()
                continue
            if not t.startswith(base) and (len(t) <= 6 or CHILD_PREFIX_RE.match(t)):
                # 与分组名共享结尾（"复活的鲁鲁修" vs "反叛的鲁鲁修"）则不加前缀
                if not _common_suffix_len(t, base) >= 3:
                    e['title'] = f'{base} {t}'
    for e in entries:
        for k in ('_group', '_parent_base', '_has_children'):
            e.pop(k, None)
    return entries


def fmt_num(x):
    if x is None:
        return ''
    if isinstance(x, float) and x.is_integer():
        return str(int(x))
    return str(x)


def status_str(e):
    if e['status'] == 'finished':
        return '完'
    if e['status'] == 'planned':
        return '想看'
    if e['progress']:
        return f"在看 第{e['progress']}集"
    return '在看'


def build_output(entries):
    lines = []
    prev_group = None
    for e in entries:
        g = e['group'] or ''
        if g != prev_group:
            lines.append('')
            if g:
                lines.append(f'# {g}')
            prev_group = g
        row = [e['title'], status_str(e), fmt_num(e['score']), '，'.join(dict.fromkeys(e['notes']))]
        while row and not row[-1]:
            row.pop()
        lines.append(' | '.join(row))
    while lines and not lines[0]:
        lines.pop(0)
    return '\n'.join(lines) + '\n'


def read_text(path):
    with open(path, 'rb') as f:
        data = f.read()
    for enc in ('utf-8', 'gbk', 'utf-16'):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
    raise SystemExit(f'无法识别文件编码: {path}')


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    desktop = os.path.abspath(os.path.join(here, '..', '..'))
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(desktop, '作品.txt')
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, '..', 'examples', '作品_足迹格式.txt')

    text = read_text(src)
    parsed = [e for e in (parse_line(l) for l in text.splitlines()) if e]
    entries = assign_groups(parsed)
    out = build_output(entries)

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(out)

    finished = sum(1 for e in entries if e['status'] == 'finished')
    watching = sum(1 for e in entries if e['status'] == 'watching')
    scored = sum(1 for e in entries if e['score'] is not None)
    groups = len({e['group'] for e in entries if e['group']})
    print(f'解析 {len(entries)} 条 -> {dst}')
    print(f'  看完 {finished} / 在看 {watching}，已评分 {scored}，分组 {groups} 个')


if __name__ == '__main__':
    main()
