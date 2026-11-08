"""Hand / forearm penetration into the avatar's own body: measure, and solve a wrist offset per frame.

  blender --background --factory-startup --python tools/rgbmocap/hand_body_pen.py -- --vrm model.vrm --vrma clip.vrma
          --out out.npz [--solve] [--clear 0.006] [--skirt-glb bake.glb] [--frames a:b] [--rounds 2]

Normally run through hand_body_fix.py (measure, solve, write, re-measure). vrma-pipeline's Blender helpers
(common, verify_vrma, footlock) come from VRMA_PIPELINE_DIR (vrma_env.py).

Obstacle = the skinned, posed mesh of the model minus both arms (vertices whose dominant bone is a shoulder
or anything below it), split into regions by dominant bone: head (face, non-spring head children),
hair_upper (bangs: spring hair above the neck top, >5 cm in front of it, within 9 cm of the centre line;
side and back hair are left out, their springs move them in playback and Blender does not simulate them), torso (neck/spine/chest/upperChest and their springs),
hips, skirt (spring bones under hips), thigh (upperLeg subtree), leg.
Query points = vertices whose dominant bone is lowerArm or below (forearm, sleeve cuff, hand, fingers).
Signed distance of a point = distance to the nearest obstacle surface, negative when the point is behind
that surface (nearest-face normal), capped at 10 cm.

--solve: per frame and arm, a wrist displacement D (Blender world) such that every query point is at
least --clear outside the surface, on frames where a point is deeper than --need: direction = depth-weighted
mean of the penetrating points' face normals (forearm point gain = its fraction along elbow->wrist), length
by a line search, at most 12 cm (solve_frame), two-bone IK with
the shoulder fixed and the hand keeping its world rotation (vrma-pipeline footlock.two_bone_ik). Then
temporal: gaps <= 6 frames bridged, 6-frame cosine ramps, Hann smoothing, and up to 3 re-check rounds that
add what a frame still needs. Writes D also in glTF axes for hand_body_fix.write_fix.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import vrma_env  # noqa: E402
VP_BL = vrma_env.pipeline_dir() / "src" / "vrma_pipeline" / "blender"
sys.path.insert(0, str(VP_BL))
sys.path.insert(0, str(VP_BL.parent))
from hand_body_fix import REGIONS, gain, temporal  # noqa: E402
import common as C  # noqa: E402
import verify_vrma as V  # noqa: E402
import footlock as FL  # noqa: E402

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402

SIDES = ("left", "right")
CAP = 0.10
HAIR_MAX = 0.04
LAG = 2
RAY_LEN = 0.35
RAYS = [np.array(v, float) / np.linalg.norm(v) for v in
        [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)] +
        [(x, y, z) for x in (1, -1) for y in (1, -1) for z in (1, -1)]]


def desc(arm, name):
    b = arm.data.bones[name]
    return {name} | {c.name for c in b.children_recursive}


def spring_bones(arm):
    out = set()
    try:
        for s in arm.data.vrm_addon_extension.spring_bone1.springs:
            for j in s.joints:
                if j.node.bone_name:
                    out.add(j.node.bone_name)
    except Exception:  # noqa: BLE001
        pass
    return out


def dominant(m, bones):
    gi = {g.index: g.name for g in m.vertex_groups}
    dom = []
    for v in m.data.vertices:
        best, bw = None, 0.0
        for g in v.groups:
            n = gi.get(g.group)
            if n in bones and g.weight > bw:
                best, bw = n, g.weight
        dom.append(best)
    return dom


def classify(arm, hm):
    springs = spring_bones(arm)
    arms = set()
    for s in SIDES:
        arms |= desc(arm, hm.get(f"{s}Shoulder") or hm[f"{s}UpperArm"])
    head = desc(arm, hm["head"])
    legs_up = desc(arm, hm["leftUpperLeg"]) | desc(arm, hm["rightUpperLeg"])
    legs_low = desc(arm, hm["leftLowerLeg"]) | desc(arm, hm["rightLowerLeg"])
    spine = desc(arm, hm["spine"])
    hips = desc(arm, hm["hips"])
    hh = arm.matrix_world @ arm.data.bones[hm["head"]].head_local  # neck top (rest)
    side_of = {}
    for s in SIDES:
        side_of.update({b: (s, "hand") for b in desc(arm, hm[f"{s}Hand"])})
        side_of.update({b: (s, "fore") for b in desc(arm, hm[f"{s}LowerArm"]) - desc(arm, hm[f"{s}Hand"])})

    def region(b, co):
        if b is None or b in arms:
            return None
        if b in head:
            if b in springs:  # bangs only: spring hair above the neck top, in front of the head, near the centre
                return "hair_upper" if (co.z > hh.z and co.y < hh.y - 0.05 and abs(co.x - hh.x) < 0.09) else None
            return "head"
        if b in spine:
            return "torso"
        if b in legs_low:
            return "leg"
        if b in legs_up:
            return "thigh"
        if b in hips:
            return "skirt" if "Skirt" in b else "hips"  # pouch / holders on hip springs count as hips
        return None
    return region, side_of, arms


def build(arm, hm):
    region, side_of, _ = classify(arm, hm)
    bones = set(arm.data.bones.keys())
    obst = {r: [] for r in REGIONS}
    query = {s: [] for s in SIDES}  # (mesh obj, vertex indices, gain kind)
    coll = bpy.context.scene.collection
    for m in C.mesh_children(arm):
        dom = dominant(m, bones)
        mw = m.matrix_world
        vreg = [region(b, mw @ v.co) for b, v in zip(dom, m.data.vertices)]
        for s in SIDES:
            idx = [i for i, b in enumerate(dom) if b in side_of and side_of[b][0] == s]
            if idx:
                query[s].append((m, np.array(idx), np.array([side_of[dom[i]][1] == "hand" for i in idx])))
        for r in REGIONS:
            keepf = [p.index for p in m.data.polygons if all(vreg[v] is not None for v in p.vertices)
                     and max(set(vreg[v] for v in p.vertices), key=lambda x: sum(vreg[v] == x for v in p.vertices)) == r]
            if not keepf:
                continue
            o = m.copy()
            o.data = m.data.copy()
            o.name = f"OBST_{r}_{m.name}"
            coll.objects.link(o)
            bm = bmesh.new()
            bm.from_mesh(o.data)
            ks = set(keepf)
            bm.faces.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in ks], context="FACES")
            loose = [v for v in bm.verts if not v.link_faces]
            bmesh.ops.delete(bm, geom=loose, context="VERTS")
            bm.to_mesh(o.data)
            bm.free()
            o.hide_render = True
            obst[r].append(o)
    return obst, query


def load_bake_skirt(glb, damp, arm, hm, obst):
    """Import the spring-baked GLB, damp its skirt bones like render_dancer.py, and add its skirt faces
    (dominant bone name contains 'Skirt') as the 'skirt' region instead of the rest-pose skirt. The bake is
    placed per frame by the hips offset to this rig; frames past the bake fall back to the rest skirt."""
    from mathutils import Quaternion
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(glb), merge_vertices=False, bone_heuristic="BLENDER")
    new = set(bpy.data.objects) - before
    arm2 = next(o for o in new if o.type == "ARMATURE")
    act = arm2.animation_data.action
    fcs = act.fcurves if hasattr(act, "fcurves") else [fc for ly in act.layers for st in ly.strips for cb in st.channelbags for fc in cb.fcurves]
    curves = {}
    for fc in fcs:
        if "Skirt" in fc.data_path and fc.data_path.endswith("rotation_quaternion"):
            curves.setdefault(fc.data_path, {})[fc.array_index] = fc
    for ch in curves.values():
        if len(ch) == 4 and damp < 1:
            for i in range(len(ch[0].keyframe_points)):
                q2 = Quaternion().slerp(Quaternion([ch[j].keyframe_points[i].co[1] for j in range(4)]), damp)
                for j in range(4):
                    kp = ch[j].keyframe_points[i]
                    kp.co[1] = kp.handle_left[1] = kp.handle_right[1] = q2[j]
    # glTF import puts bake time 0 on frame 0 and the bake trails the clip by one frame (hips height): move
    # the bake keys LAG frames earlier so bake frame f is clip frame f of the VRM + VRMA import
    for fc in fcs:
        for kp in fc.keyframe_points:
            kp.co[0] -= LAG
            kp.handle_left[0] -= LAG
            kp.handle_right[0] -= LAG
    f_end = int(max(fc.keyframe_points[-1].co[0] for fc in fcs if len(fc.keyframe_points)))
    hips2 = next(b.name for b in arm2.pose.bones if b.name.endswith("Hips"))
    coll = bpy.context.scene.collection
    bones2 = set(arm2.data.bones.keys())
    made = []
    for m in [o for o in new if o.type == "MESH"]:
        dom = dominant(m, bones2)
        keepf = [p.index for p in m.data.polygons if all(dom[v] and "Skirt" in dom[v] for v in p.vertices)]
        if not keepf:
            continue
        o = m.copy()
        o.data = m.data.copy()
        o.name = f"OBST_bakeskirt_{m.name}"
        coll.objects.link(o)
        bm = bmesh.new()
        bm.from_mesh(o.data)
        ks = set(keepf)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in ks], context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        bm.to_mesh(o.data)
        bm.free()
        made.append(o)
    for m in new:
        if m.type == "MESH":
            m.hide_render = True
    rest = obst["skirt"]
    obst["skirt"] = rest + made
    names_bake, names_rest = [o.name for o in made], [o.name for o in rest]

    def shift(f):
        if f > f_end:
            return {**{n: None for n in names_bake}, **{n: np.zeros(3) for n in names_rest}}
        t = np.array(arm.matrix_world @ arm.pose.bones[hm["hips"]].head) - np.array(arm2.matrix_world @ arm2.pose.bones[hips2].head)
        return {**{n: t for n in names_bake}, **{n: None for n in names_rest}}
    print("BAKE_SKIRT", json.dumps({"objects": names_bake, "last_frame": f_end, "skirt_bones_damped": len(curves)}))
    return {"shift": shift, "last_frame": f_end, "arm": arm2, "hips": hips2}


class Frame:
    """BVHs of all obstacle objects at the current frame + arm query points."""

    def __init__(self, obst, query, dg, shift=None):
        """shift: {object name: world translation or None (= leave the object out this frame)} for obstacle
        objects that live in another rig (the spring-baked skirt, --skirt-glb)."""
        self.bvh = []
        for r, objs in obst.items():
            for o in objs:
                mw = np.array(o.matrix_world)
                if shift is not None and o.name in shift:
                    if shift[o.name] is None:
                        continue
                    T = np.eye(4)
                    T[:3, 3] = shift[o.name]
                    mw = T @ mw
                oe = o.evaluated_get(dg)
                self.bvh.append((r, BVHTree.FromObject(oe, dg), mw, np.linalg.inv(mw)))
        self.pts = {}
        for s, lst in query.items():
            P, G = [], []
            for m, idx, ishand in lst:
                me = m.evaluated_get(dg).data
                co = np.empty(len(me.vertices) * 3)
                me.vertices.foreach_get("co", co)
                co = co.reshape(-1, 3)[idx]
                mw = np.array(m.matrix_world)
                P.append(co @ mw[:3, :3].T + mw[:3, 3])
                G.append(ishand)
            self.pts[s] = (np.concatenate(P), np.concatenate(G))

    def sd(self, P, objs=None):
        """signed distance (N,), world normal (N,3), region index (N,) (-1 = far)."""
        n = len(P)
        best = np.full(n, CAP)
        sgn = np.ones(n)
        nrm = np.zeros((n, 3))
        reg = np.full(n, -1)
        for k, (r, tree, mw, mi) in enumerate(self.bvh):
            if objs is not None and k not in objs:
                continue
            ri = REGIONS.index(r)
            Pl = P @ mi[:3, :3].T + mi[:3, 3]
            for i in range(n):
                loc, no, _ix, d = tree.find_nearest(Vector(Pl[i]), best[i])
                if loc is None or d >= best[i]:
                    continue
                side = (Pl[i][0] - loc[0]) * no[0] + (Pl[i][1] - loc[1]) * no[1] + (Pl[i][2] - loc[2]) * no[2]
                best[i] = d
                sgn[i] = -1.0 if side < 0 else 1.0
                nw = mw[:3, :3] @ np.array(no)
                nrm[i] = nw / max(np.linalg.norm(nw), 1e-9)
                reg[i] = ri
        # A point behind its nearest face is only inside when rays agree: stray single-sided sheets (hat
        # lining, ribbons) put points 10 cm in front of the face "behind" a face (f107). Cast RAYS from the
        # point; inside = >= 5 hits within RAY_LEN and >= 60 % of the first hits are back faces. Bangs
        # (hair cards, never closed) keep the nearest-face sign, at most HAIR_MAX deep.
        hair = REGIONS.index("hair_upper")
        for i in np.where(sgn < 0)[0]:
            if reg[i] == hair:
                if best[i] > HAIR_MAX:
                    sgn[i] = 1.0
                continue
            hits = back = 0
            for kk, dv in enumerate(RAYS):
                left = len(RAYS) - kk
                if back >= 9 or hits + left < 5 or back + left < 0.6 * (hits + left) - 1e-9 and back + left < 9:
                    break
                first = None
                for k, (r, tree, mw, mi) in enumerate(self.bvh):
                    if r == "hair_upper" or (objs is not None and k not in objs):
                        continue
                    o = mi[:3, :3] @ P[i] + mi[:3, 3]
                    dl = mi[:3, :3] @ dv
                    loc, no, _ix, d = tree.ray_cast(Vector(o), Vector(dl), RAY_LEN if first is None else first[0])
                    if loc is not None and (first is None or d < first[0]):
                        first = (d, float(np.dot(np.array(no), dl)) > 0)
                if first is not None:
                    hits += 1
                    back += first[1]
            if hits < 5 or back < 0.6 * hits:
                sgn[i] = 1.0
        return best * sgn, nrm, reg


def arm_joints(arm, hm, s):
    mw = arm.matrix_world
    pb = arm.pose.bones
    return [np.array(mw @ pb[hm[f"{s}{b}"]].head) for b in ("UpperArm", "LowerArm", "Hand")]


def moved(P, ishand, S, E, W, D):
    a, b, kn, reached, _ = FL.two_bone_ik(S[None], E[None], W[None], (W + D)[None], 0.999)
    out = P.copy()
    out[ishand] = P[ishand] + (reached[0] - W)
    out[~ishand] = kn[0] + (P[~ishand] - E) @ b[0].T
    return out, reached[0] - W




def near_objects(fr, P, extra):
    c = P.mean(0)
    r = float(np.linalg.norm(P - c, axis=1).max()) + extra
    out = []
    for k, (_r, tree, _mw, mi) in enumerate(fr.bvh):
        cl = mi[:3, :3] @ c + mi[:3, 3]
        if tree.find_nearest(Vector(cl), r)[0] is not None:
            out.append(k)
    return out


def solve_frame(fr, s, S, E, W, D0, clear, cap=0.12, stride=2, outer=3):
    """Wrist offset D (world) with every query point >= clear outside the obstacle, |D| <= cap.
    Direction = depth-weighted mean of the penetrating points' surface normals (divided by the point's
    gain), length = smallest step on a grid along it that clears every point (then bisected)."""
    P, ishand = fr.pts[s]
    P, ishand = P[::stride], ishand[::stride]
    g = gain(P, ishand, E, W)
    objs = near_objects(fr, P, cap + CAP)
    D = D0.copy()

    def worst(Dx):
        Pm, _ = moved(P, ishand, S, E, W, Dx)
        sd, nrm, _r = fr.sd(Pm, objs)
        return clear - sd, nrm

    for _ in range(outer):
        viol, nrm = worst(D)
        pen = viol > 5e-4
        if not pen.any():
            break
        dv = (nrm[pen] * (viol[pen] / g[pen])[:, None]).sum(0)
        if np.linalg.norm(dv) < 1e-9:
            dv = nrm[int(np.argmax(viol))]
        dv = dv / np.linalg.norm(dv)
        room = cap - np.linalg.norm(D)
        if room <= 1e-3:
            break
        grid = [a for a in (0.005, 0.01, 0.02, 0.035, 0.05, 0.07, 0.095, 0.12) if a < room] + [room]
        prev, best, found = 0.0, (np.inf, 0.0), None
        for a in grid:
            w = worst(D + a * dv)[0].max()
            if w < best[0]:
                best = (w, a)
            if w <= 5e-4:
                found = a
                break
            prev = a
        if found is not None:
            lo, hi = prev, found
            for _b in range(3):
                mid = 0.5 * (lo + hi)
                if worst(D + mid * dv)[0].max() <= 5e-4:
                    hi = mid
                else:
                    lo = mid
            D = D + hi * dv
            break
        D = D + best[1] * dv
    return D


def measure_frame(fr, s, S, E, W, D):
    P, ishand = fr.pts[s]
    Pm, disp = moved(P, ishand, S, E, W, D) if np.linalg.norm(D) > 0 else (P, np.zeros(3))
    sd, _n, reg = fr.sd(Pm)
    out = {"min_sd": float(sd.min()), "disp": disp}
    for part, msk in (("hand", ishand), ("fore", ~ishand)):
        for ri, r in enumerate(REGIONS):
            mm = msk & (reg == ri)
            out[f"{part}_{r}"] = float(max(0.0, -sd[mm].min())) if mm.any() else 0.0
    return out






def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vrm", required=True)
    ap.add_argument("--vrma", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--solve", action="store_true")
    ap.add_argument("--clear", type=float, default=0.006)
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--skirt-glb", help="spring-baked GLB (stage-studio bake_glb.py) whose skirt replaces the rest skirt")
    ap.add_argument("--skirt-damp", type=float, default=0.6, help="as graphic-mv render_dancer.py --skirt-damp")
    ap.add_argument("--need", type=float, default=0.003, help="frames are fixed where a point is deeper than this")
    ap.add_argument("--frames", help="a:b (clip frames, inclusive): solve only frames in this range (all frames are still measured)")
    args = ap.parse_args(C.script_argv())
    t0 = time.time()
    C.enable_vrm_addon()
    C.clear_scene()
    arm, _ref, _info = V.load_model_with_vrma(args.vrm, args.vrma, reimport_fix="none")
    hm = C.humanoid_map(arm)
    obst, query = build(arm, hm)
    bake = load_bake_skirt(args.skirt_glb, args.skirt_damp, arm, hm, obst) if args.skirt_glb else None
    scene = bpy.context.scene
    frames = list(range(scene.frame_start, scene.frame_end + 1))
    T = len(frames)
    info = {"obstacles": {r: [o.name for o in v] for r, v in obst.items()},
            "query_points": {s: int(sum(len(i) for _m, i, _h in query[s])) for s in SIDES}}
    print("SETUP", json.dumps(info))

    def at(i):
        scene.frame_set(frames[i])
        dg = bpy.context.evaluated_depsgraph_get()
        return Frame(obst, query, dg, bake["shift"](frames[i]) if bake else None)

    J = {s: np.zeros((T, 3, 3)) for s in SIDES}
    keys = ["min_sd"] + [f"{p}_{r}" for p in ("hand", "fore") for r in REGIONS]
    M0 = {s: {k: np.zeros(T) for k in keys} for s in SIDES}
    for i in range(T):
        fr = at(i)
        for s in SIDES:
            S, E, W = arm_joints(arm, hm, s)
            J[s][i] = (S, E, W)
            m = measure_frame(fr, s, S, E, W, np.zeros(3))
            for k in keys:
                M0[s][k][i] = m[k]
    print("MEASURED", round(time.time() - t0, 1), "s")
    res = {"frames": np.array(frames), "regions": np.array(REGIONS)}
    for s in SIDES:
        res[f"J_{s}"] = J[s]
        for k in keys:
            res[f"before_{s}_{k}"] = M0[s][k]
    if args.solve:
        D = {s: np.zeros((T, 3)) for s in SIDES}
        need = {s: M0[s]["min_sd"] < -args.need for s in SIDES}
        if args.frames:
            lo, hi = (int(x) for x in args.frames.split(":"))
            win = (np.array(frames) >= lo) & (np.array(frames) <= hi)
            need = {s: need[s] & win for s in SIDES}
            print("WINDOW", lo, hi, {s: int(need[s].sum()) for s in SIDES})
        raw = {s: np.zeros((T, 3)) for s in SIDES}
        for i in range(T):
            if not (need["left"][i] or need["right"][i]):
                continue
            fr = at(i)
            for s in SIDES:
                if need[s][i]:
                    S, E, W = J[s][i]
                    raw[s][i] = solve_frame(fr, s, S, E, W, np.zeros(3), args.clear)
        for s in SIDES:
            D[s] = temporal(raw[s], need[s])
        for rnd in range(args.rounds):
            add = {s: np.zeros((T, 3)) for s in SIDES}
            short = {s: np.zeros(T, bool) for s in SIDES}
            act = np.where((np.linalg.norm(D["left"], axis=1) > 0) | (np.linalg.norm(D["right"], axis=1) > 0) | need["left"] | need["right"])[0]
            for i in act:
                fr = at(i)
                for s in SIDES:
                    S, E, W = J[s][i]
                    m = measure_frame(fr, s, S, E, W, D[s][i])
                    if m["min_sd"] < -args.need and np.linalg.norm(D[s][i]) < 0.12 - 1e-3:
                        short[s][i] = True
                        add[s][i] = solve_frame(fr, s, S, E, W, D[s][i], args.clear) - D[s][i]
            n_short = {s: int(short[s].sum()) for s in SIDES}
            print("ROUND", rnd, n_short)
            if not any(n_short.values()):
                break
            for s in SIDES:
                if short[s].any():
                    D[s] = D[s] + temporal(add[s], short[s], ramp=4, k=5)
                    n = np.linalg.norm(D[s], axis=1, keepdims=True)
                    D[s] = D[s] * np.minimum(1.0, 0.12 / np.maximum(n, 1e-9))
        for s in SIDES:
            res[f"D_{s}"] = D[s]
            res[f"D_gltf_{s}"] = np.stack([D[s][:, 0], D[s][:, 2], -D[s][:, 1]], 1)
            res[f"J_gltf_{s}"] = np.stack([J[s][..., 0], J[s][..., 2], -J[s][..., 1]], -1)
            res[f"need_{s}"] = need[s]
    np.savez(args.out, **res)
    print("DONE", round(time.time() - t0, 1), "s", args.out)


if __name__ == "__main__":
    main()
