"""Kimodo（文章から SOMA の動きを作るモデル）の動きを中間形式にする。Kimodo の .venv の Python で動かす（Kimodo のリポジトリは変えない）:

    <Kimodo>/.venv/Scripts/python.exe tools/compose/kimodo_gen.py jobs.json

jobs.json: [{"prompt": ["...", ...], "seconds": [5, ...], "seed": 1, "steps": 100, "transition": 15, "out": "x.npz"}]
または {"npz": "Kimodo の NPZ", "out": "x.npz"}（作ってある NPZ を移し替えるだけ。モデルを読まない）。

環境変数は HF_HUB_CACHE、TEXT_ENCODER_DEVICE=cpu、TEXT_ENCODER_MODE=local。生成は CUDA。
文章のエンコーダはきゃらすたの作業プロセスと同じ（tools/kimodo_text_encoder.py、docs/motion-text.md）。CHARASTA_KIMODO_ENCODER が
stream（既定）か stream-cpu なら、埋め込みを CHARASTA_KIMODO_EMBED_DIR（compose.py は作業フォルダの cache/kimodo-embeddings を渡す）に覚え、
無い文章だけを別プロセスで層ごとに符号化する。cpu は今までの経路（エンコーダを CPU に丸ごと読む。RAM を最大 14〜15.5 GB）。
空きの RAM が CHARASTA_KIMODO_MIN_FREE_GB（既定は lib/motion-text.mjs の RAM_GB と同じ）より少なければ読み込まずに止まる。
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(1, str(Path(__file__).resolve().parent.parent))
import clip as C  # noqa: E402
import kimodo_text_encoder as kte  # noqa: E402
from soma_vrma import retarget  # noqa: E402

MODEL = "Kimodo-SOMA-RP-v1.2"


def mat_to_quat(m):
    from scipy.spatial.transform import Rotation
    shape = m.shape[:-2]
    return Rotation.from_matrix(m.reshape(-1, 3, 3)).as_quat().reshape(shape + (4,))


def to_clip(npz, skeleton):
    """Kimodo の動きを中間形式にする。NPZ は 77 関節で、BONES が使う分だけを使う。"""
    names = list(skeleton.bone_order_names)
    parents = skeleton.joint_parents.numpy().tolist()
    rest = skeleton.neutral_joints.numpy().astype(np.float64)   # T ポーズのワールドの位置（Hips が原点）
    offsets = rest.copy()
    for j, p in enumerate(parents):
        if p >= 0:
            offsets[j] = rest[j] - rest[p]
    rest_local = np.zeros((len(names), 7))
    rest_local[:, :3] = offsets
    rest_local[:, 6] = 1.0
    # T ポーズで足の裏が床に着く hips の高さ
    hips_height = float(-min(rest[names.index("LeftToeEnd"), 1], rest[names.index("RightToeEnd"), 1]))
    rest_local[0, 1] = hips_height
    rots = np.asarray(npz["local_rot_mats"], dtype=np.float64)
    frames = np.zeros(rots.shape[:2] + (7,))
    frames[:, :, :3] = offsets[None]
    frames[:, 0, :3] = np.asarray(npz["root_positions"], dtype=np.float64)
    frames[:, :, 3:] = mat_to_quat(rots)
    motion = retarget(names, parents, rest_local, frames, C.FPS, root_motion="keep")
    fc = np.asarray(npz["foot_contacts"], dtype=np.float64)   # 6 列: 左かかと、左爪先、左爪先の端、右かかと、右爪先、右爪先の端
    if fc.shape[1] == 6:
        fc = fc[:, [0, 1, 3, 4]]
    return C.make(motion["rotations"], motion["hips"] * (C.HIPS_HEIGHT / hips_height), fc)


MODE = os.environ.get("CHARASTA_KIMODO_ENCODER", "stream")
RAM_GB = {"cpu": 16, "stream": kte.RAM_GB_LOAD_AND_ENCODE}   # 読み込み前に要る RAM の空き(lib/motion-text.mjs の RAM_GB と同じ)


def load_model(prompts):
    """Kimodo を読む。stream なら、先に作る文章を全部符号化してキャッシュに入れる(エンコーダの子プロセスは 1 回)"""
    import psutil
    need = float(os.environ.get("CHARASTA_KIMODO_MIN_FREE_GB") or RAM_GB["cpu" if MODE == "cpu" else "stream"])
    free = psutil.virtual_memory().available / 2**30
    if free < need:
        raise SystemExit(f"空きの RAM が {free:.1f} GB で足りない（{need:g} GB 要る）。空くのを待って動かし直す")
    from kimodo import load_model as load
    if MODE == "cpu":
        return load(MODEL, device="cuda:0", default_family="Kimodo")
    cache = kte.EmbeddingCache(os.environ["CHARASTA_KIMODO_EMBED_DIR"], "cpu" if MODE == "stream-cpu" else "cuda")
    encoder = kte.CachedTextEncoder(cache, log=lambda s: print(s, flush=True))
    from kimodo.sanitize import sanitize_texts   # Kimodo は text_encoder を呼ぶ前にこれをかける。鍵はかけた後の文章
    encoder.prepare(sanitize_texts(prompts))
    return load(MODEL, device="cuda:0", default_family="Kimodo", text_encoder=encoder)


def main():
    jobs = json.load(open(sys.argv[1], encoding="utf8"))
    from kimodo.skeleton import SOMASkeleton77
    skeleton = SOMASkeleton77()
    model = None
    report = []
    for job in jobs:
        t = time.perf_counter()
        if "npz" in job:
            npz = dict(np.load(job["npz"], allow_pickle=True))
        else:
            if model is None:
                model = load_model([p for j in jobs if "npz" not in j for p in j["prompt"]])
                print(f"モデルを読み込んだ（{time.perf_counter() - t:.0f} 秒）", flush=True)
                t = time.perf_counter()
            from kimodo.tools import seed_everything
            seed_everything(job.get("seed", 1))
            frames = [int(round(s * model.fps)) for s in job["seconds"]]
            out = model(job["prompt"], frames, constraint_lst=[], num_denoising_steps=job.get("steps", 100), num_samples=1, multi_prompt=True,
                        num_transition_frames=job.get("transition", 15 if len(frames) > 1 else 5), post_processing=True, return_numpy=True)
            npz = {k: (v[0] if hasattr(v, "shape") and len(v.shape) > 0 and v.shape[0] == 1 else v) for k, v in out.items()}
        m = to_clip(npz, skeleton)
        C.save(job["out"], m)
        report.append({"out": job["out"], "frames": C.frames(m), "generateSec": round(time.perf_counter() - t, 2)})
        print(json.dumps(report[-1], ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
