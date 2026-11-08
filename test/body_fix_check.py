"""体に合わせる直しの純粋な部分: 手のめり込み補正の時間の処理(tools/rgbmocap/hand_body_fix.py)、首の長さ(tools/vrm/neck_len.py)、UV の余白埋め(tools/vrm/uv_pad.py)。
Blender と vrma-pipeline は呼ばない(numpy だけ)。"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "tools" / "rgbmocap"))
sys.path.insert(0, str(ROOT / "tools" / "vrm"))
import glb  # noqa: E402
import hand_body_fix as H  # noqa: E402
import neck_len as NL  # noqa: E402

# --- 手のめり込み補正: 時間でつなぐ ---
T = 60
need = np.zeros(T, bool)
need[20:25] = True
need[28:30] = True          # 3 コマのすき間はつなぐ
need[50:52] = True          # 20 コマ離れた所は別の区間
D = np.zeros((T, 3))
D[need] = [0.0, 0.0, 0.05]
S = H.temporal(D, need)
assert S.shape == (T, 3)
assert np.all(S[:10] == 0) and np.all(S[-2:] == 0), "区間と出入りの外は 0"
assert np.all(S[25:28, 2] > 0.04), "6 コマ以下のすき間はつないで動きを保つ"
assert 0 < S[16, 2] < S[19, 2] < S[22, 2], "前の出入りは 0 から滑らかに上がる"
assert np.all(S[36:44] == 0), "区間の間の離れた所は 0 に戻る"
assert S[50, 2] > 0, "別の区間も直す"
assert abs(S[25, 2] - 0.05) < 1e-9, "区間の中ほど(端から窓の半分より奥)は解いた量のまま"
d1 = np.abs(np.diff(S[:, 2]))
assert d1.max() < 0.02, f"コマの間の跳びが大きい: {d1.max()}"
assert np.all(H.temporal(np.zeros((T, 3)), np.zeros(T, bool)) == 0), "めり込みが無ければ何もしない"

P = np.array([[0, 0, 0.0], [0.5, 0, 0], [1.0, 0, 0], [0.1, 0, 0]])
g = H.gain(P, np.array([False, False, False, True]), np.zeros(3), np.array([1.0, 0, 0]))
assert np.allclose(g, [0.25, 0.5, 1.0, 1.0]), g

z = {"frames": np.arange(4)}
for s in ("left", "right"):
    for p in ("hand", "fore"):
        for r in H.REGIONS:
            z[f"before_{s}_{p}_{r}"] = np.zeros(4)
z["before_left_hand_head"] = np.array([0, 0.004, 0.02, 0.006])
z["before_left_fore_torso"] = np.array([0.007, 0, 0, 0])
rep = H.depth_summary(z, "before")
assert rep["left"] == {"framesOver5mm": 3, "maxDepthM": 0.02}, rep
assert rep["right"] == {"framesOver5mm": 0, "maxDepthM": 0.0}, rep

# --- 首の長さ: 小さな VRM を作って伸ばす ---
# 節点: 0 hips(y 1.0)> 1 neck(y 1.2)> 2 head(y 1.3)> 3 髪の骨(y 1.4)。メッシュ Body(首の筒と、筒の外と、帽子)と Face
def vrm_bytes():
    nodes = [{"name": "hips", "translation": [0, 1.0, 0], "children": [1]},
             {"name": "neck", "translation": [0, 0.2, 0], "children": [2]},
             {"name": "head", "translation": [0, 0.1, 0], "children": [3]},
             {"name": "hair", "translation": [0, 0.1, 0]},
             {"name": "Body", "mesh": 0, "skin": 0},
             {"name": "Face", "mesh": 1, "skin": 0}]
    body = np.array([[0, 1.0, 0], [0, 1.25, 0], [0.1, 1.25, 0], [0, 1.35, 0]], np.float32)
    hat = np.array([[0, 1.5, 0], [0.05, 1.55, 0], [0, 1.6, 0.05]], np.float32)
    face = np.array([[0, 1.24, 0.02], [0, 1.32, 0.05], [0.12, 1.2, 0]], np.float32)
    world_y = [1.0, 1.2, 1.3, 1.4]
    ibm = np.stack([np.linalg.inv(np.array([[1, 0, 0, 0], [0, 1, 0, y], [0, 0, 1, 0], [0, 0, 0, 1.0]])).T for y in world_y]).astype(np.float32)
    blobs, views, accs = [], [], []
    for arr, typ in ((body, "VEC3"), (hat, "VEC3"), (face, "VEC3"), (ibm.reshape(-1, 16), "MAT4")):
        off = sum(len(b) for b in blobs)
        blobs.append(arr.tobytes())
        views.append({"buffer": 0, "byteOffset": off, "byteLength": arr.nbytes})
        a = {"bufferView": len(views) - 1, "componentType": 5126, "count": len(arr), "type": typ}
        if typ == "VEC3":
            a["min"], a["max"] = arr.min(0).tolist(), arr.max(0).tolist()
        accs.append(a)
    binc = b"".join(blobs)
    js = {"asset": {"version": "2.0"}, "nodes": nodes, "buffers": [{"byteLength": len(binc)}], "bufferViews": views, "accessors": accs,
          "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}, {"attributes": {"POSITION": 1}}]}, {"primitives": [{"attributes": {"POSITION": 2}}]}],
          "skins": [{"joints": [0, 1, 2, 3], "inverseBindMatrices": 3}],
          "extensions": {"VRMC_vrm": {"humanoid": {"humanBones": {"hips": {"node": 0}, "neck": {"node": 1}, "head": {"node": 2}}}}}}
    return js, bytearray(binc)


js, binc = vrm_bytes()
tmp = Path(__file__).resolve().parent / ".body_fix_tmp.vrm"
glb.save(tmp, js, binc)
js, binc = glb.load(tmp)
tmp.unlink()
D, z0, z1 = 0.01, 1.22, 1.28
rep = NL.neck_len(js, binc, D, z0, z1)
G, _ = NL.world_mats(js["nodes"])
assert abs(G[2][1, 3] - 1.31) < 1e-6 and abs(G[3][1, 3] - 1.41) < 1e-6, "区間より上の頭と髪の骨は D 上がる"
assert abs(G[1][1, 3] - 1.2) < 1e-9, "区間より下の首の骨は動かない"
assert rep["nodesMoved"] == 2 and rep["inverseBindMoved"] == 2, rep
IB = glb.acc(js, binc, 3).reshape(-1, 4, 4)
for k in range(4):
    assert np.allclose(G[k] @ IB[k].T, np.eye(4), atol=1e-6), f"静止の形が変わらない(節点 {k})"
body = glb.acc(js, binc, 0)
assert abs(body[0, 1] - 1.0) < 1e-6, "区間の下の頂点は動かない"
assert abs(body[1, 1] - (1.25 + NL.smooth_shift(1.25, D, z0, z1))) < 1e-6 and body[1, 1] > 1.25, "首の筒の中は高さに応じて動く"
assert abs(body[2, 1] - 1.25) < 1e-6, "Body の筒の外(肩)は動かない"
assert abs(body[3, 1] - 1.36) < 1e-6, "Body の筒の中で区間より上は D 上がる"
assert np.allclose(glb.acc(js, binc, 1)[:, 1], [1.51, 1.56, 1.61], atol=1e-6), "区間より上だけの部品(帽子)は全部 D 上がる"
face = glb.acc(js, binc, 2)
assert abs(face[1, 1] - 1.33) < 1e-6 and abs(face[2, 1] - 1.2) < 1e-6, "顔は筒に関係なく高さで動く"
assert js["accessors"][0]["max"][1] > 1.359, "min と max も直す"
try:
    NL.neck_len(js, binc, D, 1.3, 1.2)
    raise AssertionError("逆の区間は断る")
except ValueError:
    pass
# --- primitive をまとめる: Body の 2 個(同じ材質なし、同じ属性)を 1 個にし、使わなくなったデータを詰める ---
import merge_prims as MP  # noqa: E402
js, binc = vrm_bytes()
P0 = np.concatenate([glb.acc(js, binc, 0), glb.acc(js, binc, 1)])
IB0 = glb.acc(js, binc, 3)
got = MP.merge_mesh(js, binc, js["meshes"][0])
assert got == [{"primitives": 2, "vertices": 7, "material": None}], got
assert len(js["meshes"][0]["primitives"]) == 1 and len(js["meshes"][1]["primitives"]) == 1
binc = MP.compact(js, binc)
assert len(js["accessors"]) == 3, "使わなくなった 2 個の accessor は消える"
assert np.array_equal(glb.acc(js, binc, js["meshes"][0]["primitives"][0]["attributes"]["POSITION"]), P0), "頂点はそのまま連結"
assert np.array_equal(glb.acc(js, binc, js["skins"][0]["inverseBindMatrices"]), IB0), "逆バインド行列は残る"
assert js["accessors"][js["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]["max"][1] > 1.59
# --- UV の余白を島の縁の色で埋める: 16x16 の画像に三角形 2 つ(島 A は範囲の中、島 B は範囲の外) ---
import uv_pad as UP  # noqa: E402
T0 = np.zeros((16, 16, 3), np.uint8)
T0[...] = (200, 50, 50)          # 余白(元の濃い色)
tri = np.array([[[0.0, 0.0], [0.5, 0.0], [0.0, 0.5]],      # 島 A(左上)
                [[1.0, 1.0], [0.75, 1.0], [1.0, 0.75]]])   # 島 B(右下)
_m, yy, xx = UP.raster(*(tri[0] * 16 - 0.5), 16, 16)
T0[yy[_m], xx[_m]] = (240, 180, 178)                      # 島 A の中を塗り直した色
T1, gap, cov = UP.pad_gutter(T0, tri, np.array([True, False]), 3)
assert np.array_equal(T1[cov], T0[cov]), "覆う画素は変えない"
assert gap.any() and np.all(T1[gap] == (240, 180, 178)), "島 A の外の余白は島 A の縁の色になる"
far = (~cov) & ~gap
assert np.all(T1[far] == T0[far]), "pad より遠い余白と、範囲の外の島 B の余白は変えない"
assert not gap[9:, 9:].any() and cov[12:, 12:].any(), "範囲の外の島 B のまわりは埋めない"

# --- uv_pad の書き出しまで: PNG と JPEG の 2 テクスチャの小さな GLB ---
import contextlib
import io
import tempfile
from PIL import Image


def _synth_glb(path):
    rng = np.random.default_rng(3)
    png = Image.fromarray(rng.integers(0, 255, (16, 16, 3), dtype=np.uint8))
    jpg = Image.fromarray(np.tile(np.linspace(0, 255, 16, dtype=np.uint8)[:, None, None], (1, 16, 3)))
    bp, bj = io.BytesIO(), io.BytesIO()
    png.save(bp, "PNG")
    jpg.save(bj, "JPEG", quality=90)
    pos = np.array([[0, 1, 0], [1, 1, 0], [0, 2, 0]], np.float32).tobytes()
    uv = np.array([[0.1, 0.1], [0.6, 0.1], [0.1, 0.6]], np.float32).tobytes()
    idx = np.array([0, 1, 2], np.uint16).tobytes()
    views, blobs, off = [], [], [0]

    def add(data):
        padn = (-off[0]) % 4
        if padn:
            blobs.append(b"\0" * padn)
            off[0] += padn
        views.append({"buffer": 0, "byteOffset": off[0], "byteLength": len(data)})
        blobs.append(data)
        off[0] += len(data)
        return len(views) - 1
    accessors, meshes, nodes = [], [], []
    for k in range(2):
        vp, vu, vi = add(pos), add(uv), add(idx)
        a0 = len(accessors)
        accessors += [{"bufferView": vp, "componentType": 5126, "count": 3, "type": "VEC3"},
                      {"bufferView": vu, "componentType": 5126, "count": 3, "type": "VEC2"},
                      {"bufferView": vi, "componentType": 5123, "count": 3, "type": "SCALAR"}]
        meshes.append({"primitives": [{"attributes": {"POSITION": a0, "TEXCOORD_0": a0 + 1}, "indices": a0 + 2, "material": k}]})
        nodes.append({"name": ("MeshPng", "MeshJpg")[k], "mesh": k})
    ip, ij = add(bp.getvalue()), add(bj.getvalue())
    J = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0, 1]}], "nodes": nodes, "meshes": meshes,
         "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": k}}} for k in range(2)],
         "textures": [{"source": 0}, {"source": 1}],
         "images": [{"bufferView": ip, "mimeType": "image/png"}, {"bufferView": ij, "mimeType": "image/jpeg"}],
         "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": off[0]}]}
    glb.save(path, J, bytearray(b"".join(blobs)))
    return ip, ij


def _views(path):
    J, B = glb.load(path)
    return J, [bytes(B[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]) for v in J["bufferViews"]]


with tempfile.TemporaryDirectory() as td, contextlib.redirect_stdout(io.StringIO()):
    src, dst = str(Path(td) / "in.glb"), str(Path(td) / "out.glb")
    ip, ij = _synth_glb(src)
    J0, V0 = _views(src)
    tri = np.array([[[0.1, 0.1], [0.6, 0.1], [0.1, 0.6]]])
    for mesh, img, other, imi, oti in (("MeshPng", ip, ij, 0, 1), ("MeshJpg", ij, ip, 1, 0)):
        UP.process(src, dst, mesh=mesh, pad=3)
        J1, V1 = _views(dst)
        assert [v for k, v in enumerate(V1) if k != img] == [v for k, v in enumerate(V0) if k != img], f"{mesh}: 画像以外の bufferView はバイト単位で同じ"
        assert J1["images"][imi]["mimeType"] == "image/png", f"{mesh}: 書き出しは PNG"
        assert V1[img][:8] == b"\x89PNG\r\n\x1a\n"
        assert J1["images"][oti]["mimeType"] == J0["images"][oti]["mimeType"], "ほかの画像の mimeType は変えない"
        a = np.asarray(Image.open(io.BytesIO(V0[img])).convert("RGB"))
        b = np.asarray(Image.open(io.BytesIO(V1[img])).convert("RGB"))
        _t, gap2, _c = UP.pad_gutter(a, tri, np.array([True]), 3)
        assert gap2.any(), "余白を埋める画素がある"
        assert np.array_equal(a[~gap2], b[~gap2]), f"{mesh}: 余白以外の画素は変わらない(JPEG も)"
        assert (a != b).any(-1)[gap2].any(), "余白は変わる"

    # 止まるべき入力は分かる文で止まる
    def expect(word, **kw):
        try:
            UP.process(src, None, probe=True, **kw)
        except UP.UvPadError as e:
            assert word in str(e), str(e)
            return
        raise AssertionError("止まるはず: " + word)
    expect("Nope", mesh="Nope")
    J, B = glb.load(src)
    J["meshes"].append({"primitives": []})
    J["nodes"].append({"name": "Empty", "mesh": 2})
    glb.save(src, J, B)
    expect("primitive", mesh="Empty")
    J["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["texCoord"] = 1
    glb.save(src, J, B)
    expect("texCoord", mesh="MeshPng")
    J["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0, "extensions": {"KHR_texture_transform": {}}}
    glb.save(src, J, B)
    expect("KHR_texture_transform", mesh="MeshPng")

    def one_image(img):
        bb = io.BytesIO()
        img.save(bb, "PNG", **({"transparency": 0} if img.mode == "P" else {}))
        d = bb.getvalue()
        return {"bufferViews": [{"byteOffset": 0, "byteLength": len(d)}], "images": [{"bufferView": 0}]}, bytearray(d)
    J3, B3 = one_image(Image.fromarray(np.zeros((16, 16), np.uint16)))
    try:
        UP.load_texture(J3, B3, J3["images"][0])
        raise AssertionError("16 ビットは止まるはず")
    except UP.UvPadError as e:
        assert "16" in str(e)
    pal = Image.new("P", (4, 4), 0)
    pal.putpalette([255, 0, 0, 0, 255, 0])
    J3, B3 = one_image(pal)
    arr, _m = UP.load_texture(J3, B3, J3["images"][0])
    assert arr.shape[2] == 4 and arr[0, 0, 3] == 0, "パレットの透明は RGBA の A に残る"

print(json.dumps({"ok": True}))
