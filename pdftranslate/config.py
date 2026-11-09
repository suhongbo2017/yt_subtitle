"""配置：环境变量 / .env / 模型注册表（models.json）三者合一。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from . import models as registry

ROOT = Path(__file__).resolve().parent.parent
_load_dotenv = registry.load_dotenv


# 兼容旧代码：界面里新增的模型走 models.json，这里保留内置预设做兜底
DEFAULT_PROVIDER = 'qwen'


@dataclass
class Config:
    provider: str = DEFAULT_PROVIDER
    label: str = ''
    base_url: str = ''
    api_key: str = ''
    model: str = ''
    target_lang: str = '简体中文'
    dpi: int = 250
    max_side: int = 2200
    concurrency: int = 2
    # 实测 Gemini 在密集表格页要 160s+，180 太贴线
    timeout: int = 300
    proxy: str = ''
    mock: bool = False
    extra_headers: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls, provider: str | None = None, **overrides) -> 'Config':
        _load_dotenv()
        name = (provider or os.getenv('VISION_PROVIDER') or registry.default_id()).strip()
        entry = registry.get(name)
        if entry is None:
            known = ', '.join(m.id for m in registry.entries())
            raise SystemExit(f'未知的模型 id：{name}。可用：{known}')

        proxy_env = os.getenv('VISION_PROXY') or os.getenv('HTTPS_PROXY') or os.getenv('https_proxy')
        proxy = proxy_env or (registry.proxy_default() if entry.proxy else '')

        cfg = cls(
            provider=entry.id,
            label=entry.label,
            base_url=os.getenv('VISION_BASE_URL') or entry.base_url,
            api_key=entry.api_key,
            model=os.getenv('VISION_MODEL') or entry.model,
            proxy=proxy or '',
        )
        for key, value in overrides.items():
            if value is not None:
                setattr(cfg, key, value)
        return cfg

    @classmethod
    def from_model(cls, model_id: str, **overrides) -> 'Config':
        return cls.from_env(provider=model_id, **overrides)

    @property
    def endpoint(self) -> str:
        base = self.base_url.rstrip('/')
        return base if base.endswith('/chat/completions') else f'{base}/chat/completions'

    @property
    def candidates(self) -> list[str]:
        return [self.model] if self.model else []
