"""vrma-pipeline（vrma_playback と footlock）を import できるようにする。場所は環境変数 VRMA_PIPELINE_DIR（compose.py と同じ。既定は無い）。"""
import json
import os
import struct
import sys
from pathlib import Path


def pipeline_dir():
    d = os.environ.get("VRMA_PIPELINE_DIR")
    if not d:
        raise RuntimeError("vrma-pipeline の場所が分からない。きゃらすたの設定(vrmaPipelineDir)か、環境変数 VRMA_PIPELINE_DIR で指定する")
    return Path(d)


def load():
    """(vrma_playback, footlock) を返す。vrma-pipeline が無ければ ImportError。"""
    src = str(pipeline_dir() / "src")
    if src not in sys.path:
        sys.path.insert(0, src)
    from vrma_pipeline import footlock, vrma_playback  # noqa: E402
    return vrma_playback, footlock


def write_glb(path, js, binc):
    jb = json.dumps(js, separators=(",", ":")).encode("utf-8")
    jb += b" " * ((4 - len(jb) % 4) % 4)
    bb = bytes(binc) + b"\0" * ((4 - len(binc) % 4) % 4)
    total = 12 + 8 + len(jb) + 8 + len(bb)
    Path(path).write_bytes(struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(jb), 0x4E4F534A) + jb
                           + struct.pack("<II", len(bb), 0x004E4942) + bb)


def put_accessor(js, binc, i, values):
    """float32 の accessor i を values（(count, 成分数)）で上書きする（binc は bytearray）。"""
    import numpy as np
    a = js["accessors"][i]
    bv = js["bufferViews"][a["bufferView"]]
    c = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    assert a["componentType"] == 5126 and values.shape == (a["count"], c)
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride", 0) or 4 * c
    v = values.astype(np.float32)
    for k in range(a["count"]):
        binc[start + k * stride: start + k * stride + 4 * c] = v[k].tobytes()
    if "min" in a:
        a["min"] = v.min(0).tolist()
        a["max"] = v.max(0).tolist()
