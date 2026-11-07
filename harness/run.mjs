/**
 * 端到端仿真：启动真实 Chrome → 打开 harness 页面 → 断言叠加层出现中英双语。
 * 无第三方依赖（只用 Node 内置 fetch / WebSocket / child_process）。
 *
 * 先跑：node --experimental-strip-types harness/server.mjs
 * 再跑：node harness/run.mjs
 */
import { spawn } from 'node:child_process';

const CHROME =
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const PROFILE = `${process.env.USERPROFILE}\\.cache\\yt-harness-profile`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=900,700',
  ],
  { stdio: 'ignore', detached: true },
);
chrome.unref();

let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  try {
    ready = (await fetch(`http://localhost:${PORT}/json/version`)).ok;
  } catch {
    /* 等 Chrome 起来 */
  }
  if (!ready) await sleep(300);
}
if (!ready) {
  console.error('Chrome 没起来，检查 CHROME_PATH');
  process.exit(1);
}

const target = await (
  await fetch(`http://localhost:${PORT}/json/new?http://localhost:8787/`, { method: 'PUT' })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let seq = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args ?? []).map((a) => a.value ?? '').join(' ');
    if (/ytsub/.test(text)) logs.push(text);
  }
};
const cdp = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJs = async (expression) =>
  (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
    ?.result?.value;

await cdp('Runtime.enable');
await cdp('Page.enable');
await sleep(4000);

// 模拟用户点 CC：触发播放器自己发 timedtext 请求（走 fetch 钩子）
await evalJs(`document.querySelector('.ytp-subtitles-button').click()`);

let passed = false;
for (let i = 0; i < 12; i++) {
  await sleep(2000);
  const raw = await evalJs(`(() => {
    const s = document.getElementById('ytsub-host')?.shadowRoot;
    const v = document.querySelector('video');
    return JSON.stringify({
      vis: s?.querySelector('.ytsub-wrap')?.getAttribute('data-visible'),
      orig: s?.querySelector('.ytsub-orig')?.textContent ?? '',
      tr: s?.querySelector('.ytsub-tr')?.textContent ?? '',
      err: s?.querySelector('.ytsub-err')?.textContent ?? '',
      t: v ? +v.currentTime.toFixed(1) : -1,
    });
  })()`);
  const st = JSON.parse(raw);
  console.log(`[${i}] t=${st.t}s`, st.err ? `err=${st.err}` : '', st.orig, st.tr ? `=> ${st.tr}` : '');
  if (st.tr && st.vis === '1') {
    passed = true;
    break;
  }
}

console.log('\nconsole:', logs.slice(-5));
console.log(passed ? '\n✅ PASS 抓字幕 → 翻译 → 双语叠加' : '\n❌ FAIL');

await fetch(`http://localhost:${PORT}/json/close/${target.id}`).catch(() => {});
process.exit(passed ? 0 : 1);
