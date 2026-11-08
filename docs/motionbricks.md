# モーションを作る（MotionBricks）

動きの画面の「モーションを足す」の「つくる」で区間の種類「MotionBricks の条件」を足し、条件を選んで「MotionBricks で作る」を押すと、NVIDIA の MotionBricks（SIGGRAPH 2026、リアルタイムの動きの生成）が人の動きを作り、VRM の骨に移し替えた VRMA を確認待ちにする。確認の欄で見て「取り込む」とモーションの一覧に入る。どのキャラのビューアでも再生できる。ビューアの中で動きをその場で操作する形は作っていない。

区間が 1 つならこのジョブ（`motion-gen`）を積み、ほかの区間と並べたときは、同じ条件が「つなぐ」のレシピの `motionbricks` の区間になる（`docs/motion-compose.md` の「画面からつなぐ」）。

用語は `CONTEXT.md`、移し替えの決めごとは `docs/adr/0003-motionbricks-retarget.md`。

## 置き場所と準備

- MotionBricks: github.com/NVlabs/motionbricks の clone（きゃらすたからは変えない）。設定の `motionbricksDir` で指す（既定は未設定）。
- 準備:

  ```sh
  git clone https://github.com/NVlabs/motionbricks.git <motionbricksDir>
  cd <motionbricksDir> && git lfs pull && uv sync
  ```

  `git lfs pull` は約 2.5 GB（ONNX のモデル、見本の動き、文書の画像と動画）。Hugging Face の checkpoint は要らない（ONNX のモデルが入っている）。
- NVIDIA の GPU は要らない。推論は TensorRT（NVIDIA の GPU）か ONNX Runtime（CPU）で、設定の `motionbricksBackend` で選ぶ（下の「推論」）。
- TensorRT で動かすときは、plan を初回に作り、`<motionbricksDir>/.trt-cache/` に置く（FP32 で約 2 分、765 MB。MotionBricks の `.gitignore` に入っている）。
- ONNX Runtime で動かすときは、`onnxruntime` を `uv run --with` で足す（MotionBricks の環境には入れない。初回だけ約 14 MB を取ってくる）。

## 推論（TensorRT か ONNX Runtime）

MotionBricks のモデルは同じ ONNX のファイル（`mmm_v6_soma_fp32.onnx`）で、動かし方を 2 つから選ぶ。

| 設定の `motionbricksBackend` | 動き |
|---|---|
| `auto`（既定） | TensorRT が動けば TensorRT、動かなければ ONNX Runtime（CUDA の device が無い、`tensorrt` を読み込めない、driver が古いなど。理由をジョブのログに出す） |
| `trt` | TensorRT（MotionBricks の `MotionBricksSOMAEngine`）。NVIDIA の GPU と CUDA が要る |
| `onnx` | ONNX Runtime の CPU（`tools/mb_onnx_engine.py` の `OnnxSOMAEngine`）。GPU を使わない |

- ONNX Runtime の経路は、MotionBricks の `MotionBricksSOMAEngine` を継いで推論だけを差し替える。入力の組み立て（向きのそろえ）、出力の読み取り（境目のコマを除く、足の接地）、端の直し（生成の最初と最後を文脈と目標のポーズに合わせる）は MotionBricks の Warp の kernel を CPU で動かす。MotionBricks のリポジトリは変えない。
- CUDA が要るのは MotionBricks の `InferenceEngine`（TensorRT の plan、GPU の buffer、CUDA graph）と、生成の時間を測る CUDA の event だけで、ONNX Runtime の経路はどちらも通さない。`tensorrt` を読み込めない環境では、MotionBricks の inference の import が通るだけの空の `tensorrt` を入れる。
- `auto` と `onnx` のときは、ジョブが `uv run --project <motionbricksDir> --no-sync --with onnxruntime==1.30.0 python …` で動かす。版は設定の `motionbricksOnnxRuntime` で替えられる。`trt` は `--with` を付けない。
- ONNX Runtime の実行先は CPU だけを使う（`tools/motionbricks_gen.py` の `--onnx-provider` で名前を指定できるが、DirectML はこのモデルで動かなかった）。
- 生成の速さ: 作者の PC（Ryzen 7 5700X）では、CPU でも 1 回の推論は 40〜60 ms で、ジョブ全体の時間は TensorRT とほとんど変わらなかった。TensorRT の plan を作る初回の約 2 分は要らないが、初回は Warp の CPU の kernel を組み立てるので約 1 分かかる（2 回目からは Warp のキャッシュを使う）。
- 結果は TensorRT と少し違う。MotionBricks は TensorRT で TF32（行列の掛け算を少ない桁で計算する）を許しているので、同じ入力でも、生成のところどころで選ぶ動きが変わる（モデルが選ぶ token の数は同じ）。TF32 を切った TensorRT と ONNX Runtime の CPU は、関節の位置の差が 0.1 mm 以下で同じになる。どちらの結果も MotionBricks の生成としては正しい。
- ONNX Runtime の CPU の結果は、同じ条件なら毎回同じ（CUDA を隠して動かしても同じ）。
- 使える機能の一覧（`GET /api/capabilities`）の `motionbricks.backend` に、どちらで動く見込みかを出す（`tensorrt`、`onnxruntime`、試しの動きは `fake`）。`auto` は `nvidia-smi` が PATH にあれば `tensorrt` とみなす。実際に使ったものは `generated.json` の `backend`。
- macOS は確かめていない（MotionBricks の依存に `tensorrt-cu12` があり、`uv sync` が通るかを確かめていない）。

## 流れ（ジョブ `motion-gen`）

1. 画面（動きの画面）か `POST /api/jobs` で積む。
2. `uv run --project <motionbricksDir> --no-sync [--with onnxruntime==1.30.0] python tools/motionbricks_gen.py … --backend <motionbricksBackend>` を MotionBricks のフォルダで動かす（`--with` は上の「推論」）。
   - MotionBricks のデモ Scene Preview と同じ作りで、`SOMACharacter`（`app/runtime/soma/character.py`）に毎コマ（1/30 秒）進む向き・速さ・種類を渡す。
   - 最初は待機の見本の動き（`idle_loop_001`、しゃがみは `crouch_idle_001`）から始まる。書き出すのは生成した区間だけで、見本の動きのコマそのものは書き出さない。「止まって終わる」は、待機の見本の動きへつなぐ生成までを書き出す。
   - 途中の動作（跳び越す・くぐる）は、動く長さの 4 割の時点で、体の前（速さ×1.2 m、2 m 以上）に Smart Primitive を置き、Scene Preview と同じく、体の前の判定の箱が触れたら始める。
3. `tools/soma_vrma.py` が VRM の骨に移し替えて VRMA を書く（下の「移し替え」）。
4. 確認待ちで止まる（`job.result.review` が `waiting`。結果は `jobs/<ジョブ>/motion.vrma`、`contacts.json`、`generated.json`）。動画・つなぐと同じく、人が見てから入れる。
5. 画面で「取り込む」（`POST /api/motion-gen/<ジョブ>/import`、本文 `{label?, motionId?}`。ID の既定は積んだときの `mb-<種類>-<時刻>`）と、保管場所の `motions/<ID>/` にモーションとして登録する（`motion.json` に `generated` と `license`。足の接地を `contacts.json` として横に置く。`docs/foot-ik.md`）。作業フォルダは残す（つなぐジョブが区間に使うため）。「捨てる」（`.../discard`）は作業フォルダを保管場所の `trash/motion-gen-<ジョブ>` へ移す。
   確認待ちの結果は、取り込む前に「つくる」の区間（確認待ちの結果）にも使える。順番待ちか実行中のつなぐジョブが使っている間は捨てられない。確認待ちのジョブが持つ ID（`motionId`）は、取り込むか捨てるまで次のジョブに使えない。

## 選べる条件

| 項目 | 値 | 中身 |
|---|---|---|
| 種類 `kind` | `forward` 歩き・走り、`strafe` 向きを保って動く、`crouch` しゃがみ歩き、`skipping`、`vogue`、`injured-torso`、`injured-leg`、`zombie`、`combat` | MotionBricks の SOMA の locomotion mode（`app/runtime/soma/presets.py`） |
| 速さ `speed` | 種類ごとの範囲（m/s）。歩き・走りは 1.84〜4.5（2.3 前後で歩き、3 で小走り、4.5 で走る） | mode の minimum_speed〜max_speed |
| 進む向き `direction` | 前・左・後ろ・右 | strafe と crouch だけ。体の向きに対して |
| 曲がる角度 `turn` | -360〜360 度（左が +） | 動く長さの 2〜8 割の区間でなめらかに曲がる |
| 長さ `seconds` | 1〜30 秒 | 動く長さ。止まる分は別に足される |
| 途中の動作 `action` | なし、`jump` 低い物を跳び越す（0.5 m）、`jump-high` 高い物（0.75 m）、`duck` 棒をくぐる | 歩き・走りだけ、長さ 4 秒以上 |
| 終わり方 `ending` | `stop` 止まって終わる、`move` 動いたまま終わる | |
| 移動 `root` | `keep` 進む、`inplace` その場 | その場は、hips の水平の位置から 1 秒の移動平均の道筋を引く（揺れは残る） |
| ラベル `label` | 100 文字まで | 空なら条件から作る |
| `motionId` | 英小文字・数字・ハイフン | 省くと `mb-<種類>-<時刻>` |

`GET /api/motion-gen` が選べる条件と、MotionBricks が使えるか（`available`）、確認待ちのジョブ（`waiting`）を返す。`GET /api/motion-gen/<ジョブ>/motion.vrma` と `contacts.json` は確認待ちの間だけ配る（ビューアの `playCandidate` が読む）。

選べる値の表は `lib/motion-gen-options.json` にあり、`lib/motion-gen.mjs`（ジョブとレシピの区間、`motionGenConditions`）と `tools/compose/compose.py`（計画の `motionbricks` の区間、`mb_conditions`）が同じファイルを読んで同じ規則で確かめる。両方の結果が同じことは `test/motion-recipe.test.mjs` が確かめる。

## 移し替え（ADR 0003）

- SOMA の静止姿勢は VRM 1.0 と同じ向きの T ポーズ（Y が上、前が +Z、左が +X、メートル）。座標の入れ替えは要らない（MotionBricks の runtime は Z が上なので、根だけ SOMA の空間に戻す）。
- 骨ごとに、静止姿勢からのワールドの回転の差を VRM の正規化した骨のワールドの回転にする。
- 骨の対応: hips←Hips、spine←Spine1、chest←Chest、neck←Neck1、head←Head、肩・上腕・前腕・手←Shoulder・Arm・ForeArm・Hand、脚の付け根・膝・足首・爪先←Leg・Shin・Foot・ToeBase。`upperChest` と指は書かない。
- hips の移動はメートルのまま書き、three-vrm-animation がキャラの hips の高さ（VRMA の静止姿勢の hips の高さ 1.012 m との比）で縮める。
- 最初のコマで体が +Z を向き、hips の真下が原点に来るようにそろえる。

## ライセンスの記録

`motion.json` の `license`（値は `lib/model-licenses.json` の `motionbricksGen`。`tools/compose/records.py` の `motionbricks_license` も同じ値を読み、`clips` に使った BVH を入れる）:

- `holder`、`summary`: 生成のモデルが NVIDIA Open Model Agreement（商用可）、生成の文脈と目標に見本の動き（NVIDIA Sample Data Evaluation License。NVIDIA の技術の評価・テスト用で、派生物の配布・提供は禁止）のポーズを使ったこと。
- `redistribution: false`、`evaluationOnly: true`（評価・テスト用のみで、作ったモーションを使った動画の公開も不可。意味は docs/motions.md の motion.json）。
- `terms`: 部分ごとの許諾。見本の動きは、使った BVH の一覧（`clips`。待機の見本と、種類の目標と、途中の動作の Smart Primitive が読む BVH）。

`generated` には、条件（`options`）、モデル、MotionBricks の版、推論（`backend`: `tensorrt` か `onnxruntime`、`providers`: ONNX Runtime の実行先）、生成ごとにモデルが選んだ token の数（`tokens`）、コマ数、進んだ距離、かかった時間（`timings.inferenceSec` は推論だけの合計）、ジョブの ID を残す。推論が違っても、使ったモデルと見本の動きは同じなので、ライセンスの記録は変わらない。

## 確かめの道具

- `node tools/motion_shots.mjs --char <キャラ> --ver <版> --motion <ID> --out DIR --port <ポート>`: キャラにモーションを当て、横と正面から決まった時刻で撮る（hips についていく）。足の高さ、接地中の足の滑り（`slide`、`slideContact`）、膝が後ろへ曲がったコマ、手首と肘が胴に入ったコマ、進む向きと体の向きの差を測って JSON に書く。足の IK のオフは `--footik 0`、足元の拡大は `--views feet`。
- `python tools/vrma_feet.py <motion.vrma>`: VRMA を SOMA の体つきのまま組み立てて、足の滑りを測る（キャラに当てたときと比べる）。

## 試しの動き（テスト）

`CHARASTA_FAKE_MOTIONBRICKS=1` で、MotionBricks を呼ばず、作りものの動き（足を振りながら前へ進む）を同じ移し替えで書く（ふだんの `python` と numpy で動く）。`fail` は失敗する。テストは `test/motion-gen.test.mjs`（確認待ち、取り込み、捨てる、API、許諾の記録）と `test/soma_vrma_check.py`（移し替えで骨の向きが SOMA と同じになること）。

## 気をつけること

- ビューアのモーションは繰り返し再生する。カメラは既定で hips の水平の位置（x, z）についていくので、「進む」モーションでもキャラは画面に入り続ける（高さは追わない。床のグリッドも 1 マス単位でキャラの下へ寄せる）。終わって最初に戻るときは、キャラと一緒にカメラも最初の位置へ戻る。画面の「カメラをキャラについていかせる」、`?follow=0`、`window.viewer.follow = false` で切れる。撮影の道具（tools/ の viewerUrl）は `follow=0` で開く。
- ビューアは、キャラのメッシュの視野の外での省略を切ってある（進むモーションで、原点から離れたキャラが消えないように）。
- 指は動かさない（VRM の静止姿勢のまま、まっすぐ）。
- 足の接地はキャラの体つきに左右される（足が大きいキャラは、かかとが着く瞬間の滑りが SOMA の体つきより大きい）。ビューアの再生時に足を床に留める（`docs/foot-ik.md`）。
