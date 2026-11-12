"""Native Messaging 宿主：让扩展在弹窗里启动/停止本地 ASR 服务。

Chrome 通过 4 字节小端长度 + JSON 的格式在 stdin/stdout 上通信。
命令：{"cmd": "status" | "start" | "stop"}
"""

from __future__ import annotations

import json
import os
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

def _project_root() -> Path:
    # PyInstaller 打包后 __file__ 指向临时解包目录，必须用 exe 自身位置反推
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent.parent
    return Path(__file__).resolve().parent.parent


ROOT = _project_root()
# PDF 翻译是独立项目，这里只负责把它的服务拉起来
PDF_PROJECT = ROOT.parent / 'pdf_trasllama'
PDF_PROJECT_ALT = ROOT.parent / 'pdftranslate'
PDF_PORT = 8765
PYTHONW = ROOT / '.venv' / 'Scripts' / 'pythonw.exe'
PORT = 8770
HOST = '127.0.0.1'
CRLF = chr(13) + chr(10)


def log(msg: str) -> None:
    try:
        logfile = ROOT / '.cache' / 'native-host.log'
        logfile.parent.mkdir(parents=True, exist_ok=True)
        with open(logfile, 'a', encoding='utf-8') as fh:
            fh.write(f'{time.strftime("%Y-%m-%d %H:%M:%S")}  {msg}\n')
    except OSError:
        pass


def read_message() -> dict | None:
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack('<I', raw)[0]
    if length == 0 or length > 1_000_000:
        return None
    data = sys.stdin.buffer.read(length)
    try:
        return json.loads(data.decode('utf-8'))
    except json.JSONDecodeError:
        return None


def send_message(payload: dict) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def healthy(timeout: float = 1.0) -> dict | None:
    try:
        with socket.create_connection((HOST, PORT), timeout=timeout) as s:
            s.sendall(
                f'GET /health HTTP/1.0\r\nHost: {HOST}\r\nConnection: close\r\n\r\n'.encode()
            )
            chunks = []
            while True:
                buf = s.recv(4096)
                if not buf:
                    break
                chunks.append(buf)
        body = b''.join(chunks).split(b'\r\n\r\n', 1)[-1]
        return json.loads(body.decode('utf-8', 'ignore'))
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def start_service(wait: float = 45.0) -> dict:
    info = healthy()
    if info:
        return {'ok': True, 'already': True, 'model': info.get('model'), 'loaded': info.get('loaded')}
    if not PYTHONW.exists():
        return {'ok': False, 'error': f'找不到 {PYTHONW}'}

    creationflags = 0
    if os.name == 'nt':
        creationflags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(
        [str(PYTHONW), '-m', 'asrsvc.server', '--port', str(PORT)],
        cwd=str(ROOT),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
        close_fds=True,
    )
    log('已启动 asrsvc.server')

    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(0.8)
        info = healthy()
        if info:
            return {'ok': True, 'already': False, 'model': info.get('model'), 'loaded': info.get('loaded')}
    return {'ok': False, 'error': '服务启动超时（首次加载模型约需 30 秒）'}


def stop_service() -> dict:
    info = healthy()
    if not info:
        return {'ok': True, 'already': True}
    # 用 netstat 找监听该端口的 PID（不依赖 psutil）
    pids: set[str] = set()
    try:
        out = subprocess.run(
            ['netstat', '-ano'], capture_output=True, text=True, timeout=10, check=False
        ).stdout
        for line in out.splitlines():
            if f':{PORT} ' in line and 'LISTENING' in line.upper():
                pids.add(line.split()[-1])
    except (OSError, subprocess.SubprocessError):
        pass
    for pid in pids:
        if pid.isdigit() and pid != '0':
            subprocess.run(['taskkill', '/pid', pid, '/f'], capture_output=True, check=False)
            log(f'已停止 PID {pid}')
    time.sleep(0.5)
    return {'ok': healthy() is None, 'stopped': sorted(pids)}


def _pdf_project() -> Path | None:
    for cand in (PDF_PROJECT, PDF_PROJECT_ALT):
        if (cand / 'pdftranslate' / 'server.py').exists():
            return cand
    return None


def _http_json(port: int, path: str, timeout: float = 1.5):
    try:
        with socket.create_connection((HOST, port), timeout=timeout) as s:
            req = f'GET {path} HTTP/1.0' + CRLF + f'Host: {HOST}' + CRLF + 'Connection: close' + CRLF + CRLF
            s.sendall(req.encode())
            chunks = []
            while True:
                buf = s.recv(4096)
                if not buf:
                    break
                chunks.append(buf)
        sep = (CRLF + CRLF).encode()
        body = b''.join(chunks).split(sep, 1)[-1]
        return json.loads(body.decode('utf-8', 'ignore'))
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def pdf_status() -> dict:
    info = _http_json(PDF_PORT, '/api/config')
    project = _pdf_project()
    return {
        'ok': True,
        'online': info is not None,
        'project': str(project) if project else '',
        'installed': project is not None,
        'port': PDF_PORT,
    }


def pdf_start(wait: float = 40.0) -> dict:
    if _http_json(PDF_PORT, '/api/config'):
        return {**pdf_status(), 'already': True}
    project = _pdf_project()
    if project is None:
        return {
            'ok': False,
            'error': '找不到 PDF 翻译项目（期望目录 pdf_trasllama 或 pdftranslate，且含 pdftranslate/server.py）',
        }
    pyw = project / '.venv' / 'Scripts' / 'pythonw.exe'
    if not pyw.exists():
        return {'ok': False, 'error': f'找不到 {pyw}，请先在该项目里创建 .venv 并安装依赖'}

    creationflags = 0
    if os.name == 'nt':
        creationflags = 0x00000008 | 0x00000200
    subprocess.Popen(
        [str(pyw), '-m', 'pdftranslate.server', '--port', str(PDF_PORT)],
        cwd=str(project),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
        close_fds=True,
    )
    log(f'已启动 PDF 翻译服务（{project}）')

    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(0.7)
        if _http_json(PDF_PORT, '/api/config'):
            return {**pdf_status(), 'already': False}
    return {'ok': False, 'error': 'PDF 服务启动超时（检查该项目的 .env 是否配好 Key）'}


def main() -> None:
    msg = read_message()
    if msg is None:
        return
    cmd = str(msg.get('cmd') or 'status').lower()
    log(f'收到命令：{cmd}')

    if cmd == 'start':
        result = start_service()
    elif cmd == 'stop':
        result = stop_service()
    elif cmd == 'pdf-status':
        result = pdf_status()
    elif cmd == 'pdf-start':
        result = pdf_start()
    else:
        info = healthy()
        result = (
            {'ok': True, 'online': True, 'model': info.get('model'), 'loaded': info.get('loaded')}
            if info
            else {'ok': True, 'online': False}
        )

    send_message(result)


if __name__ == '__main__':
    main()
