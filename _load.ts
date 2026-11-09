import { translateLines } from './src/lib/translate.ts';

// 模拟一个 10 分钟视频：约 200 条字幕，按 pump 的节奏（12 条/批）连续请求
const lines: string[] = [];
for (let i = 0; i < 200; i++) lines.push(`This is subtitle line number ${i} for the load test.`);

const cfg = {
  enabled: true, provider: 'google' as const, targetLang: 'zh-CN',
  showOriginal: true, hideNativeCaptions: true, fontScale: 1, bottomOffset: 10,
  apiBase: '', apiModel: '', apiKey: '', prefetchSeconds: 90,
  asrEnabled: false, asrUrl: '', asrChunkSec: 3,
};

let ok = 0, empty = 0, failed = 0;
const t0 = Date.now();
for (let i = 0; i < lines.length; i += 12) {
  const batch = lines.slice(i, i + 12);
  try {
    const out = await translateLines(batch, cfg as never);
    out.forEach((t) => (t && t.trim() ? ok++ : empty++));
  } catch (e) {
    failed += batch.length;
    console.log(`  批 ${i / 12} 失败: ${(e as Error).message.slice(0, 90)}`);
  }
}
console.log(`\n200 条：成功 ${ok} / 空 ${empty} / 失败 ${failed}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
