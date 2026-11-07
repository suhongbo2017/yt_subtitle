/**
 * 离屏文档：按标签页抓音频，每个标签页一个独立会话。
 *
 * 为什么必须放在 offscreen：
 *  - MV3 的 service worker 里没有 MediaRecorder / AudioContext
 *  - tabCapture 抓到的音频默认会让该标签页静音，
 *    必须再接回 AudioContext.destination，声音才不会被"吞掉"
 */

// 离屏文档只用到 runtime 消息，用带类型的 shim 访问
const chromeApi = (globalThis as unknown as {
  chrome: {
    runtime: {
      sendMessage: (msg: unknown) => Promise<unknown>;
      onMessage: {
        addListener: (
          cb: (msg: {
            type?: string;
            tabId?: number;
            streamId?: string;
            chunkSec?: number;
          }) => boolean | void,
        ) => void;
      };
    };
  };
}).chrome;

interface Session {
  stream: MediaStream;
  ctx: AudioContext | null;
  recorder: MediaRecorder | null;
  timer: number | null;
  chunkIndex: number;
  chunkSec: number;
  stopped: boolean;
}

/** 一个标签页一个会话，互不影响 */
const sessions = new Map<number, Session>();

function reportStatus(tabId: number, state: string, detail?: string) {
  void chromeApi.runtime
    .sendMessage({ type: 'ytsub:asr-status', tabId, state, detail })
    .catch(() => undefined);
}

function stopSession(tabId: number) {
  const s = sessions.get(tabId);
  if (!s) return;
  s.stopped = true;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  if (s.recorder && s.recorder.state !== 'inactive') {
    try {
      s.recorder.stop();
    } catch {
      /* ignore */
    }
  }
  s.recorder = null;
  s.stream.getTracks().forEach((t) => t.stop());
  void s.ctx?.close().catch(() => undefined);
  sessions.delete(tabId);
}

function pickMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function startSession(tabId: number, streamId: string, chunkSec: number) {
  stopSession(tabId); // 同一标签页重启时先清掉旧的

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // @ts-expect-error chrome 专有约束
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
    video: false,
  });

  // 把音频接回扬声器，否则这个标签页会静音
  const ctx = new AudioContext();
  ctx.createMediaStreamSource(stream).connect(ctx.destination);

  const session: Session = {
    stream,
    ctx,
    recorder: null,
    timer: null,
    chunkIndex: 0,
    chunkSec: Math.max(1, chunkSec),
    stopped: false,
  };
  sessions.set(tabId, session);

  const mimeType = pickMime();
  const chunkMs = Math.max(1000, Math.round(session.chunkSec * 1000));

  const recordOnce = () => {
    const current = sessions.get(tabId);
    if (!current || current.stopped) return;

    const rec = new MediaRecorder(
      current.stream,
      mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined,
    );
    current.recorder = rec;
    const parts: Blob[] = [];
    const startedAt = performance.now();

    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) parts.push(ev.data);
    };

    rec.onstop = async () => {
      const live = sessions.get(tabId);
      if (!live) return; // 已被停止
      if (parts.length) {
        const blob = new Blob(parts, { type: rec.mimeType || 'audio/webm' });
        const duration = (performance.now() - startedAt) / 1000;
        try {
          const audio = await blobToBase64(blob);
          await chromeApi.runtime.sendMessage({
            type: 'ytsub:asr-chunk',
            tabId,
            audio,
            offset: live.chunkIndex * live.chunkSec,
            duration,
          });
        } catch {
          /* 单块失败不影响后续 */
        }
        live.chunkIndex += 1;
      }
      if (!live.stopped) live.timer = window.setTimeout(recordOnce, 60);
    };

    rec.start();
    current.timer = window.setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop();
    }, chunkMs);
  };

  recordOnce();
  reportStatus(tabId, 'running');
}

chromeApi.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'ytsub:offscreen-start' && msg.streamId && msg.tabId != null) {
    void startSession(msg.tabId, msg.streamId, msg.chunkSec ?? 3).catch((err) => {
      stopSession(msg.tabId!);
      reportStatus(msg.tabId!, 'error', String(err));
    });
    return false;
  }
  if (msg?.type === 'ytsub:offscreen-stop') {
    if (msg.tabId != null) {
      stopSession(msg.tabId);
      reportStatus(msg.tabId, 'stopped');
    } else {
      // 没带 tabId：全部停止（扩展卸载/清理时用）
      for (const id of [...sessions.keys()]) {
        stopSession(id);
        reportStatus(id, 'stopped');
      }
    }
    return false;
  }
  return false;
});
