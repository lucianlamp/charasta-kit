"""フォルダの中の FBX を全部、移し替えられるか確かめて一覧にする。

    python tools/compose/fbx_check.py DIR --work WORK --out report.json

動いた FBX はコマ数・使った骨の表・進んだ距離を、動かなかった FBX は理由を書く。素材は書き換えない。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clip as C  # noqa: E402
from fbx_clip import fbx_to_clip, find_rest  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import charasta_paths as P  # noqa: E402

BLENDER = P.find_blender()   # 環境変数 VRMA_BLENDER、PATH、標準の場所の順。無ければ None


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("dir")
    p.add_argument("--work", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    work = Path(a.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    files = sorted(f for f in Path(a.dir).rglob("*") if f.suffix.lower() == ".fbx")
    jobs = [{"fbx": f.as_posix(), "rest": find_rest(f), "out": str(work / f"{k:03d}.npz")} for k, f in enumerate(files)]
    (work / "jobs.json").write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf8")
    subprocess.run([P.need(BLENDER, "Blender", "VRMA_BLENDER"), "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", str(Path(__file__).with_name("fbx_dump.py")), "--",
                    str(work / "jobs.json"), str(work / "result.json")], check=True, stdout=subprocess.DEVNULL)
    rows = []
    for job, x in zip(jobs, json.loads((work / "result.json").read_text(encoding="utf8"))):
        row = {"file": Path(job["fbx"]).name, "ok": x["ok"]}
        if not x["ok"]:
            rows.append({**row, "error": x["error"]})
            continue
        try:
            m, info = fbx_to_clip(job["out"])
        except ValueError as e:
            rows.append({**row, "ok": False, "error": str(e)})
            continue
        m = C.ground(m)
        rows.append({**row, "frames": x["frames"], "skeleton": x["kind"], "rest": job["rest"] and Path(job["rest"]).name, **info,
                     "travelM": round(float(np.linalg.norm((m["hips"][-1] - m["hips"][0])[[0, 2]])), 2)})
    Path(a.out).write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf8")
    good = [r for r in rows if r["ok"]]
    print(f"{len(good)} / {len(rows)} 本を移し替えられる")
    for r in rows:
        if not r["ok"]:
            print(" ", r["file"], r["error"])


if __name__ == "__main__":
    main()
