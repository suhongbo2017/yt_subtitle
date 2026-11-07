"""截图翻译：一张截图 → 视觉模型 → 文本块（坐标 + 原文 + 译文）。

和文档翻译共用视觉模型与模型注册表，但提示词针对屏幕内容
（界面文字、对话框、字幕、图表标注）做了调整。
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass

from .config import Config
from .vision import _norm_bbox, extract_json

SYSTEM_PROMPT = """你是屏幕截图翻译助手。用户给出一张屏幕截图（网页、软件界面、游戏、对话框、视频画面等）。

任务：找出画面里所有需要理解的文字，逐块翻译成{target}。

输出 JSON（不要 Markdown 代码块、不要解释）：
{{"blocks":[{{"bbox":[0.12,0.30,0.68,0.36],"original":"原文","translation":"译文"}}]}}

规则：
1. bbox 用归一化坐标 [左, 上, 右, 下]，以整张图为 1（左上角是 0,0），框要贴住该块文字的完整范围。
2. 相邻的同一句话合并成一块；界面上独立的按钮/标签/菜单项各自成块。
3. 纯图标、装饰、无文字区域跳过；已有译文或无需翻译的数字/时间也保留成块（translation 写回原文）。
4. 绝对不要编造画面里不存在的文字；看不清的宁可漏掉。
5. 译文口语自然，UI 短语按界面惯例翻译（例如 Settings→设置）。"""


@dataclass
class ScreenBlock:
    bbox: list[float]
    original: str
    translation: str


def translate_screen(png_bytes: bytes, cfg: Config, max_side: int = 1800) -> list[ScreenBlock]:
    import base64
    import io

    from PIL import Image

    img = Image.open(io.BytesIO(png_bytes))
    if img.mode not in ('RGB', 'L'):
        img = img.convert('RGB')
    if max(img.size) > max_side:
        scale = max_side / max(img.size)
        img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    data_uri = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()

    body = {
        'model': cfg.model,
        'temperature': 0.1,
        'max_tokens': 4096,
        'response_format': {'type': 'json_object'},
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT.format(target=cfg.target_lang)},
            {
                'role': 'user',
                'content': [
                    {'type': 'text', 'text': '请翻译这张截图里的文字。'},
                    {'type': 'image_url', 'image_url': {'url': data_uri}},
                ],
            },
        ],
    }

    last_error = ''
    for attempt in range(2):
        if attempt == 1:
            body.pop('response_format', None)
        try:
            req = urllib.request.Request(
                cfg.endpoint,
                data=json.dumps(body).encode('utf-8'),
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {cfg.api_key}',
                },
                method='POST',
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            content = data['choices'][0]['message']['content']
            if isinstance(content, list):
                content = ''.join(p.get('text', '') for p in content)
            parsed = extract_json(str(content))
            blocks: list[ScreenBlock] = []
            for b in parsed.get('blocks', []):
                bbox = _norm_bbox(b.get('bbox'))
                original = str(b.get('original') or '').strip()
                translation = str(b.get('translation') or '').strip()
                if not bbox or (not original and not translation):
                    continue
                blocks.append(ScreenBlock(bbox=bbox, original=original, translation=translation))
            # 按阅读顺序：先上后下
            blocks.sort(key=lambda b: (b.bbox[1], b.bbox[0]))
            return blocks
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode('utf-8', 'ignore')[:200]
            last_error = f'HTTP {exc.code}: {detail}'
            if exc.code in (401, 403):
                break
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)

    raise RuntimeError(f'截图翻译失败：{last_error}')


def blocks_to_json(blocks: list[ScreenBlock]) -> str:
    return json.dumps(
        [{'bbox': b.bbox, 'original': b.original, 'translation': b.translation} for b in blocks],
        ensure_ascii=False,
    )


def parse_blocks(raw: str) -> list[dict]:
    data = json.loads(raw)
    out = []
    for b in data:
        bbox = _norm_bbox(b.get('bbox'))
        if not bbox:
            continue
        out.append({'bbox': bbox, 'original': b.get('original', ''), 'translation': b.get('translation', '')})
    return out
