"""安装 Native Messaging 宿主：写清单 + 注册表（HKCU，无需管理员）。

用法：python native/install.py [--uninstall]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOST_NAME = 'com.pi.ytasr'
EXE = ROOT / 'native' / 'ytasr-host.exe'
MANIFEST = ROOT / 'native' / f'{HOST_NAME}.json'
REG_PATH = rf'Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}'


def extension_id() -> str:
    """从 manifest 的 key 推导固定扩展 ID（与 Chrome 的算法一致）。"""
    import base64
    import hashlib

    data = json.loads((ROOT / 'wxt.config.ts').read_text(encoding='utf-8')) if False else None
    del data
    key = None
    built = ROOT / '.output' / 'chrome-mv3' / 'manifest.json'
    if built.exists():
        key = json.loads(built.read_text(encoding='utf-8')).get('key')
    if not key:
        raise SystemExit('找不到扩展 key，请先运行 npm run build')
    der = base64.b64decode(key)
    digest = hashlib.sha256(der).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in digest)


def install() -> int:
    if not EXE.exists():
        print(f'[错误] 找不到 {EXE}')
        print('请先打包：')
        print('  .venv\\Scripts\\python.exe -m PyInstaller --onefile --noconsole --name ytasr-host '
              '--distpath native/dist --workpath .cache/pyi --specpath .cache/pyi native/host.py')
        print('  copy native\\dist\\ytasr-host.exe native\\ytasr-host.exe')
        return 1

    ext_id = extension_id()
    manifest = {
        'name': HOST_NAME,
        'description': 'YouTube 双语字幕 · 本地 ASR 服务启动器',
        'path': str(EXE),
        'type': 'stdio',
        'allowed_origins': [f'chrome-extension://{ext_id}/'],
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')

    import winreg

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REG_PATH) as key:
        winreg.SetValueEx(key, '', 0, winreg.REG_SZ, str(MANIFEST))

    print('已安装 Native Messaging 宿主：')
    print(f'  扩展 ID   : {ext_id}')
    print(f'  宿主程序  : {EXE}')
    print(f'  清单文件  : {MANIFEST}')
    print(f'  注册表    : HKCU\\{REG_PATH}')
    print()
    print('现在弹窗里的「服务」开关就能启动/停止本地 ASR 了。')
    return 0


def uninstall() -> int:
    import winreg

    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, REG_PATH)
        print('已删除注册表项')
    except FileNotFoundError:
        print('注册表项不存在')
    if MANIFEST.exists():
        MANIFEST.unlink()
        print('已删除清单文件')
    return 0


if __name__ == '__main__':
    raise SystemExit(uninstall() if '--uninstall' in sys.argv else install())
