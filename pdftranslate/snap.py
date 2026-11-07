"""用 PDF 自带文本层校准模型给的坐标。

模型的 bbox 在密集文档上经常偏（近页面原点准、越远越偏），
但这批文档大多有文本层（扫描件也常带 OCR 层）。文本层里的行坐标是**精确的**。

做法：不整块匹配，而是**逐行归属** —— 每一行文本层去找它最可能属于哪个块
（标签在左、值在右这种表格式排版上，整块匹配会因为阅读顺序不同而错位，
按行归属天然不受影响），最后把同一块的行框合并成块框。
"""

from __future__ import annotations

import re
from pathlib import Path

import pymupdf

from .vision import Block

MIN_LINES = 6          # 文本层行数太少（纯图页）就不做校准
LINE_MATCH_SCORE = 0.62  # 单行归属到某块的最低分


def _norm(text: str) -> str:
    text = text.lower()
    text = re.sub(r'[^a-z0-9\u4e00-\u9fff]+', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def page_lines(path: Path, index: int) -> list[dict]:
    """取出某一页文本层的行（带归一化坐标）。index 从 1 开始。"""
    lines: list[dict] = []
    try:
        with pymupdf.open(path) as doc:
            page = doc[index - 1]
            width, height = page.rect.width, page.rect.height
            data = page.get_text('dict')
    except Exception:  # noqa: BLE001
        return []

    if not width or not height:
        return []

    for block in data.get('blocks', []):
        if block.get('type') != 0:
            continue
        for line in block.get('lines', []):
            text = ''.join(span.get('text', '') for span in line.get('spans', []))
            norm = _norm(text)
            if not norm:
                continue
            x0, y0, x1, y1 = line['bbox']
            lines.append(
                {'text': norm, 'bbox': [x0 / width, y0 / height, x1 / width, y1 / height]}
            )
    lines.sort(key=lambda l: (round(l['bbox'][1], 4), l['bbox'][0]))
    return lines


def _line_score(line: str, target: str, target_tokens: set[str]) -> float:
    """一行文字属于该块的可信度。"""
    if len(line) < 3:
        return 0.0
    if line in target:
        # 行完全包含在块文本里：越长的行越可信
        return min(1.0, 0.80 + min(len(line), 40) / 200)
    tokens = set(line.split())
    if not tokens:
        return 0.0
    overlap = len(tokens & target_tokens) / len(tokens)
    if overlap < 0.6:
        return 0.0
    # 词重叠 + 长度惩罚（避免短行到处乱配）
    return min(0.95, overlap * (0.75 + min(len(line), 30) / 120))


def _union(boxes: list[list[float]]) -> list[float]:
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def snap_blocks(blocks: list[Block], lines: list[dict]) -> tuple[int, int]:
    """把 blocks 的 bbox 换成文本层坐标，返回 (匹配数, 总块数)。

    匹配上的块 bbox_source='text'，没匹配上的保持 'model'。
    """
    if len(lines) < MIN_LINES or not blocks:
        return 0, len(blocks)

    for block in blocks:
        block.bbox_source = 'model'

    targets = [
        (i, _norm(b.original), set(_norm(b.original).split()))
        for i, b in enumerate(blocks)
        if len(_norm(b.original)) >= 4
    ]
    if not targets:
        return 0, len(blocks)

    assigned: list[list[list[float]]] = [[] for _ in blocks]
    for line in lines:
        text = line['text']
        best_i, best_s = -1, 0.0
        for i, norm, tokens in targets:
            score = _line_score(text, norm, tokens)
            if score > best_s:
                best_i, best_s = i, score
        if best_i >= 0 and best_s >= LINE_MATCH_SCORE:
            assigned[best_i].append(line['bbox'])

    matched = 0
    for i, block in enumerate(blocks):
        if not assigned[i]:
            continue
        block.bbox = _union(assigned[i])
        block.bbox_source = 'text'
        matched += 1
    return matched, len(blocks)
