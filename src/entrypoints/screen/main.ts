import { browser } from 'wxt/browser';
import './style.css';

// 扩展页面里 chrome.runtime.storage 可用，但这里只用 storage API

interface Block {
  bbox: [number, number, number, number];
  original: string;
  translation: string;
}

const el = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

function fitBlocks() {
  el<HTMLElement>('.layer')
    ?.querySelectorAll<HTMLElement>('.blk')
    .forEach((node) => {
      const box = node.getBoundingClientRect();
      if (!box.height) return;
      node.style.fontSize = '';
      let size = parseFloat(getComputedStyle(node).fontSize);
      let guard = 0;
      while ((node.scrollHeight > box.height + 1 || node.scrollWidth > box.width + 1) && size > 6 && guard++ < 60) {
        size -= 0.4;
        node.style.fontSize = `${size}px`;
      }
    });
}

async function main() {
  const store = (await browser.storage.session.get('screen')) as {
    screen?: { image: string; blocks: Block[] };
  };
  const data = store.screen;
  const stage = el<HTMLElement>('#stage');

  if (!data?.image) {
    el<HTMLElement>('#info')!.style.display = '';
    el<HTMLElement>('#info')!.textContent =
      '没有找到截图数据。请通过扩展弹窗里的「📝 截图翻译」重新截图（本页只保留最近一次的结果）。';
    el<HTMLElement>('#bar')!.style.display = 'none';
    return;
  }

  document.title = '截图翻译结果';
  stage.innerHTML = `
    <img src="${data.image}" alt="截图" />
    <div class="layer"></div>`;

  const layer = el<HTMLElement>('.layer');
  const base = (stage.clientWidth || 1000) * 0.017;

  data.blocks.forEach((b, i) => {
    const [l, t, r, bt] = b.bbox;
    const div = document.createElement('div');
    div.className = 'blk';
    div.style.left = `${l * 100}%`;
    div.style.top = `${t * 100}%`;
    div.style.width = `${(r - l) * 100}%`;
    div.style.height = `${(bt - t) * 100}%`;
    div.style.setProperty('--base', `${base.toFixed(1)}px`);
    const zh = document.createElement('span');
    zh.textContent = b.translation || b.original;
    div.appendChild(zh);
    if (b.original && b.original !== b.translation) {
      const en = document.createElement('span');
      en.className = 'en';
      en.textContent = b.original;
      div.appendChild(en);
    }
    // 一键复制
    const copy = document.createElement('button');
    copy.className = 'copy';
    copy.textContent = '复制';
    copy.onclick = (e) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(`${b.translation}\n${b.original}`).then(() => {
        copy.textContent = '已复制';
        setTimeout(() => (copy.textContent = '复制'), 1200);
      });
    };
    div.appendChild(copy);
    div.dataset.i = String(i);
    layer.appendChild(div);
  });

  // 绑定控件
  document.getElementById('onlyZh')?.addEventListener('change', (e) => {
    document.body.classList.toggle('only-zh', (e.target as HTMLInputElement).checked);
  });
  document.getElementById('scale')?.addEventListener('input', (e) => {
    document.documentElement.style.setProperty('--scale', (e.target as HTMLInputElement).value);
    fitBlocks();
  });
  document.getElementById('print')?.addEventListener('click', () => window.print());

  requestAnimationFrame(fitBlocks);
  window.addEventListener('resize', fitBlocks);

  // 把原文/译文也导出成纯文本，方便整体复制
  const text = data.blocks.map((b) => `${b.translation}\n${b.original}`).join('\n\n');
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'c' && !window.getSelection()?.toString()) {
      void navigator.clipboard.writeText(text);
    }
  });
}

void main();
