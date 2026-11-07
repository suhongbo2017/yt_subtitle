import { defineContentScript } from 'wxt/utils/define-content-script';
import { installTap } from '@/lib/page-tap';

/**
 * 页面主世界脚本，必须最早执行（document_start），
 * 赶在 YouTube 播放器发出字幕请求之前把 fetch/XHR 挂钩好。
 */
export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: false,
  globalName: false,
  main() {
    installTap();
  },
});
