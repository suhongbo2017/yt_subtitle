# 交接文档

> 一句话：**给 YouTube 视频和扫描件/PDF 文档做"看得懂的中文"**。
> 由三个可以独立运行、也可以配合使用的子系统组成。

---

## 1. 这是什么

| 子系统 | 干什么 | 入口 |
|---|---|---|
| **浏览器扩展** `src/` | 在 YouTube 页面上叠加双语字幕；没有字幕轨的视频用本地 ASR 生成 | `chrome://extensions` 加载 `.output/chrome-mv3` |
| **本地 ASR 服务** `asrsvc/` | faster-whisper 转写：分片实时识别 + 整段精修 + 按 videoId 缓存 | `python -m asrsvc.server` → `127.0.0.1:8770` |
| **文档翻译** `pdftranslate/` | 扫描件/图片 PDF → 视觉大模型转写+翻译 → 双语 PDF / 覆盖式 HTML / Markdown | `python -m pdftranslate.server` → `127.0.0.1:8765` |

三者共享的思路：**能用现成信号就别硬造**。
- 视频优先用 YouTube 自带字幕轨（含自动生成），没有才上 ASR
- PDF 优先用**文本层**校准坐标（比模型给的框精确得多），没文本层才信模型
- 翻译优先走批量 + 缓存，避免逐句断章取义

---

## 2. 快速开始（3 分钟）

```bash
# 0) 环境：Node 22 / Python 3.11 / ffmpeg（可选）/ Chrome
cd D:\PI\subtitle

# 1) 前端依赖 + 构建扩展
set NODE_ENV=                       # 注意：本机 NODE_ENV=production 会让 npm 跳过 devDeps
npm install --include=dev
npm run build                       # 产物在 .output/chrome-mv3

# 2) Python 依赖
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt

# 3) 装扩展：chrome://extensions → 开发者模式 → 加载已解压 → 选 .output/chrome-mv3

# 4) 本地 ASR 服务（托盘/弹窗里可启停，见第 6 节）
.venv\Scripts\python.exe -m asrsvc.server        # 或双击 start-asr.cmd
```

**文档翻译**：双击 `start-ui.cmd`，或 `.venv\Scripts\python.exe -m pdftranslate.server`，
浏览器打开 <http://127.0.0.1:8765/>，拖 PDF 进去即可。

---

## 3. 目录结构

```
subtitle/
├─ src/                         # 浏览器扩展（WXT + React 19 + Tailwind 4）
│  ├─ entrypoints/
│  │  ├─ yt-main.content.ts     # MAIN world：钩 fetch/XHR 抓 timedtext
│  │  ├─ yt-ui.content.ts       # 叠加层 + 翻译调度 + ASR 字幕接入
│  │  ├─ background.ts          # 翻译请求 / 自检状态 / ASR 编排 / Native 调用
│  │  ├─ offscreen/             # 离屏文档：按标签页抓音频（tabCapture）
│  │  ├─ options/ popup/        # 设置页、弹窗
│  ├─ lib/
│  │  ├─ timedtext.ts           # json3 / srv3 / srv1 / vtt 解析 + 滚动字幕合并
│  │  ├─ page-tap.ts            # 字幕请求截获 + 直连拉取
│  │  ├─ overlay.ts             # Shadow DOM 双语层
│  │  ├─ translate.ts           # Google(clients5 批量) / OpenAI 兼容
│  │  ├─ settings.ts types.ts
├─ pdftranslate/                # 文档翻译
│  ├─ render.py                 # PDF → PNG（按页懒加载）
│  ├─ vision.py                 # 视觉模型调用 + JSON 解析 + bbox 归一化
│  ├─ snap.py                   # 用 PDF 文本层逐行校准坐标
│  ├─ build.py                  # 双语 PDF（含真表格）+ Markdown
│  ├─ build_html.py             # 覆盖式 HTML（含真表格、顺排降级）
│  ├─ pipeline.py               # CLI 与 Web UI 共用的流水线
│  ├─ server.py ui.html         # 本地操作界面（:8765）
│  ├─ models.py config.py       # 模型注册表（models.json）/ 配置
├─ asrsvc/                      # 本地语音识别
│  ├─ server.py                 # HTTP 接口 + 模型管理
│  └─ vod.py                    # 点播字幕：yt-dlp 下音频 → 整段转写 → 缓存
├─ native/                      # Native Messaging 启动器
│  ├─ host.py                   # Chrome ↔ 本地服务的桥（start/stop/status）
│  └─ install.py                # 写清单 + 注册表（HKCU，免管理员）
├─ harness/                     # 端到端仿真环境（假 YouTube + 真实构建产物）
├─ tests/parsers.test.ts        # 字幕解析单测（12 条）
├─ scripts/import-cookies.py    # 各种格式 cookie → Netscape cookies.txt
├─ *.cmd                        # 一键脚本（见第 6 节）
└─ docs/HANDOVER.md             # 本文
```

---

## 4. 三个子系统怎么跑

### 4.1 浏览器扩展

**字幕来源三条路，按优先级**：

1. **直连**：读播放器 `getOption('captions','track')` / `ytInitialPlayerResponse` 里的字幕轨 URL
2. **请求钩子**：在 MAIN world 挂 `fetch`/`XHR`，截获播放器自己发出的 `/api/timedtext` 响应
   （参数最全、直播分片天然支持）
3. **CC 兜底**：前两条都空 → 自动点一下 CC 按钮逼播放器请求字幕

拿到 cue 后：`翻译调度器` 按"距当前播放位置的距离"排序，提前 90 秒批量翻译，
结果按 `provider|target|规范化文本` 缓存到 `chrome.storage.local`。

**没有字幕轨时**：弹窗拨开「语音识别」→ 内容脚本向后台请求整段字幕
（`GET /subtitles?id=` 命中即秒开，否则 `POST /generate` 起作业并轮询进度）。

### 4.2 本地 ASR 服务（`asrsvc`）

```
POST /asr?lang=&offset=   音频字节 → {segments, elapsed_ms, realtime_factor}   # 实时分片用
GET  /subtitles?id=       查缓存 → {hit, segments}
POST /generate            {videoId, url} → 起作业（yt-dlp 下载 + 整段转写）
GET  /job/<id>            查进度
POST /cookies             接收扩展推来的实时 cookie
GET  /health              服务状态（弹窗据此显示在线/离线）
```

**两种转写模式**：
- `transcribe()`：分片（3 秒），`beam=1`、`vad=False`、`condition_on_previous_text=False`
- `transcribe_full()`：整段，`beam=5`、`vad=True`、`word_timestamps=True`，
  再用逐词时间戳切成 ≤46 字符 / ≤12 词的字幕行

**模型选择**（实测 i5-9400，3 秒切片）：

| 模型 | 每块耗时 | 端到端延迟 | 说明 |
|---|---|---|---|
| tiny | ~0.4s | ~4.5s | 会丢字 |
| **base（默认）** | **~0.8s** | **~5s** | 平衡 |
| small | ~5.0s | ~9.5s | 最准，中文/口音重时用 |

> 关键发现：Whisper 会把输入补齐到 30 秒再推理，**每块有约 4.4 秒固定开销**，
> 所以缩短切片没用（1 秒音频也要 4.5 秒），提升实时性的关键是换小模型。

### 4.3 文档翻译（`pdftranslate`）

```
render（PyMuPDF 渲染，按页懒加载）
  → vision（视觉大模型：转写 + 翻译 + bbox + 表格结构）
  → snap（有文本层时，用文本层的真实行坐标覆盖模型 bbox）
  → build / build_html（双语 PDF、覆盖式 HTML、Markdown）
```

**输出**：
- `<name>_双语.pdf`：原页无损拷贝（`insert_pdf`，不重新光栅化）+ 译文页
- `<name>_html/index.html`：原页做底图 + 译文按原坐标贴回（可调底图浓度、可打印）
- `<name>_译文.md`

**每页结果都落盘缓存**（`out/.cache/<name>/page-N.json`），改排版/修坐标**不用重新调模型**。

### 4.4 Native 启动器（`native/`）

扩展**不能**启动本地进程，所以用 Chrome Native Messaging：

```
弹窗开关 → background → chrome.runtime.sendNativeMessage('com.pi.ytasr', {cmd})
        → native/ytasr-host.exe（PyInstaller 打包）
        → 起/停 asrsvc，等 /health 就绪后回包
```

一次性安装：`install-native-host.cmd`（写 HKCU 注册表 + 生成清单）。

---

## 5. 配置与密钥

| 东西 | 位置 | 说明 |
|---|---|---|
| 文档翻译的模型 key | `.env`（`DASHSCOPE_API_KEY` / `GEMINI_API_KEY`） | 也支持在 Web UI「模型管理」里填，存 `secrets.json` |
| 模型列表 | `models.json` | UI 可增删改；`--provider` 用的就是这里的 id |
| YouTube 登录态 | `cookies.txt`（Netscape 格式） | **扩展会自动推送实时 cookie**，一般不用手工维护 |
| 扩展设置 | `chrome.storage.local` | ⚠️ 按扩展 ID 隔离，改 manifest 的 `key` 会"丢配置" |
| 扩展配置备份 | 设置页「导出/导入配置」 | 换 ID 前先导出 |

**都在 `.gitignore` 里**，不要提交。首次配置：

```bash
cp .env.example .env          # 填 VISION_API_KEY（qwen/gemini/...）
```

---

## 6. 一键脚本

| 脚本 | 作用 |
|---|---|
| `install-native-host.cmd` | 装 Native 启动器（**推荐**，之后弹窗里开关服务） |
| `install-autostart.cmd` / `uninstall-autostart.cmd` | 开机自启（备选，会一直跑） |
| `start-asr.cmd` | 前台跑 ASR（调试看日志） |
| `stop-asr.cmd` | 按端口杀 ASR 进程 |
| `start-ui.cmd` | 起文档翻译界面并打开浏览器 |

> `.cmd` 里的内容必须是 **ASCII**：中文在 GBK 控制台下会被解析成乱码命令。

---

## 7. 技术决策记录（为什么这么做）

| 决策 | 原因 |
|---|---|
| 拦截播放器的 timedtext 请求，而不是外部拉取 | 新版 timedtext 需要 poToken，外部请求 403/空响应；播放器自己的请求一定带齐签名 |
| Google 免费翻译用 `clients5.google.com/translate_a/t` | 常见的 `translate_a/single` 对无 Cookie 请求直接 429；clients5 还支持多个 `q` 批量 |
| 覆盖式 HTML 用"文本层逐行归属"校准坐标 | 模型 bbox 在密集文档上严重偏移（只在左上角附近准）；逐行归属不受"标签在左值在右"的阅读顺序影响 |
| ASR 用 `base` 而不是 `small` | Whisper 固定开销主导，`small` 慢 6 倍，字幕场景收益不明显 |
| ASR 字幕"粘住到下一块" | 按时间轴对齐会导致字幕永远慢一步、永远显示不出来 |
| 服务开关与语音识别开关分开 | 生命周期不同（机器级 vs 页面级），合并会破坏跨标签页隔离 |
| 用 Native Messaging 而不是自启 | 用户要求"在插件里控制"，且不想常驻 |
| 固定扩展 `key` | Native Messaging 的 `allowed_origins` 需要稳定 ID |

---

## 8. 踩过的坑（改代码前先看）

### 扩展
- **`runAt: document_start` + `world: 'MAIN'`**：必须比播放器代码更早执行才挂得上钩子
- **消息通道要 `return true`**：异步 fetch（如 ASR）期间不保持通道，Service Worker 会被回收，
  请求被中止（服务端表现为 `ConnectionAbortedError`）
- **`chrome.storage` 跟扩展 ID 走**：改 `key` 前先导出配置
- **`host_permissions` 要含 `http://*/*`**：本地模型 / ASR 服务走 http

### ASR
- **`pythonw` 下 `print` 会崩**：`sys.stdout` 是 `None`
- **端口双绑定**：Windows 下 `allow_reuse_address=1` 会让两个进程同时监听同一端口，
  请求被随机分走 → 必须关掉并加单实例检查
- **`MediaRecorder` 的 timeslice 分片不能单独解码**：只有第一片带容器头，必须 `stop()`/`start()` 循环
- **tabCapture 会让标签页静音**：必须把音频接回 `AudioContext.destination`
- **`__Secure-1PSIDTS` 是滚动 cookie**：手工导出的 `cookies.txt` 几分钟就失效，
  由扩展实时推送才可靠
- **yt-dlp 需要 `--js-runtimes node`**：解 YouTube 的 n 参数挑战

### 文档翻译
- **字体要子集化**：`insert_font` 把整个中文字体塞进去 → 600KB 变 10MB，必须 `subset_fonts()`
- **原页用 `insert_pdf` 拷贝**，不要重新光栅化（无损且体积小）
- **CJK 断行要自己算**：`insert_textbox` 只按空格断行，中文会溢出
- **表格行的 `\t` 会骗过宽度测量**：`text_length('\t')` 只算 1 字符，实际渲染撑开好几个字宽
- **模型坐标单位不统一**：有时 0-1 有时像素，要按图片实际宽高判定

### 工具链
- **本机 `NODE_ENV=production`**：`npm install` 会跳过所有 devDependencies，必须 `--include=dev`
- **Chrome 137+ 禁用了 `--load-extension`**：自动化加载要用 CDP 的 `Extensions.loadUnpacked`
- **`tasklist /fi` 在本机 shell 下不生效**：用 `tasklist | grep` 代替

---

## 9. 已知限制

1. **无文本层的纯扫描件**（手写信那种）只能依赖模型 bbox，覆盖式 HTML 会有错位
2. **表格**：模型给的 `rows` 结构可用，但极宽表格在 PDF 里会挤，HTML 里更好看
3. **yt-dlp 通路不稳**：出口 IP 被标记时即使有 cookie 也会被 bot 检查拦住
4. **直播**：目前只做点播（下载→整段转写）；实时分片仅作兜底
5. **翻译质量**：Google 免费端点偏直译，长句建议用 LLM 引擎
6. **ASR 中文**：`base` 对中文偏弱，中文内容建议 `--model small`

---

## 10. 待验证与待办

### 截图翻译的框选流程（待真实手势验证）

已验证：注入代码编译、`/api/screen` 服务端、裁剪数学、结果页渲染（用预置数据）。
自动化无法覆盖的部分：**真实拖拽选区**。原因是测试环境的三个问题叠加
（弹窗失焦即关闭、SW 自发 sendMessage 不可达、SW 休眠后不在 target 列表）。

手工验证步骤：
1. `chrome://extensions` → 刷新扩展，打开任意有外文的网页
2. 点扩展图标 → 「📝 截图翻译（当前页面）」→ 弹窗关闭，页面上出现绿色选框
3. 拖一个范围 → 约 10 秒后应弹出新标签页，选区内文字翻译并按原位置叠加
4. Esc 应取消；「整页」按钮应全页翻译；框太小（<12px）会当作误触忽略

如果没反应：查扩展 SW 的 console（`chrome://extensions` → 服务工作进程），
以及 `chrome.notifications` 弹出的系统通知（截图流程的错误都走那里，因为弹窗已关闭）。

### 功能待办

- [ ] **流式 ASR**（sherpa-onnx zipformer）：延迟从 5 秒降到 1 秒以内
- [ ] **表格版式增强**：合并单元格、跨页表头
- [ ] **术语表**：人名/产品名跨句一致性（LLM 引擎）
- [ ] **字幕轨导出/导入**：把生成的 ASR 字幕存成 `.srt`，方便外部工具复用
- [ ] **多语言目标**：目前默认简体中文，目标语言可配但没有针对性调优
- [ ] **视频字幕的二次精修触发**：播完自动精修（当前需手动）

---

## 11. 排障手册

| 症状 | 检查 | 处理 |
|---|---|---|
| 弹窗显示 `ASR 离线` | `curl 127.0.0.1:8770/health` | 弹窗里打开「本地 ASR 服务」开关；或看 `.cache/asrsvc.log` |
| 弹窗开关点了没反应 | 扩展是否刚更新过 | 刷新视频页面（内容脚本未注入） |
| 报 `未安装启动器` | `reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pi.ytasr` | 跑 `install-native-host.cmd` |
| 生成字幕卡在 `downloading` | `.cache/asrsvc.log` | 多半是 bot 检查：换节点 / 用「改用实时识别」 |
| 字幕出现但没译文 | 弹窗自检面板的「错误」栏 | 现在错误是常驻的，按提示修 key/端点 |
| 覆盖式 HTML 位置错乱 | 该 PDF 是否真的没有文本层 | 有文本层会自动校准；没有则改用双语 PDF |
| `npm install` 装不上 devDeps | `echo %NODE_ENV%` | `set NODE_ENV=` 后重装 |
| ASR 服务起不来，提示端口占用 | `netstat -ano | grep 8770` | `stop-asr.cmd` 后再起（旧版本会双绑定，已修） |

日志位置：

- ASR 服务：`.cache/asrsvc.log`
- Native 启动器：`.cache/native-host.log`
- 文档翻译：控制台输出 + `out/.cache/<name>/page-N.json`

---

## 12. 验证与测试

```bash
# 字幕解析单测（12 条，无需浏览器）
node --experimental-strip-types tests/parsers.test.ts

# 扩展端到端仿真（假 YouTube + 真实构建产物 + 真实翻译）
node --experimental-strip-types harness/server.mjs &
node harness/run.mjs

# 类型检查 / 构建
npx tsc --noEmit
npx wxt build

# 文档翻译离线排版验证（不花钱）
.venv\Scripts\python.exe -m pdftranslate samples/xxx.pdf --mock -o out

# ASR 服务自测
curl 127.0.0.1:8770/health
curl -X POST "127.0.0.1:8770/asr?lang=en" --data-binary @some.webm
```

---

## 13. 环境

| 项 | 版本 / 说明 |
|---|---|
| OS | Windows 10/11（路径均为 `D:\PI\subtitle`） |
| Node | 22.20（npm 11） |
| Python | 3.11（venv 在 `.venv`） |
| Chrome | 156（扩展需 111+ 才支持 `world: MAIN`） |
| 前端栈 | WXT 0.21 + React 19 + Tailwind 4 + TypeScript 5.9 |
| 关键依赖 | faster-whisper 1.2 / PyMuPDF 2.1 / Pillow |
| 代理 | `127.0.0.1:7897`（访问 Gemini / HF / YouTube 时需要） |
