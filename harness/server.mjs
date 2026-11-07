/**
 * 本地仿真环境：验证「抓字幕 → 翻译 → 叠加」全链路，不依赖 YouTube 网络。
 *
 * 跑法：node --experimental-strip-types harness/server.mjs
 * 同源模拟 YouTube 的关键行为：
 *   - #movie_player + <video>（叠加层要挂到它上面）
 *   - 播放器 getOption('captions', 'track') 返回 baseUrl（直连拉取路径）
 *   - /api/timedtext 返回 json3（fetch 钩子路径 + 直连路径都走它）
 *   - 真实调用 translate.ts（走代理到 Google），验证翻译链路
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProxyFetch } from './proxy-fetch.mjs';

installProxyFetch();
const { translateLines } = await import('../src/lib/translate.ts');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../.output/chrome-mv3');

const LINES = [
  'Welcome back to the channel.',
  'Today we are talking about graphics cards.',
  'The prices have gone completely crazy this year.',
  'Let me show you what I mean.',
  'This is the part everyone gets wrong.',
  'Thanks for watching, see you next time.',
];

function json3(offsetS = 0) {
  return JSON.stringify({
    events: LINES.map((text, i) => ({
      tStartMs: Math.round((offsetS + i * 2.5) * 1000),
      dDurationMs: 2400,
      segs: [{ utf8: text }],
    })),
  });
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>harness · youtube</title>
<style>
  body { margin:0; background:#0f0f0f; font-family: system-ui, sans-serif; }
  #movie_player { position: relative; width: 640px; height: 360px; background:#000; margin: 20px auto; }
  video { width:100%; height:100%; object-fit: cover; }
  .ytp-subtitles-button { position:absolute; right:8px; bottom:8px; z-index:70; }
  #log { color:#9ae6b4; font: 12px/1.6 monospace; width:640px; margin: 0 auto; white-space: pre-wrap; }
</style></head>
<body>
<div id="movie_player">
  <video id="v" src="/sample.mp4" autoplay muted loop playsinline></video>
  <button class="ytp-subtitles-button" aria-pressed="false">CC</button>
</div>
<div id="log"></div>
<script>
  // ---- 伪扩展 API（WXT 的 browser 会优先用 globalThis.browser） ----
  // 允许用 ?provider=llm&base=...&model=...&key=... 覆盖，方便验证 LLM 链路
  const q = new URLSearchParams(location.search);
  const store = {
    settings: {
      enabled: true, provider: q.get('provider') || 'google', targetLang: 'zh-CN',
      showOriginal: true, hideNativeCaptions: true,
      fontScale: 1, bottomOffset: 10,
      apiBase: q.get('base') || '', apiModel: q.get('model') || '', apiKey: q.get('key') || '',
      prefetchSeconds: 90,
    },
  };
  const msgListeners = [];
  window.__ytsubEmit = (msg) => msgListeners.forEach((cb) => { try { cb(msg, {}, () => {}); } catch (e) { console.error(e); } });
  window.browser = {
    runtime: {
      id: 'harness-extension',
      onMessage: {
        addListener: (cb) => msgListeners.push(cb),
        removeListener: () => {},
      },
      sendMessage: async (msg) => {
        if (msg.type === 'ytsub:subs-request') {
          // 模拟"缓存命中"：直接返回整条字幕轨（真实环境由 asrsvc 生成）
          return { segments: window.__cannedSubs || [] };
        }
        if (msg.type === 'ytsub:subs-poll') return { state: 'done', segments: [] };
        const res = await fetch('/translate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lines: msg.lines, settings: msg.settings }),
        });
        return res.json();
      },
    },
    storage: {
      local: {
        onChanged: { addListener: () => {}, removeListener: () => {} },
        get: async (keys) => {
          if (keys == null) return { ...store };
          if (typeof keys === 'string') return { [keys]: store[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store[k]]));
          return Object.fromEntries(Object.keys(keys).map((k) => [k, store[k] ?? keys[k]]));
        },
        set: async (obj) => Object.assign(store, obj),
        remove: async (k) => { delete store[k]; },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
      session: { onChanged: { addListener: () => {}, removeListener: () => {} }, get: async () => ({}), set: async () => {}, remove: async () => {} },
      sync: { onChanged: { addListener: () => {}, removeListener: () => {} }, get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
  };

  // ---- 伪 YouTube 播放器 ----
  const player = document.getElementById('movie_player');
  const track = { baseUrl: location.origin + '/api/timedtext?v=TEST&lang=en', languageCode: 'en', kind: 'asr' };
  const NO_CAPTIONS = q.get('nocap') === '1';
  player.getOption = (a, b) => {
    if (NO_CAPTIONS || a !== 'captions') return null;
    if (b === 'track') return track;
    if (b === 'tracklist') return [track];
    return null;
  };

  const log = (m) => { document.getElementById('log').textContent += m + '\\n'; };
  window.addEventListener('message', (e) => {
    if (e.data && e.data.ns === '__ytsub__' && e.data.t === 'cues') {
      log('cues ' + e.data.cues.length + ' via ' + e.data.source + ' :: ' + e.data.cues[0].text);
    }
  });

  // CC 按钮：模拟播放器自己发出的 timedtext 请求（走 fetch 钩子）
  document.querySelector('.ytp-subtitles-button').addEventListener('click', () => {
    if (NO_CAPTIONS) { log('no caption track on this video'); return; }
    log('player requests captions via fetch()');
    fetch('/api/timedtext?v=TEST&lang=en&fmt=json3').then((r) => r.text()).then(() => log('fetch returned'));
  });
</script>
<script src="/bundle/yt-main.js"></script>
<script src="/bundle/yt-ui.js"></script>
</body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8787');

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
    return;
  }

  if (url.pathname === '/sample.mp4') {
    // 必须支持 Range，否则浏览器无法 seek（会一直停在 0）
    const file = path.join(__dirname, 'sample.mp4');
    const size = fs.statSync(file).size;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'content-length': size,
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (url.pathname === '/api/timedtext') {
    const offset = Number(url.searchParams.get('t') ?? 0);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(json3(offset));
    return;
  }

  if (url.pathname.startsWith('/bundle/')) {
    const file = path.join(OUT, 'content-scripts', url.pathname.replace('/bundle/', ''));
    if (!fs.existsSync(file)) {
      res.writeHead(404).end('no bundle');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
    return;
  }

  if (url.pathname === '/translate' && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    try {
      const data = await translateLines(body.lines, body.settings);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (err) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
    }
    return;
  }

  res.writeHead(404).end('not found');
});

server.listen(8787, () => console.log('harness on http://localhost:8787'));
