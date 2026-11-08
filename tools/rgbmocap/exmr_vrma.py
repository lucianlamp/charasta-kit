"""動画 1 本を RGB MoCap（toyxyz_RGBMocap）の ExMR で動きにし、対象の VRM の体に合わせた VRMA にする（docs/video-to-vrma.md）。

  python tools/rgbmocap/exmr_vrma.py --video clip.mp4 --model model.vrm --out-dir OUT --work WORK [--rgbmocap RGBMOCAP_DIR] [--blender BLENDER]
         [--no-correct] [--no-cut-fix] [--no-plant-feet] [--no-hand-fix] [--hand-body-fix]

流れ:
  1. RGB MoCap の worker を、アプリが内部で呼ぶのと同じ順に動かす（prepare → track → exmr_preprocess → exmr_features → exmr）。
     画面（GUI）は使わない。プロジェクトは WORK/rgbmocap に作り、RGB MoCap の projects/ には書かない。
  2. correct（接地補正。preset normal、足のロックあり）を動かし、補正した結果を export して motion.bvh（Mixamo の骨の名前、30 fps）にする。
     失敗したら補正なしの export に戻す。--no-correct で補正をしない。
  3. 先頭が別のカットなら、次の落ち着いた姿勢で置き換える（bvh_cut.py）。--no-cut-fix で止める。
  4. BVH を Blender で FBX にし（bvh_to_fbx.py）、tools/compose の asset の区間として VRM の骨へ移す。handFrame は palm
     （手のひらの向きまで合わせる。BVH の基準の姿勢は手のひらの向きが VRM の T ポーズと違い、骨の向きだけで合わせると左 160 度、右 91 度ずれていた）。
  5. 補正の接地の区間を使い、対象の体の上で足を床に付ける（plant_feet.py）。--no-plant-feet で止める。
  6. vrma-pipeline の Stage A（MediaPipe の Pose と Hand Landmarker、CPU）で動画の手を検出し、指の形を MediaPipe に寄せる（hand_shape_fix.py、手の補正 v3）。
     開き、指の付け根の曲げ、親指を、閉じる方向と指全体の曲がりを越えない範囲で動かす。PIP と DIP は直さない。--no-hand-fix で止める。
  7. --hand-body-fix のときだけ、手と前腕が対象の体にめり込むコマで手首を体の外へ出し、腕を IK で解き直す（hand_body_fix.py）。
     658 コマで約 22 分かかるので既定では動かさない。結果は対象の体に合わせた焼き込みになる。
  2、3、5、6、7 は失敗してもジョブを落とさず、前の結果のまま exmr.json の polish に理由を残す。ExMR の本体の段階（prepare から exmr、export）が失敗したときは止める。
出力（OUT）: clip.vrma、contacts.json、quality_report.json（ExMR には判定が無いので overall は null）、exmr.json（時間、経路、補正の記録と前後の足の指標）。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import charasta_paths as P  # noqa: E402
import bvh_cut
import foot_metrics
import hand_body_fix
import hand_metrics
import hand_shape_fix
import plant_feet
import vrma_env

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
STAGES = ("track", "exmr_preprocess", "exmr_features", "exmr")
CORRECTED = "corrected_initial"


def log(msg):
    print(msg, flush=True)


def worker_env(rgbm):
    """RGB MoCap の launch_source.py が worker に渡すのと同じ環境。"""
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONHOME", "PYTHONPATH")}
    r = str(rgbm).replace("\\", "/")
    env.update(RGB_MOCAP_MANAGED="1", RGB_MOCAP_DATA=r, PYTHONDONTWRITEBYTECODE="1",
               HF_HOME=r + "/cache/huggingface", TORCH_HOME=r + "/cache/torch", XDG_CACHE_HOME=r + "/cache")
    return env


def run_quiet(cmd, what, **kw):
    """出力を拾って動かし、失敗したら終わりの 20 行を理由として出して止める（ジョブのログに残る）。"""
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    if r.returncode:
        tail = "\n".join((r.stdout + r.stderr).strip().splitlines()[-20:])
        raise SystemExit(f"{what} が失敗した（{r.returncode}）:\n{tail}")
    return r


def worker_command(rgbm, stage, args):
    """mocap.paths.worker_command を RGB MoCap の runtime で呼んで、その段階の実行のコマンドを得る（ランタイムの選び方を写さない）。"""
    code = ("import json,sys;sys.path.insert(0,sys.argv[1]);from mocap.paths import worker_command as w;"
            "print(json.dumps(w(sys.argv[2],*sys.argv[3:])))")
    out = run_quiet([str(Path(rgbm) / "runtime" / "python.exe"), "-I", "-X", "utf8", "-c", code, str(rgbm), stage, *map(str, args)],
                    f"RGB MoCap の {stage} の起動の準備", env=worker_env(rgbm))
    return json.loads(out.stdout.strip().splitlines()[-1])


def run_stage(rgbm, stage, args, logf):
    cmd = worker_command(rgbm, stage, args)
    t = time.monotonic()
    events, tail = [], []
    with subprocess.Popen(cmd, cwd=rgbm, env=worker_env(rgbm), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding="utf-8", errors="replace") as p:
        for line in p.stdout:
            logf.write(line)
            tail = (tail + [line.rstrip()])[-20:]
            if "@@MOCAP@@" in line:
                try:
                    events.append(json.loads(line.split("@@MOCAP@@", 1)[1]))
                except ValueError:
                    pass
        p.wait()
    sec = round(time.monotonic() - t, 1)
    if p.returncode:
        err = next((e.get("message") or e.get("error") for e in reversed(events) if e.get("type") in ("error", "failed")), None)
        raise SystemExit(f"RGB MoCap の {stage} が失敗した（{p.returncode}）: {err or ''}\n全部のログ: {logf.name}\n" + "\n".join(tail))
    log(f"{stage}: {sec} 秒")
    return events, sec


def fix_hand_shape(vrma, model, video, work):
    """Stage A で手を検出し、VRMA の指の形を寄せて work/handfix.vrma に書く。手の指標の前後と補正の記録を返す。"""
    pdir = vrma_env.pipeline_dir()
    py = P.venv_python(pdir)
    if not py.is_file():
        raise RuntimeError(f"vrma-pipeline の python が無い: {py}")
    mp = work / "mediapipe"
    mp.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PYTHONPATH": str(pdir / "src"), "PYTHONUTF8": "1"}
    timing = {}
    for name, args in (("pose", ["vrma_pipeline.stage_a.video_to_pose", str(video), str(mp)]),
                       ("hands", ["vrma_pipeline.stage_a.video_to_hands", str(video), str(mp / "pose3d.npz"), str(mp)])):
        t = time.monotonic()
        run_quiet([str(py), "-X", "utf8", "-m", *args], f"MediaPipe の {name}", cwd=str(pdir), env=env)
        timing[name] = round(time.monotonic() - t, 1)
    hands = mp / "hands.npz"
    out = work / "handfix.vrma"
    before = hand_metrics.hand_metrics(str(vrma), model, str(hands))
    rep = hand_shape_fix.fix_hands(str(vrma), model, str(hands), str(out))
    after = hand_metrics.hand_metrics(str(out), model, str(hands))
    return {"ran": True, "recipe": "v3", "mediapipeSec": timing, "before": before, "after": after, "fix": rep}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--rgbmocap", default=os.environ.get("RGBMOCAP_DIR"), help="RGB MoCap の場所(省くと環境変数 RGBMOCAP_DIR)")
    ap.add_argument("--no-correct", action="store_true", help="RGB MoCap の接地補正をしない")
    ap.add_argument("--no-cut-fix", action="store_true", help="先頭の別カットを置き換えない")
    ap.add_argument("--no-plant-feet", action="store_true", help="対象の体で足を床に付ける焼き込みをしない")
    ap.add_argument("--no-hand-fix", action="store_true", help="MediaPipe の手で指の形を直さない")
    ap.add_argument("--hand-body-fix", action="store_true", help="手と前腕が体にめり込むコマを直す（658 コマで約 22 分）")
    ap.add_argument("--blender", default=P.find_blender())
    a = ap.parse_args()
    rgbm, out, work = Path(P.need(a.rgbmocap, "RGB MoCap", "RGBMOCAP_DIR")), Path(a.out_dir), Path(a.work)
    P.need(a.blender, "Blender", "CHARASTA_BLENDER")
    if not (rgbm / "runtime" / "python.exe").is_file():
        raise SystemExit(f"RGB MoCap が無い（install.cmd を済ませる）: {rgbm}")
    out.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    timings = {}
    with open(work / "rgbmocap.log", "a", encoding="utf-8") as logf:
        events, timings["prepare"] = run_stage(rgbm, "prepare", ["--video", Path(a.video).resolve(), "--motion-tool", "exmr", "--project", work / "rgbmocap"], logf)
        project = next((e["project"] for e in events if e.get("type") == "prepared"), None)
        if not project:
            raise SystemExit("RGB MoCap の prepare がプロジェクトを返さなかった")
        for st in STAGES:
            _, timings[st] = run_stage(rgbm, st, ["--project", project], logf)
        polish = {}
        contacts_npz = None
        if not a.no_correct:
            try:
                _, timings["correct"] = run_stage(rgbm, "correct", ["--project", project, "--result", CORRECTED, "--correction-preset", "normal", "--foot-lock", "1"], logf)
                _, timings["export"] = run_stage(rgbm, "export", ["--project", project, "--result", CORRECTED], logf)
                contacts_npz = Path(project) / f"{CORRECTED}_contacts.npz"
                polish["correct"] = {"ran": True, "preset": "normal", "footLock": True}
            except BaseException as e:   # SystemExit も含む。補正なしの export に戻す
                polish["correct"] = {"ran": False, "error": str(e)[:400]}
                log(f"correct を諦める: {polish['correct']['error']}")
        else:
            polish["correct"] = {"ran": False, "reason": "switch off"}
        if not polish["correct"]["ran"]:
            _, timings["export"] = run_stage(rgbm, "export", ["--project", project], logf)
    bvh = Path(project) / "motion.bvh"
    if not a.no_cut_fix:
        try:
            text, cut = bvh_cut.fix_text(bvh.read_text(encoding="utf-8"))
            if cut["cut_frame"]:
                bvh = work / "motion_cutfix.bvh"
                bvh.write_text(text, encoding="utf-8")
            polish["cutFix"] = {"ran": True, **cut}
        except Exception as e:
            polish["cutFix"] = {"ran": False, "error": str(e)[:400]}
    else:
        polish["cutFix"] = {"ran": False, "reason": "switch off"}
    fbx = work / "exmr.fbx"
    t = time.monotonic()
    run_quiet([a.blender, "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1",
               "--python", str(HERE / "bvh_to_fbx.py"), "--", str(bvh), str(fbx)], "Blender の BVH から FBX への変換")
    timings["bvh_to_fbx"] = round(time.monotonic() - t, 1)
    plan = {"model": str(Path(a.model).resolve()).replace("\\", "/"),
            "segments": [{"source": "asset", "label": "ExMR", "path": str(fbx).replace("\\", "/"), "rest": str(fbx).replace("\\", "/"), "handFrame": "palm",
                          "license": {"holder": "RGB MoCap（ExMR）で動画から作った動き", "summary": "記録はジョブの利用条件に従う", "redistribution": False}}]}
    (work / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")
    t = time.monotonic()
    env = {**os.environ, "PYTHONUTF8": "1", "VRMA_BLENDER": a.blender}
    subprocess.run([sys.executable, str(ROOT / "tools" / "compose" / "compose.py"), str(work / "plan.json"), "--out", str(work / "compose"), "--work", str(work / "compose-work")],
                   check=True, env=env)
    timings["retarget"] = round(time.monotonic() - t, 1)
    final, final_contacts = work / "compose" / "motion.vrma", work / "compose" / "contacts.json"
    if not a.no_plant_feet:
        t = time.monotonic()
        try:
            cn = str(contacts_npz) if contacts_npz else None
            planted, planted_contacts = work / "planted.vrma", work / "planted_contacts.json"
            pf = plant_feet.plant_feet(str(final), a.model, str(planted), str(contacts_npz) if contacts_npz else None, str(planted_contacts))
            pf["before"] = foot_metrics.foot_metrics(str(final), a.model, contacts=cn)
            pf["after"] = foot_metrics.foot_metrics(str(planted), a.model, contacts=cn)
            final, final_contacts = planted, planted_contacts
            polish["plantFeet"] = {"ran": True, **pf}
        except Exception as e:
            polish["plantFeet"] = {"ran": False, "error": str(e)[:400]}
        timings["plant_feet"] = round(time.monotonic() - t, 1)
    else:
        polish["plantFeet"] = {"ran": False, "reason": "switch off"}
    if not a.no_hand_fix:
        t = time.monotonic()
        try:
            polish["handFix"] = fix_hand_shape(final, a.model, Path(project) / "input.mp4", work)
            final = work / "handfix.vrma"
        except BaseException as e:   # Stage A の失敗(SystemExit)も含む。直す前の VRMA のまま
            polish["handFix"] = {"ran": False, "error": str(e)[:400]}
        timings["hand_fix"] = round(time.monotonic() - t, 1)
    else:
        polish["handFix"] = {"ran": False, "reason": "switch off"}
    if a.hand_body_fix:
        t = time.monotonic()
        try:
            fixed = work / "handbody.vrma"
            polish["handBodyFix"] = hand_body_fix.fix(str(final), a.model, str(fixed), work / "handbody", a.blender)
            final = fixed
        except Exception as e:   # 直す前の VRMA のまま
            polish["handBodyFix"] = {"ran": False, "error": str(e)[:400]}
        timings["hand_body_fix"] = round(time.monotonic() - t, 1)
    else:
        polish["handBodyFix"] = {"ran": False, "reason": "switch off"}
    (out / "clip.vrma").write_bytes(final.read_bytes())
    (out / "contacts.json").write_bytes(final_contacts.read_bytes())
    (out / "quality_report.json").write_text(json.dumps({"overall": None, "engine": "exmr"}), encoding="utf-8")
    manifest = json.loads((Path(project) / "project.json").read_text(encoding="utf-8"))
    (out / "exmr.json").write_text(json.dumps({"engine": "RGB MoCap ExMR", "rgbmocap": str(rgbm), "project": project, "timingsSec": timings,
                                               "source": manifest.get("source"), "handFrame": "palm", "polish": polish}, ensure_ascii=False, indent=1), encoding="utf-8")
    log(json.dumps({"vrma": str(out / "clip.vrma"), "timingsSec": timings}, ensure_ascii=False))


if __name__ == "__main__":
    main()
