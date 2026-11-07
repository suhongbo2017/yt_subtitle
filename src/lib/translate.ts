/**
 * 翻译后端（运行在 background service worker，避免页面侧 CORS）。
 *
 * - google：免费、无需 Key，走 translate_a/single 的 gtx 客户端。
 * - llm：任意 OpenAI 兼容端点（DeepSeek / OpenAI / 本地 Ollama 等）。
 *
 * 两者都按「多行拼一批 -> 校验行数 -> 失败则逐行兜底」的方式工作。
 */
import type { Settings } from './types';

const GOOGLE_BATCH_CHARS = 900;
const LLM_BATCH_LINES = 20;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url: string, init: RequestInit, timeoutMs = 15000, retries = 2) {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (i < retries) await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

/* ---------------------------------- Google --------------------------------- */

/**
 * 主端点：Chrome 内置翻译用的 clients5，支持一次多个 q（批量），
 * 且对无 Cookie 的请求比 translate_a/single 宽容得多（后者常返回 429）。
 */
const GOOGLE_BULK = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto';
const GOOGLE_SINGLE = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t';

function readBulkPayload(data: unknown, expected: number): string[] {
  if (!Array.isArray(data) || data.length === 0) throw new Error('google: empty payload');
  // 形状可能是 [["译文","en"], ...] 或单条时 ["译文","en"]
  const rows = Array.isArray(data[0]) ? (data as unknown[][]) : [data as unknown[]];
  if (rows.length !== expected) throw new Error('google: count mismatch');
  return rows.map((row) => String((row as unknown[])[0] ?? '').trim());
}

async function googleBulk(lines: string[], target: string): Promise<string[]> {
  const qs = lines.map((line) => `&q=${encodeURIComponent(line)}`).join('');
  const url = `${GOOGLE_BULK}&tl=${encodeURIComponent(target)}${qs}`;
  const res = await fetchWithRetry(url, {});
  return readBulkPayload(await res.json(), lines.length);
}

async function googleSingle(text: string, target: string): Promise<string> {
  const url = `${GOOGLE_SINGLE}&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(text)}`;
  const res = await fetchWithRetry(url, {});
  const data = (await res.json()) as unknown[];
  const segs = (data?.[0] ?? []) as Array<[string] | null>;
  return segs.map((s) => s?.[0] ?? '').join('');
}

/** 把行按 URL 长度切批 */
function chunkByUrlLength(lines: string[], maxChars: number): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let chars = 0;
  lines.forEach((line, i) => {
    const cost = encodeURIComponent(line).length + 3;
    if (current.length && chars + cost > maxChars) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(i);
    chars += cost;
  });
  if (current.length) batches.push(current);
  return batches;
}

async function googleTranslate(lines: string[], target: string): Promise<string[]> {
  const lang = target || 'zh-CN';
  const out: string[] = new Array(lines.length).fill('');

  for (const batch of chunkByUrlLength(lines, 1200)) {
    const subset = batch.map((i) => lines[i]);
    try {
      const translated = await googleBulk(subset, lang);
      batch.forEach((i, k) => (out[i] = translated[k]));
      continue;
    } catch {
      /* 退回逐条 */
    }
    for (let k = 0; k < batch.length; k += 4) {
      await Promise.all(
        batch.slice(k, k + 4).map(async (i) => {
          try {
            out[i] = (await googleSingle(lines[i], lang)).trim();
          } catch {
            out[i] = '';
          }
        }),
      );
    }
  }
  return out;
}

/* ------------------------------------ LLM ---------------------------------- */

const SYSTEM_PROMPT = (target: string) => `你是专业的视频字幕译者。用户会给出一段 JSON：
{"lines":["...","..."]}
请把每一行译文翻译成${target}，要求：
1. 必须是口语化、简短、可直接作为字幕阅读的译文，不要解释、不要加注、不要合并句子；
2. 行数与顺序必须与输入完全一致，一行输入对应一行输出；
3. 专有名词、人名、产品名保持全片一致，首字母大写的人名保留原文；
4. 已知上下文有限时，优先保证句子通顺；
5. 只输出 JSON：{"lines":["...","..."]}`;

function extractLines(content: string, expected: number): string[] {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(content.slice(start, end + 1)) as unknown;
      if (Array.isArray(arr) && arr.length === expected) return arr.map((x) => String(x ?? '').trim());
    } catch {
      /* 继续尝试其他形状 */
    }
  }
  const lines = content
    .split('\n')
    .map((s) => s.replace(/^\s*(?:[-*\d.、]+)\s*/, '').trim())
    .filter(Boolean);
  if (lines.length === expected) return lines;
  throw new Error('llm: unexpected output shape');
}

async function llmBatch(lines: string[], settings: Settings): Promise<string[]> {
  const base = settings.apiBase.trim().replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const body: Record<string, unknown> = {
    model: settings.apiModel.trim() || 'deepseek-chat',
    temperature: 0.2,
    // 不显式给的话，部分端点默认很小，JSON 会被截断
    max_tokens: Math.min(4096, 200 + lines.reduce((n, l) => n + l.length * 3, 0)),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT(settings.targetLang) },
      { role: 'user', content: JSON.stringify({ lines }) },
    ],
  };

  let res: Response;
  try {
    res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey.trim()}`,
        },
        body: JSON.stringify(body),
      },
      45000,
      1,
    );
  } catch (err) {
    // 部分自建/旧端点不支持 response_format
    delete body.response_format;
    res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey.trim()}`,
        },
        body: JSON.stringify(body),
      },
      45000,
      1,
    );
    if (!res) throw err;
  }

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content ?? '';
  return extractLines(content, lines.length);
}

async function llmTranslate(lines: string[], settings: Settings): Promise<string[]> {
  if (!settings.apiKey.trim() && !/localhost|127\.0\.0\.1/.test(settings.apiBase)) {
    throw new Error('未配置 API Key：打开扩展设置，在 LLM 引擎里填 API Key');
  }
  const out: string[] = new Array(lines.length).fill('');
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i += LLM_BATCH_LINES) {
    const batch = lines.slice(i, i + LLM_BATCH_LINES);
    try {
      const translated = await llmBatch(batch, settings);
      translated.forEach((t, k) => (out[i + k] = t));
      continue;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    // 批失败才逐行重试（很贵，只在必要时做）
    for (let k = 0; k < batch.length; k++) {
      try {
        out[i + k] = (await llmBatch([batch[k]], settings))[0] ?? '';
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        out[i + k] = '';
      }
    }
  }

  // 一条都没翻出来：把真实原因抛上去，别让界面"静默无反应"
  if (!out.some((t) => t && t.trim())) {
    const first = errors.find(Boolean) ?? '未知错误';
    throw new Error(`LLM 翻译失败：${first.slice(0, 220)}`);
  }
  return out;
}

/* ---------------------------------- 入口 ----------------------------------- */

export async function translateLines(lines: string[], settings: Settings): Promise<string[]> {
  if (!lines.length) return [];
  if (settings.provider === 'llm') return llmTranslate(lines, settings);
  return googleTranslate(lines, settings.targetLang || 'zh-CN');
}
