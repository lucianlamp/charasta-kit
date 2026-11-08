"""MotionBricks の SOMA のエンジンを、TensorRT の代わりに ONNX Runtime で動かす（NVIDIA の GPU が無くても動く）。

tools/motionbricks_gen.py（条件から作る）と tools/compose/mb_bridge.py（区間の間のつなぎ）が使う。
推論の選び方（backend）:

- trt: MotionBricks の TensorRT のエンジン（MotionBricksSOMAEngine）。NVIDIA の GPU と CUDA が要る。
- onnx: 下の OnnxSOMAEngine。同じ ONNX のファイル（mmm_v6_soma_fp32.onnx か fp16）を ONNX Runtime で動かす。
- auto: TensorRT が動けば trt、動かなければ onnx。

OnnxSOMAEngine は MotionBricks の MotionBricksSOMAEngine（motionbricks/model/soma/engine.py）を継ぎ、推論だけを
差し替える。入力の組み立て（向きのそろえ）、出力の読み取り（境目のコマを除く、足の接地）、端の直し（生成した動きの
最初と最後を文脈と目標のポーズに合わせる）は、MotionBricks の Warp の kernel をそのまま CPU で動かす。
MotionBricks のリポジトリは変えない。

TensorRT と CUDA が要るのは MotionBricks の InferenceEngine（plan を作る、GPU の buffer、CUDA graph）と
GenerationTimer（CUDA の event）だけなので、この 2 つを通さない:

- InferenceEngine.__init__ を呼ばず、buffer は Warp の CPU の配列にする。推論は numpy で ONNX Runtime に渡す。
- stream は None（Warp の CPU は stream を使わない。MotionBricks の runtime は stream=None を受け付ける）。
- 区切りの時間は perf_counter で測る。

MotionBricks の inference は読み込むときに tensorrt を import する。tensorrt が入っていないか読み込めない
環境では、import だけを通す空の tensorrt を sys.modules に入れる。

onnxruntime は MotionBricks の環境に入っていないので、uv の一時の層で足す（uv_python。uv run の --with）。
"""

from __future__ import annotations

import os
import sys
import time
import types
from contextlib import contextmanager
from pathlib import Path

BACKENDS = ("auto", "trt", "onnx")
# uv run --with に渡す onnxruntime。版を決めておく（ジョブのたびに新しい版を探しに行かない）。
# 替えるときは環境変数 CHARASTA_MB_ONNXRUNTIME（きゃらすたの設定 motionbricksOnnxRuntime）
ONNXRUNTIME_DEFAULT = "onnxruntime==1.30.0"


def env_backend():
    """環境変数 CHARASTA_MB_BACKEND（きゃらすたの設定 motionbricksBackend）。無ければ auto。"""
    value = os.environ.get("CHARASTA_MB_BACKEND") or "auto"
    if value not in BACKENDS:
        raise SystemExit(f"CHARASTA_MB_BACKEND は {' / '.join(BACKENDS)}: {value}")
    return value


def uv_python(mb, backend=None):
    """MotionBricks の uv の環境で python を動かす uv の引数（uv の後ろ）。trt でなければ onnxruntime を --with で足す。"""
    backend = backend or env_backend()
    package = os.environ.get("CHARASTA_MB_ONNXRUNTIME") or ONNXRUNTIME_DEFAULT
    return ["run", "--project", str(mb), "--no-sync", *([] if backend == "trt" else ["--with", package]), "python"]


def tensorrt_problem(wp):
    """TensorRT が動かない理由。動くなら None（MotionBricks の app/utils/model_loading.py の require_tensorrt と同じ確かめ）。"""
    if wp.get_cuda_device_count() == 0:
        return "CUDA の device が無い"
    try:
        import tensorrt as trt

        trt.Runtime(trt.Logger(trt.Logger.ERROR))
    except Exception as e:  # 入っていない、DLL が読めない、driver が古いなど
        return f"TensorRT が動かない（{type(e).__name__}: {e}）"
    return None


def select_backend(wp, wanted, log=print):
    """backend を決め、Warp の device を合わせる（trt は cuda:0、onnx は cpu）。wp.init() の後、MotionBricks を import する前に呼ぶ。"""
    backend = wanted
    if wanted == "auto":
        problem = tensorrt_problem(wp)
        backend = "trt" if problem is None else "onnx"
        if problem:
            log(f"{problem}。ONNX Runtime で動かす")
    if backend == "onnx":
        use_tensorrt_stub_if_missing()
        wp.set_device("cpu")  # 前後の処理（Warp の kernel）も CPU で動かす
    else:
        wp.set_device("cuda:0")
    return backend


def open_engine(backend, onnx_path, *, model_to_runtime, cache_dir, fp16=False, onnx_provider="auto"):
    """(エンジン, ONNX Runtime の実行先の一覧) を返す。trt の実行先は空。"""
    if backend == "trt":
        from motionbricks.inference.builder import TensorRTBuildOptions
        from motionbricks.model.soma.engine import MotionBricksSOMAEngine

        engine = MotionBricksSOMAEngine(onnx_path, model_to_runtime=model_to_runtime,
                                        build_options=TensorRTBuildOptions(enable_fp16=fp16), cache_dir=cache_dir)
        return engine, []
    engine = make_engine_class()(onnx_path, model_to_runtime=model_to_runtime, providers=onnx_provider)
    return engine, engine.providers


def tensorrt_importable() -> bool:
    try:
        import tensorrt  # noqa: F401
        return True
    except Exception:
        return False


def use_tensorrt_stub_if_missing() -> bool:
    """tensorrt を読み込めないとき、MotionBricks の inference の import が通るだけの空のモジュールを入れる。入れたら True。"""
    if tensorrt_importable():
        return False
    sys.modules.pop("tensorrt", None)
    stub = types.ModuleType("tensorrt")
    stub.__version__ = "0 (無い)"

    class Logger:  # builder.py が読み込むときに Logger の重さの値を表に入れる
        INTERNAL_ERROR, ERROR, WARNING, INFO, VERBOSE = range(5)

    class ILogger:
        Severity = Logger

    class IProgressMonitor:
        pass

    stub.Logger, stub.ILogger, stub.IProgressMonitor = Logger, ILogger, IProgressMonitor
    sys.modules["tensorrt"] = stub
    return True


def choose_providers(ort, wanted: str = "auto") -> list[str]:
    """ONNX Runtime の実行先。auto と cpu は CPU だけ。ほかは ONNX Runtime の実行先の名前（無ければ断る）。

    auto で GPU の実行先を選ばないのは、DirectML（onnxruntime-directml 1.24.4、RTX 4070）がこのモデルの最初の
    MatMul で E_INVALIDARG になって動かなかったため（2026-11-09）。CPU でも 1 回の推論は 40〜60 ms で、
    ジョブ全体の時間は TensorRT とほとんど変わらない（docs/notes/motionbricks.md）。CoreML は確かめていない。"""
    if wanted in ("auto", "cpu"):
        return ["CPUExecutionProvider"]
    available = ort.get_available_providers()
    if wanted not in available:
        raise RuntimeError(f"ONNX Runtime に {wanted} が無い（使えるのは {', '.join(available)}）")
    return [wanted, "CPUExecutionProvider"]


class _Timer:
    """GenerationTimer（CUDA の event）の代わり。区切りごとのミリ秒を milliseconds に入れる。"""

    def __init__(self, stages):
        self.milliseconds = dict.fromkeys(stages, 0.0)
        self._pending = {}

    @contextmanager
    def stage(self, name):
        t = time.perf_counter()
        yield
        self._pending[name] = (time.perf_counter() - t) * 1000.0

    def read(self):
        for name in self.milliseconds:
            self.milliseconds[name] = self._pending.get(name, 0.0)
        self._pending.clear()


def make_engine_class():
    """MotionBricks を import できるようになってから（sys.path に入れてから）クラスを作る。"""
    import numpy as np
    import onnxruntime as ort
    import warp as wp

    from motionbricks.inference.errors import TensorContractError
    from motionbricks.inference.types import TensorMode
    from motionbricks.model.generation import GENERATION_STAGES
    from motionbricks.model.soma.engine import MotionBricksSOMAEngine

    class OnnxSOMAEngine(MotionBricksSOMAEngine):
        """MotionBricksSOMAEngine の推論を ONNX Runtime で動かす。Warp の今の device（CPU）で前後の処理をする。"""

        def __init__(self, onnx_path, *, model_to_runtime=wp.transform_identity(), providers="auto"):
            # MotionBricksEngine.__init__ と InferenceEngine.__init__ は TensorRT と CUDA が要るので呼ばず、同じ属性を作る
            self._closed = False
            self._onnx_path = Path(onnx_path)
            self._device = wp.get_device()
            self._session = ort.InferenceSession(str(self._onnx_path), providers=choose_providers(ort, providers))
            self.providers = self._session.get_providers()
            # 形は MotionBricks の契約（1 件ずつ）。ONNX の入出力の名前が契約と合うかを確かめる
            specs = {spec.name: spec for spec in self.contract.tensor_specs}
            names = {i.name for i in self._session.get_inputs()} | {o.name for o in self._session.get_outputs()}
            if names != set(specs):
                raise TensorContractError(f"ONNX の入出力 {sorted(names)} が契約 {sorted(specs)} と合わない")
            self._tensor_specs = specs
            self._inputs = [s.name for s in specs.values() if s.mode is TensorMode.INPUT]
            self._outputs = [o.name for o in self._session.get_outputs()]
            self._buffers = {s.name: wp.zeros(s.shape, dtype=wp.dtype_from_numpy(s.dtype), device=self._device) for s in specs.values()}
            self._cuda_graph = None
            self._use_cuda_graph = False
            self._model_to_runtime = wp.transform(model_to_runtime)
            self._runtime_to_model = wp.transform_inverse(self._model_to_runtime)
            self.timer = _Timer(GENERATION_STAGES)
            self._alignment = wp.empty(1, dtype=wp.transform, device=self._device)
            self._generated_frame_count = wp.empty(1, dtype=wp.int32, device=self._device)
            self._initialize_pose_layout()

        @property
        def device(self):
            return self._device

        @property
        def stream(self):
            return None

        def enqueue_async(self):
            self._ensure_open()
            wp.synchronize_device(self._device)
            feed = {name: self._buffers[name].numpy() for name in self._inputs}
            for name, value in zip(self._outputs, self._session.run(self._outputs, feed)):
                spec = self._tensor_specs[name]
                self._buffers[name].assign(np.ascontiguousarray(value, dtype=spec.dtype).reshape(spec.shape))

        def bake_cuda_graph(self):
            pass

        def synchronize(self):
            self._ensure_open()
            wp.synchronize_device(self._device)

        def _discard_resources(self, *, synchronize):
            self._buffers.clear()
            self._session = None

    return OnnxSOMAEngine
