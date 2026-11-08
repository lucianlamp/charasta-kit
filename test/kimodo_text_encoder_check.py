"""tools/kimodo_text_encoder.py のキャッシュと、Kimodo に渡す代わりのエンコーダを確かめる（numpy だけ。torch とモデルは使わない）。

符号化の別プロセス（subprocess.run）は差し替え、決まった値を書くだけにする。成功すれば「ok」を出す。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

tmp = Path(tempfile.mkdtemp(prefix="kte-check-"))
hub = tmp / "hub"
for repo, commit in [("McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp", "aaa"), ("McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised", "bbb"),
                     ("meta-llama/Meta-Llama-3-8B-Instruct", "ccc")]:
    d = hub / ("models--" + repo.replace("/", "--")) / "refs"
    d.mkdir(parents=True)
    (d / "main").write_text(commit + "\n", encoding="utf-8")
os.environ["HF_HUB_CACHE"] = str(hub)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import kimodo_text_encoder as kte  # noqa: E402

# キー: 同じ文章と設定なら同じ。文章、device、スナップショットが違えば違う
conf = kte.settings("cuda")
assert conf["repos"]["meta-llama/Meta-Llama-3-8B-Instruct"] == "ccc", conf
assert kte.cache_key("A person walks.", conf) == kte.cache_key("A person walks.", kte.settings("cuda"))
assert kte.cache_key("A person walks.", conf) != kte.cache_key("A person walks", conf)
assert kte.cache_key("A person walks.", conf) != kte.cache_key("A person walks.", kte.settings("cpu"))
assert kte.cache_key("A person walks.", conf) != kte.cache_key("A person walks.", {**conf, "repos": {**conf["repos"], "meta-llama/Meta-Llama-3-8B-Instruct": "ddd"}})
for k in ("dtype", "pooling", "instruction", "device"):
    assert k in conf, k

calls = []


def vec(text):
    return (np.arange(kte.DIM, dtype=np.float32) + len(text)) / 1000


def fake_run(cmd, input, env, **kw):
    """符号化の子プロセスの代わり。渡された文章の埋め込みを書き、報告の JSON を返す"""
    calls.append({"cmd": cmd, "texts": json.loads(input), "env": env})
    if "fail" in json.loads(input)[0]:
        return subprocess.CompletedProcess(cmd, 3, "", "Traceback ...\nRuntimeError: CUDA out of memory\n")
    cache = kte.EmbeddingCache(cmd[cmd.index("--cache-dir") + 1], cmd[cmd.index("--device") + 1])
    for t in json.loads(input):
        cache.put(t, vec(t))
    return subprocess.CompletedProcess(cmd, 0, "ログではない行\n" + json.dumps({"encoded": len(json.loads(input)), "sec": 1.0}) + "\n", "層 1/32\n")


kte.subprocess.run = fake_run
cache = kte.EmbeddingCache(tmp / "emb", "cuda")
enc = kte.CachedTextEncoder(cache)

# 1 回目: 覚えていない 2 文だけを 1 回の子プロセスで符号化する。同じ文章が 2 回あっても 1 回
rows = enc.rows(["A person walks.", "A person waves.", "A person walks."])
assert rows.shape == (3, 1, kte.DIM) and rows.dtype == np.float32, rows.shape
assert np.array_equal(rows[0, 0], vec("A person walks.")) and np.array_equal(rows[2, 0], rows[0, 0])
assert len(calls) == 1 and calls[0]["texts"] == ["A person walks.", "A person waves."], calls
c = calls[0]["cmd"]
assert c[0] == sys.executable and c[2].endswith("kimodo_text_encoder.py") and c[c.index("--device") + 1] == "cuda", c
assert calls[0]["env"]["HF_HUB_OFFLINE"] == "1"   # モデルを取りに行かない
assert (enc.misses, enc.hits) == (2, 1), (enc.misses, enc.hits)
assert enc.reports == [{"encoded": 2, "sec": 1.0}]

# 2 回目: 全部覚えているので子プロセスを起こさない
enc.rows(["A person waves."])
assert len(calls) == 1 and (enc.misses, enc.hits) == (2, 2)

# ディスクの中身: 文章ごとに 1 ファイル。別のエンコーダ(device が違う)は同じ文章でも別のファイルになる
files = sorted((tmp / "emb").glob("*.npz"))
assert len(files) == 2 and not list((tmp / "emb").glob("*.tmp.npz")), files
with np.load(files[0]) as z:
    assert str(z["text"]) in ("A person walks.", "A person waves.")
assert kte.EmbeddingCache(tmp / "emb", "cpu").missing(["A person walks."]) == ["A person walks."]

# 作業プロセスを作り直しても(新しい CachedTextEncoder)、ディスクから読む
again = kte.CachedTextEncoder(kte.EmbeddingCache(tmp / "emb", "cuda"))
assert np.array_equal(again.rows(["A person walks."])[0, 0], vec("A person walks.")) and len(calls) == 1

# 子プロセスが失敗したら、標準エラーの最後の行を理由に入れて失敗する
try:
    enc.rows(["fail here"])
    raise AssertionError("失敗しなかった")
except RuntimeError as e:
    assert "終了コード 3" in str(e) and "CUDA out of memory" in str(e), e


# 壊れたキャッシュ(BadZipFile)は消して、無いものとして符号化し直す
bad = cache.path("A person nods.")
bad.parent.mkdir(parents=True, exist_ok=True)
bad.write_bytes(b"not a zip")
n0 = len(calls)
assert cache.missing(["A person nods."]) == ["A person nods."] and not bad.exists()
assert np.array_equal(enc.rows(["A person nods."])[0, 0], vec("A person nods.")) and len(calls) == n0 + 1
trunc = cache.path("A person sits.")
np.savez(trunc, embedding=np.zeros(3, dtype=np.float32), text=np.array("x"))   # 形が違う
assert cache.missing(["A person sits."]) == ["A person sits."] and not trunc.exists()

# Kimodo が引く鍵(__call__ は torch が要るので、同じ中身の rows で確かめる)(sanitize_texts の後の文章)と同じ鍵で先に符号化すれば、__call__ で子プロセスは増えない
san_path = Path(os.environ["KIMODO_DIR"]) / "kimodo" / "sanitize.py" if os.environ.get("KIMODO_DIR") else None   # 本物の Kimodo があるときだけ
if san_path and san_path.exists():
    import importlib.util
    spec = importlib.util.spec_from_file_location("kimodo_sanitize", san_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    raw = ["a person  walks forward", "a person waves"]
    clean = mod.sanitize_texts(raw)
    assert clean == ["A person walks forward.", "A person waves."], clean
    enc2 = kte.CachedTextEncoder(kte.EmbeddingCache(tmp / "emb2", "cuda"))
    n1 = len(calls)
    enc2.prepare(mod.sanitize_texts(raw))   # 作業プロセスと kimodo_gen.py の事前の符号化
    enc2.rows(mod.sanitize_texts(raw))         # Kimodo が text_encoder に渡す文章
    assert len(calls) == n1 + 1, len(calls) - n1
    enc2.rows(clean)
    assert len(calls) == n1 + 1
    # 生の文章で準備すると鍵が合わず、2 回目の子プロセスが起きる(直す前の不具合)
    enc3 = kte.CachedTextEncoder(kte.EmbeddingCache(tmp / "emb3", "cuda"))
    n2 = len(calls)
    enc3.prepare(raw)
    enc3.rows(clean)
    assert len(calls) == n2 + 2
else:
    print("kimodo/sanitize.py が無いので鍵の確かめを飛ばした")

import shutil  # noqa: E402
shutil.rmtree(tmp, ignore_errors=True)
print("ok")
