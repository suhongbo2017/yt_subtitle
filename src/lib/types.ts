import type { Cue } from './timedtext';

export type Provider = 'google' | 'llm';

export interface Settings {
  /** 总开关 */
  enabled: boolean;
  /** google = 免费无 Key；llm = 任意 OpenAI 兼容端点 */
  provider: Provider;
  targetLang: string;
  /** 是否显示原文行 */
  showOriginal: boolean;
  /** 隐藏 YouTube 原生字幕，避免和叠加层重叠 */
  hideNativeCaptions: boolean;
  /** 字号缩放 */
  fontScale: number;
  /** 字幕位置，距底部百分比 */
  bottomOffset: number;
  /** OpenAI 兼容端点，例如 https://api.deepseek.com/v1 */
  apiBase: string;
  apiModel: string;
  apiKey: string;
  /** 提前翻译多少秒的字幕 */
  prefetchSeconds: number;
  /** 没有字幕轨时，用本地 ASR 从标签页音频转写 */
  asrEnabled: boolean;
  /** 本地 ASR 服务地址（asrsvc） */
  asrUrl: string;
  /** 每次录音切片长度（秒） */
  asrChunkSec: number;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  provider: 'google',
  targetLang: 'zh-CN',
  showOriginal: true,
  hideNativeCaptions: true,
  fontScale: 1,
  bottomOffset: 10,
  apiBase: 'https://api.deepseek.com/v1',
  apiModel: 'deepseek-chat',
  apiKey: '',
  prefetchSeconds: 90,
  asrEnabled: false,
  asrUrl: 'http://127.0.0.1:8770',
  asrChunkSec: 3,
};

/** 页面主世界 -> UI 内容脚本 */
export type PageMessage =
  | { ns: typeof NS; t: 'cues'; videoId: string; lang: string; source: 'tap' | 'direct'; cues: Cue[] }
  | { ns: typeof NS; t: 'tap-ready'; videoId: string }
  | { ns: typeof NS; t: 'log'; msg: string };

/** 语音识别相关消息 */
export type AsrMessage =
  | { type: 'ytsub:asr-start'; tabId?: number; chunkSec?: number }
  | { type: 'ytsub:asr-stop' }
  | { type: 'ytsub:asr-chunk'; audio: string; offset: number; duration: number }
  | { type: 'ytsub:asr-segments'; segments: { start: number; end: number; text: string }[] }
  | { type: 'ytsub:asr-status'; state: 'starting' | 'running' | 'stopped' | 'error'; detail?: string };

/** UI 内容脚本 -> 页面主世界 */
export type UiMessage = { ns: typeof NS; t: 'request-captions' } | { ns: typeof NS; t: 'ping' };

export const NS = '__ytsub__' as const;
