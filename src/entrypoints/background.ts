import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { loadSettings } from '@/lib/settings';
import { translateLines } from '@/lib/translate';
import type { Settings } from '@/lib/types';

interface TranslateMessage {
  type: 'ytsub:translate';
  lines: string[];
  settings: Settings;
}

interface TestMessage {
  type: 'ytsub:test';
  text?: string;
  settings: Settings;
}

interface StateMessage {
  type: 'ytsub:state';
  state: PageState;
}

export interface PageState {
  videoId: string;
  cues: number;
  translated: number;
  provider: string;
  error: string;
  asr?: string;
  /** 字幕来源：caption=YouTube 字幕轨，vod=本地生成，live=实时识别，空=还没有 */
  source?: 'caption' | 'vod' | 'live' | '';
  /** 视频页/非视频页 */
  onVideo?: boolean;
  showing: { orig: string; tr: string };
}

interface AsrStartMessage {
  type: 'ytsub:asr-start';
  tabId?: number;
  chunkSec?: number;
}

interface AsrChunkMessage {
  type: 'ytsub:asr-chunk';
  tabId?: number;
  audio: string;
  offset: number;
  duration: number;
}

interface AsrStatusMessage {
  type: 'ytsub:asr-status';
  state: 'starting' | 'running' | 'stopped' | 'error';
  detail?: string;
}

interface ScreenRegion { x: number; y: number; w: number; h: number; dpr: number }

interface GetStateMessage {
  type: 'ytsub:getState';
}

type IncomingMessage =
  | TranslateMessage
  | TestMessage
  | StateMessage
  | GetStateMessage
  | AsrStartMessage
  | AsrChunkMessage
  | AsrStatusMessage
  | { type: 'ytsub:asr-stop' }
  | { type: 'ytsub:subs-request'; tabId?: number; videoId?: string; url?: string }
  | { type: 'ytsub:subs-poll'; jobId?: string }
  | { type: 'ytsub:service'; cmd: 'start' | 'stop' | 'status' }
  | { type: 'ytsub:screen'; region?: { x: number; y: number; w: number; h: number; dpr: number } }
  | { type: 'ytsub:page-translate'; toggle?: boolean };

/**
 * 注入页面里的选框 UI：拖拽划出矩形，Esc 取消，返回设备像素坐标。
 * 必须是可序列化的自包含函数（chrome.scripting.executeScript 的 func）。
 */
function selectRegionOnPage(): Promise<ScreenRegion | { cancel: true }> {
  return new Promise((resolve) => {
    const dpr = window.devicePixelRatio || 1;
    const finish = (result: ScreenRegion | { cancel: true }) => {
      overlay.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(result);
    };

    const overlay = document.createElement('div');
    overlay.id = '__ytsubSelect__';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647', 'cursor:crosshair',
      'background:rgba(0,0,0,.28)', 'user-select:none',
    ].join(';');
    overlay.innerHTML = `
      <div style="position:fixed;top:12px;left:50%;transform:translateX(-50%);
        display:flex;gap:10px;align-items:center;background:rgba(15,17,20,.94);
        border:1px solid #2f333c;border-radius:8px;padding:8px 14px;
        font:12px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#dfe3ea;z-index:2">
        <span>拖动选择要翻译的区域</span>
        <button data-a="full" style="all:unset;cursor:pointer;background:#1c7a57;color:#fff;
          border-radius:5px;padding:3px 10px">整页</button>
        <button data-a="cancel" style="all:unset;cursor:pointer;background:#33363e;color:#aab;
          border-radius:5px;padding:3px 10px">取消</button>
      </div>`;
    document.documentElement.appendChild(overlay);

    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;border:2px solid #31d68f;background:rgba(49,214,143,.12);display:none;z-index:1';
    overlay.appendChild(box);
    const label = document.createElement('div');
    label.style.cssText = 'position:fixed;display:none;background:#1c7a57;color:#fff;font:11px sans-serif;padding:2px 6px;border-radius:4px;z-index:2';
    overlay.appendChild(label);

    let sx = 0, sy = 0, active = false;
    const pos = (e: MouseEvent) => ({ x: e.clientX, y: e.clientY });

    const onMove = (e: MouseEvent) => {
      if (!active) return;
      const { x, y } = pos(e);
      const l = Math.min(x, sx), t = Math.min(y, sy);
      const w = Math.abs(x - sx), h = Math.abs(y - sy);
      box.style.display = 'block';
      box.style.left = `${l}px`;
      box.style.top = `${t}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      label.style.display = 'block';
      label.style.left = `${l}px`;
      label.style.top = `${Math.max(0, t - 22)}px`;
      label.textContent = `${Math.round(w)} × ${Math.round(h)}（设备像素 ${Math.round(w * dpr)}）`;
    };
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).dataset?.a) return;
      active = true;
      const { x, y } = pos(e);
      sx = x; sy = y;
      overlay.style.background = 'transparent';
    };
    const onUp = (e: MouseEvent) => {
      if (!active) return;
      active = false;
      const { x, y } = pos(e);
      const w = Math.abs(x - sx), h = Math.abs(y - sy);
      if (w < 12 || h < 12) return; // 太小当误触
      finish({ x: Math.min(x, sx), y: Math.min(y, sy), w, h, dpr } as ScreenRegion);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish({ cancel: true });
    };
    overlay.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, { once: true });
    window.addEventListener('keydown', onKey, true);
    overlay.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.a === 'full') finish({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, dpr } as ScreenRegion);
        else finish({ cancel: true });
      });
    });
  });
}


/** 截图流程的错误：此时弹窗已关闭，用系统通知反馈 */
function notifyScreenError(message: string) {
  void browser.notifications
    .create({
      type: 'basic',
      iconUrl: 'icon/128.png',
      title: '截图翻译',
      message: message.slice(0, 400),
    })
    .catch(() => undefined);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return 'data:image/png;base64,' + btoa(bin);
}

/** 每个标签页的最新自检状态，供 popup 展示 */
const tabStates = new Map<number, PageState>();

/* ------------------------------ 语音识别（ASR） ----------------------------- */

const OFFSCREEN_PATH = 'offscreen.html';
type AsrState = 'idle' | 'starting' | 'running' | 'error';

/** 每个标签页独立的 ASR 会话（互不影响） */
const asrSessions = new Map<number, { state: AsrState; detail: string }>();

function asrGet(tabId: number | null | undefined) {
  return tabId != null ? asrSessions.get(tabId) : undefined;
}
function asrSet(tabId: number, state: AsrState, detail = '') {
  if (state === 'idle') asrSessions.delete(tabId);
  else asrSessions.set(tabId, { state, detail });
}

interface ChromeExt {
  offscreen?: {
    hasDocument?: () => Promise<boolean>;
    createDocument: (opts: { url: string; reasons: string[]; justification: string }) => Promise<void>;
    closeDocument?: () => Promise<void>;
    Reason?: { USER_MEDIA: string };
  };
  tabCapture?: {
    getMediaStreamId: (opts: { targetTabId?: number }) => Promise<string>;
  };
}

const chromeExt = (
  globalThis as unknown as {
    chrome?: ChromeExt & {
      cookies?: {
        getAll: (details: { domain?: string }) => Promise<
          Array<{
            name: string;
            value: string;
            domain: string;
            path?: string;
            secure?: boolean;
            expirationDate?: number;
          }>
        >;
      };
    };
  }
).chrome;

/**
 * 从 Chrome 的 cookie 库里实时导出 Netscape 格式。
 * 为什么必须实时：__Secure-1PSIDTS / 3PSIDTS 是滚动更新的，
 * 手工导出的文件几分钟后就被 YouTube 判定为无效，进而报"不是机器人"。
 */
async function exportCookies(): Promise<string | null> {
  const api = chromeExt?.cookies;
  if (!api) return null;
  const rows: string[] = ['# Netscape HTTP Cookie File', ''];
  for (const domain of ['youtube.com', 'google.com']) {
    let list: Awaited<ReturnType<typeof api.getAll>> = [];
    try {
      list = await api.getAll({ domain });
    } catch {
      continue;
    }
    for (const c of list) {
      if (!c?.name || c.value === undefined) continue;
      const dom = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
      const exp = Math.floor(c.expirationDate ?? 1893456000);
      rows.push(
        [dom, 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', String(exp), c.name, c.value].join('	'),
      );
    }
  }
  return rows.length > 2 ? rows.join(String.fromCharCode(10)) + String.fromCharCode(10) : null;
}

async function ensureOffscreen(): Promise<void> {
  const api = chromeExt?.offscreen;
  if (!api) throw new Error('当前浏览器不支持 offscreen（需要 Chrome 109+）');
  if (api.hasDocument && (await api.hasDocument().catch(() => false))) return;
  await api.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [api.Reason?.USER_MEDIA ?? 'USER_MEDIA'],
    justification: '录制标签页音频，交给本地语音识别服务转写字幕',
  });
}

async function asrStart(tabId: number, chunkSec: number): Promise<void> {
  asrSet(tabId, 'starting');
  const capture = chromeExt?.tabCapture;
  if (!capture) throw new Error('当前浏览器不支持 tabCapture');
  await ensureOffscreen();
  const streamId = await capture.getMediaStreamId({ targetTabId: tabId });
  // 离屏文档不回包，不该因为"未响应"而报错
  await browser.runtime
    .sendMessage({ type: 'ytsub:offscreen-start', tabId, streamId, chunkSec })
    .catch(() => undefined);
  asrSet(tabId, 'running');
}

async function asrStop(tabId: number | null | undefined): Promise<void> {
  if (tabId == null) {
    // 全部停掉
    for (const id of [...asrSessions.keys()]) {
      await browser.runtime
        .sendMessage({ type: 'ytsub:offscreen-stop', tabId: id })
        .catch(() => undefined);
      asrSet(id, 'idle');
    }
    return;
  }
  await browser.runtime
    .sendMessage({ type: 'ytsub:offscreen-stop', tabId })
    .catch(() => undefined);
  asrSet(tabId, 'idle');
}

async function subsRequest(
  tabId: number,
  videoId: string,
  url: string,
): Promise<{ segments?: unknown[]; jobId?: string; error?: string }> {
  const settings = await loadSettings();
  const base = settings.asrUrl.replace(/\/+$/, '');
  try {
    const cached = await fetch(`${base}/subtitles?id=${encodeURIComponent(videoId)}`).then((r) => r.json());
    if (cached?.hit && Array.isArray(cached.segments) && cached.segments.length) {
      return { segments: cached.segments };
    }
    // 先把当前浏览器会话的 cookie 推给本地服务，避免滚动过期
    try {
      const jar = await exportCookies();
      if (jar) {
        await fetch(`${base}/cookies`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: jar,
        });
      }
    } catch {
      /* cookie 推送失败就退回到磁盘上的 cookies.txt */
    }

    const started = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, url, lang: null }),
    }).then((r) => r.json());
    if (!started?.ok) return { error: started?.error ?? '生成任务启动失败' };
    asrSet(tabId, 'running', '正在生成字幕…');
    return { jobId: String(started.job) };
  } catch (err) {
    return { error: `连接本地服务失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

async function subsPoll(jobId: string) {
  const settings = await loadSettings();
  const base = settings.asrUrl.replace(/\/+$/, '');
  try {
    return await fetch(`${base}/job/${encodeURIComponent(jobId)}`).then((r) => r.json());
  } catch (err) {
    return { ok: false, state: 'error', detail: String(err) };
  }
}

function forwardToTab(tabId: number | null, payload: unknown): void {
  if (tabId == null) return;
  void browser.tabs.sendMessage(tabId, payload).catch(() => undefined);
}

async function handleChunk(msg: AsrChunkMessage): Promise<void> {
  const tabId = msg.tabId;
  if (tabId == null || !asrSessions.has(tabId)) return;
  // 录音刚停下的时刻（ASR 之前的），内容脚本用它换算视频时间轴
  const endedAt = Date.now();
  const settings = await loadSettings();
  const url = `${settings.asrUrl.replace(/\/+$/, '')}/asr?offset=${msg.offset}`;
  try {
    const bytes = Uint8Array.from(atob(msg.audio), (c) => c.charCodeAt(0));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const data = (await res.json()) as {
      ok?: boolean;
      segments?: Array<{ start: number; end: number; text: string }>;
      error?: string;
    };
    if (!data.ok) throw new Error(data.error || `ASR 服务返回 ${res.status}`);
    forwardToTab(tabId, {
      type: 'ytsub:asr-segments',
      segments: data.segments ?? [],
      endedAt,
    });
  } catch (err) {
    const detail = `语音识别失败：${err instanceof Error ? err.message : String(err)}（本地服务是否已启动？）`;
    asrSet(tabId, 'error', detail);
    forwardToTab(tabId, { type: 'ytsub:asr-status', state: 'error', detail });
  }
}

export default defineBackground(() => {
  browser.tabs.onRemoved.addListener((tabId) => {
    if (asrSessions.has(tabId)) void asrStop(tabId);
  });

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const msg = message as IncomingMessage;

    if (msg?.type === 'ytsub:state') {
      const tabId = sender.tab?.id;
      if (tabId != null) tabStates.set(tabId, msg.state);
      return false;
    }

    if (msg?.type === 'ytsub:getState') {
      void browser.tabs
        .query({ active: true, currentWindow: true })
        .then(([tab]) => {
          const id = tab?.id;
          const session = asrGet(id);
          sendResponse({
            ok: true,
            state: id != null ? tabStates.get(id) ?? null : null,
            asr: { state: session?.state ?? 'idle', tabId: id ?? null, detail: session?.detail ?? '' },
          });
        })
        .catch(() => sendResponse({ ok: false, state: null }));
      return true;
    }

    if (msg?.type === 'ytsub:asr-start') {
      const start = msg as AsrStartMessage;
      const tabId = start.tabId ?? sender.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false, error: '找不到当前标签页' });
        return true;
      }
      void asrStart(tabId, start.chunkSec ?? 3)
        .then(() => sendResponse({ ok: true, tabId }))
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          asrSet(tabId, 'error', detail);
          sendResponse({ ok: false, error: detail });
        });
      return true;
    }

    if (msg?.type === 'ytsub:asr-stop') {
      const stopTab = (msg as { tabId?: number }).tabId ?? sender.tab?.id ?? null;
      void asrStop(stopTab).then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg?.type === 'ytsub:asr-chunk') {
      // 必须 return true 并最终 sendResponse：否则事件一结束 SW 就可能被回收，
      // 正在进行的 fetch 会被中止（服务端表现为 ConnectionAbortedError）
      void handleChunk(msg as AsrChunkMessage)
        .catch(() => undefined)
        .finally(() => {
          try {
            sendResponse({ ok: true });
          } catch {
            /* 通道已关闭，忽略 */
          }
        });
      return true;
    }

    if (msg?.type === 'ytsub:asr-status') {
      const status = msg as AsrStatusMessage & { tabId?: number };
      const tabId = status.tabId ?? sender.tab?.id ?? null;
      if (tabId != null) {
        if (status.state === 'error') asrSet(tabId, 'error', status.detail ?? '未知错误');
        else if (status.state === 'running') asrSet(tabId, 'running');
        else if (status.state === 'stopped') asrSet(tabId, 'idle');
      }
      forwardToTab(tabId, { type: 'ytsub:asr-status', state: status.state, detail: status.detail });
      return false;
    }

    if (msg?.type === 'ytsub:service') {
      const cmd = (msg as { cmd: 'start' | 'stop' | 'status' }).cmd;
      try {
        browser.runtime
          .sendNativeMessage('com.pi.ytasr', { cmd })
          .then((res) => sendResponse({ ok: true, result: res }))
          .catch((err: unknown) => {
            const text = err instanceof Error ? err.message : String(err);
            sendResponse({
              ok: false,
              error: /not found|Access to the specified native messaging host is forbidden|Specified native messaging host not found/i.test(
                text,
              )
                ? '未安装启动器：请双击 install-native-host.cmd'
                : text,
            });
          });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return true;
    }

    if (msg?.type === 'ytsub:page-translate') {
      // 注入/切换整页翻译（第二次点 = 恢复原文，由脚本内部判断）
      void (async () => {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (tab?.id == null) throw new Error('找不到当前标签页');
        const url = tab.url ?? '';
        if (!/^https?:/i.test(url)) throw new Error('这个页面不支持翻译（只能翻译 http/https 网页）');

        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['/content-scripts/page-tr.js'],
        });
        return { ok: true };
      })()
        .then((r) => sendResponse(r))
        .catch((err: unknown) => {
          const text = err instanceof Error ? err.message : String(err);
          sendResponse({
            ok: false,
            error: /Cannot access|cannot be scripted|chrome:\/\//i.test(text)
              ? '这个页面不允许注入脚本（浏览器内置页 / 应用商店 / 其它扩展页面）'
              : text,
          });
        });
      return true;
    }

    if (msg?.type === 'ytsub:screen') {
      // 流程：注入选框 → 用户拖拽 → 截全页 → 按设备像素裁剪 → 视觉模型 → 结果页
      void (async () => {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (tab?.id == null) throw new Error('找不到当前标签页');

        // 1) 注入选框 UI（必须先取窗口句柄再裁剪，中间别关弹窗——弹窗早自动关了）
        const injected = await browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: selectRegionOnPage,
        }).then((r) => r[0]?.result) as ScreenRegion | { cancel: true } | undefined;

        if (!injected || 'cancel' in injected) return { ok: false, error: '已取消' };

        // 2) 截全页（此时选框已移除，不会拍进图里）
        const fullShot = (await browser.tabs.captureVisibleTab(tab.windowId, {
          format: 'png',
        })) as string;

        // 3) 按设备像素裁剪（OffscreenCanvas 在 SW 里可用）
        const { x, y, w, h, dpr } = injected;
        const bmp = await (await fetch(fullShot)).blob().then((b) => createImageBitmap(b));
        const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
        const cx = Math.round(x * dpr), cy = Math.round(y * dpr);
        const clampedW = Math.min(cw, bmp.width - cx), clampedH = Math.min(ch, bmp.height - cy);
        const canvas = new OffscreenCanvas(clampedW, clampedH);
        canvas.getContext('2d')!.drawImage(bmp, cx, cy, clampedW, clampedH, 0, 0, clampedW, clampedH);
        const cropped = await canvas.convertToBlob({ type: 'image/png' });

        // 4) 送本地视觉模型
        const settings = await loadSettings();
        const res = await fetch('http://127.0.0.1:8765/api/screen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: await blobToDataUrl(cropped),
            target: settings.targetLang,
          }),
        });
        const data = (await res.json()) as { ok: boolean; blocks?: unknown[]; error?: string };
        if (!data.ok) throw new Error(data.error || `识别失败（${res.status}）`);

        // 5) 暂存并打开结果页
        await browser.storage.session.set({
          screen: { image: await blobToDataUrl(cropped), blocks: data.blocks },
        });
        await browser.tabs.create({ url: 'screen.html' });
        return { ok: true };
      })()
        .then((r) => {
          const result = r as { ok: boolean; error?: string };
          if (!result.ok && result.error) notifyScreenError(result.error);
        })
        .catch((err: unknown) => {
          notifyScreenError(err instanceof Error ? err.message : String(err));
        });
      return true;
    }

    if (msg?.type === 'ytsub:subs-request') {
      const req = msg as { tabId?: number; videoId?: string; url?: string };
      const tabId = req.tabId ?? sender.tab?.id;
      if (tabId == null || !req.videoId || !req.url) {
        sendResponse({ error: '缺少 videoId / url' });
        return true;
      }
      void subsRequest(tabId, req.videoId, req.url)
        .then((r) => sendResponse(r))
        .catch((err: unknown) => sendResponse({ error: String(err) }));
      return true;
    }

    if (msg?.type === 'ytsub:subs-poll') {
      const jobId = (msg as { jobId?: string }).jobId;
      if (!jobId) {
        sendResponse({ ok: false, state: 'error', detail: '缺少 jobId' });
        return true;
      }
      void subsPoll(jobId).then((r) => sendResponse(r));
      return true;
    }

    if (msg?.type === 'ytsub:translate' && Array.isArray(msg.lines)) {
      translateLines(msg.lines, msg.settings)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err: unknown) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
      return true;
    }

    if (msg?.type === 'ytsub:test') {
      const text = (msg.text ?? 'Hello there, welcome back to the channel.').trim();
      translateLines([text], msg.settings)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err: unknown) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
      return true;
    }

    return false;
  });
});
