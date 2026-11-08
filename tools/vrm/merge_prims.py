"""VRM（glTF バイナリ）のメッシュの中で、同じ材質・同じ属性・同じモーフの数の primitive を 1 個にまとめる。

  python tools/vrm/merge_prims.py in.vrm out.vrm [--mesh Face_layers] [--min 2]

three.js は primitive を 1 個ずつ別の描画にするので、顔の層が 60 個の primitive に分かれていると draw call が 60 増える。
頂点・UV・骨の重み・モーフの差分はそのまま連結し、索引は頂点の先頭からずらす。メッシュの番号とモーフの順番は変わらないので、
VRM の表情の割り当て（メッシュの番号とモーフの番号）はそのまま動く。まとめたあと、使われなくなった accessor と bufferView を詰めて書く。
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import glb  # noqa: E402

CT = glb.CT


def key(js, p):
    acc = js["accessors"]
    attrs = tuple(sorted((k, acc[v]["componentType"], acc[v]["type"], bool(acc[v].get("normalized"))) for k, v in p["attributes"].items()))
    tg = tuple(tuple(sorted(t)) for t in p.get("targets", []))
    return (p.get("material"), p.get("mode", 4), attrs, tg, "indices" in p)


def add_accessor(js, chunks, arr, ctype, typ, target=None, normalized=False, minmax=False):
    """新しい bufferView と accessor を足す（データは chunks に貯め、あとで書く）。"""
    arr = np.ascontiguousarray(arr.astype(CT[ctype]))
    bv = {"buffer": 0, "byteLength": arr.nbytes, "_data": arr.tobytes()}
    if target:
        bv["target"] = target
    js["bufferViews"].append(bv)
    a = {"bufferView": len(js["bufferViews"]) - 1, "componentType": ctype, "count": len(arr), "type": typ}
    if normalized:
        a["normalized"] = True
    if minmax:
        a["min"], a["max"] = arr.min(0).tolist(), arr.max(0).tolist()
    js["accessors"].append(a)
    return len(js["accessors"]) - 1


def merge_mesh(js, binc, mesh, min_group=2):
    groups = defaultdict(list)
    for i, p in enumerate(mesh["primitives"]):
        groups[key(js, p)].append(i)
    new_prims, merged = [], []
    order = sorted(groups.values(), key=lambda g: g[0])
    for g in order:
        prims = [mesh["primitives"][i] for i in g]
        if len(g) < min_group:
            new_prims += prims
            continue
        p0 = prims[0]
        out = {k: v for k, v in p0.items() if k not in ("attributes", "indices", "targets")}
        out["attributes"] = {}
        for name in p0["attributes"]:
            a0 = js["accessors"][p0["attributes"][name]]
            arr = np.concatenate([glb.acc(js, binc, p["attributes"][name]) for p in prims])
            out["attributes"][name] = add_accessor(js, None, arr, a0["componentType"], a0["type"], 34962, a0.get("normalized", False), name == "POSITION")
        counts = [js["accessors"][p["attributes"]["POSITION"]]["count"] for p in prims]
        base = np.concatenate([[0], np.cumsum(counts)[:-1]])
        if "indices" in p0:
            idx = np.concatenate([glb.acc(js, binc, p["indices"]).ravel().astype(np.int64) + b for p, b in zip(prims, base)])
            ct = 5125 if idx.max() > 65535 else 5123
            out["indices"] = add_accessor(js, None, idx[:, None], ct, "SCALAR", 34963)
        if p0.get("targets"):
            out["targets"] = []
            for ti, t0 in enumerate(p0["targets"]):
                tt = {}
                for name in t0:
                    a0 = js["accessors"][t0[name]]
                    arr = np.concatenate([glb.acc(js, binc, p["targets"][ti][name]) for p in prims])
                    tt[name] = add_accessor(js, None, arr, a0["componentType"], a0["type"], None, False, name == "POSITION")
                out["targets"].append(tt)
        new_prims.append(out)
        merged.append({"primitives": len(g), "vertices": int(sum(counts)), "material": p0.get("material")})
    mesh["primitives"] = new_prims
    return merged


def compact(js, binc):
    """使われている accessor と bufferView だけを残し、BIN を詰め直す。"""
    used_acc = set()
    for m in js["meshes"]:
        for p in m["primitives"]:
            used_acc |= set(p["attributes"].values())
            if "indices" in p:
                used_acc.add(p["indices"])
            for t in p.get("targets", []):
                used_acc |= set(t.values())
    for s in js.get("skins", []):
        if "inverseBindMatrices" in s:
            used_acc.add(s["inverseBindMatrices"])
    for an in js.get("animations", []):
        for sm in an["samplers"]:
            used_acc |= {sm["input"], sm["output"]}
    amap = {o: n for n, o in enumerate(sorted(used_acc))}
    accs = [js["accessors"][o] for o in sorted(used_acc)]
    used_bv = {a["bufferView"] for a in accs if "bufferView" in a} | {im["bufferView"] for im in js.get("images", []) if "bufferView" in im}
    if any("sparse" in a for a in accs):
        raise ValueError("sparse accessor には対応していない")
    bmap, out, views = {}, bytearray(), []
    for o in sorted(used_bv):
        bv = dict(js["bufferViews"][o])
        data = bv.pop("_data", None)
        if data is None:
            data = bytes(binc[bv.get("byteOffset", 0):bv.get("byteOffset", 0) + bv["byteLength"]])
        out += b"\0" * ((-len(out)) % 8)
        bv["byteOffset"] = len(out)
        bv["byteLength"] = len(data)
        out += data
        bmap[o] = len(views)
        views.append(bv)
    for a in accs:
        if "bufferView" in a:
            a["bufferView"] = bmap[a["bufferView"]]
    for im in js.get("images", []):
        if "bufferView" in im:
            im["bufferView"] = bmap[im["bufferView"]]
    js["accessors"], js["bufferViews"] = accs, views
    js["buffers"] = [{"byteLength": len(out)}]

    def remap(d):
        return {k: amap[v] for k, v in d.items()}
    for m in js["meshes"]:
        for p in m["primitives"]:
            p["attributes"] = remap(p["attributes"])
            if "indices" in p:
                p["indices"] = amap[p["indices"]]
            if "targets" in p:
                p["targets"] = [remap(t) for t in p["targets"]]
    for s in js.get("skins", []):
        if "inverseBindMatrices" in s:
            s["inverseBindMatrices"] = amap[s["inverseBindMatrices"]]
    for an in js.get("animations", []):
        for sm in an["samplers"]:
            sm["input"], sm["output"] = amap[sm["input"]], amap[sm["output"]]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inp")
    ap.add_argument("out")
    ap.add_argument("--mesh", action="append", help="まとめるメッシュの名前（省けば全部）")
    ap.add_argument("--min", type=int, default=2, help="この数以上の primitive の組だけまとめる")
    a = ap.parse_args()
    js, binc = glb.load(a.inp)
    if len(js["buffers"]) != 1:
        raise SystemExit("buffer が 1 つの glb だけ扱う")
    rep = {}
    for m in js["meshes"]:
        if a.mesh and m.get("name") not in a.mesh:
            continue
        before = len(m["primitives"])
        got = merge_mesh(js, binc, m, a.min)
        if got:
            rep[m.get("name")] = {"primitivesBefore": before, "primitivesAfter": len(m["primitives"]), "merged": got}
    out = compact(js, binc)
    glb.save(a.out, js, out)
    print(rep)


if __name__ == "__main__":
    main()
