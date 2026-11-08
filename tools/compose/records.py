"""区間ごとの許諾を 1 本の motion.json の license にまとめる。商用可否は判断せず、条件の事実を書く。

一番厳しい条件を全体の条件にする: redistribution はどれか 1 つでも false なら false、evaluationOnly はどれか 1 つでも true なら true。
summary は厳しい順の先頭の区間の文を先に置く（lib/terms.mjs が summary の文言を読む）。terms に全区間の条件を残す。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# モデルの利用条件の記録は lib/model-licenses.json にまとめてある（lib/motion-text.mjs も同じファイルを読む）。
# KIMODO_LICENSE は計画の text の区間（compose.py が Kimodo を読み込む経路）、BRIDGE_LICENSE は MotionBricks のつなぎ、
# motionbricks_license は計画の motionbricks の区間（きゃらすたの motion-gen ジョブの取り込みと同じ記録）
_LICENSES = json.loads((Path(__file__).resolve().parents[2] / "lib" / "model-licenses.json").read_text(encoding="utf8"))
KIMODO_LICENSE = _LICENSES["kimodoCompose"]
BRIDGE_LICENSE = _LICENSES["motionbricksBridge"]


def motionbricks_license(sample_clips):
    """MotionBricks の条件で作った区間の許諾（評価用のみ）。lib/motion-gen.mjs の motionGenLicense と同じ値で、見本の動きの許諾の clips に使った BVH を入れる。"""
    lic = json.loads(json.dumps(_LICENSES["motionbricksGen"]))
    next(t for t in lic["terms"] if isinstance(t.get("clips"), list))["clips"] = list(sample_clips)
    return lic


def severity(lic):
    """大きいほど厳しい。lib/terms.mjs の判定の順に合わせる。"""
    s = lic.get("summary", "")
    if lic.get("evaluationOnly"):
        return 4
    if re.search("個人利用|私的利用", s):
        return 3
    if re.search("公開(不可|禁止|できない)|非公開", s):
        return 2
    if re.search("二次利用禁止|商用利用不可", s) or not lic.get("redistribution"):
        return 1
    return 0


def merge_licenses(parts):
    """parts: [{"part": 区間の説明, "license": {holder, summary, redistribution, ...}}]。"""
    worst = max(parts, key=lambda p: severity(p["license"]))["license"]
    others = list(dict.fromkeys(p["license"]["summary"] for p in parts if p["license"]["summary"] != worst["summary"]))
    merged = {
        "holder": "、".join(dict.fromkeys(p["license"].get("holder", "") for p in parts if p["license"].get("holder"))),
        "summary": worst["summary"] + "".join(f" / {s}" for s in others),
        "redistribution": all(p["license"].get("redistribution", False) for p in parts),
        "terms": [{"part": p["part"], **{k: v for k, v in p["license"].items() if k != "terms"}, **({"terms": p["license"]["terms"]} if "terms" in p["license"] else {})} for p in parts],
    }
    if any(p["license"].get("evaluationOnly") for p in parts):
        merged["evaluationOnly"] = True
    return merged
