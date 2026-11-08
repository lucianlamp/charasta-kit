"""glTF バイナリ(.glb / .vrm)を読み書きする最小の道具。accessor を numpy で読み、同じ大きさで上書きする。"""
import json
import struct

import numpy as np

CT = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8, 5122: np.int16, 5120: np.int8}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def load(path):
    b = open(path, "rb").read()
    if b[:4] != b"glTF":
        raise ValueError(f"glTF バイナリではない: {path}")
    jl = struct.unpack("<I", b[12:16])[0]
    js = json.loads(b[20:20 + jl])
    o = 20 + jl
    bl = struct.unpack("<I", b[o:o + 4])[0]
    return js, bytearray(b[o + 8:o + 8 + bl])


def _where(js, i):
    a = js["accessors"][i]
    v = js["bufferViews"][a["bufferView"]]
    dt, n = CT[a["componentType"]], NC[a["type"]]
    return a, v.get("byteOffset", 0) + a.get("byteOffset", 0), v.get("byteStride", 0), dt, n, np.dtype(dt).itemsize * n


def acc(js, binc, i):
    a, off, st, dt, n, isz = _where(js, i)
    if st and st != isz:
        raw = np.frombuffer(bytes(binc[off:off + st * a["count"]]), np.uint8).reshape(a["count"], st)[:, :isz].copy()
        return np.frombuffer(raw.tobytes(), dt).reshape(a["count"], n)
    return np.frombuffer(bytes(binc[off:off + isz * a["count"]]), dt).reshape(a["count"], n).copy()


def put(js, binc, i, arr):
    a, off, st, dt, n, isz = _where(js, i)
    if st and st != isz:
        raise ValueError("間を空けて並んだ accessor には書けない")
    arr = np.ascontiguousarray(np.asarray(arr).astype(dt)).reshape(a["count"], n)
    binc[off:off + isz * a["count"]] = arr.tobytes()
    if "min" in a:
        a["min"], a["max"] = arr.min(0).tolist(), arr.max(0).tolist()


def save(path, js, binc):
    jb = json.dumps(js, separators=(",", ":"), ensure_ascii=False).encode("utf8")
    jb += b" " * ((4 - len(jb) % 4) % 4)
    bb = bytes(binc) + b"\0" * ((4 - len(binc) % 4) % 4)
    out = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(jb) + 8 + len(bb)) + struct.pack("<I", len(jb)) + b"JSON" + jb + struct.pack("<I", len(bb)) + b"BIN\0" + bb
    open(path, "wb").write(out)
