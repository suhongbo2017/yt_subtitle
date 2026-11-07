/**
 * 字幕叠加层：挂在 #movie_player 内部 + Shadow DOM，
 * 这样全屏、剧场模式、播放器控制条显隐都不用额外处理，
 * 同时彻底隔离 YouTube 自己的全局样式。
 */

export interface OverlayStyle {
  showOriginal: boolean;
  fontScale: number;
  bottomOffset: number;
}

const STYLE = `
:host { all: initial; }
.ytsub-wrap {
  position: absolute;
  left: 0; right: 0;
  bottom: var(--ytsub-bottom, 10%);
  display: flex; flex-direction: column; align-items: center;
  gap: 0.25em;
  padding: 0 6%;
  text-align: center;
  pointer-events: none;
  font-family: Roboto, "YouTube Sans", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  transition: opacity .12s ease;
  opacity: 0;
}
.ytsub-wrap[data-visible="1"] { opacity: 1; }
.ytsub-line {
  max-width: 100%;
  padding: 0.08em 0.45em;
  border-radius: 4px;
  background: rgba(8, 8, 8, 0.72);
  line-height: 1.35;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
  white-space: pre-wrap;
  word-break: break-word;
}
.ytsub-orig {
  font-size: calc(16px * var(--ytsub-scale, 1));
  color: #e6e6e6;
  font-weight: 400;
}
.ytsub-tr {
  font-size: calc(23px * var(--ytsub-scale, 1));
  color: #fff;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.ytsub-err {
  font-size: calc(13px * var(--ytsub-scale, 1));
  color: #ffb4b4;
  background: rgba(60, 0, 0, 0.8);
}
`;

export class SubtitleOverlay {
  private host: HTMLDivElement | null = null;
  private wrap: HTMLDivElement | null = null;
  private origEl: HTMLDivElement | null = null;
  private trEl: HTMLDivElement | null = null;
  private errEl: HTMLDivElement | null = null;
  private style: OverlayStyle = { showOriginal: true, fontScale: 1, bottomOffset: 10 };
  private lastOrig = '';
  private lastTr = '';

  mount(): boolean {
    const player = document.getElementById('movie_player');
    if (!player) return false;

    if (!this.host) {
      const host = document.createElement('div');
      host.id = 'ytsub-host';
      host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:60;';
      const shadow = host.attachShadow({ mode: 'open' });
      const styleEl = document.createElement('style');
      styleEl.textContent = STYLE;

      const wrap = document.createElement('div');
      wrap.className = 'ytsub-wrap';
      wrap.dataset.visible = '0';

      const orig = document.createElement('div');
      orig.className = 'ytsub-line ytsub-orig';
      const tr = document.createElement('div');
      tr.className = 'ytsub-line ytsub-tr';
      const err = document.createElement('div');
      err.className = 'ytsub-line ytsub-err';

      wrap.append(orig, tr, err);
      shadow.append(styleEl, wrap);

      this.host = host;
      this.wrap = wrap;
      this.origEl = orig;
      this.trEl = tr;
      this.errEl = err;
      this.applyStyle();
    }

    if (this.host!.parentElement !== player) {
      if (getComputedStyle(player).position === 'static') player.style.position = 'relative';
      player.appendChild(this.host!);
    }
    return true;
  }

  setStyle(style: Partial<OverlayStyle>) {
    this.style = { ...this.style, ...style };
    this.applyStyle();
  }

  private applyStyle() {
    if (!this.wrap) return;
    this.wrap.style.setProperty('--ytsub-bottom', `${this.style.bottomOffset}%`);
    this.wrap.style.setProperty('--ytsub-scale', String(this.style.fontScale));
    this.origEl!.style.display = this.style.showOriginal ? '' : 'none';
  }

  show(original: string, translation: string) {
    if (!this.wrap) return;
    const orig = original.trim();
    const tr = translation.trim();

    if (this.lastOrig !== orig) {
      this.origEl!.textContent = orig;
      this.lastOrig = orig;
    }
    if (this.lastTr !== tr) {
      this.trEl!.textContent = tr;
      this.lastTr = tr;
    }
    this.origEl!.style.display = this.style.showOriginal && orig ? '' : 'none';
    this.trEl!.style.display = tr ? '' : 'none';
    this.wrap.dataset.visible = orig || tr ? '1' : '0';
  }

  hide() {
    if (!this.wrap) return;
    this.wrap.dataset.visible = '0';
  }

  error(message: string | null) {
    if (!this.errEl) return;
    this.errEl.textContent = message ?? '';
    this.errEl.style.display = message ? '' : 'none';
  }

  get mounted() {
    return !!this.host;
  }

  /** 当前显示内容，供自检面板读取 */
  get text() {
    return { orig: this.lastOrig, tr: this.lastTr };
  }
}
