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
  | { type: 'ytsub:service'; cmd: 'start' | 'stop' | 'status' };

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
