"""输出：双语 Markdown 与双语对照 PDF。"""

from __future__ import annotations

import io
from pathlib import Path

import pymupdf
from PIL import Image

from .render import Page
from .vision import PageResult

FONT_CANDIDATES = [
    Path('C:/Windows/Fonts/Deng.ttf'),
    Path('C:/Windows/Fonts/HarmonyOS_Sans_SC_Regular.ttf'),
    Path('C:/Windows/Fonts/simhei.ttf'),
]

KIND_LABEL = {
    'header': '页眉',
    'date': '日期',
    'addressee': '抬头',
    'subject': '事由',
    'paragraph': '正文',
    'signature': '署名',
    'annotation': '批注',
    'stamp': '印章',
    'redaction': '涂黑',
    'table': '表格',
    'other': '其他',
}

MARGIN = 46
PAGE_W, PAGE_H = 595, 842  # A4 pt


def _to_jpeg(png: bytes, quality: int = 82) -> bytes:
    img = Image.open(io.BytesIO(png))
    if img.mode not in ('RGB', 'L'):
        img = img.convert('RGB')
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=quality, optimize=True)
    return buf.getvalue()


def _font_file() -> Path | None:
    for candidate in FONT_CANDIDATES:
        if candidate.exists():
            return candidate
    return None


def _is_latin(text: str) -> bool:
    return all(c.isascii() and (c.isalnum() or c in "-'.&/") for c in text)


def _wrap(text: str, font: pymupdf.Font, size: float, max_width: float) -> list[str]:
    """按字符宽度断行，中英混排都能处理（不在拉丁单词中间断开）。"""
    # 模型常把表格行用 \t 分隔；制表符的 text_length 只算 1 个字符，
    # 实际排版却会撑开，所以统一换成空格，否则会“看着不超宽却溢出页面”。
    text = text.replace('\r', '').replace('\t', '  ')
    lines: list[str] = []
    for raw in text.split('\n'):
        raw = raw.rstrip()
        if not raw:
            lines.append('')
            continue
        current = ''
        for ch in raw:
            trial = current + ch
            if font.text_length(trial, size) <= max_width:
                current = trial
                continue
            # 超宽：拉丁单词尽量整词换行
            if ch.isalnum() and current and current[-1].isalnum():
                cut = max(current.rfind(' '), current.rfind('　'))
                tail = current[cut + 1 :] if cut > 0 else ''
                if tail and len(tail) <= 24 and _is_latin(tail):
                    lines.append(current[:cut])
                    current = tail + ch
                    continue
                # 词前是 CJK 字符或标点时，在词首断行（避免 "（Je|mez"）
                start = len(current)
                while start > 0 and current[start - 1].isascii() and current[start - 1].isalnum():
                    start -= 1
                word = current[start:]
                if start > 0 and word and len(word) <= 24 and _is_latin(word):
                    lines.append(current[:start])
                    current = word + ch
                    continue
            lines.append(current)
            current = ch
        lines.append(current)

    # 兜底：任何一行都不允许超过可用宽度
    safe: list[str] = []
    for line in lines:
        while line and font.text_length(line, size) > max_width:
            line = line[:-1]
        safe.append(line)
    return safe


class PdfWriter:
    def __init__(self, path: Path, title: str) -> None:
        self.doc = pymupdf.open()
        self.doc.set_metadata({'title': title, 'author': 'pdftranslate'})
        self.font_file = _font_file()
        self.title = title

    def _new_page(self) -> pymupdf.Page:
        return self.doc.new_page(width=PAGE_W, height=PAGE_H)

    def _register_font(self, page: pymupdf.Page) -> str:
        if self.font_file:
            page.insert_font(fontname='CJK', fontfile=str(self.font_file))
            return 'CJK'
        return 'china-s'  # PyMuPDF 内置简体中文字体

    def add_original_from(self, src_doc: pymupdf.Document, page_no: int, label: str) -> None:
        """直接拷贝原页（无损、体积小），只在右上角加一行小字标注。"""
        self.doc.insert_pdf(src_doc, from_page=page_no - 1, to_page=page_no - 1)
        out = self.doc[-1]
        fontname = self._register_font(out)
        rect = out.rect
        out.insert_text(
            (rect.width - 150, 22),
            label,
            fontname=fontname,
            fontsize=8,
            color=(0.6, 0.6, 0.6),
        )

    def add_original(self, page: Page, label: str) -> None:
        out = self._new_page()
        font = self._register_font(out)
        out.insert_text((MARGIN, MARGIN - 16), label, fontname=font, fontsize=9, color=(0.45, 0.45, 0.45))
        box = pymupdf.Rect(MARGIN, MARGIN, PAGE_W - MARGIN, PAGE_H - MARGIN)
        scale = min(box.width / page.width, box.height / page.height)
        w, h = page.width * scale, page.height * scale
        rect = pymupdf.Rect(box.x0, box.y0, box.x0 + w, box.y0 + h)
        out.insert_image(rect, stream=_to_jpeg(page.png), keep_proportion=True)

    def _draw_table(
        self,
        page: pymupdf.Page,
        y: float,
        rows: list[list[str]],
        header: bool,
        font: pymupdf.Font,
        fontname: str,
        max_w: float,
    ) -> tuple[pymupdf.Page, float]:
        """把表格画成带边框的真表格；跨页自动续，续页重复表头。"""
        size = 8.5
        lh = size * 1.35
        pad = 3.0
        cols = len(rows[0])

        # 列宽按内容长度加权（限制极值，避免某列被挤没）
        weights = []
        for c in range(cols):
            longest = max(len(str(r[c] or '')) for r in rows)
            weights.append(max(5.0, min(float(longest), 42.0)))
        total = sum(weights)
        widths = [max_w * w / total for w in weights]

        body = list(rows)
        while body:
            row = body.pop(0)
            cells = [
                _wrap(str(row[ci] or ''), font, size, max(10.0, widths[ci] - pad * 2))
                for ci in range(cols)
            ]
            row_h = max(1, max(len(c) for c in cells)) * lh + pad * 2 if any(cells) else lh + pad * 2

            if y + row_h > PAGE_H - MARGIN - 6:
                page = self._new_page()
                fontname = self._register_font(page)
                y = MARGIN
                if header and len(body) < len(rows):
                    body.insert(0, rows[0])  # 续页重复表头
                    header = False
                    continue

            x = MARGIN
            for ci, lines in enumerate(cells):
                rect = pymupdf.Rect(x, y, x + widths[ci], y + row_h)
                if header and not body:
                    page.draw_rect(rect, color=None, fill=(0.93, 0.93, 0.93))
                page.draw_rect(rect, color=(0.72, 0.72, 0.72), width=0.4)
                for li, line in enumerate(lines):
                    if not line:
                        continue
                    page.insert_text(
                        (x + pad, y + pad + size + li * lh),
                        line,
                        fontname=fontname,
                        fontsize=size,
                        color=(0.05, 0.05, 0.05),
                    )
                x += widths[ci]
            y += row_h
        return page, y + 6

    def add_translation(
        self, result: PageResult, page_no: int, show_original: bool = True
    ) -> None:
        page = self._new_page()
        fontname = self._register_font(page)
        font = pymupdf.Font(fontfile=str(self.font_file)) if self.font_file else pymupdf.Font('china-s')

        y = MARGIN
        max_w = PAGE_W - MARGIN * 2
        page.insert_text(
            (MARGIN, y - 16),
            f'第 {page_no} 页 · 译文',
            fontname=fontname,
            fontsize=9,
            color=(0.45, 0.45, 0.45),
        )
        y += 6

        for block in result.blocks:
            if block.kind == 'table' and block.rows:
                page, y = self._draw_table(page, y, block.rows, block.header, font, fontname, max_w)
                continue
            label = KIND_LABEL.get(block.kind, '其他')
            size = 10.5 if block.kind == 'paragraph' else 9.5
            if block.kind in ('annotation', 'redaction', 'stamp'):
                size = 9.0

            # 译文
            for line in _wrap(block.translation, font, size, max_w):
                if y > PAGE_H - MARGIN - 12:
                    page = self._new_page()
                    fontname = self._register_font(page)
                    y = MARGIN
                if line:
                    page.insert_text(
                        (MARGIN, y + size), line, fontname=fontname, fontsize=size, color=(0.05, 0.05, 0.05)
                    )
                y += size * 1.34

            # 原文（浅灰小字）
            if show_original and block.original and block.original != block.translation:
                for line in _wrap(block.original, font, 8.0, max_w):
                    if y > PAGE_H - MARGIN - 10:
                        page = self._new_page()
                        fontname = self._register_font(page)
                        y = MARGIN
                    if line:
                        page.insert_text(
                            (MARGIN, y + 8.0), line, fontname=fontname, fontsize=8.0, color=(0.55, 0.55, 0.55)
                        )
                    y += 8.0 * 1.3
            y += 3
            if block.kind in ('date', 'addressee', 'signature', 'subject'):
                y += 5

        if result.uncertain:
            if y > PAGE_H - MARGIN - 40:
                page = self._new_page()
                fontname = self._register_font(page)
                y = MARGIN
            for line in _wrap('存疑：' + '；'.join(result.uncertain), font, 8, max_w):
                page.insert_text((MARGIN, y + 8), line, fontname=fontname, fontsize=8, color=(0.7, 0.35, 0.2))
                y += 11

    def save(self, path: Path) -> None:
        try:
            # 只嵌入实际用到的字形，否则中文字体会把文件撑到 10MB+
            self.doc.subset_fonts()
        except Exception:  # noqa: BLE001 - 个别文档不支持子集化时直接保存
            pass
        self.doc.save(str(path), deflate=True, garbage=4)
        self.doc.close()


def _md_table(rows: list[list[str]], header: bool) -> list[str]:
    if not rows:
        return []
    def cell(c: str) -> str:
        return (c or '').replace('|', '\\|').replace('\n', ' ')
    width = len(rows[0])
    out = ['| ' + ' | '.join(cell(rows[0][i]) for i in range(width)) + ' |',
           '|' + '|'.join([' --- '] * width) + '|']
    start = 1 if header else 0
    if not header:
        # 没有表头时把第一行也当数据，表头留空
        out = ['| ' + ' | '.join([''] * width) + ' |', '|' + '|'.join([' --- '] * width) + '|']
        start = 0
    for row in rows[start:]:
        out.append('| ' + ' | '.join(cell(row[i]) for i in range(width)) + ' |')
    return out


def write_markdown(results: list[PageResult], source: str, out_path: Path) -> None:
    lines = [f'# {source} 译文', '']
    for result in results:
        lines.append(f'## 第 {result.page} 页')
        lines.append('')
        if result.error:
            lines.append(f'> ⚠️ 本页失败：{result.error}')
            lines.append('')
        for block in result.blocks:
            label = KIND_LABEL.get(block.kind, '其他')
            if block.kind == 'table' and block.rows:
                lines.append(f'**{label}**')
                lines.append('')
                lines.extend(_md_table(block.rows, block.header))
                lines.append('')
                continue
            lines.append(f'**{label}**')
            lines.append('')
            lines.append(block.translation or '_(空)_')
            lines.append('')
            if block.original and block.original != block.translation:
                lines.append(f'> {block.original}'.replace('\n', '\n> '))
                lines.append('')
        if result.uncertain:
            lines.append(f'_存疑：{"；".join(result.uncertain)}_')
            lines.append('')
        if result.notes:
            lines.append(f'_校注：{result.notes}_')
            lines.append('')
    out_path.write_text('\n'.join(lines), encoding='utf-8')


def build_bilingual_pdf(
    page_indices: list[int],
    results: list[PageResult],
    source: str,
    out_path: Path,
    show_original: bool = True,
    source_pdf: Path | None = None,
    image_page: Page | None = None,
) -> None:
    """原页用 insert_pdf 无损拷贝（体积≈原文件），后面跟一页译文。"""
    writer = PdfWriter(out_path, f'{source} 双语对照')
    by_page = {r.page: r for r in results}
    src_doc = None
    if source_pdf is not None and source_pdf.suffix.lower() == '.pdf' and source_pdf.exists():
        src_doc = pymupdf.open(source_pdf)
    try:
        for index in page_indices:
            if src_doc is not None:
                writer.add_original_from(src_doc, index, f'原文 · 第 {index} 页')
            elif image_page is not None:
                writer.add_original(image_page, f'原文 · 第 {index} 页')
            result = by_page.get(index)
            if result and result.blocks:
                writer.add_translation(result, index, show_original=show_original)
        writer.save(out_path)
    finally:
        if src_doc is not None:
            src_doc.close()
