"""tools/ の Python が使う外の道具の場所探し。OS を問わず同じ呼び方にする。

場所は環境変数か引数で受け取る(Node 側の lib/motion-recipe.mjs などが、きゃらすたの設定から渡す)。
作者の機械の場所は既定に持たない。無いものは None を返し、使う側が「設定が要る」と断る。
"""
import os
import shutil
import sys
from pathlib import Path

IS_WIN = os.name == "nt"


def venv_python(directory):
    """<directory>/.venv の python(Windows は Scripts/python.exe、それ以外は bin/python)。"""
    d = Path(directory)
    return d / ".venv" / "Scripts" / "python.exe" if IS_WIN else d / ".venv" / "bin" / "python"


def env_value(*names):
    """最初に見つかった環境変数の値(空は無いものとみなす)。無ければ None。"""
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return None


def need(value, what, env_name):
    """value が None なら、設定が要ることを伝えて終わる。"""
    if not value:
        raise SystemExit(f"{what} の場所が分からない。きゃらすたの設定(config.json)か、環境変数 {env_name} で指定する")
    return value


def find_blender():
    """Blender: 環境変数 VRMA_BLENDER / CHARASTA_BLENDER、PATH の blender、Windows の Program Files の最新版、macOS の /Applications の順。無ければ None。"""
    given = env_value("VRMA_BLENDER", "CHARASTA_BLENDER")
    if given:
        return given
    found = shutil.which("blender")
    if found:
        return found
    if IS_WIN:
        base = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Blender Foundation"
        if base.is_dir():
            def ver(p):
                return tuple(int(x) for x in p.name.split()[-1].split(".") if x.isdigit())
            for d in sorted((p for p in base.glob("Blender *") if (p / "blender.exe").is_file()), key=ver, reverse=True):
                return str(d / "blender.exe")
    elif sys.platform == "darwin":
        mac = Path("/Applications/Blender.app/Contents/MacOS/Blender")
        if mac.is_file():
            return str(mac)
    return None


def default_library():
    """保管場所の既定(lib/platform.mjs の defaultLibraryDir と同じ場所)。"""
    home = Path.home()
    if IS_WIN:
        return Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local") / "charasta" / "library"
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "charasta" / "library"
    return Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share") / "charasta" / "library"
