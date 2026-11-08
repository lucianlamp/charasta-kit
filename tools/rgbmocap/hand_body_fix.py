"""手と前腕が対象の体(顔、前髪、胴、腰、スカート、脚)にめり込むコマで、手首を体の外へ出して腕を 2 関節の IK で解き直す(手のめり込み補正)。

  python tools/rgbmocap/hand_body_fix.py --vrm model.vrm --vrma in.vrma --out out.vrma --work WORK
         [--skirt-glb bake.glb] [--clear 0.006] [--frames a:b] [--rounds 2] [--no-after] [--blender BLENDER]

流れ:
  1. Blender(hand_body_pen.py --solve)で、クリップを対象の VRM に当てて全コマの手と前腕の頂点の深さを測る。
     5 mm 以上めり込むコマ(--need 3 mm)では、手首をめり込んだ面の法線の向きへ動かし、全部の点が 6 mm(--clear)外に出る量を探す(最大 12 cm)。
     肩を止めた 2 関節の IK で腕を解き、手は向きを保つ。時間方向は 6 コマ以下のすき間をつなぎ、6 コマで出入りし、ハン窓でならす。
  2. 解いた手首の動きを VRMA に書く(write_fix)。上腕、前腕、手の回転だけを、動かすコマだけ書き換える。指は変えない。
  3. もう一度測る(--no-after で省く)。
--skirt-glb に stage-studio の bake_glb.py で揺れ骨を焼いた GLB を渡すと、静止のスカートの代わりにその揺れたスカートを避ける(ダンス MV 用)。
--frames a:b(クリップのコマ番号、両端を含む)を渡すと、その範囲のコマだけを直す(測るのは全コマ)。直したクリップに残った区間だけを
直し直すときに使う。範囲の前後 6〜9 コマも、補正をならす出入りの区間として動く。--rounds は解き直しの回数(既定 2)。
658 コマで、静止のスカートなら約 18 分、揺れたスカートなら約 49 分(測り直しに 3 から 4 分)。

この補正は対象の体に合わせた焼き込みなので、別の体(版)では測り直す。ExMR の仕上げでは exmr_vrma.py --hand-body-fix で 7 段目として動く。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import time
from pathlib import Path

import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import charasta_paths as P  # noqa: E402

HERE = Path(__file__).resolve().parent
REGIONS = ("head", "hair_upper", "torso", "hips", "skirt", "thigh", "leg")
DEEP = 0.005   # 報告で「めり込んだ」と数える深さ


# --- 時間方向の処理(Blender の hand_body_pen.py からも使う。numpy だけ) ---

def segments(mask):
    m = np.concatenate([[False], np.asarray(mask, bool), [False]]).astype(int)
    d = np.diff(m)
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


def gain(P, ishand, E, W):
    """手首を D 動かしたとき点が動く割合。手は 1、前腕は肘から手首への位置(0.25 から 1)。"""
    ew = W - E
    t = np.clip(((P - E) @ ew) / max(ew @ ew, 1e-9), 0.25, 1.0)
    return np.where(ishand, 1.0, t)


def hann_smooth(x, k):
    w = np.hanning(k + 2)[1:-1]
    w /= w.sum()
    xp = np.pad(x, ((k // 2, k // 2), (0, 0)), mode="edge")
    return np.stack([np.convolve(xp[:, c], w, mode="valid") for c in range(x.shape[1])], 1)


def temporal(D, need, bridge=6, ramp=6, k=7):
    """コマごとの手首の動き D(T, 3)を時間でつなぐ。need のコマの間が bridge 以下なら線形でつなぎ、
    前後 ramp コマで余弦で 0 へ戻し、k コマのハン窓でならす。どちらにも入らないコマは 0。"""
    T = len(D)
    segs = segments(need)
    Ds = np.array(D, float)
    filled = np.asarray(need, bool).copy()
    for (_s0, e0), (s1, _e1) in zip(segs, segs[1:]):
        if s1 - e0 <= bridge:
            for i in range(e0, s1):
                w = (i - e0 + 1) / (s1 - e0 + 1)
                Ds[i] = (1 - w) * D[e0 - 1] + w * D[s1]
            filled[e0:s1] = True
    wbest = filled.astype(float)
    for s, e in segments(filled):
        for kk in range(1, ramp + 1):
            w = 0.5 * (1 + math.cos(math.pi * kk / (ramp + 1)))
            for i, src in ((s - kk, s), (e - 1 + kk, e - 1)):
                if 0 <= i < T and not filled[i] and w > wbest[i]:
                    wbest[i] = w
                    Ds[i] = w * Ds[src]
    act = wbest > 0
    Sm = hann_smooth(Ds, k)
    Sm[~act] = 0.0
    return Sm


# --- 報告 ---

def depth_summary(z, pre):
    """npz(hand_body_pen.py の出力)から、左右ごとに 5 mm 以上めり込むコマの数と最大の深さ(m)。"""
    out = {}
    for s in ("left", "right"):
        deep = np.zeros(len(z["frames"]))
        for p in ("hand", "fore"):
            for r in REGIONS:
                k = f"{pre}_{s}_{p}_{r}"
                if k in z:
                    deep = np.maximum(deep, z[k])
        out[s] = {"framesOver5mm": int((deep > DEEP).sum()), "maxDepthM": round(float(deep.max()), 4)}
    return out


# --- VRMA への書き込み ---

def write_fix(vrma, vrm, solve_npz, out):
    """hand_body_pen.py --solve の手首の動き(glTF の軸)を VRMA に焼く。対象の正規化した骨で素の再生(vrma_playback)をし、
    腕ごとに肩を止めた 2 関節の IK(肘の向きは今の肘)で手首を D 動かす。手は世界の向きを保つので手のひらは回らず、指は手の子なので変わらない。
    上腕、前腕、手の回転だけを、D が 0 でないコマだけ書き換え、ほかのコマは元の値のまま。"""
    from scipy.spatial.transform import Rotation as R

    import vrma_env
    VP, FL = vrma_env.load()
    js, binc0 = VP.read_glb(vrma)
    binc = bytearray(binc0)
    clip = VP.load_clip(vrma)
    heads = VP.load_model(vrm)
    P = VP.play(clip, heads)
    T = len(clip["times"])
    have = set(heads)
    z = np.load(solve_npz)
    G = {}
    for b in VP.ORDER:
        if b not in have:
            continue
        q = R.from_quat(clip["rot"][b]) if b in clip["rot"] else R.identity(T)
        p = VP._humanoid_parent(b, have)
        G[b] = q if p is None else G[p] * q
    newG = dict(G)
    rep = {}
    for s in ("left", "right"):
        D = z[f"D_gltf_{s}"]
        if len(D) != T:
            raise ValueError(f"解いたコマ数 {len(D)} とクリップのコマ数 {T} が違う")
        S, E, W = P[f"{s}UpperArm"], P[f"{s}LowerArm"], P[f"{s}Hand"]
        fk_err = float(np.abs(z[f"J_gltf_{s}"][:, 2] - W).max())   # Blender と numpy の再生で手首が合っているか
        act = np.linalg.norm(D, axis=1) > 1e-6
        dR1 = np.repeat(np.eye(3)[None], T, 0)
        dR2 = dR1.copy()
        resid = np.zeros(T)
        if act.any():
            r1, r2, _k, _r, res = FL.two_bone_ik(S[act], E[act], W[act], W[act] + D[act], 0.999)
            dR1[act], dR2[act], resid[act] = r1, r2, res
        newG[f"{s}UpperArm"] = R.from_matrix(dR1) * G[f"{s}UpperArm"]
        newG[f"{s}LowerArm"] = R.from_matrix(dR2) * G[f"{s}LowerArm"]
        newG[f"{s}Hand"] = G[f"{s}Hand"]
        rep[s] = {"framesChanged": int(act.sum()), "wristMoveMaxM": round(float(np.linalg.norm(D, axis=1).max()), 4),
                  "ikResidualMaxM": round(float(resid.max()), 4),
                  "upperArmDeltaMaxDeg": round(float(np.degrees(R.from_matrix(dR1).magnitude()).max()), 1),
                  "lowerArmDeltaMaxDeg": round(float(np.degrees(R.from_matrix(dR2).magnitude()).max()), 1),
                  "blenderVsNumpyWristMaxM": round(fk_err, 4)}

    ext = js["extensions"]["VRMC_vrm_animation"]
    hb = {b: v["node"] for b, v in ext["humanoid"]["humanBones"].items() if b in VP.PARENT}
    w, _parent = VP.world_mats(js)
    anim = js["animations"][0]
    chan = {(ch["target"].get("node"), ch["target"]["path"]): anim["samplers"][ch["sampler"]]["output"] for ch in anim["channels"]}
    hv = set(hb)

    def rotm(M):
        return R.from_matrix(M[:3, :3] / np.linalg.norm(M[:3, :3], axis=0))

    for s in ("left", "right"):
        same = np.repeat(np.linalg.norm(z[f"D_gltf_{s}"], axis=1)[:, None] <= 1e-6, 4, 1)
        for b in (f"{s}UpperArm", f"{s}LowerArm", f"{s}Hand"):
            qn = newG[VP._humanoid_parent(b, have)].inv() * newG[b]
            qp, qs = rotm(w(hb[VP._humanoid_parent(b, hv)])), rotm(w(hb[b]))
            ql = (qp.inv() * qn * qs).as_quat()
            i = chan[(hb[b], "rotation")]
            old = VP.accessor(js, binc0, i)
            if len(old) != T:
                raise ValueError(f"{b} の回転のコマ数が {len(old)}")
            ql[np.sum(ql * old, 1) < 0] *= -1
            vrma_env.put_accessor(js, binc, i, np.where(same, old, ql))
    vrma_env.write_glb(out, js, binc)
    return rep


# --- 全体 ---

def blender_pen(blender, vrm, vrma, out_npz, log, solve=False, skirt_glb=None, clear=0.006, frames=None, rounds=2):
    cmd = [blender, "--background", "--factory-startup", "--python-exit-code", "1", "--python", str(HERE / "hand_body_pen.py"), "--",
           "--vrm", str(vrm), "--vrma", str(vrma), "--out", str(out_npz), "--clear", str(clear)]
    if solve:
        cmd.append("--solve")
    if skirt_glb:
        cmd += ["--skirt-glb", str(skirt_glb)]
    if frames:
        cmd += ["--frames", frames]
    if rounds != 2:
        cmd += ["--rounds", str(rounds)]
    env = {**os.environ, "PYTHONUTF8": "1"}
    with open(log, "w", encoding="utf-8") as f:
        r = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT, env=env)
    if r.returncode or not Path(out_npz).is_file():
        tail = Path(log).read_text(encoding="utf-8", errors="replace").splitlines()[-20:]
        raise RuntimeError("Blender の手のめり込みの計算が失敗した:\n" + "\n".join(tail))


def fix(vrma, vrm, out, work, blender, skirt_glb=None, clear=0.006, after=True, frames=None, rounds=2):
    """測って解いて書き、報告を返す。めり込むコマが無ければ out は入力の写し。"""
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    t = time.monotonic()
    solve = work / "hand_body_solve.npz"
    blender_pen(blender, vrm, vrma, solve, work / "hand_body_solve.log", solve=True, skirt_glb=skirt_glb, clear=clear,
                frames=frames, rounds=rounds)
    z = np.load(solve)
    rep = {"ran": True, "skirt": "baked" if skirt_glb else "rest", "clearM": clear, "before": depth_summary(z, "before"),
           "solveSec": round(time.monotonic() - t, 1)}
    if frames is not None:
        rep["frames"] = frames
    rep["write"] = write_fix(vrma, vrm, solve, out)
    if after:
        t = time.monotonic()
        meas = work / "hand_body_after.npz"
        blender_pen(blender, vrm, out, meas, work / "hand_body_after.log", skirt_glb=skirt_glb)
        rep["after"] = depth_summary(np.load(meas), "before")
        rep["afterSec"] = round(time.monotonic() - t, 1)
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vrm", required=True)
    ap.add_argument("--vrma", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--skirt-glb", help="stage-studio の bake_glb.py で揺れ骨を焼いた GLB。スカートをこの揺れた形で避ける")
    ap.add_argument("--clear", type=float, default=0.006, help="体の面から外へ出す距離(m)")
    ap.add_argument("--frames", help="a:b。この範囲のコマ(クリップのコマ番号、両端を含む)だけを直す")
    ap.add_argument("--rounds", type=int, default=2, help="解き直しの回数")
    ap.add_argument("--no-after", action="store_true", help="直したあとに測り直さない")
    ap.add_argument("--report", help="報告の JSON の書き出し先")
    ap.add_argument("--blender", default=P.find_blender())
    a = ap.parse_args()
    rep = fix(a.vrma, a.vrm, a.out, a.work, a.blender, skirt_glb=a.skirt_glb, clear=a.clear, after=not a.no_after,
              frames=a.frames, rounds=a.rounds)
    if a.report:
        Path(a.report).write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(rep, ensure_ascii=False))


if __name__ == "__main__":
    main()
