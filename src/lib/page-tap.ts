/**
 * 页面主世界（MAIN world）：截获 YouTube 自己的字幕请求。
 *
 * 为什么不用 yt-dlp 那套：官方 timedtext 接口在新版本里需要 poToken，
 * 直接在外部请求会被 403/空响应。而播放器自己发出的请求一定带齐了签名参数，
 * 所以在页面里挂钩 fetch/XHR，拿到的是「已经解密成功」的字幕数据。
 *
 * 点播：一次拿到整条字幕轨（可提前批量翻译）；
 * 直播：播放器按时间分片轮询，钩子天然变成流式输入。
 */
import { parseCues, tidy, type Cue } from './timedtext';
import { NS, type PageMessage, type UiMessage } from './types';

interface Track {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}

const TIMEDTEXT = '/api/timedtext';

function currentVideoId(): string {
  const v = /[?&]v=([\w-]{11})/.exec(location.href);
  if (v) return v[1];
  const s = /\/(?:shorts|live|embed)\/([\w-]{11})/.exec(location.href);
  return s ? s[1] : '';
}

function post(msg: PageMessage) {
  try {
    window.postMessage(msg, '*');
  } catch {
    /* 忽略 */
  }
}

let lastPayload: PageMessage | null = null;

const sendCues = (cues: Cue[], url: string, source: 'tap' | 'direct') => {
  const clean = tidy(cues);
  if (!clean.length) return;
  const lang = /[?&](?:t?lang)=([\w-]+)/.exec(url)?.[1] ?? '';
  const payload: PageMessage = {
    ns: NS,
    t: 'cues',
    videoId: currentVideoId(),
    lang,
    source,
    cues: clean,
  };
  lastPayload = payload;
  post(payload);
  uiLog(`got ${clean.length} cues (${source}${lang ? `, ${lang}` : ''})`);
};

let logCount = 0;
function uiLog(msg: string) {
  if (logCount++ > 50) return;
  post({ ns: NS, t: 'log', msg });
}

const origFetch = window.fetch.bind(window);

/* --------------------------------- 钩子 ---------------------------------- */

function installFetchTap() {
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? '';
    const promise = origFetch(input as RequestInfo, init);
    if (url.includes(TIMEDTEXT)) {
      promise
        .then((res) =>
          res
            .clone()
            .text()
            .then((text) => sendCues(parseCues(text), url, 'tap'))
            .catch(() => undefined),
        )
        .catch(() => undefined);
    }
    return promise;
  } as typeof window.fetch;
}

function installXhrTap() {
  const XHR = window.XMLHttpRequest;
  if (!XHR) return;
  const origOpen = XHR.prototype.open;
  const origSend = XHR.prototype.send;

  XHR.prototype.open = function open(this: XMLHttpRequest & { __ytsubUrl?: string }, method: string, url: string | URL, ...rest: unknown[]) {
    this.__ytsubUrl = typeof url === 'string' ? url : url?.href;
    // @ts-expect-error 透传原始参数
    return origOpen.call(this, method, url, ...rest);
  };

  XHR.prototype.send = function send(this: XMLHttpRequest & { __ytsubUrl?: string }, ...args: unknown[]) {
    const url = this.__ytsubUrl ?? '';
    if (url.includes(TIMEDTEXT)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            sendCues(parseCues(this.responseText), url, 'tap');
          }
        } catch {
          /* 忽略 */
        }
      });
    }
    // @ts-expect-error 透传原始参数
    return origSend.apply(this, args);
  };
}

/* ------------------------- 播放器字幕轨（直接拉取） ------------------------- */

function collectTracks(): Track[] {
  const tracks: Track[] = [];
  const push = (t: unknown) => {
    const item = t as { baseUrl?: string; languageCode?: string; kind?: string } | undefined;
    if (item?.baseUrl) {
      tracks.push({
        baseUrl: item.baseUrl,
        languageCode: item.languageCode ?? '',
        kind: item.kind,
      });
    }
  };

  // 1) 播放器 API：当前选中轨 + 轨道列表（参数最全）
  const player = document.getElementById('movie_player') as
    | { getOption?: (a: string, b: string) => unknown }
    | null;
  try {
    push(player?.getOption?.('captions', 'track'));
  } catch {
    /* 播放器还没就绪 */
  }
  try {
    const list = player?.getOption?.('captions', 'tracklist');
    if (Array.isArray(list)) list.forEach(push);
  } catch {
    /* 忽略 */
  }

  // 2) ytInitialPlayerResponse（仅同一条视频时有效）
  const page = (window as unknown as Record<string, any>).ytInitialPlayerResponse;
  if (!page || !currentVideoId() || page?.videoDetails?.videoId === currentVideoId()) {
    const list = page?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (Array.isArray(list)) list.forEach(push);
  }

  const seen = new Set<string>();
  return tracks.filter((t) => {
    const k = `${t.languageCode}|${t.baseUrl.slice(-60)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function withFormat(baseUrl: string, fmt: string): string {
  const stripped = baseUrl
    .replace(/([?&])fmt=[^&]*/g, '$1')
    .replace(/[?&]$/, '');
  return `${stripped}${stripped.includes('?') ? '&' : '?'}fmt=${fmt}`;
}

async function fetchTrack(track: Track): Promise<Cue[]> {
  for (const fmt of ['json3', 'srv3', 'vtt']) {
    try {
      const res = await origFetch(withFormat(track.baseUrl, fmt), { credentials: 'include' });
      if (!res.ok) continue;
      const text = await res.text();
      const cues = tidy(parseCues(text));
      if (cues.length) return cues;
    } catch {
      /* 试下一种格式 */
    }
  }
  return [];
}

let directAttempts = 0;

async function directLoad() {
  if (directAttempts > 8) return;
  directAttempts++;

  const tracks = collectTracks();
  if (!tracks.length) {
    setTimeout(() => void directLoad(), 1200);
    return;
  }

  // 优先英文字幕轨（转译目标一般是中文），否则用第一条
  const preferred =
    tracks.find((t) => /^en/i.test(t.languageCode) && t.kind !== 'asr') ??
    tracks.find((t) => /^en/i.test(t.languageCode)) ??
    tracks[0];

  const cues = await fetchTrack(preferred);
  if (cues.length) {
    sendCues(cues, `?lang=${preferred.languageCode}`, 'direct');
  } else {
    uiLog('direct fetch empty, relying on player CC request');
  }
}

/* --------------------------------- 启动 ----------------------------------- */

export function installTap() {
  installFetchTap();
  installXhrTap();

  window.addEventListener('message', (event: MessageEvent<UiMessage>) => {
    const data = event.data;
    if (!data || data.ns !== NS) return;
    if (data.t === 'ping') {
      post({ ns: NS, t: 'tap-ready', videoId: currentVideoId() });
    }
    if (data.t === 'request-captions') {
      directAttempts = 0;
      // UI 脚本可能晚于第一次抓取启动，先把已有结果补发一次
      if (lastPayload) post(lastPayload);
      void directLoad();
    }
  });

  // YouTube 是 SPA，切视频后重新解析
  window.addEventListener('yt-navigate-finish', () => {
    directAttempts = 0;
    lastPayload = null;
    setTimeout(() => void directLoad(), 600);
  });

  post({ ns: NS, t: 'tap-ready', videoId: currentVideoId() });
  setTimeout(() => void directLoad(), 800);
}
