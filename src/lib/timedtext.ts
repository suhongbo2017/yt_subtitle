/**
 * YouTube 字幕（/api/timedtext）解析。
 *
 * 播放器实际请求的字幕格式取决于客户端版本，可能是 json3、srv3/srv1(xml)
 * 或 vtt，这里统一转成带时间戳的 cue 列表。
 *
 * 本文件不依赖任何浏览器扩展 API，可在页面主世界（MAIN world）直接使用。
 */

export interface Cue {
  /** 秒 */
  start: number;
  /** 秒 */
  end: number;
  text: string;
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const SENTENCE_END = /[A-Za-z0-9.,!?'")\]]$/;
const WORD_START = /^[A-Za-z0-9(]/;

/** 折叠空白、去零宽字符 */
function clean(s: string): string {
  return s
    .replace(/\u200b/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 拼接 Youtube 的分段文本。
 * json3 的 segs 有时不带空格，srv3 的 <s> 有时带前导空格，这里按需补一个空格；
 * 中日韩文本不补空格。
 */
function smartJoin(parts: string[]): string {
  const hasCJK = CJK.test(parts.join(''));
  let out = '';
  for (const raw of parts) {
    const p = raw ?? '';
    if (!p) continue;
    if (out && !hasCJK && SENTENCE_END.test(out) && WORD_START.test(p)) out += ' ';
    out += p;
  }
  return out;
}

/** 老接口会在 JSON 前面加 )]}' 防 XSSI */
export function stripXssi(text: string): string {
  return text.replace(/^\)\]\}'[^\n]*\n?/, '');
}

function durationFrom(start: number, dur: number, text: string): number {
  if (dur > 0) return start + dur;
  return start + Math.max(0.8, text.length / 15);
}

/** fmt=json3 */
function parseJson3(text: string): Cue[] {
  const data = JSON.parse(stripXssi(text)) as {
    events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }>;
  };
  const cues: Cue[] = [];
  for (const ev of data.events ?? []) {
    if (!ev || typeof ev.tStartMs !== 'number' || !Array.isArray(ev.segs)) continue;
    const body = clean(smartJoin(ev.segs.map((s) => s?.utf8 ?? '')));
    if (!body) continue;
    const start = ev.tStartMs / 1000;
    cues.push({
      start,
      end: durationFrom(start, (ev.dDurationMs ?? 0) / 1000, body),
      text: body,
    });
  }
  return cues;
}

/** fmt=srv3（<p t d>）与 srv1（<text start dur>） */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function parseAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs))) out[m[1]] = decodeEntities(m[2]);
  return out;
}

function collectMatches(text: string, re: RegExp): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ attrs: m[1] ?? '', inner: m[2] ?? '' });
  return out;
}

function parseXml(text: string): Cue[] {
  const cues: Cue[] = [];

  for (const p of collectMatches(text, /<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const attrs = parseAttrs(p.attrs);
    if (attrs.t == null) continue;
    const start = Number(attrs.t) / 1000;
    if (!Number.isFinite(start)) continue;

    const segs = collectMatches(p.inner, /<s\b([^>]*)>([\s\S]*?)<\/s>/g).map((s) => decodeEntities(s.inner));
    const body = clean(segs.length ? smartJoin(segs) : decodeEntities(p.inner.replace(/<[^>]*>/g, '')));
    if (!body) continue;

    const dur = Number(attrs.d ?? 0) / 1000;
    cues.push({ start, end: durationFrom(start, dur, body), text: body });
  }
  if (cues.length) return cues;

  for (const el of collectMatches(text, /<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const attrs = parseAttrs(el.attrs);
    const body = clean(decodeEntities(el.inner.replace(/<[^>]*>/g, '')));
    if (!body) continue;
    const start = Number(attrs.start ?? 0) || 0;
    const dur = Number(attrs.dur ?? 0) || 0;
    cues.push({ start, end: durationFrom(start, dur, body), text: body });
  }
  return cues;
}

function parseTimestamp(s: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

/** 。vtt */
function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const m = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/.exec(block);
    if (!m) continue;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    if (!Number.isFinite(start)) continue;
    const body = clean(block.slice(m.index + m[0].length).replace(/<[^>]*>/g, ' '));
    if (!body) continue;
    cues.push({ start, end: Math.max(end || 0, start + 0.5), text: body });
  }
  return cues;
}

/** 同一行重复/滚动补全的 cue 合并成一条，避免字幕抖动 */
/** 相邻字幕之间的小空隙补齐，避免"字幕闪一下就消失、露出空档" */
export function fillGaps(cues: Cue[], maxGap = 2.0, maxHold = 8.0): Cue[] {
  for (let i = 0; i < cues.length; i++) {
    const cur = cues[i];
    const next = cues[i + 1];
    if (next) {
      const gap = next.start - cur.end;
      // 空隙 < maxGap 就延到下一句开始；否则最多再撑 maxHold
      if (gap > 0 && gap <= maxGap) cur.end = next.start;
      else if (gap > maxGap) cur.end = Math.min(next.start, cur.end + maxHold);
    } else if (cur.end - cur.start < 1.0) {
      cur.end = cur.start + 1.0;
    }
    // 单句不要过长（滚动字幕合并后可能跨很久）
    if (cur.end - cur.start > maxHold + 4) cur.end = cur.start + maxHold + 4;
  }
  return cues;
}

export function tidy(cues: Cue[]): Cue[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const out: Cue[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && (c.text === prev.text || c.text.startsWith(prev.text) || prev.text.startsWith(c.text))) {
      if (c.text.length > prev.text.length) prev.text = c.text;
      prev.end = Math.max(prev.end, c.end);
      continue;
    }
    out.push({ ...c });
  }
  return fillGaps(out);
}

export function parseCues(text: string): Cue[] {
  const s = text.trim();
  if (!s) return [];
  // 所有格式统一过 tidy（含滚动合并 + 空隙补齐），避免下游各处自己补
  if (s.startsWith('WEBVTT')) return tidy(parseVtt(s));
  if (s.startsWith('{') || s.startsWith(')]}')) {
    try {
      return tidy(parseJson3(s));
    } catch {
      /* 落到下一种格式 */
    }
  }
  if (s.startsWith('<')) {
    try {
      return tidy(parseXml(s));
    } catch {
      /* 忽略 */
    }
  }
  return [];
}

const cueKey = (c: Cue) => `${c.start.toFixed(2)}|${c.text}`;

/** 增量合并（直播会分片推送字幕） */
export function mergeCueLists(existing: Cue[], incoming: Cue[]): Cue[] {
  const map = new Map<string, Cue>();
  for (const c of existing) map.set(cueKey(c), c);
  for (const c of incoming) {
    const k = cueKey(c);
    const old = map.get(k);
    if (!old || c.end > old.end) map.set(k, c);
  }
  return [...map.values()].sort((a, b) => a.start - b.start);
}
