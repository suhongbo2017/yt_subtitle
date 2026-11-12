# YouTube 双语字幕 · 扫描件翻译

> 📗 **只想用起来** → [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md)（安装/四个功能怎么用/常见问题）
> 📘 **接手维护** → [`docs/HANDOVER.md`](docs/HANDOVER.md)（架构/决策/踩坑/排障/待办）
> 本 README 是两者的精简索引。


在 YouTube 播放页实时抓取字幕轨并翻译，中英双语叠加显示。支持点播、直播和无官方字幕的视频（走播放器自动字幕）。

## 安装（Chrome / Edge，2 步）

1. 打开 `chrome://extensions`，右上角打开「开发者模式」
2. 点「加载已解压的扩展程序」，选择本仓库的 `.output/chrome-mv3` 目录

> 已构建好的产物就在 `.output/chrome-mv3`，不需要自己编译。

## 使用

打开任意 YouTube 视频 → 右下角 **CC 按钮打开** → 字幕下方会出现译文。

扩展会自动做三件事，按优先级：

| 路径 | 说明 |
|---|---|
| 1. 直接拉取 | 读播放器 `getOption('captions','track')` / `ytInitialPlayerResponse` 里的字幕轨 URL，自己请求 `fmt=json3` |
| 2. 请求钩子 | 在页面主世界挂 `fetch`/`XHR`，截获播放器自己发出的 `/api/timedtext` 响应（参数最全，直播分片天然支持） |
| 3. CC 兜底 | 前两条都拿不到时，自动点一下播放器的 CC 按钮，逼播放器去请求字幕 |

翻译结果会本地缓存，同一句话不会重复请求。

## 设置

点扩展图标 → 「打开完整设置」。

- **翻译引擎**
  - `Google 免费`（默认）：零配置
  - `LLM`：任意 OpenAI 兼容端点（DeepSeek / OpenAI / 本地 Ollama），中文质量明显更好
- **目标语言**：简体中文 / 繁體中文 / 日本語 / 한국어 / English
- **显示**：字号、字幕距底部距离、是否显示原文、是否隐藏 YouTube 原生字幕
- **提前翻译**：默认提前 90 秒翻译后续字幕

设置页有「测试翻译」按钮，可以先确认密钥和网络是通的。

## 实现要点

```
src/
  entrypoints/
    yt-main.content.ts   # MAIN world，document_start，挂钩 fetch/XHR
    yt-ui.content.ts     # 叠加层 + 翻译调度（预取/批处理/去重缓存）
    background.ts        # 翻译请求（避开页面 CORS）+ 自检状态中转
    options/ popup/      # React 19 + Tailwind 4
  lib/
    timedtext.ts         # json3 / srv3 / srv1 / vtt 解析，滚动字幕合并
    page-tap.ts          # 字幕请求截获 + 直连拉取
    overlay.ts           # Shadow DOM 叠加层（挂在 #movie_player 内，全屏/剧场模式自动适配）
    translate.ts         # Google(clients5 批量) / OpenAI 兼容
    settings.ts types.ts
```

几个踩过的坑：

- **不能用 yt-dlp 那套**：新版 timedtext 需要 poToken，外部请求会 403/空响应。播放器自己发的请求一定带齐签名，所以在页面里拦截最稳。
- **Google 端点选择**：`translate_a/single`（gtx）容易被判 429；改用 Chrome 内置翻译同款的 `clients5.google.com/translate_a/t?client=dict-chrome-ex`，它原生支持一次多个 `q`，可以批量。
- **`runAt: document_start` + MAIN world**：必须比播放器代码更早执行才能挂上钩子。

## 开发

```bash
npm install          # 注意：本机 NODE_ENV=production 会让 npm 跳过 devDependencies，用 --include=dev
npm run dev          # 热更开发（会自动打开浏览器）
npm run build        # 产出 .output/chrome-mv3
npm run compile      # tsc 类型检查
```

### 测试

```bash
# 解析器单测（12 条，无需浏览器）
node --experimental-strip-types tests/parsers.test.ts

# 端到端仿真：真实浏览器 + 真实翻译，不依赖 YouTube 网络
node --experimental-strip-types harness/server.mjs   # 另开终端
node harness/run.mjs                                  # 需要 Chrome 在本机
```

`harness/` 里用一个假播放器复现 YouTube 的关键行为（`getOption('captions')`、`/api/timedtext`），
加载的是 `.output` 里真实的构建产物，所以能验证「抓取 → 翻译 → 叠加」整条链路。

## 坐标校准与降级

模型的 bbox 在密集文档（政府电报、表格化公文）上经常偏：**靠近页面原点准、越远越偏**。
实测 059UAP00012 那份，模型给的框横向只到页面 40% 就截止了，
直接贴上去就是左上角一团、正文压在一起。

现在的策略是三层：

1. **文本层校准（首选）**：PDF 有文本层时（扫描件也常带 OCR 层），
   把文本层的每一行按「它最可能属于哪个块」做归属，再用这些行的真实坐标合并成块框。
   按行归属而不是整块匹配，是因为这类公文常是「标签在左、值在右」的表格式排版，
   整块匹配会因阅读顺序不同而错位。
2. **可信度门槛**：只有匹配到 ≥3 块且占比 ≥40% 才采信校准结果；
   否则说明文本层是垃圾 OCR（比如手写信那种），继续用模型坐标。
3. **顺排降级**：校准可信时，没匹配上的块**不再**使用模型的框（会压住别人），
   而是渲染到页面下方的「未定位内容」；整页坐标明显不合理时（过扁 / 互相重叠 / 面积离谱）
   整页改为「原图 + 顺排译文」。

因此改排版、修坐标都**不需要重新调模型**，缓存里已有转写结果，重跑只花几秒。

## 表格

模型对表格页返回 `kind: "table"` + `rows`（译文单元格二维数组）+ `header`，
渲染时：

- **HTML**：真 `<table>`，`table-layout: fixed` + 按内容长度加权分配列宽，盖在原表位置
- **PDF**：带边框的表格，自动分页并在续页重复表头
- **Markdown**：标准 markdown 表格

列宽按 `最长内容 × 0.6 + 平均长度 × 0.4` 加权，避免长内容列（如"发生区域"）被挤成竖排。

---

# 附：本地语音识别（无字幕视频）

YouTube 大多数视频有自动字幕轨，扩展默认就用它。**没有字幕轨**的视频（直播没开字幕、
纯音乐现场、部分地区限制视频）可以改用本地 whisper 转写，链路是：

```
标签页音频 (tabCapture) → 离屏文档 MediaRecorder 按 6 秒切片
  → 本地 asrsvc (faster-whisper) 转写 → 复用现有翻译 + 叠加层
```

## 启动 ASR 服务

**推荐：在扩展弹窗里控制**（不占开机自启）

弹窗里「本地 ASR 服务」是**独立开关**，和「语音识别」分开：

| 开关 | 作用域 | 生命周期 |
|---|---|---|
| 本地 ASR 服务 | 整机，所有标签页共用 | 手动启停，不随页面变化 |
| 语音识别 | 当前视频 | 按页面 |

分开的原因：服务启动要加载模型（~1.5s、500MB），不该随视频开关反复重启；
而且关掉一个页面的识别不应该把别的页面正在用的服务一起杀掉。

第一次需要装一次启动器（扩展本身不能起进程，走 Chrome Native Messaging）：

```cmd
install-native-host.cmd        :: 写注册表 + 扩展 ID 绑定，一次性
uninstall-native-host.cmd      :: 移除
```

装完后弹窗里的开关就能直接启停服务，不需要命令行。

### 备选：开机自启



`install-autostart.cmd` 会做三件事：
1. 在「启动」文件夹创建快捷方式 `YouTubeSubtitleASR.lnk`
2. 立刻用 `pythonw.exe`（无控制台）在后台起一份
3. 验证 `/health` 是否响应

配套脚本：

| 脚本 | 作用 |
|---|---|
| `install-autostart.cmd` | 安装开机自启 + 立刻启动 |
| `uninstall-autostart.cmd` | 取消自启（当前进程不受影响） |
| `stop-asr.cmd` | 立即停掉（按端口找进程） |
| `start-asr.cmd` | 前台运行，看实时日志用 |

弹窗右上角会显示 `ASR base`（在线）或 `ASR 离线`，离线时会提示去装自启。
日志在 `.cache/asrsvc.log`。

**手动启动**（调试用）：

```bash
.venv/Scripts/python.exe -m pip install -r requirements.txt   # 含 faster-whisper
.venv/Scripts/python.exe -m asrsvc.server --model small --threads 6
# → http://127.0.0.1:8770/   首次会下载模型（small ≈ 460MB，缓存在 .cache/hf）
```

> 服务启动时会检查端口：如果已有实例在跑，会**直接退出并提示**，
> 而不是像以前那样两个进程同时监听、请求被随机分走（这会导致"有时正常有时报错"）。

注意两个常见错误：

- 用 `python.exe`（系统 Python）而不是 `.venv\Scripts\python.exe` → `No module named 'faster_whisper'`
- 在 `.venv\Scripts>` 目录里执行 `-m asrsvc.server` → `No module named 'asrsvc'`（`-m` 按当前目录找包）

`.cmd` 会自动 `cd` 到项目根目录并调用 venv 里的 python，避免这两个坑。

## 两条路径

| 路径 | 何时用 | 首播 | 之后 |
|---|---|---|---|
| **点播生成（默认）** | 有 cookie 能下载音频 | 等 1-3 分钟（下音频 + 整段转写） | **秒开**，逐词时间戳，任意 seek 都对得上 |
| 实时识别（兜底） | 没 cookie / 下载失败 | 约 5 秒后出字幕 | 每次都要重新跑 |

点播生成走的是：`yt-dlp 下载音频 → whisper 整段转写 → 按 videoId 缓存`，
翻译也是整条字幕轨一次性批量翻（有上下文），不再每 3 秒断章取义。

### cookie 自动同步（推荐，不用手工导出）

扩展带 `cookies` 权限，每次生成字幕前会把**当前浏览器会话的 cookie 实时推给本地服务**
（写到 `.cache/runtime-cookies.txt`）。这样能绕开一个坑：
YouTube 的 `__Secure-1PSIDTS` / `__Secure-3PSIDTS` 是**滚动更新**的，
手工导出的文件几分钟后就失效，yt-dlp 会报 "Sign in to confirm you're not a bot"。

所以正常情况下你**什么都不用做**，只要浏览器里是登录状态即可。

### 手工导出（备用）



`yt-dlp` 直连会被 YouTube 判为机器人，需要登录态：

1. Chrome 装 **Get cookies.txt LOCALLY**
2. 登录 youtube.com → 该扩展 → Export
3. 放到项目根目录 `cookies.txt`（或用 `scripts/import-cookies.py` 转任意格式）

```bash
python scripts/import-cookies.py cookie/ytb.txt cookies.txt
```

还需要 **Node.js**（解 YouTube 的 n 参数挑战），服务会自动用 `--js-runtimes node`。

`cookies.txt` / `cookie/` / `secrets.json` 都已加进 `.gitignore`。

## 配置备份

设置页右上角有 **导出配置 / 导入配置**（JSON）。

> ⚠️ `chrome.storage` 是按**扩展 ID** 隔离的：一旦改 `wxt.config.ts` 里的 `key`
> 或换加载路径导致 ID 变化，配置就会"消失"（其实还躺在
> `Chrome/User Data/Default/Local Extension Settings/<旧ID>/` 里，可以用
> `strings` 之类的工具捞出来）。改 ID 前先导出一次配置。

## 使用

1. 视频页点扩展图标 → 打开「语音识别」开关
2. Chrome 会提示"此扩展可以录制你的标签页音频"，允许
3. 约 8–10 秒后出现第一句双语字幕，之后每 6 秒更新一块

**实测（i5-9400 / 无可用 GPU，3 秒切片）**：

| 模型 | 每块识别耗时 | 端到端延迟 | 说明 |
|---|---|---|---|
| tiny | ~0.4s | ~4.5s | 最快，会丢字 |
| **base（默认）** | **~0.8s** | **~5s** | 速度与准确率平衡 |
| small | ~5.0s | ~9.5s | 最准，中文/口音重时用 |

> 关键发现：Whisper 会把输入补齐到 30 秒再跑，所以**每块有小 5 秒的固定开销**，
> 用 `small` 时切片再短也没用（1 秒音频同样要 4.5 秒）。提升实时性的关键是**换小模型**，
> 而不是缩短切片。

## 实现要点

- **off 屏文档**：MV3 的 service worker 里没有 `MediaRecorder` / `AudioContext`，
  必须用 `chrome.offscreen`
- **声音不能吞**：`tabCapture` 抓到的音频默认会让标签页静音，
  必须再 `connect(audioCtx.destination)` 接回扬声器
- **分片要重开录制**：`MediaRecorder` 的 timeslice 分片只有第一片带容器头，
  后面几片单独无法解码，所以每 6 秒 `stop()` 再 `start()`（会丢 ~150ms）
- **直播式显示 + 粘住**：ASR 有延迟，按时间轴对齐会导致"字幕永远慢一步"，
  所以改成最新一块到达就上屏；**并且一直粘住到下一块替换**（12 秒无更新才消失），
  否则按切片时长算，一句话只显示 3-4 秒，根本来不及看
- **跨块去重**：切片边界会把同一句话切两半，用词级 overlap 比较去掉重复开头
- **时间轴自校正**：用「录音结束时刻的墙上时间」反推视频时间轴，
  seek / 卡顿导致漂移超过 3 秒时自动重设基准

## 已知限制

- 只处理英文（或任意有字幕轨语言）→ 目标语言；没有字幕轨的视频（如纯音乐直播）无法翻译
- 直播字幕本身有 10–30 秒的延迟，这是 YouTube 自动字幕的固有延迟
- Google 免费端点偶尔会限流，失败的行会留空并在下一轮重试；追求稳定请用 LLM 引擎

---

---

## 相关项目

**扫描件 / PDF / 截图翻译** 已拆分到独立项目 [`pdf_trasllama`](https://github.com/suhongbo2017/pdf_trasllama)：

- 视觉大模型转写+翻译（不做传统 OCR）
- 输出双语 PDF / 覆盖式 HTML / Markdown
- 自带本地 Web 界面（`:8765`）

本项目的**截图翻译**功能依赖它提供的服务：

```cmd
:: 在 pdftranslate 目录下
start-server.cmd
```

服务地址可在扩展设置页改（默认 `http://127.0.0.1:8765`）。
