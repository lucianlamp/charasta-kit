"""Windows と macOS で同じに動かすための、外部ツールと置き場所の探し方。Blender の外で動く tools/*.py が使う。
Blender、ffmpeg、きゃらすたの保管場所、きゃらすたの本体(root)を、環境変数、引数、標準の場所の順に探す。見つからなければ、何を設定すればよいかを書いて止まる。"""
import glob
import os
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _env(*names):
    """空文字は未設定と見なす"""
    for n in names:
        v = os.environ.get(n)
        if v and v.strip():
            return v.strip()
    return None


def _version_key(p):
    m = re.search(r'Blender (\d+)(?:\.(\d+))?', str(p).replace('\\', '/'))
    return (int(m.group(1)), int(m.group(2) or 0)) if m else (0, 0)


def find_blender():
    """環境変数 BLENDER、PATH の blender、Windows の標準の場所の新しい版、macOS の /Applications の順"""
    v = _env('BLENDER')
    if v:
        return v
    v = shutil.which('blender')
    if v:
        return v
    found = sorted(glob.glob('C:/Program Files/Blender Foundation/Blender */blender.exe'), key=_version_key)
    if found:
        return found[-1]
    mac = '/Applications/Blender.app/Contents/MacOS/Blender'
    if os.path.exists(mac):
        return mac
    raise SystemExit('Blender が見つからない。環境変数 BLENDER に blender の実行ファイルを指定するか、PATH に blender を置いてほしい')


def find_ffmpeg():
    """環境変数 CHARASTA_FFMPEG か FFMPEG、無ければ PATH の ffmpeg"""
    return _env('CHARASTA_FFMPEG', 'FFMPEG') or 'ffmpeg'


def library(arg=None):
    """引数 --library、無ければ環境変数 CHARASTA_LIBRARY"""
    v = arg or _env('CHARASTA_LIBRARY')
    if not v:
        raise SystemExit('きゃらすたの保管場所が分からない。環境変数 CHARASTA_LIBRARY か引数 --library で指定してほしい')
    return Path(v)


def charasta_root(arg=None):
    """引数 --charasta、環境変数 CHARASTA_ROOT、stage-studio がキットの中(<kit>/stage-studio)にあるときはその <kit> の順"""
    v = arg or _env('CHARASTA_ROOT')
    if v:
        return Path(v)
    parent = ROOT.parent
    if (parent / 'tools' / 'common.mjs').exists():
        return parent
    raise SystemExit('きゃらすたの場所が分からない。環境変数 CHARASTA_ROOT か引数 --charasta で指定してほしい(stage-studio をキットの中に置いた場合は自動で見つかる)')
