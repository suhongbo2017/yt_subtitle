"""把 PDF / 图片渲染成适合视觉模型的位图（按页懒加载，避免一次渲染上百页）。"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from pathlib import Path

import pymupdf
from PIL import Image

IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'}


@dataclass
class Page:
    index: int
    png: bytes
    width: int
    height: int
    page_width_pt: float = 0.0
    page_height_pt: float = 0.0

    @property
    def data_uri(self) -> str:
        return 'data:image/png;base64,' + base64.b64encode(self.png).decode()


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_SUFFIXES


def count_pages(path: Path) -> int:
    """只读页数，不做渲染（大文件也很快）。"""
    if is_image(path):
        return 1
    with pymupdf.open(path) as doc:
        return doc.page_count


def _shrink(png: bytes, max_side: int) -> tuple[bytes, int, int]:
    img = Image.open(io.BytesIO(png))
    w, h = img.size
    longest = max(w, h)
    if longest <= max_side:
        return png, w, h
    scale = max_side / longest
    img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    return buf.getvalue(), img.width, img.height


def load_page(path: Path, index: int, dpi: int = 250, max_side: int = 2200) -> Page:
    """渲染单页。index 从 1 开始。"""
    if is_image(path):
        if index != 1:
            raise IndexError(f'图片只有 1 页：{path.name}')
        img = Image.open(path).convert('RGB')
        buf = io.BytesIO()
        img.save(buf, format='PNG', optimize=True)
        png, w, h = _shrink(buf.getvalue(), max_side)
        return Page(index=1, png=png, width=w, height=h)

    with pymupdf.open(path) as doc:
        if not 1 <= index <= doc.page_count:
            raise IndexError(f'{path.name} 只有 {doc.page_count} 页，请求第 {index} 页')
        page = doc[index - 1]
        pix = page.get_pixmap(dpi=dpi)
        png, w, h = _shrink(pix.tobytes('png'), max_side)
        return Page(
            index=index,
            png=png,
            width=w,
            height=h,
            page_width_pt=page.rect.width,
            page_height_pt=page.rect.height,
        )


def load_pages(path: Path, dpi: int = 250, max_side: int = 2200, indices: set[int] | None = None) -> list[Page]:
    """渲染指定页（默认全部）。小文件方便，大文件请用 load_page 逐页加载。"""
    total = count_pages(path)
    wanted = indices or set(range(1, total + 1))
    return [load_page(path, i, dpi=dpi, max_side=max_side) for i in sorted(wanted) if i <= total]
