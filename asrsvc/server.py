"""本地语音识别服务：faster-whisper + 极简 HTTP 接口。

给浏览器扩展调用：
    POST /asr?lang=en&offset=12.5    body = 音频字节(webm/opus/wav/mp4…)
    → {"ok":true,"text":"...","segments":[{"start":0.2,"end":2.9,"text":"..."}],"elapsed_ms":1234}
"""

from __future__ import annotations

import io
import json
import os
import sys
import threading
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .vod import SubtitleService

ROOT = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ROOT_STR = str(ROOT)
DEFAULT_MODEL_DIR = os.path.join(ROOT_STR, '.cache', 'hf', 'models')


@dataclass
class Segment:
    start: float
    end: float
    text: str


class Engine:
    """懒加载 + 串行推理（whisper 在 CPU 上并发反而更慢）。"""

    def __init__(self, model_size: str = 'base', threads: int = 6, model_dir: str | None = None) -> None:
        self.model_size = model_size
        self.threads = threads
        self.model_dir = model_dir or DEFAULT_MODEL_DIR
        self._model = None
        self._lock = threading.Lock()
        self.load_seconds = 0.0

    def ensure(self):
        if self._model is not None:
            return self._model
        with self._lock:
            if self._model is None:
                from faster_whisper import WhisperModel

                started = time.time()
                self._model = WhisperModel(
                    self.model_size,
                    device='cpu',
                    compute_type='int8',
                    cpu_threads=self.threads,
                    download_root=self.model_dir,
                )
                self.load_seconds = round(time.time() - started, 1)
        return self._model

    def transcribe_full(self, audio: bytes, lang: str | None = None) -> tuple[list[Segment], float, float]:
        """整段转写：给完整上下文 + 逐词时间戳，质量和时间对齐都比分片好。"""
        model = self.ensure()
        started = time.time()
        stream, info = model.transcribe(
            io.BytesIO(audio),
            language=lang or None,
            task='transcribe',
            beam_size=5,
            vad_filter=True,
            vad_parameters={'min_silence_duration_ms': 400},
            condition_on_previous_text=True,
            word_timestamps=True,
        )
        segments: list[Segment] = []
        for s in stream:
            text = s.text.strip()
            if not text:
                continue
            words = getattr(s, 'words', None)
            if not words:
                segments.append(Segment(start=round(s.start, 2), end=round(s.end, 2), text=text))
                continue
            # 用逐词时间戳把长句切成适合做字幕的短行
            buf: list[str] = []
            line_start = 0.0
            line_end = 0.0
            for w in words:
                token = w.word or ''
                if not token.strip():
                    continue
                cur_len = sum(len(x) for x in buf)
                too_long = buf and (cur_len + len(token.strip()) > 46 or len(buf) >= 12)
                if too_long:
                    segments.append(
                        Segment(start=round(line_start, 2), end=round(line_end, 2),
                                text=''.join(buf).strip())
                    )
                    buf = []
                if not buf:
                    line_start = w.start
                buf.append(token)
                line_end = w.end
            if buf:
                segments.append(
                    Segment(start=round(line_start, 2), end=round(line_end, 2),
                            text=''.join(buf).strip())
                )
        elapsed = time.time() - started
        return segments, elapsed, float(getattr(info, 'duration', 0.0) or 0.0)

    def transcribe(self, audio: bytes, lang: str | None = None, vad: bool = False) -> tuple[list[Segment], float, float]:
        model = self.ensure()
        started = time.time()
        stream, info = model.transcribe(
            io.BytesIO(audio),
            language=lang or None,
            task='transcribe',
            beam_size=1,
            vad_filter=vad,
            vad_parameters={'min_silence_duration_ms': 300},
            condition_on_previous_text=False,  # 分片之间不要互相"带偏"
            without_timestamps=False,
        )
        segments = [
            Segment(start=round(s.start, 2), end=round(s.end, 2), text=s.text.strip())
            for s in stream
            if s.text.strip()
        ]
        elapsed = time.time() - started
        return segments, elapsed, float(getattr(info, 'duration', 0.0) or 0.0)


class Handler(BaseHTTPRequestHandler):
    engine: Engine
    service: SubtitleService
    last_hit: float = 0.0

    def log_message(self, fmt: str, *args) -> None:  # 静音
        return

    def handle_error(self, request, client_address) -> None:  # noqa: ANN001
        """客户端提前断开很常见（切页面、扩展重载），不要打整段 traceback。"""
        import sys

        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            print(f'  [客户端断开] {type(exc).__name__}')
            return
        super().handle_error(request, client_address)

    def _json(self, data: dict, code: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        try:
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            # 对端已走，丢掉这条响应即可
            pass

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'content-type')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        Handler.last_hit = time.time()
        parsed = urlparse(self.path)
        q = parse_qs(parsed.query)

        if parsed.path == '/subtitles':
            video_id = (q.get('id') or [''])[0]
            if not video_id:
                self._json({'ok': False, 'error': '缺少 id'}, 400)
                return
            segments = self.service.load_cached(video_id)
            if segments is None:
                self._json({'ok': True, 'hit': False, 'segments': []})
            else:
                self._json({'ok': True, 'hit': True, 'segments': segments})
            return

        if parsed.path.startswith('/job/'):
            job = self.service.get(parsed.path[len('/job/') :])
            if job is None:
                self._json({'ok': False, 'error': '作业不存在'}, 404)
                return
            self._json(
                {
                    'ok': True,
                    'state': job.state,
                    'progress': round(job.progress, 2),
                    'detail': job.detail,
                    'segments': job.segments,
                }
            )
            return

        if parsed.path == '/health':
            self._json(
                {
                    'ok': True,
                    'model': self.engine.model_size,
                    'loaded': self.engine._model is not None,
                    'load_seconds': self.engine.load_seconds,
                }
            )
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        Handler.last_hit = time.time()
        parsed = urlparse(self.path)
        if parsed.path == '/cookies':
            # 扩展每次生成前推一份实时 cookie（__Secure-*PSIDTS 会滚动过期）
            length = int(self.headers.get('Content-Length') or 0)
            text = self.rfile.read(length).decode('utf-8', 'replace')
            if 'youtube.com' not in text:
                self._json({'ok': False, 'error': 'cookie 里没有 youtube.com'}, 400)
                return
            path = ROOT / '.cache' / 'runtime-cookies.txt'
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, 'w', encoding='utf-8', newline=chr(10)) as fh:
                fh.write(text if text.endswith(chr(10)) else text + chr(10))
            self.service.cookies = path
            log(f'收到实时 cookie（{text.count(chr(10))} 行）→ {path}')
            self._json({'ok': True})
            return

        if parsed.path == '/generate':
            length = int(self.headers.get('Content-Length') or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b'{}')
            except json.JSONDecodeError:
                self._json({'ok': False, 'error': 'bad json'}, 400)
                return
            video_id = (payload.get('videoId') or '').strip()
            url = (payload.get('url') or '').strip()
            if not video_id or not url:
                self._json({'ok': False, 'error': '需要 videoId 和 url'}, 400)
                return
            job = self.service.start(
                video_id, url, payload.get('lang') or None, force=bool(payload.get('force'))
            )
            self._json({'ok': True, 'job': job.id, 'state': job.state})
            return

        if parsed.path != '/asr':
            self.send_error(404)
            return
        q = parse_qs(parsed.query)
        lang = (q.get('lang') or [''])[0] or None
        offset = float((q.get('offset') or ['0'])[0] or 0)
        vad = (q.get('vad') or ['0'])[0] == '1'

        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            self._json({'ok': False, 'error': '空音频'}, 400)
            return
        audio = self.rfile.read(length)

        try:
            segments, elapsed, duration = self.engine.transcribe(audio, lang=lang, vad=vad)
        except Exception as exc:  # noqa: BLE001
            self._json({'ok': False, 'error': f'{type(exc).__name__}: {exc}'}, 500)
            return

        rtf = round(elapsed / duration, 2) if duration else None
        self._json(
            {
                'ok': True,
                'text': ' '.join(s.text for s in segments).strip(),
                'segments': [
                    {'start': round(s.start + offset, 2), 'end': round(s.end + offset, 2), 'text': s.text}
                    for s in segments
                ],
                'duration': round(duration, 2),
                'elapsed_ms': round(elapsed * 1000),
                'realtime_factor': rtf,
            }
        )


LOG_FILE = ROOT / '.cache' / 'asrsvc.log'


def log(msg: str) -> None:
    line = f'{time.strftime("%Y-%m-%d %H:%M:%S")}  {msg}'
    # pythonw.exe（无控制台）下 sys.stdout 是 None，直接 print 会抛异常
    if sys.stdout is not None:
        try:
            print(line, flush=True)
        except (OSError, ValueError):
            pass
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, 'a', encoding='utf-8') as fh:
            fh.write(line + '\n')
    except OSError:
        pass


class SingleInstanceServer(ThreadingHTTPServer):
    # Windows 下默认 allow_reuse_address=1 会让两个进程同时绑同一端口，
    # 请求被随机分走，表现为"有时候正常有时候报错"。这里禁掉。
    allow_reuse_address = False
    daemon_threads = True


def _port_in_use(port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex(('127.0.0.1', port)) == 0


def serve(
    port: int = 8770,
    model: str = 'base',
    threads: int = 6,
    warmup: bool = True,
    cookies: str | None = None,
    idle_exit: int = 0,
) -> None:
    Handler.engine = Engine(model_size=model, threads=threads)
    Handler.service = SubtitleService(
        Handler.engine, cookies=Path(cookies) if cookies else None
    )
    if warmup:
        log(f'加载模型 {model} …')
        Handler.engine.ensure()
        log(f'模型就绪（{Handler.engine.load_seconds}s）')
    Handler.last_hit = time.time()
    if idle_exit:
        def watchdog() -> None:
            while True:
                time.sleep(60)
                if time.time() - Handler.last_hit > idle_exit:
                    log(f'空闲 {idle_exit // 60} 分钟，自动退出')
                    os._exit(0)

        threading.Thread(target=watchdog, daemon=True).start()
        log(f'空闲 {idle_exit // 60} 分钟后自动退出')

    if _port_in_use(port):
        log(f'端口 {port} 已被占用：可能已经有一个 ASR 服务在跑了。')
        log('请先关掉另一个窗口（或换端口：--port 8771），否则请求会被分到旧进程上。')
        raise SystemExit(1)

    try:
        server = SingleInstanceServer(('127.0.0.1', port), Handler)
    except OSError as exc:
        log(f'无法监听 {port}：{exc}')
        raise SystemExit(1)
    log(f'ASR 服务已启动： http://127.0.0.1:{port}/  模型 {model}  线程 {threads}')
    log(f'cookies: {cookies or "（未找到 cookies.txt，无法下载视频音频）"}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    import argparse

    ap = argparse.ArgumentParser(description='本地 whisper ASR 服务')
    ap.add_argument('--port', type=int, default=8770)
    ap.add_argument('--model', default='base', help='tiny(最快) / base(推荐) / small(最准) / medium')
    ap.add_argument('--threads', type=int, default=6)
    ap.add_argument('--no-warmup', action='store_true')
    ap.add_argument('--cookies', default=None, help='yt-dlp 用的 cookies.txt（默认项目根目录）')
    ap.add_argument('--idle-exit', type=int, default=0, help='空闲多少秒后自动退出（0=不退出）')
    args = ap.parse_args()
    cookies = args.cookies or (str(ROOT / 'cookies.txt') if (ROOT / 'cookies.txt').exists() else None)
    serve(
        args.port,
        args.model,
        args.threads,
        warmup=not args.no_warmup,
        cookies=cookies,
        idle_exit=args.idle_exit,
    )
