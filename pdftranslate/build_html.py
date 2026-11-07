"""输出「覆盖式」HTML：原页做底图，译文按原坐标贴回去，视觉上接近原 PDF。"""

from __future__ import annotations

import html
import io
import json
from pathlib import Path

from PIL import Image

from .vision import Block, PageResult

PAGE_CSS = """
:root { --blk-bg: rgba(255,255,255,.90); --blk-fg: #111; --scale: 1; --bg-opacity: .4; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 16px 64px;
  background: #2b2b2e; color: #e8e8e8;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}
toolbar, .toolbar {
  position: sticky; top: 0; z-index: 100;
  display: flex; flex-wrap: wrap; gap: 14px; align-items: center;
  padding: 10px 14px; margin: -24px -16px 20px;
  background: rgba(20,20,22,.94); border-bottom: 1px solid #3a3a3f;
  font-size: 13px; backdrop-filter: blur(6px);
}
.toolbar label { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
.toolbar input[type=range] { width: 120px; }
.toolbar .title { font-weight: 600; margin-right: auto; }
.page {
  position: relative; margin: 0 auto 26px; background: #fff;
  box-shadow: 0 6px 24px rgba(0,0,0,.45); overflow: hidden;
  width: min(1000px, 96vw);
}
.page > img.bg { display: block; width: 100%; height: auto; opacity: var(--bg-opacity); transition: opacity .15s; }
.layer { position: absolute; inset: 0; }
.blk {
  position: absolute; overflow: hidden;
  background: var(--blk-bg); color: var(--blk-fg);
  border-radius: 3px; padding: 0 3px;
  line-height: 1.24; font-size: calc(var(--base) * var(--scale));
  white-space: pre-wrap; word-break: break-word;
  transition: background .15s;
}
.blk:hover { background: #fff8dc; outline: 1px solid #d9a300; }
.blk[data-kind="redaction"] { background: rgba(120,120,120,.85); color: #fff; }
.blk[data-kind="annotation"], .blk[data-kind="stamp"] { background: rgba(255,245,200,.92); font-style: italic; }
.blk[data-kind="signature"] { background: rgba(235,245,255,.92); }
.blk.tbl { padding: 0; background: transparent; }
.blk.tbl table {
  width: 100%; height: auto; border-collapse: collapse; table-layout: fixed;
  font-size: calc(var(--base) * var(--scale) * .78); background: rgba(255,255,255,.94);
}
.blk.tbl th, .blk.tbl td {
  border: 1px solid #bbb; padding: 1px 4px; text-align: left; vertical-align: top;
  line-height: 1.25; word-break: break-word;
}
.blk.tbl th { background: #eee; font-weight: 600; }
.tbl-flow { max-width: 100%; margin: 10px 0; border-collapse: collapse; background: #fff; color: #111; font-size: 12px; width: 100%; }
.tbl-flow th, .tbl-flow td { border: 1px solid #ccc; padding: 3px 6px; text-align: left; vertical-align: top; }
.tbl-flow th { background: #eee; }
.flow-page { background: #fff; }
.flow { padding: 18px 26px 26px; color: #111; }
.flow-note {
  font-size: 12px; color: #a05a00; background: #fff7e6; border: 1px solid #ffd591;
  border-radius: 6px; padding: 6px 10px; margin-bottom: 14px;
}
.flow-item { margin-bottom: 14px; }
.flow-item .zh { font-size: 15px; line-height: 1.6; color: #111; white-space: pre-wrap; }
.flow-item .en { font-size: 11.5px; line-height: 1.5; color: #8a8a8a; margin-top: 3px; white-space: pre-wrap; }
body.hide-bg .flow-page > img.bg { display: none; }
.orphans { max-width: 1000px; margin: 0 auto; }
.orphans h3 { font-size: 13px; color: #9a9a9a; font-weight: 500; margin: 18px 0 8px; }
.orphans .row { background: #fff; color: #111; padding: 8px 12px; border-radius: 4px; margin-bottom: 8px; }
.orphans .row .o { display: block; font-size: 11px; color: #777; margin-top: 4px; }
body.hide-bg .page > img.bg { visibility: hidden; }
body.hide-bg .page { background: #fff; }
body.hide-bg .page { background: #fff; }
body.only-orig .blk { display: none; }
@media print {
  body { background: #fff; padding: 0; }
  .toolbar, .orphans { display: none; }
  .page { box-shadow: none; margin: 0; width: 100%; page-break-after: always; }
}
"""

PAGE_JS = """
// 逐块自适应字号：内容超出框就缩小，保证不溢出、不遮挡相邻块
function fit() {
  document.querySelectorAll('.blk').forEach((el) => {
    const boxH = el.clientHeight;
    const boxW = el.clientWidth;
    if (!boxH || !boxW) return;
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize);
    let guard = 0;
    while ((el.scrollHeight > boxH + 1 || el.scrollWidth > boxW + 1) && size > 4 && guard++ < 160) {
      size -= 0.3;
      el.style.fontSize = size + 'px';
    }
  });
}
const scaleEl = document.getElementById('scale');
scaleEl?.addEventListener('input', () => {
  document.documentElement.style.setProperty('--scale', scaleEl.value);
  requestAnimationFrame(fit);
});
document.getElementById('toggleBg')?.addEventListener('change', (e) => {
  document.body.classList.toggle('hide-bg', !e.target.checked);
});
const op = document.getElementById('bgOpacity');
op?.addEventListener('input', () => {
  document.documentElement.style.setProperty('--bg-opacity', op.value / 100);
});
document.getElementById('onlyOrig')?.addEventListener('change', (e) => {
  document.body.classList.toggle('only-orig', e.target.checked);
});
document.addEventListener('DOMContentLoaded', fit);
window.addEventListener('load', fit);
window.addEventListener('beforeprint', fit);
"""


def _page_image(png: bytes, max_width: int = 1400, quality: int = 82) -> bytes:
    img = Image.open(io.BytesIO(png))
    if img.width > max_width:
        h = int(img.height * max_width / img.width)
        img = img.resize((max_width, h), Image.LANCZOS)
    if img.mode not in ('RGB', 'L'):
        img = img.convert('RGB')
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=quality, optimize=True)
    return buf.getvalue()


def _col_widths(rows: list[list[str]]) -> list[float]:
    """按内容长度估算列宽比例，避免窄列把长内容挤成竖排。"""
    cols = len(rows[0])
    weights = []
    for c in range(cols):
        lengths = [len(str(r[c] or '')) for r in rows]
        longest = max(lengths)
        avg = sum(lengths) / len(lengths)
        weights.append(max(4.0, min(longest * 0.6 + avg * 0.4, 46.0)))
    total = sum(weights) or 1.0
    return [w / total for w in weights]


def _table_markup(block: Block, cls: str, style: str = '') -> str:
    rows = block.rows or []
    if not rows:
        return ''
    head = ''
    body = rows
    if block.header:
        head = '<thead><tr>' + ''.join(f'<th>{html.escape(c)}</th>' for c in rows[0]) + '</tr></thead>'
        body = rows[1:]
    tbody = ''.join(
        '<tr>' + ''.join(f'<td>{html.escape(c)}</td>' for c in row) + '</tr>' for row in body
    )
    colgroup = (
        '<colgroup>'
        + ''.join(f'<col style="width:{w * 100:.2f}%">' for w in _col_widths(rows))
        + '</colgroup>'
    )
    return f'<table class="{cls}" style="{style}">{colgroup}{head}<tbody>{tbody}</tbody></table>'


def _iou(a: list[float], b: list[float]) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    inter = (x1 - x0) * (y1 - y0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def bbox_quality(blocks: list[Block]) -> tuple[float, str]:
    """粗略判断这一页的坐标可不可信：过扁、互相重叠、总面积离谱都算坏。"""
    boxes = [b.bbox for b in blocks if b.bbox]
    if not boxes:
        return 0.0, '无坐标'
    n = len(boxes)
    thin = sum(1 for bb in boxes if (bb[3] - bb[1]) < 0.008)
    overlaps = sum(
        1 for i in range(n) for j in range(i + 1, n) if _iou(boxes[i], boxes[j]) > 0.35
    )
    area = sum((bb[2] - bb[0]) * (bb[3] - bb[1]) for bb in boxes)
    score = 1.0
    score -= min(0.6, thin / n * 1.2)
    score -= min(0.6, overlaps / n * 0.8)
    if area > 1.8:
        score -= 0.35
    if area < 0.04:
        score -= 0.3
    return max(0.0, score), f'扁={thin} 重叠={overlaps} 面积={area:.2f}'


def _block_html(block: Block, base_px: float) -> str:
    if block.kind == 'table' and block.rows:
        if not block.bbox:
            return ''
        left, top, right, bottom = block.bbox
        style = (
            f'left:{left * 100:.3f}%;top:{top * 100:.3f}%;'
            f'width:{(right - left) * 100:.3f}%;height:{(bottom - top) * 100:.3f}%;'
            f'--base:{base_px:.2f}px;'
        )
        return (
            f'<div class="blk tbl" data-kind="table" style="{style}">'
            + _table_markup(block, 'inside')
            + '</div>'
        )

    if not block.bbox or not block.translation.strip():
        return ''

    left, top, right, bottom = block.bbox
    style = (
        f'left:{left * 100:.3f}%;top:{top * 100:.3f}%;'
        f'width:{(right - left) * 100:.3f}%;height:{(bottom - top) * 100:.3f}%;'
        f'--base:{base_px:.2f}px;'
    )
    text = html.escape(block.translation)
    return (
        f'<div class="blk" data-kind="{html.escape(block.kind)}" '
        f'style="{style}" title="{html.escape(block.original[:300])}">{text}</div>'
    )


def build_html(
    page_images: list[tuple[int, bytes]],
    results: list[PageResult],
    source: str,
    out_dir: Path,
    title: str | None = None,
) -> Path:
    """page_images: [(页码, 整页PNG)]；写出 out_dir/index.html + assets/"""
    out_dir.mkdir(parents=True, exist_ok=True)
    assets = out_dir / 'assets'
    assets.mkdir(exist_ok=True)

    by_page = {r.page: r for r in results}
    flow_pages: list[int] = []
    sections: list[str] = []
    orphans: list[str] = []

    for index, png in page_images:
        name = f'page-{index:03d}.jpg'
        (assets / name).write_bytes(_page_image(png))
        result = by_page.get(index)
        blocks = result.blocks if result else []
        # 以页面显示宽度 ~1000px 估算基础字号：11pt/595pt ≈ 1.85% 页宽
        base_px = 1000 * 0.0185
        blk_html = '\n'.join(_block_html(b, base_px) for b in blocks)

        quality, detail = bbox_quality(blocks) if blocks else (0.0, '无块')
        use_flow = bool(blocks) and quality < 0.55
        if use_flow:
            flow_pages.append(index)
            rows = []
            for b in blocks:
                if b.kind == 'table' and b.rows:
                    rows.append(f'<div class="flow-item">{_table_markup(b, "tbl-flow")}</div>')
                    continue
                zh = html.escape(b.translation or '')
                en = html.escape((b.original or '')[:600])
                if not zh and not en:
                    continue
                rows.append(f'<div class="flow-item"><div class="zh">{zh}</div><div class="en">{en}</div></div>')
            sections.append(
                f'<section class="page flow-page" data-page="{index}">'
                f'<img class="bg" src="assets/{name}" alt="第 {index} 页">'
                f'<div class="flow"><div class="flow-note">本页坐标不可靠（{detail}），已改为顺排</div>{"".join(rows)}</div>'
                f'</section>'
            )
            continue

        no_box = [b for b in blocks if not b.bbox and (b.translation.strip() or b.rows)]
        if no_box:
            rows = ''
            for b in no_box:
                if b.kind == 'table' and b.rows:
                    rows += f'<div class="row">{_table_markup(b, "tbl-flow")}</div>'
                else:
                    rows += (
                        f'<div class="row">{html.escape(b.translation)}'
                        f'<span class="o">{html.escape(b.original[:400])}</span></div>'
                    )
            orphans.append(f'<div class="orphans"><h3>第 {index} 页 · 未定位内容</h3>{rows}</div>')

        note = ''
        if result and result.uncertain:
            note = ' · 存疑 ' + str(len(result.uncertain))
        sections.append(
            f'<section class="page" data-page="{index}">'
            f'<img class="bg" src="assets/{name}" alt="第 {index} 页">'
            f'<div class="layer">{blk_html}</div></section>'
            f'<!-- page {index} · {len(blocks)} 块{note} -->'
        )

    total_blocks = sum(len(r.blocks) for r in results)
    flow_note = f'，{len(flow_pages)} 页改顺排' if flow_pages else ''
    placed = sum(
        1 for r in results for b in r.blocks if b.bbox and (b.translation.strip() or b.rows)
    )
    tables = sum(1 for r in results for b in r.blocks if b.kind == 'table' and b.rows)

    doc = f"""<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title or source)} · 双语覆盖版</title>
<style>{PAGE_CSS}</style>
</head><body>
<div class="toolbar">
  <span class="title">{html.escape(source)}</span>
  <label><input type="checkbox" id="toggleBg" checked> 显示原文底图</label>
  <label>底图浓度 <input type="range" id="bgOpacity" min="0" max="100" step="5" value="40"></label>
  <label><input type="checkbox" id="onlyOrig"> 只看原文</label>
  <label>字号 <input type="range" id="scale" min="0.6" max="2" step="0.05" value="1"></label>
  <span style="color:#888">{total_blocks} 块，{placed} 块已定位，{tables} 个表格{flow_note}</span>
</div>
{''.join(sections)}
{''.join(orphans)}
<script>{PAGE_JS}</script>
</body></html>
"""
    index = out_dir / 'index.html'
    index.write_text(doc, encoding='utf-8')
    return index


def write_page_map(out_dir: Path, results: list[PageResult]) -> None:
    """给调试用：把每页结构化结果落盘，方便排查坐标问题。"""
    data = [r.to_dict() for r in results]
    (out_dir / 'blocks.json').write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
