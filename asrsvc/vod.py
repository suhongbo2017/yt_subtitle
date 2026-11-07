"""点播字幕生成：yt-dlp 下音频 → whisper 整段转写 → 按 videoId 缓存。

和实时分片相比，一次拿到整段音频可以：
  - 用完整上下文转写（不会在切片边界丢词）
  - 拿到逐词时间戳，任意 seek 都对得上
  - 只算一次，之后直接读缓存
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / '.cache' / 'audio'
ASR_DIR = ROOT / '.cache' / 'asr'
COOKIES = ROOT / 'cookies.txt'
YTDLP = os.getenv('YTDLP_BIN') or 'yt-dlp'


def _log(msg: str) -> None:
    try:
        from .server import log as _srv_log

        _srv_log(msg)
    except Exception:  # noqa: BLE001
        print(msg, flush=True)


def _ytdlp_args(url: str, out_tmpl: str, cookies: Path | None) -> list[str]:
    args = [
        YTDLP,
        '--no-playlist',
        '--no-warnings',
        '--js-runtimes',
        'node',
        # 太密集的请求容易被判为机器人，稍微放慢一点
        '--sleep-requests',
        '0.8',
        '--retries',
        '3',
        '--fragment-retries',
        '3',
        '-f',
        'bestaudio/best',
        '-o',
        out_tmpl,
    ]
    if cookies and cookies.exists():
        args[1:1] = ['--cookies', str(cookies)]
    args.append(url)
    return args


@dataclass
class Job:
    id: str
    video_id: str
    state: str = 'queued'  # queued|downloading|transcribing|done|error
    progress: float = 0.0
    detail: str = ''
    segments: list[dict] = field(default_factory=list)
    started: float = field(default_factory=time.time)
    finished: float = 0.0


class SubtitleService:
    """点播字幕作业管理（同一 videoId 只跑一次）。"""

    def __init__(self, engine, cookies: Path | None = None) -> None:
        self.engine = engine
        self.cookies = cookies
        self.jobs: dict[str, Job] = {}
        self.by_video: dict[str, str] = {}
        self._lock = threading.Lock()
        AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        ASR_DIR.mkdir(parents=True, exist_ok=True)

    # ---------- 缓存 ----------
    def cache_path(self, video_id: str) -> Path:
        return ASR_DIR / f'{video_id}.json'

    def load_cached(self, video_id: str) -> list[dict] | None:
        path = self.cache_path(video_id)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            return data.get('segments')
        except (OSError, json.JSONDecodeError):
            return None

    def _save_cache(self, video_id: str, segments: list[dict], meta: dict) -> None:
        payload = {
            'videoId': video_id,
            'model': getattr(self.engine, 'model_size', ''),
            'created': time.strftime('%Y-%m-%d %H:%M:%S'),
            **meta,
            'segments': segments,
        }
        self.cache_path(video_id).write_text(
            json.dumps(payload, ensure_ascii=False, indent=1), encoding='utf-8'
        )

    # ---------- 作业 ----------
    def start(self, video_id: str, url: str, lang: str | None, force: bool = False) -> Job:
        with self._lock:
            existing = self.by_video.get(video_id)
            if existing and existing in self.jobs:
                job = self.jobs[existing]
                if job.state not in ('done', 'error'):
                    return job
            job = Job(id=uuid.uuid4().hex[:8], video_id=video_id)
            self.jobs[job.id] = job
            self.by_video[video_id] = job.id
        threading.Thread(target=self._run, args=(job, url, lang, force), daemon=True).start()
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def _run(self, job: Job, url: str, lang: str | None, force: bool) -> None:
        try:
            if not force:
                cached = self.load_cached(job.video_id)
                if cached:
                    job.segments = cached
                    job.state = 'done'
                    job.progress = 1.0
                    job.detail = '缓存命中'
                    job.finished = time.time()
                    return

            audio = self._download(job, url)
            _log(f'[{job.video_id}] 音频就绪：{audio.name} ({audio.stat().st_size // 1024} KB)')
            job.state = 'transcribing'
            job.progress = 0.6
            job.detail = '转写中…'
            segments, elapsed, duration = self.engine.transcribe_full(audio.read_bytes(), lang=lang)
            job.segments = [
                {'start': s.start, 'end': s.end, 'text': s.text} for s in segments
            ]
            self._save_cache(
                job.video_id,
                job.segments,
                {
                    'duration': round(duration, 2),
                    'transcribeSeconds': round(elapsed, 1),
                    'audio': audio.name,
                },
            )
            job.state = 'done'
            job.progress = 1.0
            job.detail = f'{len(job.segments)} 段 · 转写 {elapsed:.0f}s'
            job.finished = time.time()
            _log(f'[{job.video_id}] 完成：{len(job.segments)} 段，转写 {elapsed:.1f}s / 音频 {duration:.0f}s')
        except Exception as exc:  # noqa: BLE001
            job.state = 'error'
            job.detail = f'{type(exc).__name__}: {exc}'
            job.finished = time.time()
            _log(f'[{job.video_id}] 失败：{job.detail}')

    def _download(self, job: Job, url: str) -> Path:
        job.state = 'downloading'
        job.progress = 0.05
        job.detail = '下载音频…'
        existing = sorted(AUDIO_DIR.glob(f'{job.video_id}.*'))
        if existing:
            job.progress = 0.55
            job.detail = '音频已缓存'
            return existing[0]

        out_tmpl = str(AUDIO_DIR / f'{job.video_id}.%(ext)s')
        proc = None
        for attempt in range(2):
            proc = subprocess.run(
                _ytdlp_args(url, out_tmpl, self.cookies),
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=1800,
            )
            if proc.returncode == 0:
                break
            msg = (proc.stderr or proc.stdout or '')
            if 'not a bot' in msg or 'Sign in' in msg:
                _log(f'[{job.video_id}] 被判定为机器人（第 {attempt + 1} 次），等待后重试')
                time.sleep(8)
                continue
            break
        if proc is None or proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or '').strip().splitlines()[-3:]
            text = ' | '.join(tail)
            if 'not a bot' in text or 'Sign in' in text:
                raise RuntimeError(
                    'YouTube 判定为机器人：cookie 可能已过期或被 IP 标记。'
                    '请重新导出 cookies.txt（登录状态下 Chrome → Cookie-Editor → Export），或改用实时识别。'
                )
            raise RuntimeError('yt-dlp 下载失败：' + text)
        files = sorted(AUDIO_DIR.glob(f'{job.video_id}.*'))
        if not files:
            raise RuntimeError('yt-dlp 没有产出音频文件')
        job.progress = 0.55
        job.detail = '下载完成'
        return files[0]
