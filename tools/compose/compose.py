"""計画ファイル（JSON）を読み、文章・動画・アセット・VRMA・MotionBricks の条件の区間を 1 本の VRMA につなぐ。計画の書き方は skills/motion-compose/SKILL.md。

    python tools/compose/compose.py plan.json --out DIR [--work DIR] [--fake]

DIR に書くもの: motion.vrma、contacts.json、license.json、generated.json、report.json。
素材の変換は --work（既定は DIR/work）の cache に残し、同じ条件なら作り直さない。
--fake は Kimodo と MotionBricks を呼ばない（文章と MotionBricks の区間は作りものの動き、つなぎは補間。テスト用）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import charasta_paths as P  # noqa: E402
import anatomy  # noqa: E402
import check  # noqa: E402
import clip as C  # noqa: E402
from fbx_clip import fbx_to_clip, find_rest  # noqa: E402
import fingers  # noqa: E402
import grip as Grip  # noqa: E402
import neck as Neck  # noqa: E402
from records import BRIDGE_LICENSE, KIMODO_LICENSE, merge_licenses, motionbricks_license  # noqa: E402
from soma_vrma import retarget, write_vrma  # noqa: E402
from vrma_read import read_vrma  # noqa: E402
import weapon as Weapon  # noqa: E402
import weapon_check as WeaponCheck  # noqa: E402

# 外の道具の場所は環境変数で受け取る(きゃらすたのサーバーが設定から渡す。lib/motion-recipe.mjs)。既定の場所は持たない。
# 設定が無い道具は None で、使う区間があるときに need() が「設定が要る」と断る。
KIMODO_PYTHON = P.env_value("KIMODO_PYTHON")
MOTIONBRICKS_DIR = P.env_value("MOTIONBRICKS_DIR")
PIPELINE_DIR = Path(P.env_value("VRMA_PIPELINE_DIR")) if P.env_value("VRMA_PIPELINE_DIR") else None
BLENDER = P.find_blender()
UV = os.environ.get("CHARASTA_UV", "uv")
DEFAULT_LIBRARY = P.default_library()
DEFAULT_BRIDGE = {"seconds": 1.2, "method": "motionbricks", "gap": None}
MIN_BRIDGE_SEC, MAX_BRIDGE_SEC = 16 / C.FPS, 56 / C.FPS   # MotionBricks の 6〜16 トークン
SOURCES = ("text", "video", "asset", "vrma", "motionbricks")
MB_GEN = HERE.parent / "motionbricks_gen.py"
# MotionBricks の条件で選べる値。きゃらすたの motion-gen ジョブ（lib/motion-gen.mjs の motionGenConditions）と同じファイル、同じ規則で確かめる
MB_OPTIONS = json.loads((HERE.parents[1] / "lib" / "motion-gen-options.json").read_text(encoding="utf8"))
MB_KEYS = ("kind", "speed", "direction", "turn", "seconds", "action", "ending", "root")
BOTH_ARMS = "both-arms"


def key_of(*parts):
    return hashlib.sha1(json.dumps(parts, ensure_ascii=False, sort_keys=True).encode("utf8")).hexdigest()[:16]


def file_key(path):
    """ファイルの中身の値。同じパスで中身を変えたら作り直す。パスが無ければ None。"""
    return hashlib.sha1(Path(path).read_bytes()).hexdigest()[:16] if path else None


def run(cmd, env=None, cwd=None):
    print(">", " ".join(str(c) for c in cmd[:6]), "...", flush=True)
    subprocess.run([str(c) for c in cmd], check=True, env={**os.environ, "PYTHONUTF8": "1", **(env or {})}, cwd=cwd)


def library_dir(plan):
    """保管場所。計画の library、CHARASTA_LIBRARY、CHARASTA_CONFIG かリポジトリの config.json の libraryDir の順に見る。読むだけで書かない。"""
    found = plan.get("library") or os.environ.get("CHARASTA_LIBRARY")
    if found:
        return Path(found)
    config = Path(os.environ.get("CHARASTA_CONFIG") or HERE.parent.parent / "config.json")
    if config.exists():
        return Path(json.loads(config.read_text(encoding="utf8")).get("libraryDir", DEFAULT_LIBRARY))
    return Path(DEFAULT_LIBRARY)


def open_library_motion(seg, library):
    """motion の ID から VRMA のパスと許諾を決める。許諾は motion.json の値をそのまま使い、計画の値で上書きしない。"""
    if "license" in seg:
        raise SystemExit(f"区間「{seg['label']}」は motion と license を同時に書けない（許諾は保管場所の motion.json をそのまま読む）")
    folder = library / "motions" / seg["motion"]
    record = folder / "motion.json"
    if not record.exists():
        raise SystemExit(f"区間「{seg['label']}」のモーション {seg['motion']} が保管場所 {library} に無い")
    m = json.loads(record.read_text(encoding="utf8"))
    seg["path"] = str(folder / "motion.vrma")
    lic = m.get("license")
    # 古い MotionBricks の生成物は evaluationOnly を持たない。きゃらすたが読むとき（lib/library.mjs の #motionRecord）と同じく、見本の動きの許諾から補う
    if lic and "evaluationOnly" not in lic and any("Sample Data Evaluation License" in str(t.get("license", "")) for t in lic.get("terms", [])):
        lic = {**lic, "evaluationOnly": True}
    seg["licenseRecord"] = lic
    seg["motionRecord"] = {"id": seg["motion"], "library": str(library), "sha256": m.get("sha256"), "source": m.get("source"), "contacts": m.get("contacts")}
    if m.get("contacts"):
        seg["contactsPath"] = str(folder / m["contacts"])


def _mb_pick(value, table, name, fallback):
    v = fallback if value is None else value
    if not isinstance(v, str) or v not in table:
        raise SystemExit(f"{name} は {' / '.join(table)}")
    return v


def _mb_num(value, name, lo, hi, fallback):
    # bool は int の仲間なので断る。数字の文字列は通す（lib/motion-gen.mjs の num と同じ）
    if value is None or value == "":
        v = fallback
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        v = float(value)
    elif isinstance(value, str) and value.strip():
        try:
            v = float(value)
        except ValueError:
            v = float("nan")
    else:
        v = float("nan")
    if not (v == v and lo <= v <= hi):
        raise SystemExit(f"{name} は {lo}〜{hi} の数")
    return int(v) if float(v).is_integer() else v


def mb_conditions(seg, at):
    """MotionBricks の区間の条件を確かめて既定を埋める。lib/motion-gen.mjs の motionGenConditions と同じ規則。"""
    o, d = MB_OPTIONS, MB_OPTIONS["defaults"]
    kind = _mb_pick(seg.get("kind"), o["kinds"], f"{at} の kind", d["kind"])
    k = o["kinds"][kind]
    c = {"kind": kind,
         "speed": round(_mb_num(seg.get("speed"), f"{at} の speed", k["min"], k["max"], k["default"]) * 1000) / 1000,
         "direction": _mb_pick(seg.get("direction"), o["directions"], f"{at} の direction", d["direction"]) if k.get("directions") else "forward",
         "turn": _mb_num(seg.get("turn"), f"{at} の turn", *o["turn"], d["turn"]),
         "seconds": _mb_num(seg.get("seconds"), f"{at} の seconds", *o["seconds"], d["seconds"]),
         "action": _mb_pick(seg.get("action"), o["actions"], f"{at} の action", d["action"]),
         "ending": _mb_pick(seg.get("ending"), o["endings"], f"{at} の ending", d["ending"]),
         "root": _mb_pick(seg.get("root"), o["roots"], f"{at} の root", d["root"])}
    if c["speed"] == int(c["speed"]):
        c["speed"] = int(c["speed"])
    if c["action"] != "none" and kind != "forward":
        raise SystemExit(f"{at} の途中の動作は「歩き・走り」のときだけ")
    if c["action"] != "none" and c["seconds"] < o["actionMinSeconds"]:
        raise SystemExit(f"{at} の途中の動作を入れるときは長さを {o['actionMinSeconds']} 秒以上にする")
    return c


def license_of(seg):
    """区間の許諾。文章は Kimodo の記録、保管場所のモーションは motion.json、それ以外は計画に書いた license（辞書か JSON のパス）。無ければ止める。推測で埋めない。"""
    lic = seg.get("licenseRecord") or seg.get("license")
    if isinstance(lic, str):
        lic = json.loads(Path(lic).read_text(encoding="utf8"))
    if lic is None and seg["source"] == "text":
        return KIMODO_LICENSE
    if seg["source"] == "motionbricks":
        if lic is not None:
            raise SystemExit(f"区間「{seg['label']}」は motionbricks なので license を書かない（MotionBricks の記録を使う）")
        return motionbricks_license([])   # 見本の動きの一覧は作ったあとに入れる（make_motionbricks）
    if not lic or "summary" not in lic or "redistribution" not in lic:
        raise SystemExit(f"区間「{seg['label']}」の license が無い（holder、summary、redistribution を書く）")
    return lic


def read_plan(path):
    plan = json.loads(Path(path).read_text(encoding="utf8"))
    segs = plan.get("segments") or []
    if len(segs) < 1:
        raise SystemExit("segments が空")
    for i, s in enumerate(segs):
        if s.get("source") not in SOURCES:
            raise SystemExit(f"区間 {i} の source は {', '.join(SOURCES)} のどれか: {s.get('source')}")
        s.setdefault("label", f"{i + 1}-{s['source']}")
        if ("contacts" in s or "motionRecord" in s) and (s["source"] != "vrma" or "motion" in s):
            raise SystemExit(f"区間「{s['label']}」の contacts と motionRecord は、path の vrma の区間だけに書く（motion の区間は motion.json から読む）")
        if "motionRecord" in s and not isinstance(s["motionRecord"], dict):
            raise SystemExit(f"区間「{s['label']}」の motionRecord は連想配列")
        if s["source"] == "motionbricks":
            s.update(mb_conditions(s, f"区間「{s['label']}」"))
        if s["source"] == "vrma" and "motion" in s:
            open_library_motion(s, library_dir(plan))
        elif "contacts" in s:   # 保管場所の外の VRMA の接地（きゃらすたが写した、確認待ちのジョブの結果の contacts.json など）
            s["contactsPath"] = s["contacts"]
        need = {"text": ("prompt", "seconds"), "video": ("path",), "asset": ("path",), "vrma": ("path",), "motionbricks": ()}[s["source"]]
        if not all(k in s for k in need):
            raise SystemExit(f"区間「{s['label']}」に {', '.join(need)} が要る（vrma は motion でもよい）")
        if s.get("root", "keep") not in ("keep", "inplace"):
            raise SystemExit(f"区間「{s['label']}」の root は keep か inplace")
        if "grip" in s and (s["source"] != "asset" or s["grip"] not in ("right", "left")):
            raise SystemExit(f"区間「{s['label']}」の grip は asset の区間に right か left で書く")
        if "grip" in s and not plan.get("model") and s.get("gripBody") != "rest":
            raise SystemExit(f"区間「{s['label']}」の grip には計画の model が要る。REST の体で解くなら gripBody: rest を書く")
        if "gripSolve" in s and s["gripSolve"] not in (BOTH_ARMS, Grip.OTHER.get(s.get("grip"), "") + "-arm"):
            raise SystemExit(f"区間「{s['label']}」の gripSolve は {BOTH_ARMS} か、武器を持たない方の腕（left-arm か right-arm）")
        if "weapon" in s:
            if s["source"] != "asset" or "grip" in s or not plan.get("model") or s.get("gripBody") == "rest":
                raise SystemExit(f"区間「{s['label']}」の weapon は、計画に model がある asset の区間に、grip の代わりに書く")
            s["weaponDef"] = Weapon.read(s["weapon"])
        if s["source"] == "asset":
            s["neckLimitDeg"] = s.get("neckLimitDeg", plan.get("neckLimitDeg", Neck.LIMIT_DEG))
            s["chestShare"] = s.get("chestShare", plan.get("chestShare", Neck.CHEST_SHARE))
            if not Neck.LIMIT_MIN_DEG <= s["neckLimitDeg"] <= Neck.LIMIT_MAX_DEG:
                raise SystemExit(f"区間「{s['label']}」の neckLimitDeg は 30〜180 度")
            if not 0 <= s["chestShare"] <= 1:
                raise SystemExit(f"区間「{s['label']}」の chestShare は 0〜1")
        elif "neckLimitDeg" in s or "chestShare" in s:
            raise SystemExit(f"区間「{s['label']}」の neckLimitDeg と chestShare は asset の区間だけに書く")
        poses = s.get("handPose", "fist")
        if not all(x in ("fist", "source") for x in (poses.values() if isinstance(poses, dict) else [poses])) or ("handPose" in s and s["source"] != "asset"):
            raise SystemExit(f"区間「{s['label']}」の handPose は asset の区間に fist か source で書く。手ごとなら left と right")
        if "handFrame" in s and (s["source"] != "asset" or s["handFrame"] not in ("bone", "palm")):
            raise SystemExit(f"区間「{s['label']}」の handFrame は asset の区間に bone か palm で書く")
        if s["source"] == "asset" and "gripDiameterCm" in plan:
            s.setdefault("gripDiameterCm", plan["gripDiameterCm"])
        widths = s.get("gripDiameterCm", 3)
        if "gripDiameterCm" in s and (s["source"] != "asset" or not all(1 <= x <= 8 for x in (widths.values() if isinstance(widths, dict) else [widths]))):
            raise SystemExit(f"区間「{s['label']}」の gripDiameterCm は asset の区間に 1〜8 cm で書く")
        if "elbowPrior" in s and "grip" not in s:
            raise SystemExit(f"区間「{s['label']}」の elbowPrior は grip の区間だけに書く")
        if "grip" in s:
            s["elbowPrior"] = s.get("elbowPrior", plan.get("elbowPrior", False))
            if not isinstance(s["elbowPrior"], bool):
                raise SystemExit(f"区間「{s['label']}」の elbowPrior は true か false")
        if s["source"] == "text":
            s["prompt"] = s["prompt"] if isinstance(s.get("prompt"), list) else [s.get("prompt")]
            s["seconds"] = s["seconds"] if isinstance(s.get("seconds"), list) else [s.get("seconds")] * len(s["prompt"])
        s["bridgeOptions"] = {**DEFAULT_BRIDGE, **plan.get("bridge", {}), **s.get("bridge", {})}
        s["licenseRecord"] = license_of(s)
    return plan, segs


# ---------------------------------------------------------------- 素材を中間形式にする
def fake_text(seconds):
    sys.path.insert(0, str(HERE.parent))
    from motionbricks_gen import FPS, fake_motion
    names, parents, rest, local, _, contacts = fake_motion(SimpleNamespace(seconds=sum(seconds), speed=1.2))
    motion = retarget(names, parents, rest, local, FPS)
    return C.make(motion["rotations"], motion["hips"], contacts)


def make_text(segs, cache, fake):
    jobs = []
    for s in segs:
        s["cache"] = cache / f"text-{key_of(file_key(s.get('npz')), s['prompt'], s['seconds'], s.get('seed', 1), s.get('steps', 100), s.get('transition'), fake, None if fake else os.environ.get('CHARASTA_KIMODO_ENCODER', 'stream'))}.npz"
        if s["cache"].exists():
            continue
        if fake:
            C.save(s["cache"], fake_text(s["seconds"]))
        elif "npz" in s:
            jobs.append({"npz": s["npz"], "out": str(s["cache"])})
        else:
            jobs.append({"prompt": s["prompt"], "seconds": s["seconds"], "seed": s.get("seed", 1), "steps": s.get("steps", 100),
                         **({"transition": s["transition"]} if "transition" in s else {}), "out": str(s["cache"])})
    if jobs:
        f = cache / "kimodo-jobs.json"
        f.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf8")
        run([P.need(KIMODO_PYTHON, "Kimodo の python", "KIMODO_PYTHON"), HERE / "kimodo_gen.py", f], env={"TEXT_ENCODER_DEVICE": "cpu", "TEXT_ENCODER_MODE": "local",
                                                     "CHARASTA_KIMODO_EMBED_DIR": str(cache / "kimodo-embeddings")})


def make_motionbricks(segs, cache, fake):
    """MotionBricks の条件の区間を motionbricks_gen.py で作る（きゃらすたの motion-gen ジョブと同じ道具と引数）。
    移動（root）は compose の区間の root で扱うので、ここではいつも進む動きを作る。結果は cache に残し、同じ条件なら作り直さない。"""
    for s in segs:
        opts = {k: s[k] for k in MB_KEYS if k != "root"}
        base = cache / f"mb-{key_of(opts, bool(fake))}"
        vrma, info_f, contacts = base.with_suffix(".vrma"), base.with_suffix(".info.json"), base.with_suffix(".contacts.json")
        if not (vrma.exists() and info_f.exists() and contacts.exists()):
            args = [MB_GEN, "--out", vrma, "--info", info_f, "--contacts", contacts, "--kind", s["kind"], "--speed", s["speed"], "--direction", s["direction"],
                    "--turn", s["turn"], "--seconds", s["seconds"], "--action", s["action"], "--ending", s["ending"], "--root", "keep"]
            if fake:
                run([sys.executable, *args, "--fake"])
            else:
                mb = P.need(MOTIONBRICKS_DIR, "MotionBricks", "MOTIONBRICKS_DIR")
                run([UV, "run", "--project", mb, "--no-sync", "python", *args, "--motionbricks", mb], cwd=mb)
        info = json.loads(info_f.read_text(encoding="utf8"))
        s["path"], s["contactsPath"] = str(vrma), str(contacts)
        s["licenseRecord"] = motionbricks_license(info.get("sampleClips", []))
        s["motionbricksRecord"] = {"tool": "MotionBricks", "version": None if fake else mb_version(), "model": "試しの動き" if fake else MB_MODEL, "engine": info.get("engine"),
                                   "frames": info.get("frames"), "fps": info.get("fps"), "travelM": info.get("travelM"), "speedUsed": info.get("speedUsed"),
                                   "actionStartedSec": info.get("actionStartedSec"), "timings": info.get("timings"), "sampleClips": info.get("sampleClips", [])}


MB_MODEL = "MotionBricks-SOMA-RP-v1（mmm_v6_soma_fp32.onnx）"   # lib/motion-gen.mjs の MODEL と同じ


def mb_version():
    if not MOTIONBRICKS_DIR:
        return None
    try:
        return re.search(r"__version__\s*=\s*[\"']([^\"']+)", (Path(MOTIONBRICKS_DIR) / "motionbricks" / "_version.py").read_text(encoding="utf8")).group(1)
    except (OSError, AttributeError):
        return None


def asset_key(s):
    return key_of(file_key(s["path"]), file_key(s.get("rest") or find_rest(s["path"])), "fingers10", s.get("handPose"), s.get("gripDiameterCm"), *([s["handFrame"]] if s.get("handFrame", "bone") != "bone" else []))


def hold_side(s):
    """両手で持つときの持つ手。grip か武器の定義の hold。無ければ None。"""
    return s["weaponDef"]["hold"] if "weaponDef" in s else s.get("grip")


def make_assets(segs, cache):
    """FBX を中間形式にする。キャッシュは切り出しと速さと腕の IK の前の形なので、キーに trim、speed、model は要らない。"""
    jobs = []
    for s in segs:
        rest = s.get("rest") or find_rest(s["path"])
        key = asset_key(s)
        s["dump"], s["cache"] = cache / f"fbx-{key}.dump.npz", cache / f"fbx-{key}.npz"
        s["gapFile"] = cache / f"fbx-{key}-{hold_side(s)}.grip.npz" if hold_side(s) else None
        if not s["dump"].exists():
            jobs.append({"fbx": s["path"], "rest": rest, "out": str(s["dump"])})
    if jobs:
        f, r = cache / "fbx-jobs.json", cache / "fbx-result.json"
        f.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf8")
        run([P.need(BLENDER, "Blender", "VRMA_BLENDER"), "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", HERE / "fbx_dump.py", "--", f, r])
        bad = [x for x in json.loads(r.read_text(encoding="utf8")) if not x["ok"]]
        if bad:
            raise SystemExit("FBX を読めない: " + "; ".join(f"{Path(x['fbx']).name}: {x['error']}" for x in bad))
    for s in segs:
        if s["cache"].exists() and (s["gapFile"] is None or s["gapFile"].exists()):
            continue
        try:
            m, info = fbx_to_clip(s["dump"], hold_side(s), s.get("handPose"), s.get("gripDiameterCm", fingers.GRIP_DIAMETER_CM),
                                   **({"palm": True} if s.get("handFrame") == "palm" else {}))
        except ValueError as e:
            raise SystemExit(f"{Path(s['path']).name}: {e}") from e
        if s["gapFile"]:
            np.savez(s["gapFile"], local=m["gripLocal"], left=m["gripArms"]["left"], right=m["gripArms"]["right"])
        C.save(s["cache"], m)
        s["cache"].with_suffix(".json").write_text(json.dumps(info), encoding="utf8")


def make_video(segs, cache, model):
    for s in segs:
        if not model:
            raise SystemExit(f"動画の区間「{s['label']}」には計画の model（体を合わせる VRM）が要る")
        src = Path(s["path"])
        key = key_of(file_key(src), file_key(model))
        s["cache"] = cache / f"video-{key}.npz"
        if s["cache"].exists():
            continue
        work = cache / f"video-{key}"
        (work / "in").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, work / "in" / src.name)
        pipeline = Path(P.need(PIPELINE_DIR, "vrma-pipeline", "VRMA_PIPELINE_DIR"))
        run([P.venv_python(pipeline), "batch_convert.py", "--input", work / "in", "--output", work / "out", "--vrm", model], cwd=pipeline)
        C.save(s["cache"], read_vrma(work / "out" / src.stem / f"{src.stem}.vrma"))


def solve_grip(s, m, gap, arms, model, origin=None):
    """切り出しと速さのあとの区間の腕を解き、記録を s に残す。origin は胴を回す前の動きで、両手の位置はこれで決める。"""
    body = Grip.vrm_rest(model) if model else C.REST
    m, rec = Grip.apply(m, gap, s["grip"], body, arms if s.get("gripSolve", BOTH_ARMS) == BOTH_ARMS else None, origin, s.get("elbowPrior", False))
    rec["body"] = {"vrm": str(model), "sha256": hashlib.sha256(Path(model).read_bytes()).hexdigest()} if model else "rest"
    s["gripRecord"], s["gripGap"], s["gripRest"] = rec, gap, body
    return m


def solve_weapon(s, m, arms, model):
    """切り出したあとの区間を、武器を主に速さを変えて解き、記録を s に残す。"""
    body = Grip.vrm_rest(model)
    radii = WeaponCheck.body_radii(model, body)
    m, rec = Weapon.solve(m, s["weaponDef"], body, radii, arms, s.get("speed", 1), s.get("weaponMaxStepDeg", Weapon.MAX_STEP_DEG))
    s["weaponRecord"], s["weaponBody"] = rec, (body, radii)
    return m


def solve_neck(s, m, model, chest_share, keep_arms):
    """首と頭を体に合わせた上限へ収め、記録を s に残す。"""
    body = Grip.vrm_rest(model) if model else C.REST
    length = json.loads(Path(s["cache"]).with_suffix(".json").read_text(encoding="utf8"))["neckLengthM"]
    limit = Neck.body_limit(s["neckLimitDeg"], length, body, Grip.body_ratio(body), not model or "neck" in Grip.vrm_bones(model))
    m, s["neckRecord"] = Neck.solve(m, limit, chest_share, keep_arms)
    return m


def read_contacts(path, n):
    """contacts.json（docs/foot-ik.md）を n コマの 30 fps の接地にする。列は名前で CONTACT_ORDER へ並べ、fps が違えば線形に直す。"""
    rec = json.loads(Path(path).read_text(encoding="utf8"))
    order = rec.get("order") or C.CONTACT_ORDER
    if sorted(order) != sorted(C.CONTACT_ORDER):
        raise SystemExit(f"{path} の order が {C.CONTACT_ORDER} ではない: {order}")
    frames = np.asarray(rec["frames"], dtype=np.float64)[:, [order.index(k) for k in C.CONTACT_ORDER]]
    src = np.arange(len(frames)) / float(rec.get("fps", C.FPS))
    at = np.arange(n) / C.FPS
    return np.stack([np.interp(at, src, frames[:, k]) for k in range(4)], 1)


def load_segment(s, cache, model=None):
    """区間の中間形式を、切り出し・速さ・握り・足の高さ・接地・移動までそろえて返す。"""
    if s["source"] in ("vrma", "motionbricks"):
        s["cache"] = cache / f"vrma-{key_of(file_key(s['path']), file_key(s.get('contactsPath')))}.npz"
        if not s["cache"].exists():
            m = read_vrma(s["path"])
            if s.get("contactsPath"):   # 保管場所のモーションの横か、計画の contacts の接地を使う。推定しない
                m = C.make(m["rotations"], m["hips"], read_contacts(s["contactsPath"], C.frames(m)))
            C.save(s["cache"], m)
    m = C.load(s["cache"])
    gap, arms = None, None
    if s.get("gapFile"):
        with np.load(s["gapFile"]) as z:
            gap, arms = z["local"], {"left": z["left"], "right": z["right"]}
    trim = s.get("trim")
    if trim:
        a, b = C.trim_span(m, trim[0], trim[1])
        m = C.trim(m, trim[0], trim[1])
        gap = None if gap is None else gap[a:b]
    origin = None
    if "weaponDef" in s:
        m = solve_weapon(s, solve_neck(s, m, model, 0.0, False), arms, model)    # 武器の当たりは首のあとの頭で測る。胴は回さない
    else:
        if s["source"] != "motionbricks" and s.get("speed", 1) != 1:   # motionbricks の speed は動きの速さ（m/s）で、作るときに使った
            m = C.retime(m, s["speed"])
            gap = None if gap is None else C.stretch(gap, s["speed"])
        if "neckLimitDeg" in s:
            origin, m = m, solve_neck(s, m, model, s["chestShare"], gap is not None)   # 順番は胴、両手の位置、肘
        if gap is not None:
            m = solve_grip(s, m, gap, arms, model, origin)
    m = C.ground(m)
    if m["contacts"] is None:
        m = C.make(m["rotations"], m["hips"], C.estimate_contacts(m))
    if s.get("root", "keep") == "inplace":
        m = C.inplace(m)
    return m


# ---------------------------------------------------------------- つなぐ
def choose_method(opt, a, b, fake):
    """つなぎの作り方を決める。返すのは (motionbricks か interpolate か none, 理由)。"""
    if opt["seconds"] <= 0:
        return "none", "計画でつなぎなしを選んだ"
    if opt["method"] == "interpolate":
        return "interpolate", "計画で補間を選んだ"
    if fake:
        return "interpolate", "--fake"
    if C.frames(a) < 4 or C.frames(b) < 4:
        return "interpolate", "区間が 4 コマより短い"
    if not MIN_BRIDGE_SEC <= opt["seconds"] <= MAX_BRIDGE_SEC:
        return "interpolate", f"つなぎの長さが MotionBricks の範囲（{MIN_BRIDGE_SEC:.2f}〜{MAX_BRIDGE_SEC:.2f} 秒）の外"
    return "motionbricks", ""


def join(segs, clips, work, fake):
    """clips を順に前の区間の終わりへ置き、間のつなぎを作る。返すのは (並べた部分 [{clip, label, bridge}], つなぎの記録)。"""
    parts, bridges, jobs = [{"clip": clips[0], "label": segs[0]["label"], "bridge": False}], [], []
    prev = clips[0]
    for i in range(1, len(clips)):
        s = segs[i]
        opt = s["bridgeOptions"]
        placed = C.place_after(prev, clips[i], opt["gap"], opt["seconds"])
        method, why = choose_method(opt, prev, placed, fake)
        rec = {"after": segs[i - 1]["label"], "before": s["label"], "method": method, "seconds": opt["seconds"], **({"reason": why} if why else {})}
        name = f"つなぎ {segs[i - 1]['label']} - {s['label']}"
        if method == "motionbricks":
            pa, pb, out = work / f"bridge-{i}-a.npz", work / f"bridge-{i}-b.npz", work / f"bridge-{i}.npz"
            C.save(pa, prev)
            C.save(pb, placed)
            jobs.append({"a": str(pa), "b": str(pb), "seconds": opt["seconds"], "out": str(out)})
            parts.append({"clip": out, "label": name, "bridge": True})
        elif method == "interpolate":
            parts.append({"clip": C.interpolate(prev, placed, max(1, int(round(opt["seconds"] * C.FPS)))), "label": name, "bridge": True})
        parts.append({"clip": placed, "label": s["label"], "bridge": False})
        bridges.append(rec)
        prev = placed
    if jobs:
        f, r = work / "bridge-jobs.json", work / "bridge-report.json"
        f.write_text(json.dumps(jobs), encoding="utf8")
        mb = P.need(MOTIONBRICKS_DIR, "MotionBricks", "MOTIONBRICKS_DIR")
        run([UV, "run", "--project", mb, "--no-sync", "python", HERE / "mb_bridge.py", f, r], cwd=mb)
        reports = iter(json.loads(r.read_text(encoding="utf8"))["bridges"])
        for b in bridges:
            if b["method"] == "motionbricks":
                rep = next(reports)
                b.update(tokens=rep["tokens"], frames=rep["frames"], generateSec=rep["generateSec"], endGapCm=rep["endGapCm"])
        for p in parts:
            if isinstance(p["clip"], Path):
                p["clip"] = C.load(p["clip"])
    return parts, bridges


def assemble(parts):
    """全体を 1 本にして、部分ごとのコマの範囲を記録する。"""
    motion, seams = C.concat([p["clip"] for p in parts])
    spans, at = [], 0
    for p in parts:
        spans.append({"label": p["label"], "bridge": p["bridge"], "start": at, "end": at + C.frames(p["clip"])})
        at += C.frames(p["clip"])
    return C.face_forward(motion), seams, spans


def seg_record(s):
    keep = {k: s[k] for k in ("source", "label", "prompt", "seconds", "seed", "path", "trim", "speed", "root", "npz", "grip", "gripSolve", "gripBody", "weapon", "weaponMaxStepDeg", "neckLimitDeg", "chestShare", "elbowPrior", "handPose", "gripDiameterCm", "handFrame", "motionRecord",
                                  *(("kind", "direction", "turn", "action", "ending") if s["source"] == "motionbricks" else ())) if k in s}
    if "motionbricksRecord" in s:
        keep["motionbricks"] = s["motionbricksRecord"]
        keep["license"] = s["licenseRecord"]   # 見本の動きの利用条件（評価用のみ）を区間の記録にも残す
    if s.get("cache") and Path(s["cache"]).with_suffix(".json").exists():
        keep["retarget"] = json.loads(Path(s["cache"]).with_suffix(".json").read_text(encoding="utf8"))
    if "gripRecord" in s:
        keep.setdefault("retarget", {})["grip"] = s["gripRecord"]
    if "weaponRecord" in s:
        keep.setdefault("retarget", {})["weapon"] = s["weaponRecord"]
    if "neckRecord" in s:
        keep.setdefault("retarget", {})["neck"] = s["neckRecord"]
    return keep


def grip_report(segs, motion, spans):
    """最後の 1 本の全コマで、両手首の差の誤差を測る。つなぎのあとの位置と向きで測るので、途中の処理の崩れも入る。"""
    rows = []
    for k, s in enumerate(segs):
        if "gripGap" not in s:
            continue
        span = [x for x in spans if not x["bridge"]][k]
        part = C.make({b: q[span["start"]:span["end"]] for b, q in motion["rotations"].items()}, motion["hips"][span["start"]:span["end"]])
        gap = Grip.gap_for(part, s["gripGap"], s["grip"], s["gripRest"])
        err = Grip.gap_error(part, gap, s["grip"], s["gripRest"])
        rec = s["gripRecord"]
        rows.append({"label": s["label"], "frames": len(err), "gapErrorMaxCm": round(float(err.max() * 100), 3), "solve": rec["solve"], "arms": Grip.arm_report(part, s["gripRest"]), "anatomy": anatomy.summary(part, s["gripRest"]),
                     "weaponMoveCm": rec["weaponMoveCm"], "reachShift": rec["reachShift"], "unreachedFrames": rec["unreachedFrames"]})
    return rows


def weapon_report(segs, motion, spans):
    """最後の 1 本の区間のコマで武器を測る。"""
    rows = []
    for k, s in enumerate(segs):
        if "weaponRecord" not in s:
            continue
        span = [x for x in spans if not x["bridge"]][k]
        part = C.make({b: q[span["start"]:span["end"]] for b, q in motion["rotations"].items()}, motion["hips"][span["start"]:span["end"]])
        rows.append({"label": s["label"], **WeaponCheck.report(part, s["weaponDef"], *s["weaponBody"]), "pushCm": s["weaponRecord"]["pushCm"], "reachShift": s["weaponRecord"]["reachShift"]})
    return rows


def finger_report(segs):
    """FBX の区間の指で、範囲へ収めた関節のコマの数と、移さなかった手。"""
    rows = []
    for s in segs:
        if s["source"] == "asset":
            rows.append({"label": s["label"], **json.loads(Path(s["cache"]).with_suffix(".json").read_text(encoding="utf8"))["fingers"]})
    return rows


def neck_report(segs, motion, spans):
    """最後の 1 本の全コマで、胸から見た頭の回転を測る。"""
    rows = []
    for k, s in enumerate(segs):
        if "neckRecord" not in s:
            continue
        span = [x for x in spans if not x["bridge"]][k]
        part = C.make({b: q[span["start"]:span["end"]] for b, q in motion["rotations"].items()}, motion["hips"][span["start"]:span["end"]])
        rows.append({"label": s["label"], **s["neckRecord"], **Neck.report(part)})
    return rows


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("plan")
    p.add_argument("--out", required=True)
    p.add_argument("--work")
    p.add_argument("--fake", action="store_true", help="Kimodo と MotionBricks を呼ばない（テスト用）")
    a = p.parse_args(argv)
    plan, segs = read_plan(a.plan)
    out = Path(a.out).resolve()
    work = Path(a.work).resolve() if a.work else out / "work"
    cache = work / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)

    of = lambda kind: [s for s in segs if s["source"] == kind]   # noqa: E731
    make_text(of("text"), cache, a.fake)
    make_motionbricks(of("motionbricks"), cache, a.fake)
    make_assets(of("asset"), cache)
    make_video(of("video"), cache, plan.get("model"))
    clips = [load_segment(s, cache, plan.get("model") if s.get("gripBody") != "rest" else None) for s in segs]
    parts, bridges = join(segs, clips, work, a.fake)
    motion, seams, spans = assemble(parts)

    meta = write_vrma(out / "motion.vrma", motion, generator="charasta tools/compose")
    (out / "contacts.json").write_text(json.dumps({"fps": C.FPS, "order": C.CONTACT_ORDER, "frames": np.round(motion["contacts"], 3).tolist()}), encoding="utf8")
    used_bridge = any(b["method"] == "motionbricks" for b in bridges)
    license_ = merge_licenses([{"part": f"区間: {s['label']}", "license": s["licenseRecord"]} for s in segs] + ([{"part": "つなぎ", "license": BRIDGE_LICENSE}] if used_bridge else []))
    (out / "license.json").write_text(json.dumps(license_, ensure_ascii=False, indent=2), encoding="utf8")
    generated = {"tool": "motion-compose", "frames": meta["frames"], "fps": C.FPS, "durationSec": round(meta["durationSec"], 3),
                 "options": {"root": "inplace" if all(s.get("root") == "inplace" for s in segs) else "keep"},
                 "segments": [seg_record(s) for s in segs], "bridges": bridges,
                 "spans": spans, "retarget": "T ポーズからのワールドの回転の差を VRM の正規化した骨へ（docs/adr/0003-motionbricks-retarget.md、docs/motion-compose.md）"}
    (out / "generated.json").write_text(json.dumps(generated, ensure_ascii=False, indent=2), encoding="utf8")
    rep = check.report(motion, seams, spans)
    grips = grip_report(segs, motion, spans)
    if grips:
        rep["grip"] = grips
    weapons = weapon_report(segs, motion, spans)
    if weapons:
        rep["weapon"] = weapons
    necks = neck_report(segs, motion, spans)
    if necks:
        rep["neck"] = necks
    fingers_ = finger_report(segs)
    if fingers_:
        rep["fingers"] = fingers_
    (out / "report.json").write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps({"frames": meta["frames"], "seconds": rep["seconds"], "seams": rep["seams"], "elsewhereP99": rep["elsewhereP99"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
