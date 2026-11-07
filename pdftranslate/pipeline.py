"""流水线：CLI 与本地 Web UI 共用。"""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .build import build_bilingual_pdf, write_markdown
from .build_html import build_html, write_page_map
from .config import Config
from .render import IMAGE_SUFFIXES, count_pages, is_image, load_page
from .snap import page_lines, snap_blocks
from .vision import PageResult, transcribe_page

SUFFIXES = {'.pdf', *IMAGE_SUFFIXES}

Emit = Callable[[str], None]


@dataclass
class Options:
    pages: str = ''
    html: bool = False
    pdf: bool = True
    md: bool = True
    force: bool = False
    skip_done: bool = False
    no_original: bool = False


@dataclass
class FileStat:
    path: Path
    pages: int = 0
    ok: int = 0
    failed: list[int] = field(default_factory=list)
    seconds: float = 0.0
    pdf: Path | None = None
    md: Path | None = None
    html: Path | None = None
    skipped: bool = False

    @property
    def done(self) -> bool:
        return self.pages > 0 and not self.failed


def collect_inputs(target: Path) -> list[Path]:
    if target.is_file():
        return [target]
    if not target.exists():
        return []
    return sorted(p for p in target.rglob('*') if p.is_file() and p.suffix.lower() in SUFFIXES)


def dedupe_names(paths: list[Path]) -> dict[Path, str]:
    counts: dict[str, int] = {}
    for p in paths:
        counts[p.stem] = counts.get(p.stem, 0) + 1
    return {p: (f'{p.parent.name}_{p.stem}' if counts[p.stem] > 1 else p.stem) for p in paths}


def parse_pages(spec: str, total: int) -> set[int]:
    if not spec or not spec.strip():
        return set(range(1, total + 1))
    wanted: set[int] = set()
    for part in spec.split(','):
        part = part.strip()
        if '-' in part:
            a, b = part.split('-', 1)
            wanted.update(range(int(a), int(b) + 1))
        elif part:
            wanted.add(int(part))
    return {p for p in wanted if 1 <= p <= total}


def estimate(inputs: list[Path], pages_spec: str = '') -> tuple[int, list[tuple[Path, int, int]]]:
    rows: list[tuple[Path, int, int]] = []
    total = 0
    for src in inputs:
        try:
            n = count_pages(src)
        except Exception:  # noqa: BLE001
            rows.append((src, 0, 0))
            continue
        todo = len(parse_pages(pages_spec, n))
        total += todo
        rows.append((src, todo, n))
    return total, rows


def process_file(
    src: Path,
    cfg: Config,
    opts: Options,
    out_dir: Path,
    name: str,
    emit: Emit,
    progress: Callable[[int, int], None] | None = None,
) -> FileStat:
    stat = FileStat(path=src)
    pdf_path = out_dir / f'{name}_双语.pdf'
    md_path = out_dir / f'{name}_译文.md'
    html_dir = out_dir / f'{name}_html'

    if opts.skip_done and pdf_path.exists() and md_path.exists() and not opts.html:
        emit(f'{src.name} —— 已有输出，跳过')
        stat.skipped = True
        return stat
    if opts.skip_done and pdf_path.exists() and md_path.exists() and opts.html and (html_dir / 'index.html').exists():
        emit(f'{src.name} —— 已有输出（含 HTML），跳过')
        stat.skipped = True
        return stat

    started = time.time()
    try:
        total_pages = count_pages(src)
    except Exception as exc:  # noqa: BLE001
        stat.failed = [0]
        emit(f'读取失败：{exc}')
        return stat

    indices = sorted(parse_pages(opts.pages, total_pages))
    stat.pages = len(indices)
    if not indices:
        emit('没有匹配的页')
        return stat

    cache_dir = out_dir / '.cache' / name
    cache_dir.mkdir(parents=True, exist_ok=True)
    done_count = 0

    def run(index: int) -> PageResult:
        nonlocal done_count
        cache_file = cache_dir / f'page-{index}.json'
        if cache_file.exists() and not opts.force and not cfg.mock:
            result = PageResult.from_dict(json.loads(cache_file.read_text(encoding='utf-8')))
        else:
            page = load_page(src, index, dpi=cfg.dpi, max_side=cfg.max_side)
            result = transcribe_page(
                page.data_uri, index, cfg, image_size=(page.width, page.height)
            )
            if result.ok and not cfg.mock:
                cache_file.write_text(
                    json.dumps(result.to_dict(), ensure_ascii=False, indent=1), encoding='utf-8'
                )
        done_count += 1
        if progress:
            progress(done_count, len(indices))
        detail = f'{len(result.blocks)} 块' if result.ok else f'FAIL {result.error[:120]}'
        emit(f'第 {index}/{total_pages} 页 · {detail}')
        return result

    if cfg.concurrency > 1:
        with ThreadPoolExecutor(max_workers=cfg.concurrency) as pool:
            results = list(pool.map(run, indices))
    else:
        results = [run(i) for i in indices]

    results.sort(key=lambda r: r.page)

    # 有文本层的 PDF：用文本层的精确行坐标校正模型给的 bbox
    if not is_image(src):
        snapped_total = 0
        for res in results:
            lines = page_lines(src, res.page)
            if not lines:
                continue
            matched, total = snap_blocks(res.blocks, lines)
            snapped_total += matched
            # 只有校准结果足够可信（数量+比例）才敢丢掉模型坐标，
            # 否则文本层可能是扫描件的垃圾 OCR 层，反而会把好坐标搞坏
            if matched >= 3 and matched / max(1, total) >= 0.4:
                # 校准可信：未匹配上的块不再用模型的框，改为页下顺排
                dropped = 0
                for b in res.blocks:
                    if b.bbox_source != 'text' and b.bbox and len(b.original or '') >= 8:
                        b.bbox = None
                        dropped += 1
                emit(f'第 {res.page} 页 · 文本层校准 {matched}/{total} 块，改顺排 {dropped} 块')
        if snapped_total:
            emit(f'坐标校准完成：共 {snapped_total} 块采用文本层坐标')

    stat.ok = sum(1 for r in results if r.ok)
    stat.failed = [r.page for r in results if not r.ok]
    stat.seconds = time.time() - started

    if opts.md:
        write_markdown(results, src.name, md_path)
        stat.md = md_path
    if opts.pdf:
        image_page = load_page(src, 1, dpi=cfg.dpi, max_side=cfg.max_side) if is_image(src) else None
        build_bilingual_pdf(
            indices,
            results,
            src.name,
            pdf_path,
            show_original=not opts.no_original,
            source_pdf=None if is_image(src) else src,
            image_page=image_page,
        )
        stat.pdf = pdf_path
    if opts.html:
        imgs = [(i, load_page(src, i, dpi=cfg.dpi, max_side=cfg.max_side).png) for i in indices]
        stat.html = build_html(imgs, results, src.name, html_dir)
        write_page_map(html_dir, results)

    emit(f'完成 {stat.ok}/{len(results)} 页，用时 {stat.seconds:.1f}s')
    return stat


def run_job(
    inputs: list[Path],
    cfg: Config,
    opts: Options,
    out_dir: Path,
    emit: Emit,
    progress: Callable[[int, int], None] | None = None,
    names: dict[Path, str] | None = None,
) -> list[FileStat]:
    out_dir.mkdir(parents=True, exist_ok=True)
    # 命名要和界面列表保持一致（否则同名文件的输出对不上徽章）
    names = names or dedupe_names(inputs)
    stats: list[FileStat] = []
    for idx, src in enumerate(inputs, start=1):
        emit(f'[{idx}/{len(inputs)}] {src.name}')
        stats.append(
            process_file(src, cfg, opts, out_dir, names[src], emit, progress=progress)
        )
    return stats
