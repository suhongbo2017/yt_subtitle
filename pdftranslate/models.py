"""模型注册表：可在界面里增删改，持久化到 models.json / secrets.json。

解析顺序（Key）：secrets.json 里的 api_key → 模型条目的 key_env 环境变量 → VISION_API_KEY
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_FILE = ROOT / 'models.json'
SECRETS_FILE = ROOT / 'secrets.json'


def load_dotenv() -> None:
    """把项目根目录 .env 读进环境变量（config 与 models 共用）。"""
    env_file = ROOT / '.env'
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

DEFAULT_MODELS: list[dict] = [
    {
        'id': 'qwen',
        'label': 'Qwen3-VL-Plus',
        'base_url': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'model': 'qwen3-vl-plus',
        'key_env': 'DASHSCOPE_API_KEY',
        'proxy': False,
        'note': '阿里云百炼，国内直连，性价比高',
    },
    {
        'id': 'gemini',
        'label': 'Gemini 2.5 Flash',
        'base_url': 'https://generativelanguage.googleapis.com/v1beta/openai',
        'model': 'gemini-2.5-flash',
        'key_env': 'GEMINI_API_KEY',
        'proxy': True,
        'note': '手写识别最强；免费额度 20 次/天',
    },
    {
        'id': 'openai',
        'label': 'GPT-4.1 mini',
        'base_url': 'https://api.openai.com/v1',
        'model': 'gpt-4.1-mini',
        'key_env': 'OPENAI_API_KEY',
        'proxy': True,
        'note': '需要代理',
    },
    {
        'id': 'glm',
        'label': 'GLM-4.5V',
        'base_url': 'https://open.bigmodel.cn/api/paas/v4',
        'model': 'glm-4.5v',
        'key_env': 'ZHIPU_API_KEY',
        'proxy': False,
        'note': '智谱，国内直连',
    },
]

BUILTIN_IDS = {m['id'] for m in DEFAULT_MODELS}


@dataclass
class ModelEntry:
    id: str
    label: str = ''
    base_url: str = ''
    model: str = ''
    key_env: str = ''
    proxy: bool = False
    note: str = ''
    api_key: str = field(default='', repr=False)  # 仅内部使用，不下发到界面

    @property
    def builtin(self) -> bool:
        return self.id in BUILTIN_IDS

    @property
    def endpoint(self) -> str:
        base = self.base_url.rstrip('/')
        return base if base.endswith('/chat/completions') else f'{base}/chat/completions'

    def public(self) -> dict:
        data = asdict(self)
        data.pop('api_key', None)
        data['builtin'] = self.builtin
        data['has_key'] = bool(self.api_key)
        return data


def _read_json(path: Path, fallback: dict) -> dict:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return fallback


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def _secrets() -> dict[str, str]:
    return _read_json(SECRETS_FILE, {})


def _save_secrets(data: dict[str, str]) -> None:
    _write_json(SECRETS_FILE, data)


def load_registry() -> dict:
    """返回 {'models': [...], 'default': 'qwen'}，首次运行写入默认值。"""
    data = _read_json(MODELS_FILE, {})
    models: list[dict] = data.get('models') or []
    known = {m.get('id') for m in models}
    # 新版本新增的内置模型自动补齐，不覆盖用户改过的
    for default in DEFAULT_MODELS:
        if default['id'] not in known:
            models.append(dict(default))
    if not models:
        models = [dict(m) for m in DEFAULT_MODELS]
    default_id = data.get('default') or models[0]['id']
    if default_id not in {m['id'] for m in models}:
        default_id = models[0]['id']
    registry = {'models': models, 'default': default_id}
    if not MODELS_FILE.exists():
        _write_json(MODELS_FILE, registry)
    return registry


def entries() -> list[ModelEntry]:
    load_dotenv()
    secrets = _secrets()
    out: list[ModelEntry] = []
    for raw in load_registry()['models']:
        key = (
            (secrets.get(raw['id']) or '').strip()
            or os.getenv(raw.get('key_env') or '', '')
            or os.getenv('VISION_API_KEY', '')
        )
        out.append(
            ModelEntry(
                id=raw['id'],
                label=raw.get('label') or raw['id'],
                base_url=raw.get('base_url') or '',
                model=raw.get('model') or '',
                key_env=raw.get('key_env') or '',
                proxy=bool(raw.get('proxy')),
                note=raw.get('note') or '',
                api_key=key,
            )
        )
    return out


def get(model_id: str) -> ModelEntry | None:
    for entry in entries():
        if entry.id == model_id:
            return entry
    return None


def default_id() -> str:
    return load_registry()['default']


def upsert(payload: dict) -> ModelEntry:
    """新增或更新；payload 里给 api_key 时写入 secrets.json。"""
    model_id = (payload.get('id') or '').strip()
    if not model_id:
        raise ValueError('id 不能为空')
    if not model_id.replace('-', '').replace('_', '').isalnum():
        raise ValueError('id 只能用字母、数字、- 和 _')

    registry = load_registry()
    models = registry['models']
    record = {
        'id': model_id,
        'label': (payload.get('label') or model_id).strip(),
        'base_url': (payload.get('base_url') or '').strip(),
        'model': (payload.get('model') or '').strip(),
        'key_env': (payload.get('key_env') or '').strip(),
        'proxy': bool(payload.get('proxy')),
        'note': (payload.get('note') or '').strip(),
    }
    if not record['base_url'] or not record['model']:
        raise ValueError('base_url 和 model 不能为空')

    for i, item in enumerate(models):
        if item['id'] == model_id:
            models[i] = record
            break
    else:
        models.append(record)
    _write_json(MODELS_FILE, registry)

    key = (payload.get('api_key') or '').strip()
    if key:
        secrets = _secrets()
        secrets[model_id] = key
        _save_secrets(secrets)

    entry = get(model_id)
    assert entry is not None
    return entry


def delete(model_id: str) -> bool:
    registry = load_registry()
    before = len(registry['models'])
    registry['models'] = [m for m in registry['models'] if m['id'] != model_id]
    if len(registry['models']) == before:
        return False
    if registry.get('default') == model_id and registry['models']:
        registry['default'] = registry['models'][0]['id']
    _write_json(MODELS_FILE, registry)
    secrets = _secrets()
    if secrets.pop(model_id, None) is not None:
        _save_secrets(secrets)
    return True


def set_default(model_id: str) -> None:
    registry = load_registry()
    if model_id not in {m['id'] for m in registry['models']}:
        raise ValueError('模型不存在')
    registry['default'] = model_id
    _write_json(MODELS_FILE, registry)


def proxy_default() -> str:
    return os.getenv('VISION_PROXY') or os.getenv('HTTPS_PROXY') or os.getenv('https_proxy') or 'http://127.0.0.1:7897'


def test_entry(entry: ModelEntry, timeout: int = 30) -> dict:
    """发一个极小的纯文本请求，验证端点 / Key / 模型名是否可用。"""
    import time

    body = json.dumps(
        {'model': entry.model, 'max_tokens': 4, 'messages': [{'role': 'user', 'content': 'ping'}]}
    ).encode()
    req = urllib.request.Request(
        entry.endpoint,
        data=body,
        method='POST',
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {entry.api_key}'},
    )
    proxy = proxy_default() if entry.proxy else ''
    opener = (
        urllib.request.build_opener(
            urllib.request.ProxyHandler({'http': proxy, 'https': proxy})
        )
        if proxy
        else urllib.request.build_opener()
    )
    started = time.time()
    try:
        with opener.open(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode('utf-8', 'ignore'))
        latency = round((time.time() - started) * 1000)
        reply = ''
        try:
            reply = str(data['choices'][0]['message']['content'])[:60]
        except (KeyError, IndexError, TypeError):
            reply = ''
        return {'ok': True, 'latency_ms': latency, 'reply': reply, 'model': entry.model}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', 'ignore')[:220]
        return {'ok': False, 'error': f'HTTP {exc.code}: {detail}', 'model': entry.model}
    except Exception as exc:  # noqa: BLE001
        return {'ok': False, 'error': f'{type(exc).__name__}: {exc}', 'model': entry.model}
