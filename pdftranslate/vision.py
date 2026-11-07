"""调用视觉大模型：一页图片 → 结构化转写 + 译文。"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from .config import Config

SYSTEM_PROMPT = """你是专业的档案文献转写与翻译助手。用户给出一页手写或打印的扫描件。

分两步做，但只输出一个 JSON：
1) 逐行转写：把页面上每一行文字按视觉顺序转写成 lines 数组，保留原始换行，一行一条。
2) 按语段组织：把 lines 组合成 blocks，一个自然段 / 一个独立要素（日期、称呼、署名、批注、印章）算一个 block，不要合并两个不同的自然段。

转写规则：
- 手写体按最可能的读法转写；不确定的单词保留最可能拼写并把该行放进 uncertain。
- 常见专有名词按语义判断（例如手写看起来像 "Lee Alamos" 的，若上下文是新墨西哥州军事/科研设施，应为 "Los Alamos"），但必须在 notes 里说明做过该校正。
- 涂黑处 kind 用 redaction，original 与 translation 都原样写 `[涂黑]`，有可见标注则写 `[涂黑 (b)(6)]`（不要翻译成中文括号，不要猜测被涂黑的内容）。
- 表格：kind 用 table，并把内容放进 rows（二维数组，每行一个数组，单元格写**译文**）；
  如果首行是表头，header 设为 true；original_rows 放原文单元格（可选）。
  绝对不要把表格行用制表符或空格拼成一段 paragraph。
- 方向词、数字、日期、编号、人名是关键信息：转写完成后回看一遍图片复核，确认没有左右/东西方向颠倒、数字看错。
- 保留原文大小写与拼写错误，不做"修正"；打字机的多余空格合并，但不要改动措辞。

翻译规则：
- 每块译文用{target}，公文体但不生硬。
- 人名、机构名、地名、型号保留英文原文，首次出现时括号内给中文。
- 数字、日期、编号原样保留；方向词（southwest/northeast 等）务必逐一对应，不要改写。

输出格式（只输出 JSON，不要 Markdown 代码块、不要解释）：
{{"lines":["..."],"blocks":[{{"kind":"header|date|addressee|subject|paragraph|signature|annotation|stamp|redaction|other","original":"原文，保留换行","translation":"译文","bbox":[0.12,0.18,0.88,0.27]}}],"uncertain":["..."],"notes":"..."}}

表格块的示范：{{"kind":"table","header":true,"rows":[["编号","日期","时间"],[".205","1950年3月22日","00:10"]],"original_rows":[["Number","Date","Time"],[".205","22 Mar 1950","0010"]],"bbox":[0.05,0.2,0.95,0.6]}}

bbox 是该块在页面上的外接矩形，用归一化坐标 [左, 上, 右, 下]，以整页宽高为 1（左上角为 0,0）。
必须给出尽量贴合的 bbox：它会被用来把译文覆盖到原位置，坐标不准会导致文字错位或压住其他内容。"""


@dataclass
class Block:
    kind: str
    original: str
    translation: str
    # 归一化坐标 [left, top, right, bottom]，0-1，用于 HTML 覆盖式排版
    bbox: list[float] | None = None
    # kind == 'table' 时的表格内容：rows 是译文单元格，original_rows 是原文单元格
    rows: list[list[str]] | None = None
    original_rows: list[list[str]] | None = None
    header: bool = False
    # 'model' = 模型给的坐标；'text' = 用 PDF 文本层校准过的坐标
    bbox_source: str = 'model'

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> 'Block':
        return cls(
            kind=data.get('kind', 'paragraph'),
            original=data.get('original', ''),
            translation=data.get('translation', ''),
            bbox=data.get('bbox'),
            rows=data.get('rows'),
            original_rows=data.get('original_rows'),
            header=bool(data.get('header') or False),
            bbox_source=data.get('bbox_source') or 'model',
        )


@dataclass
class PageResult:
    page: int
    blocks: list[Block] = field(default_factory=list)
    uncertain: list[str] = field(default_factory=list)
    notes: str = ''
    model: str = ''
    error: str = ''

    @property
    def ok(self) -> bool:
        return bool(self.blocks) and not self.error

    def to_dict(self) -> dict[str, Any]:
        return {
            'page': self.page,
            'model': self.model,
            'error': self.error,
            'notes': self.notes,
            'uncertain': self.uncertain,
            'blocks': [b.__dict__ for b in self.blocks],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> 'PageResult':
        return cls(
            page=data.get('page', 0),
            blocks=[Block.from_dict(b) for b in data.get('blocks', [])],
            uncertain=list(data.get('uncertain') or []),
            notes=data.get('notes') or '',
            model=data.get('model') or '',
            error=data.get('error') or '',
        )


def extract_json(text: str) -> dict[str, Any]:
    """尽量从模型输出里挖出 JSON 对象。"""
    cleaned = text.strip()
    cleaned = re.sub(r'^```(?:json)?\s*', '', cleaned)
    cleaned = re.sub(r'\s*```$', '', cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    start, end = cleaned.find('{'), cleaned.rfind('}')
    if start >= 0 and end > start:
        return json.loads(cleaned[start : end + 1])
    raise ValueError(f'模型没有返回 JSON：{text[:200]}')


def _opener(cfg: Config):
    if cfg.proxy:
        handler = urllib.request.ProxyHandler({'http': cfg.proxy, 'https': cfg.proxy})
        return urllib.request.build_opener(handler)
    return urllib.request.build_opener()


def _post(cfg: Config, body: dict[str, Any]) -> dict[str, Any]:
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(
        cfg.endpoint,
        data=data,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {cfg.api_key}',
            **cfg.extra_headers,
        },
        method='POST',
    )
    with _opener(cfg).open(req, timeout=cfg.timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _build_body(cfg: Config, model: str, page_uri: str, page_no: int) -> dict[str, Any]:
    return {
        'model': model,
        'temperature': 0.1,
        'max_tokens': 8192,
        'response_format': {'type': 'json_object'},
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT.format(target=cfg.target_lang)},
            {
                'role': 'user',
                'content': [
                    {'type': 'text', 'text': f'这是第 {page_no} 页，请转写并翻译。'},
                    {'type': 'image_url', 'image_url': {'url': page_uri}},
                ],
            },
        ],
    }


def _norm_bbox(raw: Any, image_size: tuple[int, int] | None = None) -> list[float] | None:
    """校验并归一化模型给的坐标；不合法的直接丢弃，宁可不覆盖也不要错位。

    模型有时给归一化值，有时给像素值，这里两种都接受：
    只要有任意分量大于 1，就按图片实际宽高换算（需要 image_size）。
    """
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    try:
        vals = [float(v) for v in raw]
    except (TypeError, ValueError):
        return None

    if max(vals) > 1.02:
        if not image_size:
            return None
        w, h = image_size
        if max(vals) > max(w, h) * 1.05:
            return None
        # x 分量按宽、y 分量按高换算
        vals = [vals[0] / w, vals[1] / h, vals[2] / w, vals[3] / h]

    if any(v < -0.02 or v > 1.02 for v in vals):
        return None
    left, top, right, bottom = vals
    if right - left < 0.02 or bottom - top < 0.005:
        return None
    return [max(0.0, left), max(0.0, top), min(1.0, right), min(1.0, bottom)]


def _norm_rows(raw: Any) -> list[list[str]] | None:
    """表格单元格二维数组；行内长度不齐时补空串。"""
    if not isinstance(raw, list) or not raw:
        return None
    out: list[list[str]] = []
    for row in raw:
        if isinstance(row, (list, tuple)):
            out.append([str(c).strip() if c is not None else '' for c in row])
        elif row is not None:
            out.append([str(row).strip()])
    width = max((len(r) for r in out), default=0)
    if width < 2:
        return None
    return [r + [''] * (width - len(r)) for r in out]


def _parse(content: Any, page_no: int, model: str, image_size: tuple[int, int] | None = None) -> PageResult:
    if isinstance(content, list):  # 少数实现返回分段数组
        content = ''.join(part.get('text', '') for part in content)
    parsed = extract_json(str(content))
    blocks = [
        Block(
            kind=str(b.get('kind') or 'paragraph'),
            original=str(b.get('original') or '').strip(),
            translation=str(b.get('translation') or '').strip(),
            bbox=_norm_bbox(b.get('bbox'), image_size),
            rows=_norm_rows(b.get('rows')),
            original_rows=_norm_rows(b.get('original_rows')),
            header=bool(b.get('header') or False),
        )
        for b in parsed.get('blocks', [])
        if str(b.get('original') or '').strip()
        or str(b.get('translation') or '').strip()
        or b.get('rows')
    ]
    return PageResult(
        page=page_no,
        blocks=blocks,
        uncertain=[str(x) for x in parsed.get('uncertain', []) or []],
        notes=str(parsed.get('notes') or ''),
        model=model,
    )


def _should_try_next_model(error: str) -> bool:
    lowered = error.lower()
    return any(token in lowered for token in ('model_not_found', 'unknown model', 'does not exist',
                                              'not found', 'access_denied', 'permission', 'not supported'))


def transcribe_page(
    page_png_data_uri: str,
    page_no: int,
    cfg: Config,
    image_size: tuple[int, int] | None = None,
) -> PageResult:
    if cfg.mock:
        from .mock import mock_page

        return mock_page(page_no)

    last_error = ''
    for model in cfg.candidates:
        # 每轮先带 response_format，失败后再去掉（部分端点不支持）
        for attempt in range(4):
            body = _build_body(cfg, model, page_png_data_uri, page_no)
            if attempt >= 2:
                body.pop('response_format', None)
            try:
                resp = _post(cfg, body)
                return _parse(resp['choices'][0]['message']['content'], page_no, model, image_size)
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode('utf-8', 'ignore')[:300]
                last_error = f'HTTP {exc.code}: {detail}'
                if exc.code == 429:
                    retry_after = exc.headers.get('retry-after') if exc.headers else None
                    wait = float(retry_after) if retry_after and retry_after.isdigit() else (4 * (attempt + 1) ** 2)
                    print(f'    限流，{wait:.0f}s 后重试（第 {attempt + 1} 次）')
                    time.sleep(min(wait, 60))
                    continue
                if exc.code in (401, 403) and _should_try_next_model(detail):
                    break  # 换下一个模型
                if exc.code in (401, 403):
                    return PageResult(page=page_no, model=model, error=last_error)
                if exc.code == 404:
                    break
                continue
            except Exception as exc:  # noqa: BLE001 - 网络/解析错误都重试一次
                last_error = str(exc)
                continue

    return PageResult(page=page_no, model=cfg.model, error=last_error or 'unknown error')
