"""CLI：python -m pdftranslate <文件或目录> [选项]"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from . import models as registry
from .config import Config
from .pipeline import Options, collect_inputs, estimate, run_job


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog='pdftranslate',
        description='用视觉大模型把扫描件/图片 PDF 转写并翻译成双语对照（支持整个目录）',
    )
    parser.add_argument('input', type=Path, help='PDF / 图片 / 目录')
    parser.add_argument('-o', '--out', type=Path, default=None, help='输出目录（默认 ./out）')
    parser.add_argument('--pages', default='', help='只处理指定页，如 1-3,5（对每个文件生效）')
    parser.add_argument('--dpi', type=int, default=250, help='渲染 DPI（手写件建议 250-300）')
    parser.add_argument('--max-side', type=int, default=2200, help='送给模型的最长边像素')
    parser.add_argument('--target', default='简体中文', help='目标语言')
    parser.add_argument(
        '--provider',
        default=None,
        help='模型 id（见 models.json）：' + ' / '.join(m.id for m in registry.entries()),
    )
    parser.add_argument('--base-url', default=None, help='OpenAI 兼容端点')
    parser.add_argument('--model', default=None, help='视觉模型名')
    parser.add_argument('--api-key', default=None, help='API Key（也可用 .env）')
    parser.add_argument('--concurrency', type=int, default=2, help='同一文件内的并发页数')
    parser.add_argument('--mock', action='store_true', help='不调 API，用内置示例验证排版')
    parser.add_argument('--force', action='store_true', help='忽略缓存重新请求')
    parser.add_argument('--no-original', action='store_true', help='PDF 里只放译文')
    parser.add_argument(
        '--html', action='store_true', help='额外输出覆盖式 HTML（译文按原坐标贴回原页）'
    )
    parser.add_argument('--only', choices=['pdf', 'md', 'html'], default=None, help='只输出一种格式')
    parser.add_argument('--dry-run', action='store_true', help='只列出将处理哪些文件、共多少页')
    parser.add_argument('--skip-done', action='store_true', help='跳过已有输出的文件')
    args = parser.parse_args(argv)

    inputs = collect_inputs(args.input)
    if not inputs:
        print(f'没有找到可处理的文件：{args.input}', file=sys.stderr)
        return 1

    cfg = Config.from_env(
        provider=args.provider,
        base_url=args.base_url,
        model=args.model,
        api_key=args.api_key,
        dpi=args.dpi,
        max_side=args.max_side,
        target_lang=args.target,
        concurrency=args.concurrency,
        mock=args.mock,
    )
    out_dir = args.out or Path('out')

    if args.dry_run:
        print(f'提供商 {cfg.provider} · 模型 {cfg.model}' + (f' · 代理 {cfg.proxy}' if cfg.proxy else ''))
        print(f'输出到 {out_dir}/')
        total, rows = estimate(inputs, args.pages)
        base = args.input if args.input.is_dir() else args.input.parent
        for src, todo, pages in rows:
            rel = src.relative_to(base) if src.is_relative_to(base) else src
            print(f'  {rel}  {todo}/{pages} 页')
        print(
            f'\n合计 {total} 页。按每页约 8-15 秒（并发 {cfg.concurrency}）估算，'
            f'约 {total * 12 / max(1, cfg.concurrency) / 60:.1f} 分钟。'
        )
        return 0

    if not cfg.mock and not cfg.api_key:
        preset = PRESETS[cfg.provider]
        print(
            f'缺少 API Key：在 .env 里填 {preset.env_key}= 或 VISION_API_KEY=，也可以加 --api-key\n'
            f'（当前提供商 {cfg.provider}，端点 {cfg.base_url}）\n'
            '先用 --mock 可以在不联网的情况下验证排版。',
            file=sys.stderr,
        )
        return 1

    only = args.only
    opts = Options(
        pages=args.pages,
        html=args.html or only == 'html',
        pdf=only in (None, 'pdf'),
        md=only in (None, 'md'),
        force=args.force,
        skip_done=args.skip_done,
        no_original=args.no_original,
    )

    started = time.time()
    stats = run_job(inputs, cfg, opts, out_dir, emit=lambda line: print('  ' + line, flush=True))

    print('\n' + '=' * 72)
    total_pages = sum(s.pages for s in stats)
    total_ok = sum(s.ok for s in stats)
    print(
        f'全部完成：{len(stats)} 个文件，{total_ok}/{total_pages} 页成功，'
        f'总用时 {time.time() - started:.0f}s'
    )
    for s in stats:
        if s.skipped:
            print(f'  - {s.path.name[:56]:58s} 已跳过')
            continue
        flag = '✓' if s.done else ('✗' if not s.ok else '~')
        print(
            f'  {flag} {s.path.name[:56]:58s} {s.ok:3d}/{s.pages:3d} 页  {s.seconds:5.1f}s'
            + (f'  失败页 {s.failed}' if s.failed else '')
        )
    return 0 if all(s.done or s.skipped for s in stats) else 2


if __name__ == '__main__':
    raise SystemExit(main())
