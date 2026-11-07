"""本地 Web UI：浏览器里选文件、跑任务、看结果。

启动：.venv/Scripts/python.exe -m pdftranslate.server [--port 8765]
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import models as registry
from .config import Config
from .screen import blocks_to_json, translate_screen
from .pipeline import Options, collect_inputs, count_pages, dedupe_names, estimate, run_job

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = ROOT / 'samples'
DEFAULT_OUT = ROOT / 'out'
UI_FILE = Path(__file__).resolve().parent / 'ui.html'


class Cancelled(Exception):
    pass


class Job:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.running = False
        self.log: list[str] = []
        self.done = 0
        self.total = 0
        self.current = ''
        self.results: list[dict] = []
        self.started = 0.0
        self.finished = 0.0
        self.cancel = False
        self.error = ''

    def emit(self, line: str) -> None:
        if self.cancel:
            raise Cancelled()
        with self.lock:
            stamp = time.strftime('%H:%M:%S')
            self.log.append(f'{stamp}  {line}')
            if len(self.log) > 800:
                del self.log[:200]
            self.current = line

    def progress(self, done: int, total: int) -> None:
        with self.lock:
            self.done = done
            self.total = total

    def snapshot(self) -> dict:
        with self.lock:
            return {
                'running': self.running,
                'log': self.log[-400:],
                'done': self.done,
                'total': self.total,
                'current': self.current,
                'results': self.results,
                'elapsed': round((self.finished or time.time()) - self.started, 1) if self.started else 0,
                'error': self.error,
            }


JOB = Job()


def _rel(path: Path, base: Path) -> str:
    try:
        return str(path.relative_to(base)).replace('\\', '/')
    except ValueError:
        return str(path)


def _all_names(input_dir: Path) -> dict[Path, str]:
    sources = [p for p in collect_inputs(input_dir) if '.cache' not in p.parts and '_html' not in str(p)]
    return dedupe_names(sources)


def start_job(files: list[Path], cfg: Config, opts: Options, out_dir: Path) -> None:
    with JOB.lock:
        JOB.running = True
        JOB.cancel = False
        JOB.log = []
        JOB.results = []
        JOB.done = JOB.total = 0
        JOB.started = time.time()
        JOB.finished = 0.0
        JOB.error = ''

    def worker() -> None:
        self_input_dir = Handler.input_dir
        try:
            stats = run_job(
                files,
                cfg,
                opts,
                out_dir,
                emit=JOB.emit,
                progress=JOB.progress,
                names=_all_names(self_input_dir),
            )
            with JOB.lock:
                JOB.results = [
                    {
                        'name': s.path.name,
                        'pages': s.pages,
                        'ok': s.ok,
                        'failed': s.failed,
                        'seconds': round(s.seconds, 1),
                        'skipped': s.skipped,
                        'html': _rel(s.html, out_dir) if s.html else '',
                        'pdf': _rel(s.pdf, out_dir) if s.pdf else '',
                        'md': _rel(s.md, out_dir) if s.md else '',
                    }
                    for s in stats
                ]
        except Cancelled:
            JOB.emit.__self__  # noqa: B018 - 仅表示正常取消
            with JOB.lock:
                JOB.log.append('已取消')
        except Exception as exc:  # noqa: BLE001
            with JOB.lock:
                JOB.error = str(exc)
                JOB.log.append(f'出错：{exc}')
        finally:
            with JOB.lock:
                JOB.running = False
                JOB.finished = time.time()

    threading.Thread(target=worker, daemon=True).start()


def list_files(base: Path, out_dir: Path) -> list[dict]:
    rows: list[dict] = []
    sources = [p for p in collect_inputs(base) if '.cache' not in p.parts and '_html' not in str(p)]
    names = dedupe_names(sources)
    for src in sources:
        if '.cache' in src.parts or '_html' in str(src):
            continue
        try:
            pages = count_pages(src)
        except Exception:  # noqa: BLE001
            pages = 0
        stem = names[src]
        rows.append(
            {
                'path': _rel(src, base),
                'name': src.name,
                'pages': pages,
                'size': round(src.stat().st_size / 1024 / 1024, 2),
                'pdf': (out_dir / f'{stem}_双语.pdf').exists(),
                'html': (out_dir / f'{stem}_html' / 'index.html').exists(),
                'md': (out_dir / f'{stem}_译文.md').exists(),
            }
        )
    return rows


class Handler(BaseHTTPRequestHandler):
    input_dir = DEFAULT_INPUT
    out_dir = DEFAULT_OUT

    def log_message(self, fmt: str, *args) -> None:  # 静音
        return

    # ---------- helpers ----------
    def _json(self, data: dict, code: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(404, 'not found')
            return
        ctype = mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
        if path.suffix == '.md':
            ctype = 'text/plain; charset=utf-8'
        body = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        length = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(length) if length else b''

    def _payload(self) -> dict | None:
        """容错解析 JSON 体：编码不规范时不要让整个请求线程崩掉。"""
        try:
            raw = self._body().decode('utf-8', 'replace')
            data = json.loads(raw or '{}')
        except json.JSONDecodeError as exc:
            self._json({'ok': False, 'error': f'请求体不是合法 JSON：{exc}'}, 400)
            return None
        if not isinstance(data, dict):
            self._json({'ok': False, 'error': '请求体必须是对象'}, 400)
            return None
        return data

    # ---------- routes ----------
    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path

        if route in ('/', '/index.html'):
            self._file(UI_FILE)
            return
        if route == '/api/state':
            self._json({**JOB.snapshot(), 'files': list_files(self.input_dir, self.out_dir)})
            return
        if route == '/api/config':
            models = [m.public() for m in registry.entries()]
            default = registry.default_id()
            self._json(
                {
                    'models': models,
                    'default': default,
                    'has_key': bool(registry.get(default) and registry.get(default).api_key),
                    'input_dir': str(self.input_dir),
                }
            )
            return
        if route == '/api/models':
            self._json(
                {
                    'models': [m.public() for m in registry.entries()],
                    'default': registry.default_id(),
                    'env': {'proxy_default': registry.proxy_default()},
                }
            )
            return
        if route.startswith('/out/'):
            target = (self.out_dir / urllib.parse.unquote(route[len('/out/') :])).resolve()
            if self.out_dir.resolve() in target.parents or target == self.out_dir.resolve():
                self._file(target)
            else:
                self.send_error(403, 'forbidden')
            return
        self.send_error(404, 'not found')

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if route == '/api/screen':
            length = int(self.headers.get('Content-Length') or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b'{}')
            except json.JSONDecodeError:
                self._json({'ok': False, 'error': 'bad json'}, 400)
                return
            image = str(payload.get('image') or '')
            if not image.startswith('data:image'):
                self._json({'ok': False, 'error': '缺少 image（dataURL）'}, 400)
                return
            import base64

            from .config import Config as _C

            cfg = _C.from_env(
                provider=payload.get('provider') or None,
                model=payload.get('model') or None,
                target_lang=payload.get('target') or '简体中文',
            )
            if not cfg.api_key:
                self._json(
                    {'ok': False, 'error': '未配置视觉模型 Key（在设置页或模型管理里填）'}, 400
                )
                return
            try:
                png = base64.b64decode(image.split(',', 1)[1])
                blocks = translate_screen(png, cfg)
                self._json({'ok': True, 'blocks': json.loads(blocks_to_json(blocks))})
            except Exception as exc:  # noqa: BLE001
                self._json({'ok': False, 'error': str(exc)}, 200)
            return

        if route == '/api/upload':
            name = (query.get('name') or ['upload.pdf'])[0]
            name = Path(name).name
            dest_dir = self.input_dir / '_uploads'
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / name
            dest.write_bytes(self._body())
            self._json({'ok': True, 'path': _rel(dest, self.input_dir)})
            return

        if route == '/api/models' or route == '/api/models/upsert':
            payload = self._payload()
            if payload is None:
                return
            try:
                entry = registry.upsert(payload)
            except ValueError as exc:
                self._json({'ok': False, 'error': str(exc)}, 400)
                return
            if payload.get('make_default'):
                registry.set_default(entry.id)
            self._json({'ok': True, 'model': entry.public(), 'default': registry.default_id()})
            return

        if route == '/api/models/delete':
            payload = self._payload()
            if payload is None:
                return
            ok = registry.delete((payload.get('id') or '').strip())
            self._json(
                {'ok': ok, 'models': [m.public() for m in registry.entries()], 'default': registry.default_id()}
            )
            return

        if route == '/api/models/default':
            payload = self._payload()
            if payload is None:
                return
            try:
                registry.set_default((payload.get('id') or '').strip())
            except ValueError as exc:
                self._json({'ok': False, 'error': str(exc)}, 400)
                return
            self._json({'ok': True, 'default': registry.default_id()})
            return

        if route == '/api/models/test':
            payload = self._payload()
            if payload is None:
                return
            model_id = (payload.get('id') or '').strip()
            entry = registry.get(model_id)
            if entry is None and payload.get('base_url'):
                entry = registry.ModelEntry(
                    id=model_id or 'tmp',
                    base_url=payload['base_url'].strip(),
                    model=(payload.get('model') or '').strip(),
                    proxy=bool(payload.get('proxy')),
                    api_key=(payload.get('api_key') or '').strip(),
                )
            if entry is None:
                self._json({'ok': False, 'error': '模型不存在'}, 404)
                return
            if not entry.api_key:
                self._json({'ok': False, 'error': '还没有填 Key'}, 400)
                return
            self._json(registry.test_entry(entry))
            return

        if route == '/api/start':
            payload = self._payload()
            if payload is None:
                return
            if JOB.running:
                self._json({'ok': False, 'error': '已有任务在跑'}, 409)
                return

            chosen = payload.get('files') or []
            files = [self.input_dir / f for f in chosen]
            files = [f for f in files if f.exists()]
            if not files:
                self._json({'ok': False, 'error': '没有选择文件'}, 400)
                return

            cfg = Config.from_env(
                provider=payload.get('provider') or None,
                model=payload.get('model') or None,
                target_lang=payload.get('target') or '简体中文',
                dpi=int(payload.get('dpi') or 250),
                concurrency=int(payload.get('concurrency') or 2),
            )
            if not cfg.api_key:
                entry = registry.get(cfg.provider)
                hint = f'（在「模型管理」里给 {cfg.provider} 填 Key，或设环境变量 {entry.key_env}）' if entry else ''
                self._json({'ok': False, 'error': f'模型 {cfg.provider} 缺少 API Key {hint}'}, 400)
                return

            opts = Options(
                pages=payload.get('pages') or '',
                html=bool(payload.get('html')),
                pdf=payload.get('pdf', True),
                md=payload.get('md', True),
                force=bool(payload.get('force')),
                skip_done=bool(payload.get('skip_done')),
            )
            start_job(files, cfg, opts, self.out_dir)
            self._json({'ok': True, 'total_files': len(files), 'provider': cfg.provider, 'model': cfg.model})
            return

        if route == '/api/cancel':
            JOB.cancel = True
            self._json({'ok': True})
            return

        if route == '/api/estimate':
            payload = self._payload()
            if payload is None:
                return
            files = [self.input_dir / f for f in payload.get('files') or []]
            total, _rows = estimate([f for f in files if f.exists()], payload.get('pages') or '')
            self._json({'pages': total, 'minutes': round(total * 12 / max(1, int(payload.get('concurrency') or 2)) / 60, 1)})
            return

        self.send_error(404, 'not found')


def serve(port: int, input_dir: Path, out_dir: Path) -> None:
    Handler.input_dir = input_dir.resolve()
    Handler.out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'界面已启动： http://127.0.0.1:{port}/')
    print(f'输入目录：{Handler.input_dir}')
    print(f'输出目录：{Handler.out_dir}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='pdftranslate 本地操作界面')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--input', type=Path, default=DEFAULT_INPUT)
    ap.add_argument('--out', type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()
    serve(args.port, args.input, args.out)
