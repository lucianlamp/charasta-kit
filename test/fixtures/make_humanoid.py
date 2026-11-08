"""体型と揺れものの直しのテストが使う、小さな人型の VRM 1.0 を作る(市販の VRM は再配布できないので使わない)。

  python test/fixtures/make_humanoid.py out.vrm

骨は T ポーズで回転なし。Body は骨ごとの筒(首の筒は neck と head の重みを混ぜる)、Face は頭の球(全部 head、モーフ 1 つ)、
Hair は頭の後ろの揺れ骨の帯。揺れものは髪 2 本、スカート 1 本、リボン 1 本。コライダーは頭、spine、左の上腕(球、軸から外した offset)、左の太もも(カプセル)。
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "vrm"))
import glb  # noqa: E402

# 名前、親、世界の位置
BONES = [
    ("hips", None, (0, 0.90, 0)), ("spine", "hips", (0, 0.95, 0)), ("chest", "spine", (0, 1.05, 0)), ("neck", "chest", (0, 1.25, 0)), ("head", "neck", (0, 1.31, 0)),
    ("leftShoulder", "chest", (0.02, 1.22, 0)), ("leftUpperArm", "leftShoulder", (0.10, 1.21, 0)), ("leftLowerArm", "leftUpperArm", (0.30, 1.21, 0)), ("leftHand", "leftLowerArm", (0.47, 1.21, 0)),
    ("rightShoulder", "chest", (-0.02, 1.22, 0)), ("rightUpperArm", "rightShoulder", (-0.10, 1.21, 0)), ("rightLowerArm", "rightUpperArm", (-0.30, 1.21, 0)), ("rightHand", "rightLowerArm", (-0.47, 1.21, 0)),
    ("leftUpperLeg", "hips", (0.08, 0.85, 0)), ("leftLowerLeg", "leftUpperLeg", (0.08, 0.50, 0)), ("leftFoot", "leftLowerLeg", (0.08, 0.10, 0)),
    ("rightUpperLeg", "hips", (-0.08, 0.85, 0)), ("rightLowerLeg", "rightUpperLeg", (-0.08, 0.50, 0)), ("rightFoot", "rightLowerLeg", (-0.08, 0.10, 0)),
    ("J_Sec_Hair1_01", "head", (0, 1.40, -0.09)), ("J_Sec_Hair2_01", "J_Sec_Hair1_01", (0, 1.25, -0.10)),
    ("J_Sec_Hair1_02", "head", (0.04, 1.40, -0.09)), ("J_Sec_Hair2_02", "J_Sec_Hair1_02", (0.04, 1.25, -0.10)),
    ("J_Sec_Skirt1_01", "hips", (0, 0.85, 0.11)), ("J_Sec_Skirt2_01", "J_Sec_Skirt1_01", (0, 0.70, 0.13)),
    ("Ribbon_0", "chest", (0, 1.15, 0.10)), ("Ribbon_1", "Ribbon_0", (0, 1.08, 0.11)),
]
HUMAN = [b for b, _, _ in BONES[:19]]
IDX = {b: i for i, (b, _, _) in enumerate(BONES)}
POS = {b: np.array(p, float) for b, _, p in BONES}


class Builder:
    def __init__(self):
        self.bin = bytearray()
        self.js = {"asset": {"version": "2.0"}, "buffers": [], "bufferViews": [], "accessors": []}

    def add(self, arr, typ, ct, minmax=False):
        arr = np.ascontiguousarray(arr)
        while len(self.bin) % 4:
            self.bin.append(0)
        self.js["bufferViews"].append({"buffer": 0, "byteOffset": len(self.bin), "byteLength": arr.nbytes})
        self.bin += arr.tobytes()
        a = {"bufferView": len(self.js["bufferViews"]) - 1, "componentType": ct, "count": len(arr), "type": typ}
        if minmax:
            a["min"], a["max"] = arr.min(0).tolist(), arr.max(0).tolist()
        self.js["accessors"].append(a)
        return len(self.js["accessors"]) - 1


def tube(p0, p1, r, rings=6, seg=12):
    """p0 から p1 への筒。頂点、法線、高さの割合 t、三角形"""
    u = (p1 - p0) / np.linalg.norm(p1 - p0)
    a = np.cross(u, [0, 0, 1.0]) if abs(u[2]) < 0.9 else np.cross(u, [1.0, 0, 0])
    a /= np.linalg.norm(a)
    b = np.cross(u, a)
    P, Nn, T, F = [], [], [], []
    for i in range(rings + 1):
        t = i / rings
        for j in range(seg):
            th = 2 * np.pi * j / seg
            d = np.cos(th) * a + np.sin(th) * b
            P.append(p0 + (p1 - p0) * t + r * d)
            Nn.append(d)
            T.append(t)
    for i in range(rings):
        for j in range(seg):
            q, w = i * seg + j, i * seg + (j + 1) % seg
            F += [q, q + seg, w, w, q + seg, w + seg]
    return np.array(P), np.array(Nn), np.array(T), np.array(F)


def build():
    parts = []   # (頂点, 法線, 骨の組 (n,4), 重み (n,4), 三角形)

    def part(p0, p1, r, w_of_t, rings=6):
        P, Nn, T, F = tube(POS[p0] if isinstance(p0, str) else np.array(p0, float), POS[p1] if isinstance(p1, str) else np.array(p1, float), r, rings)
        J = np.zeros((len(P), 4), int)
        W = np.zeros((len(P), 4))
        for v, t in enumerate(T):
            for k, (bone, w) in enumerate(w_of_t(t)):
                J[v, k], W[v, k] = IDX[bone], w
        parts.append((P, Nn, J, W, F))

    one = lambda b: (lambda t: [(b, 1.0)])
    part("hips", "spine", 0.12, one("hips"))
    part("spine", "chest", 0.11, one("spine"))
    part("chest", (0, 1.24, 0), 0.12, one("chest"))
    part("neck", (0, 1.33, 0), 0.03, lambda t: [("neck", 1 - t), ("head", t)], rings=8)
    for s, sg in (("left", 1), ("right", -1)):
        part(f"{s}UpperArm", f"{s}LowerArm", 0.04, one(f"{s}UpperArm"))
        part(f"{s}LowerArm", f"{s}Hand", 0.035, one(f"{s}LowerArm"))
        part(f"{s}Hand", (sg * 0.55, 1.21, 0), 0.03, one(f"{s}Hand"))
        part(f"{s}UpperLeg", f"{s}LowerLeg", 0.07, one(f"{s}UpperLeg"))
        part(f"{s}LowerLeg", f"{s}Foot", 0.05, one(f"{s}LowerLeg"))
        part(f"{s}Foot", (sg * 0.08, 0.02, 0.1), 0.04, one(f"{s}Foot"))
    body = [np.concatenate([p[i] for p in parts]) for i in range(4)]
    off, faces = 0, []
    for p in parts:
        faces.append(p[4] + off)
        off += len(p[0])
    body.append(np.concatenate(faces))

    # 顔: 頭の球(全部 head)、モーフは前の頂点を前へ
    lat, lon, c, r = 10, 16, np.array([0, 1.42, 0]), 0.1
    FP, FN = [], []
    for i in range(lat + 1):
        for j in range(lon):
            th, ph = np.pi * i / lat, 2 * np.pi * j / lon
            d = np.array([np.sin(th) * np.cos(ph), np.cos(th), np.sin(th) * np.sin(ph)])
            FP.append(c + r * d)
            FN.append(d)
    FP, FN = np.array(FP), np.array(FN)
    FF = []
    for i in range(lat):
        for j in range(lon):
            q, w = i * lon + j, i * lon + (j + 1) % lon
            FF += [q, q + lon, w, w, q + lon, w + lon]
    FJ = np.zeros((len(FP), 4), int)
    FJ[:, 0] = IDX["head"]
    FW = np.zeros((len(FP), 4))
    FW[:, 0] = 1
    morph = np.zeros_like(FP)
    morph[FP[:, 2] > 0.05, 2] = 0.01

    # 髪: 揺れ骨の帯
    HP, HJ = [], []
    for k, (a, b) in enumerate((("J_Sec_Hair1_01", "J_Sec_Hair2_01"), ("J_Sec_Hair1_02", "J_Sec_Hair2_02"))):
        for t in np.linspace(0, 1, 5):
            for dx in (-0.015, 0.015):
                HP.append(POS[a] + (POS[b] - POS[a]) * t + [dx, 0, 0])
                HJ.append((a, b, 1 - t))
    HP = np.array(HP)
    HJn = np.array([[IDX[a], IDX[b], 0, 0] for a, b, _ in HJ])
    HW = np.array([[w, 1 - w, 0, 0] for _, _, w in HJ])
    HF = []
    for k in range(2):
        base = k * 10
        for i in range(4):
            q = base + i * 2
            HF += [q, q + 2, q + 1, q + 1, q + 2, q + 3]

    B = Builder()

    def prim(P, Nn, J, W, F, morph=None):
        a = {"POSITION": B.add(P.astype(np.float32), "VEC3", 5126, True), "NORMAL": B.add((Nn / np.linalg.norm(Nn, axis=1, keepdims=True)).astype(np.float32), "VEC3", 5126),
             "JOINTS_0": B.add(J.astype(np.uint16), "VEC4", 5123), "WEIGHTS_0": B.add(W.astype(np.float32), "VEC4", 5126)}
        p = {"attributes": a, "indices": B.add(np.asarray(F, np.uint32), "SCALAR", 5125), "material": 0}
        if morph is not None:
            p["targets"] = [{"POSITION": B.add(morph.astype(np.float32), "VEC3", 5126, True)}]
        return p

    js = B.js
    js["meshes"] = [{"name": "Body", "primitives": [prim(*body)]}, {"name": "Face", "primitives": [prim(FP, FN, FJ, FW, FF, morph)]},
                    {"name": "Hair", "primitives": [prim(HP, np.tile([0, 0, -1.0], (len(HP), 1)), HJn, HW, HF)]}]
    js["materials"] = [{"name": "skin"}]
    nodes = []
    for name, parent, p in BONES:
        rel = np.array(p) - (POS[parent] if parent else 0)
        nodes.append({"name": "J_Bip_" + name if name in HUMAN else name, "translation": [float(x) for x in rel]})
    for name, parent, _ in BONES:
        if parent:
            nodes[IDX[parent]].setdefault("children", []).append(IDX[name])
    mesh_nodes = [len(nodes) + i for i in range(3)]
    nodes += [{"name": n, "mesh": i, "skin": 0} for i, n in enumerate(("Body", "Face", "Hair"))]
    js["nodes"] = nodes
    js["scenes"] = [{"nodes": [IDX["hips"]] + mesh_nodes}]
    js["scene"] = 0
    joints = list(range(len(BONES)))
    ibm = np.array([np.linalg.inv(np.block([[np.eye(3), POS[b][:, None]], [np.zeros((1, 3)), np.ones((1, 1))]])).T.reshape(16) for b, _, _ in BONES], np.float32)
    js["skins"] = [{"joints": joints, "inverseBindMatrices": B.add(ibm, "MAT4", 5126)}]
    sphere = lambda node, r, off=(0, 0, 0): {"node": IDX[node], "shape": {"sphere": {"offset": list(off), "radius": r}}}
    js["extensions"] = {
        "VRMC_vrm": {"specVersion": "1.0", "meta": {"name": "test humanoid", "version": "1", "authors": ["charasta test"], "licenseUrl": "https://vrm.dev/licenses/1.0/", "avatarPermission": "onlyAuthor"},
                     "humanoid": {"humanBones": {b: {"node": IDX[b]} for b in HUMAN}},
                     "expressions": {"preset": {"happy": {"morphTargetBinds": [{"node": mesh_nodes[1], "index": 0, "weight": 1}]}}}},
        "VRMC_springBone": {"specVersion": "1.0",
                            "colliders": [sphere("head", 0.1, (0, 0.1, 0)), sphere("spine", 0.1), sphere("leftUpperArm", 0.04, (0.1, 0.01, 0.02)),
                                          {"node": IDX["leftUpperLeg"], "shape": {"capsule": {"offset": [0, 0, 0], "radius": 0.07, "tail": [0, -0.3, 0]}}}],
                            "colliderGroups": [{"name": "body", "colliders": [0, 1, 2, 3]}],
                            "springs": [
                                {"name": "Hair-hair_0", "joints": [{"node": IDX["J_Sec_Hair1_01"], "stiffness": 0.8, "dragForce": 0.4, "gravityPower": 0, "gravityDir": [0, -1, 0], "hitRadius": 0.02},
                                                                    {"node": IDX["J_Sec_Hair2_01"], "stiffness": 0.6, "dragForce": 0.4, "gravityPower": 0, "gravityDir": [0, -1, 0], "hitRadius": 0.02}], "colliderGroups": [0]},
                                {"name": "Hair-hair_1", "joints": [{"node": IDX["J_Sec_Hair1_02"], "stiffness": 0.8, "dragForce": 0.4, "gravityPower": 0, "gravityDir": [0, -1, 0], "hitRadius": 0.02},
                                                                    {"node": IDX["J_Sec_Hair2_02"], "stiffness": 0.6, "dragForce": 0.4, "gravityPower": 0, "gravityDir": [0, -1, 0], "hitRadius": 0.02}], "colliderGroups": [0]},
                                {"name": "Skirt-skirt0_0", "joints": [{"node": IDX["J_Sec_Skirt1_01"], "stiffness": 0.5, "dragForce": 0.05, "gravityPower": 0, "gravityDir": [0, -1, 0], "hitRadius": 0.02},
                                                                       {"node": IDX["J_Sec_Skirt2_01"], "stiffness": 0.5, "dragForce": 0.05, "gravityPower": 0, "gravityDir": [0, -1, 0], "hitRadius": 0.02}], "colliderGroups": [0]},
                                {"name": "", "joints": [{"node": IDX["Ribbon_0"], "stiffness": 1.0, "dragForce": 0.3, "gravityPower": 0.2, "gravityDir": [0, -1, 0], "hitRadius": 0.01},
                                                         {"node": IDX["Ribbon_1"], "stiffness": 1.0, "dragForce": 0.3, "gravityPower": 0.2, "gravityDir": [0, -1, 0], "hitRadius": 0.01}]}]}}
    js["extensionsUsed"] = ["VRMC_vrm", "VRMC_springBone"]
    js["buffers"] = [{"byteLength": len(B.bin)}]
    return js, B.bin


if __name__ == "__main__":
    js, binc = build()
    glb.save(sys.argv[1], js, binc)
    print(json.dumps({"out": sys.argv[1], "nodes": len(js["nodes"])}))
