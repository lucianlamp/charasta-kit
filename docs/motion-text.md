# 文章からモーションを作る（Kimodo）

動きの画面の「モーションを足す」の「つくる」の文章の区間（開いたときに 1 つ置いてある）に、日本語（英語も可）で動きを書いて「文章から作る」を押すと、Kimodo（NVIDIA、文章から人の動きを作るモデル。Kimodo-SOMA-RP-v1.2）が候補を作る。候補はビューアで見て、1 本を選んで「取り込む」とモーションになる。残りは捨てる。区間が 1 つのときだけこのジョブを積む。ほかの区間とつなぐときは、先にこの区間だけで作り、確認待ちの候補を「つくる」の区間にする（`docs/motion-compose.md` の「画面からつなぐ」）。MotionBricks の条件で作る方は `docs/motionbricks.md`。

用語は `CONTEXT.md`、判断の理由は `docs/adr/0004-kimodo-worker-and-claude-translation.md`。

## 置き場所と準備

- Kimodo: 設定の `kimodoDir`（`.venv`、Python 3.10。きゃらすたからは変えない）。モデルの置き場は設定の `hfCacheDir`（`HF_HUB_CACHE`）。SSD に置く（HDD では読み込みが 10 分ほどかかった）。Kimodo、LLM2Vec、Llama 3 8B Instruct のファイルが入っている。
- 作業プロセスは次の環境変数で起動する: `HF_HUB_CACHE=<hfCacheDir>`、`TEXT_ENCODER_DEVICE=cpu`、`TEXT_ENCODER_MODE=local`、`PYTHONUTF8=1`、`CHARASTA_KIMODO_ENCODER`（下の「文章のエンコーダ」）、`CHARASTA_KIMODO_EMBED_DIR=<保管場所>/kimodo-cache/embeddings`。
- 英語への変換に `claude`（Claude Code の `claude -p`）が要る。PATH にあって、ログイン済みであること。

## 流れ（ジョブ `motion-text`）

1. 画面（動きの画面）か `POST /api/jobs` で積む。入力: `text`（1000 文字まで）、`seconds`（省くと区間ごとに自動。1〜22）、`candidates`（既定 2、最大 3）、`root`（`keep` 進む、`inplace` その場）、`label`。
2. 英語の説明文に直す。`claude -p` を別プロセスで呼ぶ（下の「英語への変換」）。
3. 資源を確かめる。GPU の空きが足りなければ空くまで待つ。そのあと RAM の空きを確かめ、足りなければ理由つきで失敗する（読み込み前は読み込みと符号化の分、読み込み済みは符号化の分。下の「検査」）。
4. 作業プロセス（`tools/kimodo_worker.py`）で Kimodo を読み込む（エンコーダは読まない）。区間の文章のうち、埋め込みのキャッシュに無いものを、別プロセス（`tools/kimodo_text_encoder.py`）で層ごとに読みながら符号化してキャッシュへ書く。そのあと seed を変えて候補を作る。VRMA と `contacts.json` までここで書く。
5. hips の高さを確かめ、2 m を超える候補は捨てる。1 本も残らなければ失敗にする。
6. 確認待ちで止まる。人が候補を選んで「取り込む」を押して初めてモーションになる。「全部捨てる」は作業フォルダを保管場所の `trash/text-motion-<ジョブ ID>/` へ移す。確認待ちの候補は、取り込む前に「つくる」の区間（確認待ちの結果）にも使える（`docs/motion-compose.md` の「画面からつなぐ」）。順番待ちか実行中のつなぐジョブが使っている間は捨てられず、別の候補を取り込んでも使われている候補のファイルは消さない。

取り込むと、選ばなかった候補のファイル（作業フォルダの `cand/<番号>/`、作り直せるもの）は消す。

`speed`（m/s、0.5〜2）を付けると腰を +Z へまっすぐその速さで進ませる（Kimodo の Root2D の拘束）。`segments`（`[{prompt, seconds}]`）を付けると claude を通らずその区間で作る。`speed` のある動きは 10 区間、40 秒まで作れ、区間の秒は 0.1 秒単位（無いときは 0.5 秒単位）、区間に `speed`（0〜2 m/s）を書くとその区間だけその速さで進む（0 で立ち止まる。速さは 0.6 秒かけて移る）。歩きながら話すショートはセリフの時刻に区間を合わせてこの 2 つで作る。

## 英語への変換

- `claude -p --model sonnet --tools "" --no-session-persistence --strict-mcp-config --disable-slash-commands --setting-sources "" --output-format json --system-prompt <指示>` を引数の配列で起動し、文章は標準入力で渡す（shell に渡さない。引数にも載せない）。ツール、MCP、スキル、設定を読ませないので 1 回約 5 秒、約 0.005 USD（1148 トークン）で済む（読ませると約 13 秒、約 0.5 USD）。モデルは環境変数 `CHARASTA_CLAUDE_MODEL`（既定 `sonnet`）。
- 返事は `{"segments": [{"prompt": "A person ...", "seconds": 6}]}`。「A person」で始まる 1 文で、動作の順番を `then` などで明示させる。日本語のままだと意味が崩れるため（実験）。
- 文章が長いときは、10 秒以内の区間に分けさせる。`seconds` を指定したときは、区間の秒を比例配分して指定の合計に合わせ、端数は最後の区間に寄せる。
- 確かめ（返事を受けたあと）: 区間は 6 個まで、1 区間は 1〜10 秒、合計は 22 秒まで。外れたら Kimodo を起こす前に失敗する。15 秒の単発は hips が 3.9 m まで上がって壊れ、複数区間は 22 秒まで実用だったため。区間をつなぐ重なりは 5 コマ（Kimodo の既定）。
- 文面: 1 文 1 動作の平易な文にし、歩数・速さ・「止まる」を歩く文に入れない（止まるなら別の短い区間にする）。移動の区間は 5 秒以上で、いちばん長くする。実機で通る文面と区間の長さは `test/motion-text-real.test.mjs` が確かめる（環境変数 `CHARASTA_REAL_KIMODO=1` のときだけ動く。既定はスキップ）。決めた経緯は `docs/notes/motion-text.md` の「歩く文章が進まなかった件」。
- 同じ設定でも seed で出来が揺れる。候補を複数作って選ぶのはこのため。確認の欄の「進んだ距離」で見分けられる。数え方は `tools/vrma_stats.py`（VRMA の hips の水平の道のり、直線距離、高さ、骨ごとの最大の角度、太ももの振れ）。
- 文章は外部（Anthropic の API）へ送られる。ボタンを押したときだけ行う（画面の注意書きにも出す）。`claude` が使えないときは「英語の説明文に直せなかった（claude が使えない？）」と理由を付けて失敗する。claude が 0 以外で終わったときは、標準エラーの最後の行と標準出力の末尾（`is_error` の JSON など）を理由に入れる。

## 作業プロセス

- `tools/kimodo_worker.py` を Kimodo の `.venv` の Python で動かす常駐プロセス。標準入出力の 1 行 JSON で話す（要求 `load`、`generate`、`quit`。応答と途中経過）。標準出力はこの JSON だけにして、ライブラリのログは標準エラーへ回す。
- 管理は `lib/kimodo-worker.mjs`。ジョブが使い、最後の要求から 15 分使わなければ終了する。起動した PID は `<保管場所>/jobs/kimodo-worker.json` に記録し、サーバーの終了（SIGINT、SIGTERM、`exit`）で、その PID の木だけを止める。サーバーが先に落ちても、標準入力が閉じるので、作業プロセスは今の処理が終わってから終了する。前のサーバーが残した PID の記録は、プロセスが生きていれば知らせるだけで止めず（持ち主を確かめられないため）、死んでいれば消す。ログは `jobs/kimodo-worker.log`。
- ジョブは動いている間、`hold()` で「使わないことによる終了」のタイマーを止め、終わったら戻す（GPU 待ちや要求と要求の間に終了しない）。終了（`close()`）は入口で `loaded` を false にし、次の起動はその終了を待つ。サーバーを止めるときの終了（`close({final: true})`）のあとは起動しない。
- サーバーを止めると、ジョブに取り消しの信号（`ctx.signal`）が渡り、GPU の待ちを切り上げ、RAM の検査とモデルの読み込みの前、生成の前に中断する。ジョブを取り消す API は無い。
- 要求が時間内に答えなければ（生成の上限は 15 分、環境変数 `CHARASTA_KIMODO_TIMEOUT_MS`）、作業プロセスを止めて失敗にする。
- 読み込み中は、ジョブの段階に「文章のモデルを読み込んでいる（約 2 分）」と出る。読み込み済みなら「文章のモデルは読み込み済み」。
- 文章の埋め込みは文章ごとにディスクへ覚える（下の「文章のエンコーダ」）。応答の `encoder` に経路（`mode`）、当たりと外れの数、この要求で符号化したときはその報告（`encoded`。秒、RAM と VRAM の最大）が入り、`encodeSec` が生成のうちの符号化の秒になる（ジョブの `timings.encodeSec`）。
- 移し替えは `tools/soma_vrma.py`（ADR 0003）をそのまま使う。NPZ は 77 関節で、`BONES` が使うのは 30 関節の部分。静止姿勢の hips は 1.005 m。足の接地は NPZ の 6 列から 4 列（左かかと、左爪先、右かかと、右爪先）を `contacts.json` に写す（`docs/foot-ik.md`）。

## 検査

| 検査 | 内容 |
|---|---|
| 入力（積むとき） | 文章が要る、1000 文字まで。`seconds` は 1〜22。`candidates` は 1〜3 の整数。`root` は `keep` か `inplace` |
| 区間（英語に直したあと） | 6 個まで、1 区間 1〜10 秒、合計 22 秒まで |
| RAM | `stream` と `stream-cpu`: 作業プロセスが読み込み前なら空き 5 GB（環境変数 `CHARASTA_KIMODO_MIN_FREE_GB`）、読み込み済みなら 2 GB（符号化の別プロセスの分）未満で失敗する（`RAM_GB`。作業プロセスの最大 2.74 GB と符号化の最大 1.35 GB に余裕を足した。`docs/notes/motion-text.md` の「実測」）。`cpu`: 読み込み前だけ 16 GB（読み込みの最大が 14〜15.5 GB） |
| GPU | `nvidia-smi` の空きが 4000 MiB 未満なら 10 秒ごとに見て待つ（上限 10 分、環境変数 `CHARASTA_GPU_WAIT_MS`）。待ち切れなければ失敗する。測れなければ待たない |
| hips の高さ | 2 m を超える候補は捨てる。全部捨てたら失敗 |

## 登録する motion.json

- `generated`: `tool: "Kimodo"`、`model: "Kimodo-SOMA-RP-v1.2"`、`text`（原文）、`english`（英語の説明文をつなげたもの）、`segments`（区間ごとの説明文と秒）、`seed`、`candidate`（番号）、`candidates`（作った本数）、`root`、`frames`、`fps`、`durationSec`、`travelM`、`hipsMaxM`、`translation`（`claude -p` とモデル）、`sampleMotions: false`（見本の動きを使わない）、`timings`、`job`。
- `license`（`motionTextLicense()`。値は `lib/model-licenses.json` の `kimodoText`。`tools/compose/records.py` も同じファイルを読む）: `holder`、`summary`、`redistribution: false`、`terms`。`evaluationOnly` は付けない（見本の動きを使わないので、MotionBricks のモーションにある評価用のみの制限は付かない）。
  - Kimodo-SOMA-RP-v1.2: NVIDIA Open Model License（https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/）。コードは Apache 2.0。
  - 文章の埋め込み LLM2Vec（McGill-NLP の 2 つのアダプタ）: MIT。
  - その元の Meta Llama 3 8B Instruct: Meta Llama 3 Community License（https://llama.meta.com/llama3/license/）。利用は Acceptable Use Policy（https://llama.meta.com/llama3/use-policy/）に従う。この案内を `summary` と `terms` に 1 行入れてある。Llama 3 の成果物や、それを使った製品・サービスを配布・提供するときの条件（「Built with Meta Llama 3」の表示とライセンス文の写し、ライセンス 1.b.i）も `summary` と `terms` の `condition` に事実として書いた。
  - 見本の動き（MotionBricks の BVH）: 使っていない。
- 商用で使えるかの判断はここに書かない（条件の事実だけを書く）。`redistribution` は「取り出せる状態での二次配布」の記録で、判断をしていない既定の false にしてある。一覧の札は「二次配布 不可」と出る。

## API

| 道 | 返すもの |
|---|---|
| `GET /api/motion-texts` | 使えるか（`available`）、条件の範囲、確認待ちのジョブ（`waiting`） |
| `GET /api/motion-texts/<ジョブ ID>/candidates/<番号>/motion.vrma`、`.../contacts.json` | 確認待ちの候補のファイル。ビューアの再生が読む（確認待ちのジョブだけ） |
| `POST /api/motion-texts/<ジョブ ID>/import` | 本文 `{n, label?, motionId?}`。候補 `n` を取り込む（既定の ID は `text-<ジョブ ID>`） |
| `POST /api/motion-texts/<ジョブ ID>/discard` | 全部捨てる（作業フォルダを `trash/` へ移す） |

## 画面

「つくる」の文章の区間（`public/text-motion.mjs` の `textFields`）: 文章欄、長さ（空なら自動）、候補の本数、移動。ラベルとボタン（「文章から作る」）は「つくる」の欄の下にある。作成中は一覧の先頭の仮の行に段階（英語に直している、モデルを読み込んでいる、候補を作っている）を出す。確認待ちは右の欄の先頭に「候補を選んで取り込む」を出し、原文、英語の説明文（畳み）、候補ごとの「見る」と「取り込む」、利用条件の要約、ラベル、モーション ID、「全部捨てる」が並ぶ。「見る」はビューアの `window.viewer.playCandidate({id, file, contactsUrl, ...})` で、保管場所に入れる前の候補を今のキャラに当てて再生する（足の IK も効く）。

## 試しの動き（テスト）

`CHARASTA_FAKE_KIMODO=1` で、`claude` と Kimodo を呼ばず、同じ手順を通す。英語への変換は「。」か改行で区切って先頭に `A person ` を付けるだけで、作業プロセスは `kimodo_worker.py --fake`（ふだんの `python` と numpy で動く作りものの動き）。`high` は hips が 2.5 m 持ち上がる動き、`fail` は Kimodo の失敗、`load-fail` は読み込みの失敗、`claude-fail` は英語への変換の失敗、`noisy` は標準出力へ print と fd 1 への書き込みと `null` の行を出す、`die` は生成の途中で作業プロセスが終わる、`hang` は生成が終わらない。

テスト `test/motion-text.test.mjs`: 入力の検査、区間の検査、`claude -p` の引数（文章を載せない）、ジョブの全体（確認待ち、取り込み、選ばなかった候補の削除）、ライセンスの記録、長さの指定、失敗の経路、RAM と GPU（エンコーダの経路ごと）、エンコーダの設定と埋め込みの置き場、埋め込みのキャッシュ（`test/kimodo_text_encoder_check.py`。符号化の別プロセスは差し替える。torch とモデルは使わない）、作業プロセスの PID と使い回しと終了、API、Kimodo が無い設定。作業プロセスの標準出力は、起動時に `os.dup(1)` で複製したファイルだけをプロトコルに使い、fd 1 は標準エラーへ向け直す（C のライブラリの出力が応答に混ざらない）。受け側は連想配列でない JSON の行（`null` など）をログへ回す。RAM と GPU の測り方は `tools.freeMemGB`、`tools.gpuFreeMiB` で差し替える。

## 文章のエンコーダ

Kimodo の文章の埋め込みは LLM2Vec（Llama 3 8B Instruct に mntp と supervised の 2 つの LoRA、bf16 で約 16 GB）で作る。丸ごと RAM に読むと 14〜15.5 GB 要るので、既定では層を 1 つずつ読む別プロセスで作り、埋め込みをディスクに覚える。

- 経路は環境変数 `CHARASTA_KIMODO_ENCODER`（サーバーの config.env でも渡せる）。
  - `stream`（既定）: `tools/kimodo_text_encoder.py` を Kimodo の `.venv` の Python で別プロセスとして起動し、CUDA で計算する。
  - `stream-cpu`: 同じ別プロセスを CPU で計算する。今までの経路とビットまで同じ値になる（`docs/notes/motion-text.md` の「確かめ」）。1 文で約 80〜100 秒。
  - `cpu`: 今までの経路。作業プロセスがエンコーダを CPU に丸ごと読む（RAM 14〜15.5 GB、空き 16 GB を確かめる）。埋め込みはプロセスの中だけで覚える。
  - これ以外の値は、文章を claude に送る前に理由つきで失敗する。
- 置き場所: `<保管場所>/kimodo-cache/embeddings/<sha256>.npz`（`embedding` が float32 の 4096 次元、`text` が文章）。キーは文章と、エンコーダの設定（3 つのリポジトリのスナップショット、bf16、平均の取り方、指示文、Llama 3 の囲み、batch 1、device、計算の版）の sha256。CPU と CUDA で値が少し違うので device もキーに入る。書くときは別名に書いてから置き換える。消しても作り直せる。motion-compose（`tools/compose/kimodo_gen.py`）は保管場所に書かないので、作業フォルダの `cache/kimodo-embeddings` に覚える。
- 作業プロセスは Kimodo を `load_model(..., text_encoder=<代わり>)` で読む（エンコーダは読まない）。生成の要求ごとに、区間の文章のうちキャッシュに無いものをまとめて 1 回だけ別プロセスで符号化し、そのあと seed ごとに生成する。代わりのエンコーダは LLM2VecEncoder と同じ形（`[文の数, 1, 4096]` の float32、CPU、長さは全部 1）を返す。
- 別プロセスの計算は kimodo の LLM2VecEncoder と同じ: 1 文ずつ（batch 1）、指示文は空、Llama 3 の user の囲みを付けて字句に分け、文章の部分だけを平均する（LLM2Vec のメソッドをそのまま呼ぶ）。層は transformers の `ModifiedLlamaDecoderLayer`、マスクは `create_causal_mask`（sdpa、DynamicCache あり）。transformers 5.1 では LlamaBiModel の `_update_causal_mask` は呼ばれず、マスクは `create_causal_mask` が作る。本物と同じ関数を呼ぶので、注意のかかり方も本物と同じになる。mntp の LoRA は bf16 の重みに fp32 の差分（B @ A × 2）を足して bf16 に戻し（peft の合体と同じ丸め）、supervised の LoRA は合体せず fp32 で足す（peft の lora.Linear と同じ）。
- 重みは safetensors を普通のファイルの読み込みで、要るものだけ読む。mmap（`safe_open`）は Windows でファイル全体（4 つで約 16 GB）がコミットに数えられ、読んだページが作業セットに残ったので使わない。埋め込みの表（1 GB）は要る行だけ読む。
- モデルは取りに行かない（別プロセスは `HF_HUB_OFFLINE=1`。スナップショットは `HF_HUB_CACHE` の `refs/main` から決める）。

## 気をつけること

- `stream` でも作業プロセスと符号化の別プロセスで RAM を最大約 4.1 GB、GPU を約 3.4 GB 使う。`cpu` は RAM を約 15 GB 使う。ほかの重い処理と同時に動かさない。
- 新しい文章は 1 文で約 1 分かかる（層ごとにファイルから読むため）。同じ文章は 2 回目からキャッシュで 0 秒。
- `stream`（CUDA）の動きは、今までの CPU のエンコーダで作った動きと少しだけ違う（`docs/notes/motion-text.md` の「確かめ」）。前に作った動きを同じ seed で作り直すときは `stream-cpu` にする。
- 日本語のままでは意味が崩れるので、英語に直す段を外さない。
- 見本の動き（MotionBricks の BVH）は使わない。`soma_vrma.py` は MotionBricks の環境でも Kimodo の環境でも動く（numpy だけ）。

## GPU と CPU

Kimodo の生成は `cuda:0`。文章のエンコーダ（LLM2Vec、Llama 3 8B）は bfloat16 で約 16 GB あり、12 GB の GPU には丸ごと載らない。既定の `stream` は層を 1 つずつ GPU に載せて計算する（VRAM 約 1.3 GB。上の「文章のエンコーダ」）。`cpu` では今までどおり CPU（`TEXT_ENCODER_DEVICE=cpu`）。量子化（bitsandbytes）は値が変わり、Kimodo の `.venv` に bitsandbytes も無い（入れると Kimodo の環境を変える）ので使わない。このジョブは動画をエンコードしないので、ffmpeg は使わない。
