"""把各种格式的 cookie 导出统一成 yt-dlp 能用的 Netscape cookies.txt。

支持：
  - 已经是 Netscape 格式（原样复制）
  - Cookie-Editor / EditThisCookie 的 JSON 数组
  - {"cookies": [...]} 包装的 JSON
  - Playwright/Puppeteer 的 storageState JSON

用法：
    python scripts/import-cookies.py 导出文件 [cookies.txt]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / 'cookies.txt'

HEADER = (
    '# Netscape HTTP Cookie File\n'
    '# 由 scripts/import-cookies.py 生成，仅供本机 yt-dlp 使用，请勿外传\n\n'
)


def parse_netscape(text: str) -> list[list[str]]:
    rows = []
    for line in text.splitlines():
        line = line.strip().lstrip('\ufeff')
        if not line:
            continue
        # Netscape 格式里 HttpOnly cookie 前面带 #HttpOnly_，这不是注释！
        # SID / HSID / SSID / __Secure-* / LOGIN_INFO 全是 HttpOnly，漏了就等于没登录
        if line.startswith('#HttpOnly_'):
            line = line[len('#HttpOnly_') :]
        elif line.startswith('#'):
            continue
        parts = line.split('\t')
        if len(parts) == 7:
            parts[6] = parts[6].rstrip('\r')
            rows.append(parts)
    return rows


def parse_json(data: object) -> list[list[str]]:
    items: list[dict] = []
    if isinstance(data, list):
        items = [x for x in data if isinstance(x, dict)]
    elif isinstance(data, dict):
        if isinstance(data.get('cookies'), list):
            items = [x for x in data['cookies'] if isinstance(x, dict)]
        elif isinstance(data.get('cookies'), dict):
            items = []
        else:
            items = []

    rows: list[list[str]] = []
    for c in items:
        name = c.get('name')
        value = c.get('value')
        if not name or value is None:
            continue
        domain = c.get('domain') or ''
        if not domain:
            url = c.get('url') or ''
            domain = url.split('/')[2] if '//' in url else ''
        if not domain:
            continue
        if not domain.startswith('.') and not c.get('hostOnly'):
            # youtube 的登录 cookie 都在 .youtube.com 域下
            if 'youtube.com' in domain and not domain.startswith('.'):
                domain = '.' + domain.lstrip('.')
        path = c.get('path') or '/'
        secure = 'TRUE' if c.get('secure') else 'FALSE'
        expires = c.get('expirationDate') or c.get('expires') or 0
        try:
            expires_i = int(float(expires))
        except (TypeError, ValueError):
            expires_i = 0
        if expires_i <= 0:
            expires_i = 1893456000  # 2030，避免会话 cookie 被丢
        include_sub = 'TRUE' if domain.startswith('.') else 'FALSE'
        rows.append([domain, include_sub, path, secure, str(expires_i), str(name), str(value)])
    return rows


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1
    src = Path(argv[0])
    out = Path(argv[1]) if len(argv) > 1 else DEFAULT_OUT
    if not src.exists():
        print(f'找不到文件：{src}')
        return 1

    text = src.read_text(encoding='utf-8', errors='ignore')
    rows: list[list[str]] = []
    if text.lstrip().startswith(('[', '{')):
        try:
            rows = parse_json(json.loads(text))
            kind = 'JSON'
        except json.JSONDecodeError as exc:
            print(f'JSON 解析失败：{exc}')
            return 1
    else:
        rows = parse_netscape(text)
        kind = 'Netscape'

    if not rows:
        print('没有解析出任何 cookie')
        return 1

    lines = [HEADER.rstrip('\n')]
    for r in rows:
        lines.append('\t'.join(r))
    # 必须用 LF：Windows 默认会把换行转成 CRLF，个别解析器会读错
    with open(out, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('\n'.join(lines) + '\n')

    yt = [r for r in rows if 'youtube' in r[0] or 'google' in r[0]]
    names = {r[5] for r in yt}
    print(f'来源格式：{kind}')
    print(f'共 {len(rows)} 条（其中 YouTube/Google 域 {len(yt)} 条）→ {out}')
    for key in ('SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'):
        print(f'  {key:18s} {"有" if key in names else "缺失"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
