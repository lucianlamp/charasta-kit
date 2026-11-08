"""tools/mb_onnx_engine.py の、MotionBricks も Warp も onnxruntime も要らない部分を確かめる(test/motion-gen-backend.test.mjs が動かす)。

推論の選び方、uv の引数、ONNX Runtime の実行先の選び方、tensorrt が無いときの空のモジュール。最後に OK を出す。
"""

import os
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import mb_onnx_engine as M  # noqa: E402

# uv の引数: trt は onnxruntime を足さない。ほかは決めた版、環境変数で替えられる
os.environ.pop("CHARASTA_MB_ONNXRUNTIME", None)
assert M.uv_python("D:/mb", "trt") == ["run", "--project", "D:/mb", "--no-sync", "python"]
assert M.uv_python("D:/mb", "onnx") == ["run", "--project", "D:/mb", "--no-sync", "--with", M.ONNXRUNTIME_DEFAULT, "python"]
os.environ["CHARASTA_MB_ONNXRUNTIME"] = "onnxruntime-directml==1.24.0"
assert M.uv_python("D:/mb", "auto")[-2] == "onnxruntime-directml==1.24.0"
os.environ.pop("CHARASTA_MB_ONNXRUNTIME")

# 環境変数の backend
os.environ.pop("CHARASTA_MB_BACKEND", None)
assert M.env_backend() == "auto"
os.environ["CHARASTA_MB_BACKEND"] = "onnx"
assert M.env_backend() == "onnx" and M.uv_python("D:/mb")[4] == "--with"
os.environ["CHARASTA_MB_BACKEND"] = "trt"
assert "--with" not in M.uv_python("D:/mb")
os.environ["CHARASTA_MB_BACKEND"] = "gpu"
try:
    M.env_backend()
    raise AssertionError("知らない backend を通した")
except SystemExit as e:
    assert "CHARASTA_MB_BACKEND" in str(e)
os.environ.pop("CHARASTA_MB_BACKEND")


# ONNX Runtime の実行先
def fake_ort(*providers):
    return types.SimpleNamespace(get_available_providers=lambda: list(providers))


# auto は GPU の実行先があっても CPU だけ(DirectML はこのモデルで動かなかった)。名前を書けばそれを先にする
assert M.choose_providers(fake_ort("CPUExecutionProvider")) == ["CPUExecutionProvider"]
assert M.choose_providers(fake_ort("DmlExecutionProvider", "CPUExecutionProvider")) == ["CPUExecutionProvider"]
assert M.choose_providers(fake_ort("DmlExecutionProvider", "CPUExecutionProvider"), "cpu") == ["CPUExecutionProvider"]
assert M.choose_providers(fake_ort("DmlExecutionProvider", "CPUExecutionProvider"), "DmlExecutionProvider") == ["DmlExecutionProvider", "CPUExecutionProvider"]
try:
    M.choose_providers(fake_ort("CPUExecutionProvider"), "DmlExecutionProvider")
    raise AssertionError("無い実行先を通した")
except RuntimeError:
    pass


# backend の決め方: CUDA の device が無ければ onnx で、Warp は CPU。trt を選べば cuda:0
class FakeWp:
    def __init__(self, cuda):
        self.cuda, self.device = cuda, None

    def get_cuda_device_count(self):
        return self.cuda

    def set_device(self, d):
        self.device = d


logs = []
wp = FakeWp(0)
saved = sys.modules.get("tensorrt")
sys.modules["tensorrt"] = None  # import できない tensorrt
assert M.select_backend(wp, "auto", logs.append) == "onnx" and wp.device == "cpu"
assert "CUDA の device が無い" in logs[0]
stub = sys.modules["tensorrt"]  # 空のモジュールが入る(MotionBricks の inference の import を通すため)
assert stub is not None and stub.Logger.ERROR != stub.Logger.INFO and isinstance(stub.ILogger, type) and isinstance(stub.IProgressMonitor, type)
assert M.use_tensorrt_stub_if_missing() is False, "入れたあとは import できる"
wp = FakeWp(1)
assert M.select_backend(wp, "trt") == "trt" and wp.device == "cuda:0"
wp = FakeWp(1)
assert M.select_backend(wp, "onnx") == "onnx" and wp.device == "cpu"
if saved is None:
    sys.modules.pop("tensorrt", None)
else:
    sys.modules["tensorrt"] = saved

print("OK mb_onnx_engine")
