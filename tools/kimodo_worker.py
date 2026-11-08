"""Kimodo（NVIDIA、文章から SOMA の動きを作るモデル）を読み込んだまま待つ作業プロセス。

Kimodo の .venv の Python で動かす（Kimodo のリポジトリは変えない）:

    <Kimodo>/.venv/Scripts/python.exe -u tools/kimodo_worker.py   (macOS / Linux は .venv/bin/python)

標準入力に 1 行 1 件の JSON を受け取り、標準出力に 1 行 1 件の JSON を返す。標準出力に出すのは下の JSON だけで、
ライブラリのログや警告は標準エラーへ回す。標準入力が閉じたら終わる。

要求（id は呼び出し側が付ける数）:
    {"id": 1, "op": "load"}                         モデルを読み込む。読み込み済みなら何もしない
    {"id": 2, "op": "generate", "segments": [{"prompt": "...", "seconds": 6}], "seeds": [11, 12],
     "root": "keep", "speed": 1.2, "outDir": "...", "steps": 100}  seed ごとに outDir/<n>/{motion.vrma, contacts.json, info.json} を書く
                                                    区間に "speed" があれば、その区間はその速さ(0 で止まる)
    {"id": 3, "op": "quit"}
応答:
    {"event": "ready", "pid": N, "fake": false}     起動した
    {"event": "progress", "id": N, "text": "..."}   途中経過
    {"id": N, "ok": true, ...} または {"id": N, "ok": false, "error": "..."}

--fake [high|fail|load-fail|noisy|die|hang] は Kimodo を使わず、決まった作りものの動きを同じ移し替えで書く（テスト用。ふだんの
Python と numpy だけで動く）。high は hips を 2.5 m 持ち上げる、fail は generate が失敗する、load-fail は load が失敗する、
noisy は generate の間に標準出力へ print と fd 1 への書き込みと「null」の行を出す、die は generate の途中でプロセスが終わる、
hang は generate が終わらない。

移し替えは tools/soma_vrma.py（docs/adr/0003-motionbricks-retarget.md）。Kimodo の NPZ は 77 関節で、その
うち BONES が使う 30 関節の部分だけを使う。静止姿勢は T ポーズ。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# 標準出力はプロトコルの JSON だけにする。ライブラリが print しても標準エラーへ流れる
# プロトコルの出力は、標準出力を複製した別のファイルに書く。そのあと fd 1 を標準エラーへ向け直すので、
# Python の print だけでなく C のライブラリが fd 1 へ書いた出力も、応答の行と混ざらず標準エラーへ流れる
PROTO = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr
for _s in (sys.stdin, sys.stderr):
    _s.reconfigure(encoding="utf-8")   # Windows の既定（cp932）にしない

import numpy as np  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from soma_vrma import retarget, write_vrma  # noqa: E402

FPS = 30
MODEL = "Kimodo-SOMA-RP-v1.2"
# 区間をつなぐ重なりのコマ数。Kimodo の既定の 5。15 にすると、重なりの間は前の区間の終わりの姿勢に拘束されるので、短い区間の歩きが進まなくなる
# （実機 2026-10-31、2 秒の手振り + 4 秒の歩き、seed 4 本の平均: 5 で 2.2 m、10 で 1.4 m、15 で 1.0 m。境の関節の動きの滑らかさは 5・8・10・15 で変わらなかった。docs/motion-text.md）
TRANSITION_FRAMES = 5
CONTACT_COLUMNS = ["leftHeel", "leftToe", "rightHeel", "rightToe"]


def send(obj):
    PROTO.write(json.dumps(obj, ensure_ascii=False) + "\n")
    PROTO.flush()


class CachedEncoder:
    """文章の埋め込みを文章ごとに覚える。同じ文章を seed だけ替えて何本も作るとき、エンコード（CPU で 3〜8 秒）を 1 回で済ませる。

    LLM2Vec は batch_size=1 で 1 文ずつ符号化し、返すのは [文の数, 1, 次元]（長さは全部 1）なので、文章ごとの行をそのまま覚えられる。
    """

    def __init__(self, encoder):
        self.encoder = encoder
        self.rows = {}
        self.hits = 0
        self.misses = 0

    def __call__(self, texts):
        import torch
        single = isinstance(texts, str)
        items = [texts] if single else list(texts)
        todo = [t for t in dict.fromkeys(items) if t not in self.rows]
        self.hits += len(items) - len(todo)
        if todo:
            self.misses += len(todo)
            feat, _ = self.encoder(todo)
            for t, row in zip(todo, feat):
                self.rows[t] = row.detach().clone()
        out = torch.stack([self.rows[t] for t in items])
        lengths = [1] * len(items)
        return (out[0], 1) if single else (out, lengths)

    def __getattr__(self, name):
        return getattr(self.encoder, name)


class Kimodo:
    def __init__(self):
        self.model = None
        self.skeleton = None
        self.cache = None
        self.mode = None

    def load(self):
        if self.model is not None:
            return {"loaded": True, "already": True}
        t = time.perf_counter()
        import torch
        from kimodo import load_model
        from kimodo.skeleton import SOMASkeleton77

        mode = os.environ.get("CHARASTA_KIMODO_ENCODER", "stream")
        if mode == "cpu":   # 今までの経路: エンコーダ(Llama 3 8B)を CPU に丸ごと読む。RAM を 14〜15.5 GB 使う
            model = load_model(MODEL, device="cuda:0", default_family="Kimodo")
            self.cache = CachedEncoder(model.text_encoder)
            model.text_encoder = self.cache
        else:   # stream(CUDA)か stream-cpu: 埋め込みはディスクのキャッシュから。無い文章は別プロセスで層ごとに符号化する
            import kimodo_text_encoder as kte
            device = "cpu" if mode == "stream-cpu" else "cuda"
            self.cache = kte.CachedTextEncoder(kte.EmbeddingCache(os.environ["CHARASTA_KIMODO_EMBED_DIR"], device))
            model = load_model(MODEL, device="cuda:0", default_family="Kimodo", text_encoder=self.cache)
        self.mode = mode
        self.model = model
        self.skeleton = SOMASkeleton77()
        self.torch = torch
        return {"loaded": True, "already": False, "loadSec": round(time.perf_counter() - t, 1), "fps": float(model.fps), "encoder": mode}

    def encode(self, prompts, rid):
        """覚えていない文章を先に符号化する(seed ごとの生成の前に 1 回)。今までの経路では何もしない"""
        if self.mode == "cpu":
            return
        from kimodo.sanitize import sanitize_texts   # Kimodo は text_encoder を呼ぶ前にこれをかける。鍵はかけた後の文章
        prompts = sanitize_texts(prompts)
        todo = self.cache.cache.missing(prompts)
        if todo:
            send({"event": "progress", "id": rid, "text": f"文章 {len(todo)} 件を符号化している（層ごとに読む）"})
            self.cache.prepare(prompts)

    def motion(self, segments, seed, steps, speed=None):
        """文章の区間から NPZ 相当の辞書と、SOMA の骨の並びを返す。speed(m/s)があれば、腰を +Z へまっすぐその速さで進ませる(区間の speed が優先)"""
        from kimodo.constraints import Root2DConstraintSet
        from kimodo.tools import seed_everything

        m = self.model
        seed_everything(seed)
        prompts = [s["prompt"] for s in segments]
        frames = [int(round(s["seconds"] * m.fps)) for s in segments]
        constraints = []
        if speed:
            n = sum(frames)
            path = self.torch.zeros(n, 2, device=m.device)
            path[:, 1] = self.torch.as_tensor(root_path(segments, frames, speed, m.fps), device=m.device)
            constraints = [Root2DConstraintSet(self.skeleton, self.torch.arange(n, device=m.device), path)]
        out = m(prompts, frames, constraint_lst=constraints, num_denoising_steps=steps, num_samples=1, multi_prompt=True,
                num_transition_frames=TRANSITION_FRAMES, post_processing=True, return_numpy=True)
        npz = {k: (v[0] if hasattr(v, "shape") and len(v.shape) > 0 and v.shape[0] == 1 else v) for k, v in out.items()}
        return soma_arrays(self.skeleton, npz), np.asarray(npz["foot_contacts"], dtype=float)


SPEED_RAMP_SEC = 0.6  # 区間の速さが変わるとき、この秒をかけて移る。止まる区間の頭でつんのめらない


def root_path(segments, frames, speed, fps):
    """腰の +Z の位置のコマごとの列(m)。区間の speed(0 で止まる)が無ければ speed で進む"""
    v = np.concatenate([np.full(n, s.get("speed", speed), dtype=np.float64) for s, n in zip(segments, frames)])
    k = max(1, int(round(SPEED_RAMP_SEC * fps)))
    v = np.convolve(np.pad(v, (k // 2, k - 1 - k // 2), mode="edge"), np.ones(k) / k, mode="valid")
    return np.concatenate([[0.0], np.cumsum(v[:-1]) / fps])


def mat_to_quat(m):
    from scipy.spatial.transform import Rotation
    shape = m.shape[:-2]
    return Rotation.from_matrix(m.reshape(-1, 3, 3)).as_quat().reshape(shape + (4,))


def soma_arrays(sk, npz):
    """soma_vrma.retarget に渡す (joint_names, parents, rest_local, frames_local)。"""
    names = list(sk.bone_order_names)
    parents = sk.joint_parents.numpy().tolist()
    rest = sk.neutral_joints.numpy().astype(np.float64)   # T ポーズのワールドの位置（Hips が原点）
    offsets = rest.copy()
    for j, p in enumerate(parents):
        if p >= 0:
            offsets[j] = rest[j] - rest[p]
    rest_local = np.zeros((len(names), 7))
    rest_local[:, :3] = offsets
    rest_local[:, 6] = 1.0
    # T ポーズで足の裏が床に着く hips の高さ（爪先の端の関節が床に着くとする）。静止姿勢の hips は約 1.005 m
    rest_local[0, 1] = float(-min(rest[names.index("LeftToeEnd"), 1], rest[names.index("RightToeEnd"), 1]))
    rots = npz["local_rot_mats"].astype(np.float64)
    if rots.shape[1] != len(names):
        raise ValueError(f"関節の数が違う: {rots.shape[1]}")
    frames = np.zeros(rots.shape[:2] + (7,))
    frames[:, :, :3] = offsets[None]
    frames[:, 0, :3] = npz["root_positions"].astype(np.float64)
    frames[:, :, 3:] = mat_to_quat(rots)
    return names, parents, rest_local, frames


def fake_arrays(segments, seed, mode):
    """作りものの動き。seed で足を振る速さが変わる（候補が別の動きになる）。"""
    import motionbricks_gen as mg
    seconds = sum(s["seconds"] for s in segments)
    ns = argparse.Namespace(seconds=seconds, speed=1.0 + (seed % 5) * 0.1)
    names, parents, rest, local, _, contacts = mg.fake_motion(ns)
    if mode == "high":
        local[:, 0, 1] += 2.5
    return (names, parents, rest, local), contacts


def write_candidate(out_dir, n, seed, arrays, contacts, root):
    """retarget して VRMA と contacts.json と info.json を out_dir/n に書き、info を返す。"""
    names, parents, rest, local = arrays
    motion = retarget(names, parents, rest, local, FPS, root_motion=root)
    d = Path(out_dir) / str(n)
    d.mkdir(parents=True, exist_ok=True)
    meta = write_vrma(str(d / "motion.vrma"), motion, generator="charasta kimodo_worker")
    fc = np.asarray(contacts, dtype=float)
    if fc.shape[1] == 6:   # 左かかと、左爪先、左爪先の端、右かかと、右爪先、右爪先の端 から端の 2 列を除く
        fc = fc[:, [0, 1, 3, 4]]
    (d / "contacts.json").write_text(json.dumps({"fps": FPS, "order": CONTACT_COLUMNS, "frames": np.round(fc, 3).tolist()}), encoding="utf8")
    hips = motion["hips"]
    info = {"n": n, "seed": seed, "frames": meta["frames"], "durationSec": meta["durationSec"],
            "hipsMaxM": round(float(hips[:, 1].max()), 3), "hipsMinM": round(float(hips[:, 1].min()), 3),
            "travelM": round(float(np.linalg.norm(hips[-1, [0, 2]] - hips[0, [0, 2]])), 3)}
    (d / "info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf8")
    return info


def handle(req, kimodo, fake):
    op = req.get("op")
    rid = req.get("id")
    if op == "load":
        if fake == "load-fail":
            raise RuntimeError("試しの動き: モデルを読み込めない")
        if fake:
            return {"loaded": True, "already": False, "loadSec": 0.0}
        return kimodo.load()
    if op == "generate":
        if fake == "fail":
            raise RuntimeError("試しの動き: Kimodo が失敗した")
        if fake == "die":
            os._exit(3)
        if fake == "hang":
            time.sleep(3600)
        if fake == "noisy":   # ライブラリが標準出力へ出す物を真似る。応答の行に混ざってはいけない
            print("print のノイズ")
            os.write(1, "C の層のノイズ\n".encode("utf-8"))
            # 応答と同じ形の行が fd 1 へ漏れても、応答にならない(dup2 が無ければ、この行が応答として読まれて失敗する)
            os.write(1, (json.dumps({"id": rid, "ok": False, "error": "漏れた出力"}, ensure_ascii=False) + "\n").encode("utf-8"))
            PROTO.write("null\n")   # 応答の形でない行がプロトコルに漏れたとき、受け側が落ちないこと
            PROTO.flush()
        segments, seeds = req["segments"], req["seeds"]
        steps = int(req.get("steps", 100))
        if not fake and kimodo.model is None:
            raise RuntimeError("モデルを読み込んでいない（先に load）")
        out, t0 = [], time.perf_counter()
        reports = len(getattr(kimodo.cache, "reports", []))
        if not fake:
            kimodo.encode([s["prompt"] for s in segments], rid)
        encode_sec = round(time.perf_counter() - t0, 2)
        for k, seed in enumerate(seeds, 1):
            send({"event": "progress", "id": rid, "text": f"候補 {k}/{len(seeds)} を作っている（seed {seed}）"})
            t = time.perf_counter()
            if fake:
                arrays, contacts = fake_arrays(segments, seed, fake)
            else:
                arrays, contacts = kimodo.motion(segments, seed, steps, req.get("speed"))
            info = write_candidate(req["outDir"], k, seed, arrays, contacts, req.get("root", "keep"))
            info["generateSec"] = round(time.perf_counter() - t, 2)
            out.append(info)
        reply = {"candidates": out, "totalSec": round(time.perf_counter() - t0, 2), "encodeSec": encode_sec}
        if kimodo.cache:
            reply["encoder"] = {"mode": kimodo.mode, "hits": kimodo.cache.hits, "misses": kimodo.cache.misses}
            if len(getattr(kimodo.cache, "reports", [])) > reports:   # この要求で符号化したときだけ、その報告を付ける
                reply["encoder"]["encoded"] = kimodo.cache.reports[-1]
        return reply
    raise ValueError(f"知らない op: {op}")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--fake", nargs="?", const="1", default=None, help="Kimodo を使わない作りものの動き（1、high、fail、load-fail）")
    a = p.parse_args(argv)
    fake = a.fake
    kimodo = Kimodo()
    send({"event": "ready", "pid": os.getpid(), "fake": bool(fake)})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            send({"ok": False, "error": "JSON ではない行を受け取った"})
            continue
        if req.get("op") == "quit":
            send({"id": req.get("id"), "ok": True, "bye": True})
            break
        try:
            send({"id": req.get("id"), "ok": True, **handle(req, kimodo, fake)})
        except Exception as e:   # 1 件の失敗で作業プロセスは落とさない
            import traceback
            traceback.print_exc()
            send({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
