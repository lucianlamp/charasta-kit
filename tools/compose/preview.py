"""compose.py の結果を確かめ用の保管場所に取り込み、キャラに当てて横と正面を並べた動画を作る。本番の保管場所には書かない。

    python tools/compose/preview.py DIR --id compose-1 --label ... --config viewer.config.json --char avatar-sample-b --ver v2-official

viewer.config.json の port で自分のサーバーを立て、終わったらその PID だけを止める。撮影は tools/motion_shots.mjs（ANGLE d3d11 の GPU）。
DIR/shots にコマと測った値、DIR/preview.mp4 に動画を書く。ffmpeg は h264_nvenc を使い、使えなければ libx264 に落とす。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent


def encode(args, out):
    """入力の引数 args から mp4 を書く。返すのは使ったエンコーダ。"""
    for codec, opts in (("h264_nvenc", ["-preset", "p5", "-cq", "21"]), ("libx264", ["-crf", "20"])):
        r = subprocess.run(["ffmpeg", "-y", "-v", "error", *args, "-c:v", codec, *opts, "-pix_fmt", "yuv420p", str(out)], capture_output=True, text=True, errors="replace")
        if r.returncode == 0:
            return codec
        print(codec, "が使えない:", r.stderr.strip().split("\n")[-1], flush=True)
    raise RuntimeError("ffmpeg が失敗した")


def stacked(shots, motion, out, views=("side", "front")):
    inputs, chains = [], []
    for k, view in enumerate(views):
        fs = sorted(shots.glob(f"{motion}-{view}-t*.jpg"), key=lambda p: float(re.search(r"-t([\d.]+)\.jpg", p.name)[1]))
        lst = shots / f"{view}.txt"
        lst.write_text("".join(f"file '{p.as_posix()}'\nduration 0.033333\n" for p in fs), encoding="utf8")
        inputs += ["-f", "concat", "-safe", "0", "-i", str(lst)]
        chains.append(f"[{k}:v]fps=30[v{k}]")
    return encode([*inputs, "-filter_complex", ";".join(chains) + ";" + "".join(f"[v{k}]" for k in range(len(views))) + "hstack"], out)


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("dir")
    p.add_argument("--id", required=True)
    p.add_argument("--label", default="")
    p.add_argument("--config", required=True)
    p.add_argument("--char", required=True)
    p.add_argument("--ver", required=True)
    p.add_argument("--skip-import", action="store_true")
    a = p.parse_args()
    d = Path(a.dir).resolve()
    config = Path(a.config).resolve()
    port = json.loads(config.read_text(encoding="utf8"))["port"]
    env = {**os.environ, "CHARASTA_CONFIG": str(config), "W": "480", "H": "540"}
    if not a.skip_import:
        subprocess.run(["node", "scripts/import-motion.mjs", "--id", a.id, "--label", a.label, "--src", str(d / "motion.vrma"), "--license-json", str(d / "license.json"),
                        "--generated-json", str(d / "generated.json"), "--contacts-json", str(d / "contacts.json"), "--pack", "motion-compose"], cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
    log = open(d / "server.log", "w")
    server = subprocess.Popen(["node", "server.mjs"], cwd=ROOT, env=env, stdout=log, stderr=log)
    print("サーバーの PID", server.pid, flush=True)
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/api/motions", timeout=2)
                break
            except OSError:
                time.sleep(0.5)
        shots = d / "shots"
        shots.mkdir(exist_ok=True)
        t = time.perf_counter()
        subprocess.run(["node", "tools/motion_shots.mjs", "--char", a.char, "--ver", a.ver, "--motion", a.id, "--out", str(shots), "--port", str(port), "--every", "0.03333"],
                       cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
        print(f"撮影 {time.perf_counter() - t:.0f} 秒", flush=True)
    finally:
        server.terminate()
        server.wait(10)
        log.close()
    print("エンコーダ", stacked(shots, a.id, d / "preview.mp4"), flush=True)
    print(json.dumps({k: v for k, v in json.loads((shots / f"{a.id}.json").read_text(encoding="utf8")).items() if k != "times"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
