"""VRMA を、その中の静止姿勢の骨（MotionBricks で作ったものなら SOMA の体つき）で組み立てて、足の接地と滑りを測る。

    python tools/vrma_feet.py motion.vrma [...]

キャラに当てたとき（tools/motion_shots.mjs の slide）と比べて、滑りが移し替え（体つきの違い）で増えたのか、
もとの動きにあるのかを見分ける。測り方は motion_shots.mjs と同じ（その足の最低から 3 cm 以内が 5 コマ以上続く区間を接地とみなす）。
"""

import json
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from soma_vrma import qmul, qrot  # noqa: E402


def load(path):
    buf = Path(path).read_bytes()
    jl = struct.unpack_from("<I", buf, 12)[0]
    js = json.loads(buf[20:20 + jl])
    blob = buf[20 + jl + 8:]

    def read(i, width):
        a = js["accessors"][i]
        v = js["bufferViews"][a["bufferView"]]
        return np.frombuffer(blob, np.float32, a["count"] * width, v["byteOffset"]).reshape(a["count"], width).astype(np.float64)
    return js, read


def feet(path):
    js, read = load(path)
    nodes = js["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    anim = js["animations"][0]
    rot, trans = {}, None
    for ch in anim["channels"]:
        s = anim["samplers"][ch["sampler"]]
        if ch["target"]["path"] == "rotation":
            rot[ch["target"]["node"]] = read(s["output"], 4)
        else:
            trans = read(s["output"], 3)
    n = len(trans)
    pos, wrot = {}, {}
    for i, node in enumerate(nodes):   # 親が先に並んでいる
        q = rot.get(i, np.tile([0, 0, 0, 1.0], (n, 1)))
        if i not in parent:
            pos[i], wrot[i] = trans, q
        else:
            p = parent[i]
            pos[i] = pos[p] + qrot(wrot[p], np.tile(node["translation"], (n, 1)))
            wrot[i] = qmul(wrot[p], q)
    names = {nd["name"]: i for i, nd in enumerate(nodes)}
    out, slides = {}, []
    lows = []
    for a, b in (("leftFoot", "leftToes"), ("rightFoot", "rightToes")):
        pa, pb = pos[names[a]], pos[names[b]]
        low = np.minimum(pa[:, 1], pb[:, 1])
        lows.append(low.min())
        floor = low.min()
        on = low - floor <= 0.03
        stance = np.zeros(n, bool)   # 最低から 3 cm 以内が 5 コマ以上続く区間
        i = 0
        while i < n:
            j = i
            while j < n and on[j] == on[i]:
                j += 1
            if on[i] and j - i >= 5:
                stance[i:j] = True
            i = j
        for i in range(1, n):
            if not (stance[i] and stance[i - 1]):
                continue
            k = pa if pa[i, 1] < pb[i, 1] else pb
            slides.append(np.hypot(*(k[i, [0, 2]] - k[i - 1, [0, 2]])) * 30 * 100)
    slides = np.sort(slides)
    out = {"file": str(path), "footMinY": float(min(lows)), "contactFrames": len(slides),
           "meanCmPerSec": float(slides.mean()) if len(slides) else 0.0,
           "p95CmPerSec": float(slides[int(len(slides) * 0.95)]) if len(slides) else 0.0}
    return out


if __name__ == "__main__":
    for f in sys.argv[1:]:
        print(json.dumps(feet(f), ensure_ascii=False))
