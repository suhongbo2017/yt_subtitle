/**
 * 整页翻译：遍历 DOM 文本节点 → 批量翻译 → 原地替换，可一键恢复原文。
 *
 * 通过 chrome.scripting.executeScript 按需注入（用户点按钮才跑），
 * 不在所有页面上常驻。
 */
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { loadSettings } from '@/lib/settings';

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP',
  'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON_LABEL',
  'SVG', 'MATH', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'HEAD', 'TITLE',
]);
const SKIP_SELECTOR = '[translate="no"], .notranslate, [data-ytsub-skip], #ytsub-host, .__ytsub-pt__';
const CJK = /[\u4e00-\u9fff\u3040-\u30ff]/;

interface Session {
  originals: Map<Text, string>;
  panel: HTMLElement | null;
  restore(): void;
}

declare global {
  interface Window {
    __ytsubPageTranslate?: Session;
  }
}

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  registration: 'runtime',
  runAt: 'document_idle',
  main() {
    console.log('[ytsub/pt] injected, existing session =', !!window.__ytsubPageTranslate);
    // 二次点击 = 恢复原文
    if (window.__ytsubPageTranslate) {
      console.log('[ytsub/pt] → restore');
      window.__ytsubPageTranslate.restore();
      return;
    }
    void runPageTranslate();
  },
});

/** 这段文字值不值得翻译 */
function worthTranslating(raw: string): boolean {
  const text = raw.trim();
  if (text.length < 2) return false;
  if (!/[A-Za-z\u3040-\u30ff\u0400-\u04ff]/.test(text)) return false; // 没有任何可译字符
  if (/^(?:[\d\s\p{P}\p{S}]+)$/u.test(text)) return false; // 纯数字/标点

  // 已经是中文为主就别翻了
  const cjk = (text.match(CJK) ?? []).length;
  if (cjk > 0 && cjk / text.length > 0.25) return false;
  return true;
}

const CONTENT_ROOT = 'main, article, [role="main"], #mw-content-text, #content, .markdown-body';
const NOISE = 'nav, aside, footer, header, [role="navigation"], .sidebar, .nav, .menu, .advertisement';

/** 优先只翻正文区域；找不到就用 body，但排除导航/侧栏/页脚 */
function pickRoot(): { root: Element; scoped: boolean } {
  const main = document.querySelector(CONTENT_ROOT);
  return main ? { root: main, scoped: true } : { root: document.body, scoped: false };
}

function collectTextNodes(root: Element, scoped: boolean): Text[] {
  if (!root) return [];
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
      if (el.isContentEditable) return NodeFilter.FILTER_REJECT;
      if (el.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      if (!scoped && el.closest(NOISE)) return NodeFilter.FILTER_REJECT;

      // 不可见元素跳过（display:none / 尺寸为 0）
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;

      return worthTranslating(node.nodeValue ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  } as never);

  while (walker.nextNode()) out.push(walker.currentNode as Text);
  return out;
}

function splitEdges(raw: string): { lead: string; core: string; trail: string } {
  const lead = raw.match(/^\s*/)?.[0] ?? '';
  const trail = raw.match(/\s*$/)?.[0] ?? '';
  const core = raw.slice(lead.length, raw.length - trail.length);
  return { lead, core, trail };
}

function mountPanel(host: HTMLDivElement): ShadowRoot {
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .box { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
        display: flex; align-items: center; gap: 10px; padding: 8px 12px;
        background: rgba(17,19,23,.95); color: #e6eaf0; border: 1px solid #333a45;
        border-radius: 10px; font: 12px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
        box-shadow: 0 6px 24px rgba(0,0,0,.45); }
      button { all: unset; cursor: pointer; padding: 3px 9px; border-radius: 6px;
        background: #2a2f38; color: #cfd6e2; }
      button:hover { background: #353c48; }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #31d68f; }
      .dot.busy { background: #f5b942; }
      .dot.err { background: #f87171; }
    </style>
    <div class="box">
      <span class="dot busy" id="dot"></span>
      <span id="msg">准备翻译…</span>
      <button id="restore">恢复原文</button>
      <button id="close">×</button>
    </div>`;
  return shadow;
}

async function runPageTranslate(): Promise<void> {
  const host = document.createElement('div');
  host.className = '__ytsub-pt__';
  host.style.cssText = 'all:initial';
  const shadow = mountPanel(host);
  document.documentElement.appendChild(host);

  const msg = shadow.getElementById('msg') as HTMLElement;
  const dot = shadow.getElementById('dot') as HTMLElement;

  const originals = new Map<Text, string>();
  let closed = false;

  const restore = () => {
    console.log('[ytsub/pt] restore() called, originals =', originals.size);
    for (const [node, text] of originals) {
      if (node.isConnected) node.nodeValue = text;
    }
    originals.clear();
    host.remove();
    window.__ytsubPageTranslate = undefined;
  };

  (shadow.getElementById('restore') as HTMLElement).addEventListener('click', restore);
  (shadow.getElementById('close') as HTMLElement).addEventListener('click', () => {
    closed = true;
    host.remove();
  });

  window.__ytsubPageTranslate = { originals, panel: host, restore };

  try {
    const settings = await loadSettings();
    if (!settings.enabled) {
      msg.textContent = '翻译已在扩展里关闭';
      dot.className = 'dot err';
      return;
    }

    const { root, scoped } = pickRoot();
    const allNodes = collectTextNodes(root, scoped);
    // 封顶：整页几千条会让免费接口直接限流，按文档顺序取前 MAX_NODES 条
    const MAX_NODES = 400;
    const nodes = allNodes.slice(0, MAX_NODES);
    console.log('[ytsub/pt] collected nodes =', allNodes.length, '→ 处理', nodes.length, 'scoped =', scoped);
    if (!nodes.length) {
      msg.textContent = '没有找到可翻译的文字';
      dot.className = 'dot err';
      return;
    }
    if (allNodes.length > MAX_NODES) {
      msg.textContent = `内容较多，先翻前 ${MAX_NODES} 段…`;
    }

    // 去重：同样的句子只翻一次
    const uniq = new Map<string, string>(); // core → translated
    const queue: string[] = [];
    for (const node of nodes) {
      const { core } = splitEdges(node.nodeValue ?? '');
      if (core && !uniq.has(core) && !queue.includes(core)) queue.push(core);
    }

    msg.textContent = `翻译中 0/${queue.length}`;
    let done = 0;

    const applyOne = (core: string, translated: string) => {
      for (const node of nodes) {
        const { core: c, lead, trail } = splitEdges(node.nodeValue ?? '');
        if (c !== core || !translated) continue;
        if (!originals.has(node)) originals.set(node, node.nodeValue ?? '');
        node.nodeValue = `${lead}${translated}${trail}`;
      }
    };

    // Google 免费接口对整页翻译很脆弱：小批次 + 单并发 + 间隔，否则大量 429
    const gentle = settings.provider === 'google';
    const BATCH = gentle ? 6 : 12;
    const CONCURRENCY = gentle ? 1 : 2;
    const GAP_MS = gentle ? 250 : 0;
    const MAX_FAILS = 4; // 连续失败这么多次就认为被限流，直接收手
    let cursor = 0;
    let fails = 0;
    let aborted = false;

    const worker = async () => {
      while (!closed && !aborted) {
        const start = cursor;
        cursor += BATCH;
        const batch = queue.slice(start, start + BATCH);
        if (!batch.length) return;
        try {
          const res = (await browser.runtime.sendMessage({
            type: 'ytsub:translate',
            lines: batch,
            settings,
          })) as { ok: boolean; data?: string[]; error?: string } | undefined;

          if (res?.ok && Array.isArray(res.data)) {
            const usable = res.data.filter((t) => t && t.trim()).length;
            if (usable === 0) {
              // 全部为空：等同这批失败（多半是限流），否则会"看起来在跑但没结果"
              fails += 1;
              msg.textContent = `这批没拿到译文（${fails}/${MAX_FAILS}），可能是接口限流…`;
              dot.className = 'dot busy';
              if (fails >= MAX_FAILS) {
                aborted = true;
                msg.textContent = `连续 ${fails} 批拿不到译文（免费接口限流）。建议在设置页切到 LLM 引擎后重试`;
                dot.className = 'dot err';
              }
            } else {
              fails = 0;
              res.data.forEach((t, i) => {
                const core = batch[i];
                if (!t || !t.trim()) return;
                uniq.set(core, t);
                applyOne(core, t);
              });
            }
          } else if (res?.error) {
            fails += 1;
            msg.textContent = `翻译出错（${fails}）：${res.error.slice(0, 50)}`;
            dot.className = 'dot err';
            if (fails >= MAX_FAILS) {
              aborted = true;
              msg.textContent = `连续失败 ${fails} 次（多为免费接口限流），已停止。可在设置页切到 LLM 引擎后重试`;
            }
          }
        } catch (err) {
          fails += 1;
          msg.textContent = `翻译出错（${fails}）：${err instanceof Error ? err.message.slice(0, 50) : ''}`;
          dot.className = 'dot err';
          if (fails >= MAX_FAILS) {
            aborted = true;
            msg.textContent = `连续失败 ${fails} 次，已停止。可切到 LLM 引擎后重试`;
          }
        }
        done = Math.min(queue.length, done + batch.length);
        if (!closed) msg.textContent = `翻译中 ${done}/${queue.length}`;
        if (GAP_MS) await new Promise((r) => setTimeout(r, GAP_MS));
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (!closed && !aborted) {
      console.log('[ytsub/pt] done, translated =', done);
      msg.textContent = `已翻译 ${done} 段`;
      dot.className = 'dot';
    }
  } catch (err) {
    dot.className = 'dot err';
    msg.textContent = `失败：${err instanceof Error ? err.message.slice(0, 60) : String(err)}`;
  }
}
