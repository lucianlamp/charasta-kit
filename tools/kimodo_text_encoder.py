"""Kimodo の文章の埋め込み（LLM2Vec、Llama 3 8B Instruct）を、デコーダの層を 1 つずつ読みながら計算する。

8B のエンコーダを丸ごと RAM に載せない（今までの CPU のエンコーダは読み込みに RAM を 14〜15.5 GB 使った）。
埋め込みは文章ごとにディスクへ覚え、作業プロセスは覚えた埋め込みだけを Kimodo に渡す（docs/motion-text.md）。

別プロセスで動かす（Kimodo の .venv の Python。Kimodo のリポジトリは変えない）:

    python -u tools/kimodo_text_encoder.py --cache-dir DIR [--device cuda|cpu]  < 文章の JSON の配列

符号化した埋め込みを DIR/<キー>.npz に書き、標準出力に 1 行の JSON（件数、秒、RAM と VRAM の最大）を返す。ログは標準エラー。

計算は kimodo の LLM2VecEncoder（llm2vec_wrapper.py）と同じ:
- 文章は 1 文ずつ（batch_size=1）。指示文は空。Llama 3 の user の囲み（prepare_for_tokenization）を付け、
  文章の部分だけを平均する（skip_instruction、mean）。字句の分け方と平均は LLM2Vec のメソッドをそのまま呼ぶ。
- 層は transformers の LlamaBiModel の層（ModifiedLlamaDecoderLayer）を使い、マスクは LlamaModel.forward と同じ
  create_causal_mask（sdpa、DynamicCache あり）で作る。
- mntp の LoRA は読み込み時と同じく、CPU で bf16 の重みに fp32 の差分（B @ A * 2）を足して bf16 に戻す。
- supervised の LoRA は合体せず、peft の lora.Linear と同じ順で fp32 で足して bf16 に戻す。
CPU（--device cpu）なら今までの CPU のエンコーダとビットまで同じ値になる（2 層に減らした本物と比べて確かめた）。
CUDA では行列の計算の順が変わるので、値がわずかに変わる（docs/motion-text.md の実測）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

BASE_REPO = "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp"
SUPERVISED_REPO = "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised"
LLAMA_REPO = "meta-llama/Meta-Llama-3-8B-Instruct"   # mntp の adapter_config.json の base_model_name_or_path
LORA_SCALE = 32 / 16   # lora_alpha / r（2 つのアダプタとも同じ）
TARGETS = {"self_attn": ["q_proj", "k_proj", "v_proj", "o_proj"], "mlp": ["gate_proj", "up_proj", "down_proj"]}
DIM = 4096
# 読み込み前に要る RAM の空き(GB)。lib/motion-text.mjs の RAM_GB.stream.load と同じ値。測った値は docs/motion-text.md の「実測」
RAM_GB_LOAD_AND_ENCODE = 5   # Kimodo の読み込み(作業プロセス)と、続く符号化の別プロセス


def snapshot(repo):
    """HF_HUB_CACHE の中のスナップショットのフォルダ(refs/main が指すもの)。取りに行かない。
    snapshot_download(local_files_only=True) は Llama 3 の使わないファイル(original/ など)が無いと断るので使わない"""
    hub = os.environ.get("HF_HUB_CACHE") or str(Path.home() / ".cache" / "huggingface" / "hub")
    repo_dir = Path(hub) / ("models--" + repo.replace("/", "--"))
    return repo_dir / "snapshots" / (repo_dir / "refs" / "main").read_text(encoding="utf-8").strip()


def settings(device):
    """キャッシュのキーに入れる設定。埋め込みの値を変えるものを全部入れる（device は CPU と CUDA で値が少し違うため）"""
    return {"encoder": "LLM2Vec", "repos": {r: snapshot(r).name for r in (BASE_REPO, SUPERVISED_REPO, LLAMA_REPO)},
            "dtype": "bfloat16", "pooling": "mean", "instruction": "", "template": "llama3-user", "skipInstruction": True,
            "batchSize": 1, "maxLength": 512, "docMaxLength": 400, "device": device, "method": "layer-stream-1"}


def cache_key(text, conf):
    return hashlib.sha256(json.dumps({"text": text, **conf}, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


class EmbeddingCache:
    """<dir>/<sha256>.npz（embedding: float32[4096]、text）。書くときは別名に書いてから置き換える"""

    def __init__(self, cache_dir, device):
        self.dir = Path(cache_dir)
        self.device = device
        self.conf = settings(device)

    def path(self, text):
        return self.dir / f"{cache_key(text, self.conf)}.npz"

    def valid(self, text):
        """キャッシュのファイルがあり、読める。壊れていれば(BadZipFile、ValueError など)消して False"""
        import numpy as np
        p = self.path(text)
        if not p.exists():
            return False
        try:
            with np.load(p) as z:
                if z["embedding"].shape != (DIM,):
                    raise ValueError("embedding の形が違う")
            return True
        except Exception:   # 書きかけや壊れたファイル。消して符号化し直す
            p.unlink(missing_ok=True)
            return False

    def missing(self, texts):
        return [t for t in dict.fromkeys(texts) if not self.valid(t)]

    def get(self, text):
        import numpy as np
        with np.load(self.path(text)) as z:
            return z["embedding"]

    def put(self, text, emb):
        import numpy as np
        self.dir.mkdir(parents=True, exist_ok=True)
        p = self.path(text)
        tmp = p.with_name(p.stem + f".{os.getpid()}.tmp.npz")
        np.savez(tmp, embedding=np.asarray(emb, dtype=np.float32), text=np.array(text))
        os.replace(tmp, p)


def ensure(texts, cache, log=lambda s: None):
    """覚えていない文章を別プロセスで符号化してキャッシュへ書く。符号化した件数と、子の報告（無ければ None）を返す"""
    todo = cache.missing(texts)
    if not todo:
        return 0, None
    cmd = [sys.executable, "-u", str(Path(__file__).resolve()), "--cache-dir", str(cache.dir), "--device", cache.device]
    log(f"文章 {len(todo)} 件を符号化する（層ごとに読む、{cache.device}）")
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    r = subprocess.run(cmd, input=json.dumps(todo, ensure_ascii=False), capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
    sys.stderr.write(r.stderr)
    if r.returncode != 0:
        tail = r.stderr.strip().splitlines()[-1:] or [""]
        raise RuntimeError(f"文章の符号化に失敗した（終了コード {r.returncode}）: {tail[0]}")
    report = json.loads(r.stdout.strip().splitlines()[-1])
    still = cache.missing(todo)
    if still:
        raise RuntimeError(f"文章の符号化のあとも埋め込みが無い: {still[0][:80]}")
    return len(todo), report


class CachedTextEncoder:
    """Kimodo の text_encoder の代わり。LLM2VecEncoder と同じ形（[文の数, 1, 4096] の float32 と長さの並び）を返す。

    値はディスクのキャッシュから読み、無ければ ensure で符号化する。LLM2VecEncoder（TEXT_ENCODER_DEVICE=cpu）と同じく CPU の
    テンソルを返す（Kimodo が .to(device) する）。
    """

    def __init__(self, cache, log=lambda s: None):
        self.cache = cache
        self.log = log
        self.hits = 0
        self.misses = 0
        self.reports = []

    def prepare(self, texts):
        n, report = ensure(list(texts), self.cache, self.log)
        self.misses += n
        if report:
            self.reports.append(report)

    def rows(self, items):
        """[文の数, 1, 4096] の float32(numpy)。無い文章は先に符号化する"""
        import numpy as np
        before = self.misses
        self.prepare(items)
        self.hits += len(items) - (self.misses - before)
        return np.stack([self.cache.get(t) for t in items])[:, None]

    def __call__(self, texts):
        import torch
        single = isinstance(texts, str)
        items = [texts] if single else list(texts)
        out = torch.tensor(self.rows(items))
        lengths = [1] * len(items)
        return (out[0], lengths[0]) if single else (out, lengths)

    def to(self, device):
        return self

    def eval(self):
        return self


# ---- 符号化（子プロセスの中） ----

_LORA_CLASS = None


def _lora_linear(base, a, b):
    """peft の lora.Linear(合体しない LoRA)の forward と同じ計算。A と B は fp32(peft の autocast_adapter_dtype)。
    クラスは 1 回だけ作る(呼ぶたびに関数の中で作ると、クラスの循環参照が重みを握り、gc まで RAM が戻らなかった)"""
    global _LORA_CLASS
    if _LORA_CLASS is None:
        import torch
        import torch.nn.functional as F

        class LoraLinear(torch.nn.Module):
            def __init__(self, base, a, b):
                super().__init__()
                self.base_layer, self.a, self.b = base, a, b

            def forward(self, x):
                result = self.base_layer(x)
                dtype = result.dtype
                x = x.to(self.a.dtype)
                result = result + F.linear(F.linear(x, self.a), self.b) * LORA_SCALE
                return result.to(dtype)
        _LORA_CLASS = LoraLinear
    return _LORA_CLASS(base, a, b)


class SafeFile:
    """safetensors を普通のファイルの読み込みで開く。mmap(safe_open)は Windows でファイル全体がコミットに数えられ
    (4 つで約 16 GB)、読んだページが作業セットに残るので使わない。要る重みだけを読む"""

    DTYPES = {"BF16": "bfloat16", "F32": "float32"}

    def __init__(self, path):
        import struct
        self.f = open(path, "rb")
        n = struct.unpack("<Q", self.f.read(8))[0]
        self.header = json.loads(self.f.read(n))
        self.base = 8 + n

    def get(self, name, rows=None):
        """名前の重み。rows を渡すと 1 次元目のその行だけを読む"""
        import torch
        meta = self.header[name]
        dtype = getattr(torch, self.DTYPES[meta["dtype"]])
        start, end = meta["data_offsets"]
        shape = meta["shape"]
        if rows is None:
            return self._read(self.base + start, end - start, dtype).reshape(shape)
        row = (end - start) // shape[0]
        return torch.stack([self._read(self.base + start + r * row, row, dtype) for r in rows])

    def _read(self, offset, size, dtype):
        import torch
        self.f.seek(offset)
        buf = bytearray(size)
        self.f.readinto(buf)
        return torch.frombuffer(buf, dtype=dtype)


class Weights:
    """Llama 3 の重みと 2 つの LoRA。名前ごとに読む(全部は読まない)"""

    def __init__(self):
        llama = snapshot(LLAMA_REPO)
        self.index = json.loads((llama / "model.safetensors.index.json").read_text(encoding="utf-8"))["weight_map"]
        self.files = {f: SafeFile(llama / f) for f in set(self.index.values())}
        self.mntp = SafeFile(snapshot(BASE_REPO) / "adapter_model.safetensors")
        self.sup = SafeFile(snapshot(SUPERVISED_REPO) / "adapter_model.safetensors")

    def llama(self, name, rows=None):
        return self.files[self.index[name]].get(name, rows)

    def lora(self, which, layer, path, part):
        f = self.mntp if which == "mntp" else self.sup
        return f.get(f"base_model.model.layers.{layer}.{path}.lora_{part}.weight")


def _layer(skel_config, i, w, device):
    """i 番目の層を作り、mntp を合体した重みと supervised の LoRA を付けて device に置く"""
    import torch
    from kimodo.model.llm2vec.models.bidirectional_llama import ModifiedLlamaDecoderLayer
    with torch.device("meta"):
        layer = ModifiedLlamaDecoderLayer(skel_config, i)
    prefix = f"model.layers.{i}."
    for norm in ("input_layernorm", "post_attention_layernorm"):
        getattr(layer, norm).weight = torch.nn.Parameter(w.llama(f"{prefix}{norm}.weight").to(device), requires_grad=False)
    for block, names in TARGETS.items():
        mod = getattr(layer, block)
        for name in names:
            path = f"{block}.{name}"
            # mntp の合体: fp32 の差分(B @ A * 2)を bf16 の重みに足して bf16 に戻す(peft の merge の bf16 += fp32 と同じ丸め)。
            # 本物は CPU で合体する。CUDA で合体しても 32 層 x 7 個の全部で CPU とビットまで同じだった(docs/motion-text.md)
            weight = w.llama(f"{prefix}{path}.weight").to(device)
            delta = (w.lora("mntp", i, path, "B").to(device) @ w.lora("mntp", i, path, "A").to(device)) * LORA_SCALE
            weight = (weight.float() + delta).to(torch.bfloat16)
            del delta
            base = torch.nn.Linear(weight.shape[1], weight.shape[0], bias=False, device="meta")
            base.weight = torch.nn.Parameter(weight, requires_grad=False)
            del weight
            a = w.lora("sup", i, path, "A").to(device)
            b = w.lora("sup", i, path, "B").to(device)
            setattr(mod, name, _lora_linear(base, a, b))
    return layer


def encode(texts, device="cuda", layers=None, log=lambda s: None):
    """文章の並びを符号化して float32 の [文の数, 4096]（torch、CPU）を返す。layers は確かめ用に層の数を減らす"""
    import torch
    from transformers import AutoConfig, AutoTokenizer
    from transformers.cache_utils import DynamicCache
    from transformers.masking_utils import create_causal_mask
    from transformers.models.llama.modeling_llama import LlamaRMSNorm, LlamaRotaryEmbedding
    from kimodo.model.llm2vec.llm2vec import LLM2Vec, batch_to_device
    from kimodo.model.llm2vec.models.bidirectional_llama import LlamaBiModel

    # LLM2Vec.from_pretrained と同じ設定: 字句は mntp のもの(pad は eos、左詰め)、構成は元の Llama 3(_name_or_path が囲みを決める)
    tokenizer = AutoTokenizer.from_pretrained(BASE_REPO)
    tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "left"
    config = AutoConfig.from_pretrained(LLAMA_REPO)
    if layers is not None:
        config.num_hidden_layers = layers
    with torch.device("meta"):
        skel = LlamaBiModel(config)   # 層の作りと _attn_implementation(sdpa) を決めるだけ。重みは持たない
    config = skel.config
    l2v = LLM2Vec(skel, tokenizer, pooling_mode="mean", max_length=512, doc_max_length=400, skip_instruction=True)

    w = Weights()
    rotary = LlamaRotaryEmbedding(config=config).to(device)   # inv_freq は CPU の fp32 で計算してから移す
    feats, states = [], []
    for text in texts:
        sent = l2v._convert_to_str("", text)   # encode と同じ: 指示文は空
        f = l2v.tokenize([l2v.prepare_for_tokenization(sent)])
        f = batch_to_device(f, device)
        ids = f["input_ids"][0].tolist()
        x = w.llama("model.embed_tokens.weight", rows=ids).to(device)[None]   # 埋め込みの表(1 GB)は要る行だけ読む
        cache_position = torch.arange(x.shape[1], device=device)
        position_ids = cache_position.unsqueeze(0)
        past = DynamicCache(config=config)   # 本物は use_cache=True(config)で DynamicCache を作る
        mask = create_causal_mask(config=config, input_embeds=x, attention_mask=f["attention_mask"], cache_position=cache_position,
                                  past_key_values=past, position_ids=position_ids)
        pos = rotary(x, position_ids=position_ids)
        feats.append(f)
        states.append({"x": x, "mask": mask, "pos": pos, "position_ids": position_ids, "cache_position": cache_position, "past": past})

    n = config.num_hidden_layers
    with torch.no_grad():
        for i in range(n):
            t = time.perf_counter()
            layer = _layer(config, i, w, device)
            for s in states:
                s["x"] = layer(s["x"], attention_mask=s["mask"], position_embeddings=s["pos"], position_ids=s["position_ids"],
                               past_key_values=s["past"], use_cache=True, cache_position=s["cache_position"])
            del layer
            if device != "cpu":
                torch.cuda.synchronize()
            log(f"層 {i + 1}/{n}（{time.perf_counter() - t:.2f} 秒）")
        norm = LlamaRMSNorm(config.hidden_size, eps=config.rms_norm_eps)
        norm.weight = torch.nn.Parameter(w.llama("model.norm.weight").to(device), requires_grad=False)
        out = []
        for f, s in zip(feats, states):
            hidden = norm(s["x"])
            out.append(l2v.get_pooling(f, hidden).detach().cpu())
    return torch.cat(out, dim=0).to(torch.float32)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--cache-dir", required=True)
    p.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    a = p.parse_args(argv)
    sys.stdin.reconfigure(encoding="utf-8")
    texts = json.loads(sys.stdin.read())
    import psutil
    import torch
    t = time.perf_counter()
    cache = EmbeddingCache(a.cache_dir, a.device)
    emb = encode(texts, a.device, log=lambda s: print(s, file=sys.stderr, flush=True))
    for text, row in zip(texts, emb):
        cache.put(text, row.numpy())
    mem = psutil.Process().memory_info()
    report = {"encoded": len(texts), "sec": round(time.perf_counter() - t, 2), "device": a.device,
              "peakRssGB": round(getattr(mem, "peak_wset", mem.rss) / 2**30, 2)}
    if a.device == "cuda":
        report["peakVramGB"] = round(torch.cuda.max_memory_reserved() / 2**30, 2)
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
