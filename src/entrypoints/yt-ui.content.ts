import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { mergeCueLists, type Cue } from '@/lib/timedtext';
import { SubtitleOverlay } from '@/lib/overlay';
import { cacheItem, loadSettings, settingsItem } from '@/lib/settings';
import { DEFAULT_SETTINGS, NS, type PageMessage, type Settings } from '@/lib/types';

const NATIVE_CSS_ID = 'ytsub-native-captions-off';
const MAX_CACHE_ENTRIES = 6000;

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_start',
  main() {
    void boot();
  },
});

async function boot() {
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let cues: Cue[] = [];
  let cursor = 0;
  let holdUntil = 0;
  let running = 0;
  let failStreak = 0;
  let nextAttemptAt = 0;
  // ASR：录音起点在视频时间轴上的位置（用最后一段对齐"现在"来自校正）
  let asrBase: number | null = null;
  let asrChunks = 0;
  // 直播式显示：ASR 有 2-4 秒延迟，按时间轴对齐会导致"字幕永远慢一步、显示不出来"，
  // 所以最新一句到达就上屏并保持几秒，等下一块替换（和直播字幕行为一致）
  // 粘住式显示：新的一块到达才替换，12 秒没有更新才自动消失
  let asrLive: { texts: string[]; updatedAt: number } | null = null;
  const ASR_LIVE_TTL = 12000;
  let enabled = true;
  let errorUntil = 0;

  const overlay = new SubtitleOverlay();
  const translations = new Map<string, string>();
  const inFlight = new Set<string>();
  let cache: Record<string, string> = {};

  /* ------------------------------- 工具函数 ------------------------------- */

  const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const keyOf = (text: string) => `${settings.provider}|${settings.targetLang}|${norm(text)}`;

  const videoEl = (): HTMLVideoElement | null =>
    document.querySelector<HTMLVideoElement>(
      '#movie_player video.html5-main-video, #movie_player video, video.html5-main-video',
    );

  const post = (msg: unknown) => window.postMessage(msg, '*');

  function notifyError(message: string | null) {
    currentError = message ?? '';
    if (message) {
      // 常驻显示：翻译没出来时用户必须能看到原因，而不是 6 秒后无声无息
      errorUntil = 0;
      overlay.error(message);
      console.warn('[ytsub] 翻译失败：', message);
    } else {
      overlay.error(null);
    }
    reportState(true);
  }

  /* ------------------------------- 自检上报 ------------------------------- */

  let currentError = '';
  let lastReportAt = 0;

  function reportState(force = false) {
    const now = Date.now();
    if (!force && now - lastReportAt < 900) return;
    lastReportAt = now;
    void browser.runtime
      .sendMessage({
        type: 'ytsub:state',
        state: {
          videoId: /[?&]v=([\w-]{11})/.exec(location.search)?.[1] ?? '',
          cues: cues.length,
          translated: translations.size,
          provider: settings.provider,
          error: currentError,
          asr: asrProgress,
          source: cueSource,
          onVideo: /[?&]v=[\w-]{11}/.test(location.search),
          showing: overlay.text,
        },
      })
      .catch(() => undefined);
  }

  /* --------------------------------- 样式 --------------------------------- */

  function applyNativeCaptionCss() {
    const existing = document.getElementById(NATIVE_CSS_ID);
    if (settings.hideNativeCaptions && !existing) {
      const style = document.createElement('style');
      style.id = NATIVE_CSS_ID;
      style.textContent = '.ytp-caption-window-container{display:none!important}';
      (document.head ?? document.documentElement).appendChild(style);
    } else if (!settings.hideNativeCaptions && existing) {
      existing.remove();
    }
  }

  /** 去掉与上一块末尾重复的开头词（切片边界上常见） */
  function dedupeOverlap(prev: string | undefined, next: string): string {
    if (!prev) return next;
    const a = prev.toLowerCase().split(/\s+/).filter(Boolean);
    const b = next.split(/\s+/).filter(Boolean);
    const limit = Math.min(a.length, b.length, 8);
    for (let k = limit; k >= 2; k--) {
      if (a.slice(-k).join(' ') === b.slice(0, k).join(' ').toLowerCase()) {
        return b.slice(k).join(' ');
      }
    }
    return next;
  }

  /* ------------------------------ 点播字幕生成 ------------------------------ */

  let vodTimer: ReturnType<typeof setInterval> | null = null;
  let asrProgress = '';
  /** 当前字幕来源，供弹窗显示「正在用哪个功能」 */
  let cueSource: 'caption' | 'vod' | 'live' | '' = '';

  function stopVodPolling() {
    if (vodTimer) {
      clearInterval(vodTimer);
      vodTimer = null;
    }
  }

  function injectVodSubs(segments: { start: number; end: number; text: string }[]) {
    const clean = segments
      .map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
      .filter((s) => s.text);
    if (!clean.length) return;
    cues = mergeCueLists([], clean);
    cueSource = 'vod';
    cursor = 0;
    asrLive = null;
    asrProgress = '';
    doneSignal();
    reportState(true);
    console.debug(`[ytsub] 点播字幕已加载 ${clean.length} 段`);
  }

  let resolveDone: (() => void) | null = null;
  function doneSignal() {
    resolveDone?.();
    resolveDone = null;
  }

  async function requestVodSubs(videoId: string): Promise<boolean> {
    asrProgress = '正在检查字幕缓存…';
    reportState(true);
    const res = (await browser.runtime.sendMessage({
      type: 'ytsub:subs-request',
      videoId,
      url: location.href,
    })) as { segments?: { start: number; end: number; text: string }[]; jobId?: string; error?: string };

    if (res?.segments?.length) {
      injectVodSubs(res.segments);
      return true;
    }
    if (!res?.jobId) {
      asrProgress = '';
      notifyError(res?.error ?? '字幕生成失败');
      return false;
    }

    const jobId = res.jobId;
    stopVodPolling();
    vodTimer = setInterval(() => {
      void (async () => {
        const st = (await browser.runtime.sendMessage({ type: 'ytsub:subs-poll', jobId })) as {
          state?: string;
          progress?: number;
          detail?: string;
          segments?: { start: number; end: number; text: string }[];
        };
        if (st?.state === 'done' && st.segments?.length) {
          stopVodPolling();
          injectVodSubs(st.segments);
          return;
        }
        if (st?.state === 'error') {
          stopVodPolling();
          asrProgress = '';
          notifyError(`字幕生成失败：${st.detail ?? ''}`);
          return;
        }
        asrProgress = `${st?.detail ?? '处理中'} ${Math.round((st?.progress ?? 0) * 100)}%`;
        reportState(true);
      })();
    }, 2500);
    return false;
  }

  /* -------------------------------- 渲染循环 ------------------------------- */

  function findCue(t: number): Cue | null {
    if (!cues.length) return null;
    if (cursor >= cues.length || cues[cursor].start > t) cursor = 0;
    while (cursor + 1 < cues.length && cues[cursor + 1].start <= t) cursor++;
    const cue = cues[cursor];
    if (!cue) return null;
    if (t >= cue.start - 0.05 && t <= cue.end + 0.15) return cue;
    return null;
  }

  let lastTick = 0;
  function loop(ts: number) {
    requestAnimationFrame(loop);
    if (ts - lastTick < 90) return;
    lastTick = ts;

    if (!enabled) {
      overlay.hide();
      return;
    }
    if (!overlay.mount()) return;

    const video = videoEl();
    if (!video) return;

    if (asrLive && ts - asrLive.updatedAt < ASR_LIVE_TTL) {
      holdUntil = ts + 600;
      // 逐句查译文缓存（翻译是按单句缓存的），拼起来显示
      const orig = asrLive.texts.join(' ');
      const tr = asrLive.texts
        .map((t) => translations.get(keyOf(t)) ?? '')
        .filter(Boolean)
        .join(' ');
      overlay.show(orig, tr);
      if (errorUntil && ts > errorUntil) notifyError(null);
      return;
    }
    if (asrLive) asrLive = null;

    const cue = findCue(video.currentTime);
    if (cue) {
      holdUntil = ts + 600;
      overlay.show(cue.text, translations.get(keyOf(cue.text)) ?? '');
    } else if (ts > holdUntil) {
      overlay.hide();
    }

    if (errorUntil && ts > errorUntil) notifyError(null);
  }

  /* -------------------------------- 翻译调度 ------------------------------- */

  function rank(cue: Cue, now: number): number {
    const delta = cue.start - now;
    if (delta < -6) return 100_000 + Math.abs(delta);
    if (delta > settings.prefetchSeconds) return 50_000 + (delta - settings.prefetchSeconds);
    return Math.abs(delta - 2);
  }

  async function pump() {
    if (!enabled || running >= 2) return;
    if (Date.now() < nextAttemptAt) return;
    const video = videoEl();
    if (!video || !cues.length) return;
    const now = video.currentTime;

    const pending = cues.filter((c) => {
      const key = keyOf(c.text);
      return !translations.has(key) && !inFlight.has(key);
    });
    if (!pending.length) return;

    pending.sort((a, b) => rank(a, now) - rank(b, now));

    const batch: Cue[] = [];
    const batchKeys = new Set<string>();
    let chars = 0;
    for (const cue of pending) {
      const key = keyOf(cue.text);
      if (batchKeys.has(key)) continue;
      if (batch.length >= 12 || chars + cue.text.length > 900) break;
      batch.push(cue);
      batchKeys.add(key);
      chars += cue.text.length;
    }
    if (!batch.length) return;

    batchKeys.forEach((k) => inFlight.add(k));
    running++;
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'ytsub:translate',
        lines: batch.map((c) => c.text),
        settings,
      })) as { ok: boolean; data?: string[]; error?: string } | undefined;

      if (res?.ok && Array.isArray(res.data)) {
        res.data.forEach((text, i) => {
          const key = keyOf(batch[i].text);
          if (text) {
            translations.set(key, text);
            cache[key] = text;
          }
        });
        scheduleSave();
        failStreak = 0;
        nextAttemptAt = 0;
        if (currentError) notifyError(null);
      } else if (res?.error) {
        failStreak += 1;
        nextAttemptAt = Date.now() + Math.min(30000, 2000 * failStreak);
        notifyError(res.error);
      }
    } catch (err) {
      failStreak += 1;
      nextAttemptAt = Date.now() + Math.min(30000, 2000 * failStreak);
      notifyError(err instanceof Error ? err.message : String(err));
    } finally {
      batchKeys.forEach((k) => inFlight.delete(k));
      running--;
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushCache();
    }, 4000);
  }

  async function flushCache() {
    const keys = Object.keys(cache);
    if (keys.length > MAX_CACHE_ENTRIES) {
      for (const k of keys.slice(0, keys.length - MAX_CACHE_ENTRIES)) delete cache[k];
    }
    try {
      await cacheItem.setValue(cache);
    } catch {
      /* 超过配额时放弃本次写入 */
    }
  }

  /* --------------------------------- 生命周期 ------------------------------ */

  function requestCaptions() {
    post({ ns: NS, t: 'request-captions' });
  }

  let ccTimer: number | null = null;
  function armCCFallback() {
    if (ccTimer) return;
    ccTimer = window.setTimeout(() => {
      ccTimer = null;
      if (cues.length) return;
      // 直接拉取失败时，点一下 CC 按钮让播放器自己去请求字幕，钩子会接住
      const btn = document.querySelector<HTMLButtonElement>('.ytp-subtitles-button');
      if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
    }, 2500);
  }

  function reset(clearCues = true) {
    if (clearCues) cues = [];
    cursor = 0;
    holdUntil = 0;
    asrBase = null;
    cueSource = '';
    asrLive = null;
    overlay.hide();
    notifyError(null);
    armCCFallback();
    requestCaptions();
  }

  function applySettings(next: Settings) {
    settings = next;
    enabled = next.enabled;
    overlay.setStyle({
      showOriginal: next.showOriginal,
      fontScale: next.fontScale,
      bottomOffset: next.bottomOffset,
    });
    applyNativeCaptionCss();
    if (!enabled) overlay.hide();
  }

  /* ---------------------------------- 启动 -------------------------------- */

  settings = await loadSettings();
  applySettings(settings);
  try {
    cache = (await cacheItem.getValue()) ?? {};
    for (const [k, v] of Object.entries(cache)) translations.set(k, v);
  } catch {
    cache = {};
  }

  settingsItem.watch((value) => {
    if (value) applySettings({ ...DEFAULT_SETTINGS, ...value });
  });

  window.addEventListener('message', (event: MessageEvent<PageMessage>) => {
    const data = event.data;
    if (!data || data.ns !== NS) return;
    if (data.t === 'cues') {
      cues = mergeCueLists(cues, data.cues);
      cueSource = 'caption';
      cursor = 0;
      reportState(true);
    }
    if (data.t === 'log') {
      console.debug('[ytsub]', data.msg);
    }
  });

  // 本地语音识别（无字幕视频）送来的句子 -> 走同一套 cue + 翻译管线
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as
      | {
          type: 'ytsub:asr-segments';
          segments: { start: number; end: number; text: string }[];
          endedAt?: number;
        }
      | { type: 'ytsub:asr-status'; state: string; detail?: string }
      | { type: 'ytsub:vod-start' }
      | { type: 'ytsub:vod-stop' };
    if (msg?.type === 'ytsub:vod-start') {
      const vid = /[?&]v=([\w-]{11})/.exec(location.search)?.[1] ?? '';
      if (!vid) {
        notifyError('当前页面不是 YouTube 视频页');
        return false;
      }
      notifyError(null);
      void requestVodSubs(vid);
      return false;
    }
    if (msg?.type === 'ytsub:vod-stop') {
      stopVodPolling();
      asrProgress = '';
      reportState(true);
      return false;
    }
    if (msg?.type === 'ytsub:asr-status') {
      if (msg.state === 'error') notifyError(msg.detail ?? '语音识别出错');
      if (msg.state === 'running') {
        asrBase = null;
        asrChunks = 0;
        notifyError(null);
      }
      if (msg.state === 'stopped') {
        asrBase = null;
        asrLive = null;
      }
      return false;
    }
    if (msg?.type !== 'ytsub:asr-segments') return false;

    const video = videoEl();
    const segments = (msg.segments ?? []).filter((seg) => seg.text.trim());
    if (!video || !segments.length) return false;

    // 录音结束那一刻的视频时间 = 现在 - (ASR 处理耗时 + 传输耗时)
    const last = segments[segments.length - 1];
    const lag = msg.endedAt ? (Date.now() - msg.endedAt) / 1000 : 0;
    const videoAtChunkEnd = video.currentTime - lag * (video.playbackRate || 1);
    const implied = videoAtChunkEnd - last.end;
    if (asrBase == null || Math.abs(implied - asrBase) > 3) {
      asrBase = implied;
      console.debug('[ytsub] ASR 基准重设于', asrBase.toFixed(1), 's（滞后 ' + lag.toFixed(1) + 's）');
    }
    const base = asrBase;
    // 最新一句立刻上屏；翻译还没回来时先显示原文
    // 只显示最新一句（粘住直到下一块），并去掉与上一块重复的开头词
    const fresh = segments[segments.length - 1].text.trim();
    const prev = asrLive?.texts[asrLive.texts.length - 1];
    const deduped = dedupeOverlap(prev, fresh);
    asrLive = {
      texts: deduped ? [deduped] : asrLive ? asrLive.texts : [fresh],
      updatedAt: performance.now(),
    };
    const incoming = segments.map((seg) => {
      const start = Math.max(0, base + seg.start);
      const end = Math.max(start + 0.4, base + seg.end);
      return { start, end, text: seg.text.trim() };
    });
    cues = mergeCueLists(cues, incoming);
    cueSource = 'live';
    cursor = 0;
    asrChunks += 1;
    console.debug(`[ytsub] ASR 第 ${asrChunks} 块：${incoming.length} 句`);
    reportState(true);
    return false;
  });

  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => {
      reset(performance.now() > 3000);
      applyNativeCaptionCss();
    }, 300);
  });

  requestAnimationFrame(loop);
  setInterval(() => void pump(), 900);
  setInterval(() => reportState(), 3000);
  setTimeout(() => reset(false), 500);
  window.addEventListener('beforeunload', () => void flushCache());
}
