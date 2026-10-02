# 🐾 动漫足迹

一个简约美观的个人追番 / 作品记录工具。纯静态网页，无需安装、无需登录，数据保存在本地浏览器里。

**在线使用：<https://shiki-desu.github.io/anime-footprint/>**

## 功能

- 📺 **记录作品**：动漫、剧场版、真人影视、小说、漫画，自由添加 / 编辑 / 删除
- ⭐ **个人评分**：0~10 分（支持 0.5），卡片右上角金色角标展示
- 📊 **进度管理**：看完 / 在看 / 想看三种状态，记录"看到第几集"，在看卡片悬停可一键 +1 集
- 🗂 **分组维护**：同一系列的作品放进一个分组，分组视图按系列折叠展示
- 🖼 **海报自动匹配**：输入名字即从网络搜索作品信息和海报，无需自己找图；也支持手动填封面链接
- 🎨 **自定义视觉**：浅色 / 深色 / 跟随系统、6 种主题色 + 自定义取色器、三档封面大小
- 🔍 **筛选排序**：按状态 / 类型筛选，按记录顺序、最近改动、评分、标题排序，全局搜索
- 💾 **数据自主**：本地 localStorage 存储，一键导出 / 导入 JSON 备份

## 快速开始

**方式一（推荐）**：直接打开 [GitHub Pages 在线版](https://shiki-desu.github.io/anime-footprint/)。

**方式二**：克隆仓库后双击 `index.html` 即可运行（纯静态，无构建步骤）。

## 从旧的 作品.txt 导入

本工具定义了一套简洁的**足迹格式**（`examples/作品_足迹格式.txt` 是一份真实转换示例）：

```
# 分组名（可选，之后的作品都归入该分组，空行结束当前分组）
标题 | 状态 | 评分 | 备注
```

- 状态：`完` / `在看 第13集`（可只写 `第13集`）/ `想看`；省略状态时默认视为看完
- 评分：0~10，支持一位小数，可省略
- 备注：任意文字（二刷、神作、烂尾……），可省略

示例：

```
# Fate系列
fate ubw | 完 | 9
fate zero | 完 | 9.5 | 神作
命运石之门 | 完 | 10 | 二刷
无职转生 第三季 | 在看 第13集
```

在页面里打开「⋯ → 导入 / 导出」，选择 txt 文件或直接粘贴 → **解析预览** → **确认导入**（可选追加或覆盖）。

如果你手上是格式比较随意的旧记录（序号、"完"、"看到第N集"、"神★"等混杂写法），可以用转换脚本清洗成足迹格式：

```bash
python tools/convert_works_txt.py 旧记录.txt 输出.txt
```

## 海报匹配与网络说明

封面匹配链路（按顺序自动降级）：

1. **中文本地索引**（动漫/剧场版）：首次使用会从 unpkg 下载 [bangumi-data](https://github.com/bangumi-data/bangumi-data) 索引（约 8MB，之后缓存 7 天），在本地做中文/模糊匹配，再经 AniList 接口按 MAL id 批量取封面，全程不依赖 bgm.tv，速度快、命中率高；
2. **Bangumi（api.bgm.tv）**：直连；可在「外观设置」配置自建镜像；
3. **IMDb suggestion**（真人影视）：经公共代理尽力而为，图床可直连；
4. **公共 CORS 代理**：尽力而为，不太稳定；
5. **Kitsu**：兜底（英文/日文匹配较好，中文有限）。

图片加载失败时会自动经 images.weserv.nl 代理重试。补全的最后一步会把**同分组的系列封面复用给小说 / 漫画条目**（如"无职转生 全24卷"借用无职转生动画的封面）。

部分国内网络无法直连 `api.bgm.tv`（动漫封面走索引不受影响；小说、真人影视的匹配率会下降）。解决办法（二选一）：

1. **部署一个自己的镜像（推荐，5 分钟）**：在 [Cloudflare Workers](https://workers.cloudflare.com/) 免费创建一个 Worker，粘贴以下代码并部署，然后在应用「外观设置 → Bangumi 镜像地址」里填入你的 `https://xxx.workers.dev`：

   ```js
   export default {
     async fetch(req) {
       const cors = {
         'Access-Control-Allow-Origin': '*',
         'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
         'Access-Control-Allow-Headers': 'Content-Type',
       };
       if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
       const url = new URL(req.url);
       const resp = await fetch('https://api.bgm.tv' + url.pathname + url.search, {
         method: req.method,
         headers: { 'Content-Type': req.headers.get('Content-Type') || 'application/json',
                    'User-Agent': 'anime-footprint/1.0' },
         body: req.method === 'POST' ? req.body : undefined,
       });
       const headers = new Headers(resp.headers);
       Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
       return new Response(resp.body, { status: resp.status, headers });
     }
   };
   ```

2. **不配置镜像**：应用自动回退到 Kitsu 搜索（英文/日文匹配较好，中文命中率有限），也可以手动粘贴封面链接。

## 数据与备份

- 所有数据保存在浏览器 localStorage 中，**清理浏览器数据会清空记录**
- 建议定期在「导入 / 导出」里下载 JSON 备份；换设备 / 换浏览器时导入即可迁移

## 项目结构

```
index.html            页面结构
style.css             主题与样式（CSS 变量驱动，深浅色 / 主题色 / 封面大小）
app.js                主逻辑：状态、渲染、交互、导入导出、批量补全
bangumi.js            海报搜索链路（镜像 / Bangumi / 代理 / Kitsu）与图片代理降级
bgindex.js            bangumi-data 本地中文索引（IndexedDB 缓存）+ AniList 批量封面
importer.js           足迹格式 / JSON 导入解析
tools/convert_works_txt.py   旧记录 → 足迹格式 转换脚本
examples/作品_足迹格式.txt    真实转换示例（266 条）
```

## License

[MIT](LICENSE)
