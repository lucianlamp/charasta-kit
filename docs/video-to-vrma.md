# 動画からモーションを作る（vrma-pipeline）

モーションを作る画面（モーションの画面の「新しく作る」）の動画の区間（区間が 1 つのとき「動画から作る」）で、動画から VRMA を作る。ジョブは VRMA と、元の動画と並べた比較の動画を作って止まる。人が確認のモーダル（モーションの画面の「確認待ちの結果を見比べる」）で比較を見て「取り込んで次へ」を押すまで、モーションにならない。

変換は vrma-pipeline の `batch_convert.py`（MediaPipe Pose と Hand Landmarker）。入力の `engine` は `mediapipe` だけ。MediaPipe は Apache-2.0。

用語は `CONTEXT.md`。変換そのものの説明と品質の直し方は vrma-pipeline の `README_WINDOWS.md`。

## 置き場所と準備

- vrma-pipeline: 設定の `vrmaPipelineDir` で指す。きゃらすたからは読むだけ。
- 準備は vrma-pipeline の `scripts\setup.ps1`。`.venv`（Python 3.12）、MediaPipe のモデル、Blender と VRM アドオンを確かめる。
- URL の動画は `tools\fetch_video.ps1` が yt-dlp で取る（`%LOCALAPPDATA%\vrma-ytdlp`）。

## 流れ（ジョブ `video-motion`）

1. 画面か API で積む。URL は `POST /api/jobs`、手元の動画は `POST /api/video-motions`（本文は動画、ヘッダ `x-filename` と `x-params`）。手元の動画は入力を確かめてから `uploads/` に流し、ジョブが作業フォルダへ移す。
2. 動画を取る。URL はこのジョブの中で初めて取りに行く（`fetch_video.ps1 -DownloadOnly`）。
3. 切り出す（ffmpeg。開始と終了の秒、切り抜き、ミラー解除、速さ）。音は捨てる。
4. `<動画>.license.json` に権利のメモを書き、VRMA を作る。

   `mediapipe`: `batch_convert.py` を動かす（MediaPipe Pose と Hand Landmarker で BVH、Blender で対象のバージョンの `model.vrm` へ移し替えて VRMA、手の検証ループ、測定）。`--anatomy` と検証ループは既定で on で、ジョブは指定しない。ループは VRMA の手を元の動画と比べ、手と顔、両手の関係がずれた区間の手首を腕の IK で動かす（2 回、腕の方向の変化は `--hand-offset-max-deg` 30 度まで、1800 秒で打ち切り）。急な動きが増えた回や腕の方向が 45 度を超えて変わった回は採らない。失敗したときは移し替えた VRMA を残し、`manifest.json` の `outputs.hand_loop` に残す。時間は 1098 コマで約 66 秒、294 コマで約 33 秒増える。ループは CPU で動く。`--anatomy off --hand-loop off` のとき、前のバージョンと一致するのは VRMA と BVH だけで、品質判定は違う。ジョブの画面にはこの 2 つを切る入力がない。
5. Blender（Cycles、GPU）で VRMA を対象のバージョンに当てて全コマ描き、`side_by_side.ps1` で元の動画と並べる（`compare.mp4`）。描いたコマは残さない。
6. `charasta_license.py` が利用条件の記録を作る。
7. 確認待ちで止まる（`job.result.review` が `waiting`）。
8. 画面で「取り込んで次へ」（`POST /api/video-motions/<ジョブ>/import`、本文 `{label, motionId}`）か「捨てる」（`.../discard`）。捨てると作業フォルダは保管場所の `trash/` へ移る。確認待ちの結果は、取り込む前に作る画面の区間（確認待ちの結果）にも使える（`docs/motion-compose.md` の「画面からつなぐ」。利用条件はジョブの `license` のまま）。順番待ちか実行中のつなぐジョブが使っている間は捨てられない。

ジョブの順番待ちは 1 件ずつなので、ほかのジョブの Blender や撮影と GPU を取り合わない。時間の上限は、URL の取得が 15 分、切り出しの ffmpeg と ffprobe が各 5 分、それより後はコマ数から決める（`120 秒 + 1 コマ 3 秒`）。上限を超えると、起動した外部コマンドを子のプロセスごと止める（`taskkill /T`、自分が起動した PID だけ）。

Stage A の MediaPipe は CPU で動く（このパッケージは GPU の処理を切った作り）。GPU を使うのは Blender の描画。

## 入力

| 項目 | 値 | 中身 |
|---|---|---|
| `url` か手元のファイル | どちらか 1 つ | `url` は http か https |
| `charId`、`verId` | 対象のキャラのバージョン | この `model.vrm` の体に合わせて作る。VRM 1.0 |
| `rights` | 500 文字まで、必須 | 権利のメモ |
| `unmirror` | true か false | 左右を反転する |
| `speed` | 0.1〜4、既定 1 | 動画が実際の何倍速か。0.6 倍のスローなら 0.6。全コマ残して fps を変える |
| `depthOpt` | true か false、既定 true | 全身の奥行き最適化。ダンスは入れたまま。剣のように振りの速さを優先するなら false も作って比べる（入れると振りのピークが約 13% 下がった） |
| `grip` | 0〜100 cm、既定 0 | 両手で持つ物があるときの手首の間隔。`depthOpt` が false のときは使えない |
| `trimStart`、`trimEnd` | 秒 | 切り出す範囲。`trimEnd` を省くと最後まで |
| `crop` | `幅:高さ:左:上` | ほかの人や小窓を除く |
| `label` | 100 文字まで | 空ならファイル名か URL のホスト名 |

切り出したあとの長さは 120 秒まで。`GET /api/video-motions` は使えるかどうか（`available`）と確認待ちのジョブ（`waiting`）を返す。

## 記録

`motion.json` に次を残す。

- `fittedTo`: `{charId, charName, verId}`。どのキャラの体に合わせたか。画面の一覧に出し、ほかのキャラに当てると注意の色と見出しの文で知らせる。VRMA は当てた体で接地をそろえて焼くので、体の違うキャラではずれる。
- `generated`: `tool` が `vrma-pipeline`。`model`、`job`、`frames`、`fps`、`quality`（パイプラインの判定）、`options`（切り出しと変換の条件。変換は `depthOpt` と `grip`）。
- `license`: `charasta_license.py` の出力に `rightsNote`（権利のメモ）を足したもの。`summary` は書いたメモにかかわらず「個人利用のみ。公開・再配布・商用利用は不可（動画の公開も不可）」、`redistribution` は false。メモの文から公開してよいと読み取ることはしない。公開してよい動画でも、今は同じ扱いになる。

取り込む前の VRMA は `jobs/<ジョブ>/` にあり、モーションの一覧には出ない。配るのは `compare.mp4` だけ。

## 試しの動き（テスト）

`CHARASTA_FAKE_VRMA_PIPELINE=1` で、vrma-pipeline と Blender と yt-dlp を呼ばず、作りものの動きで通す（ffmpeg と python と numpy は要る）。`fail` は変換の失敗、`hang` は変換が終わらない。`CHARASTA_VIDEO_MOTION_TIMEOUT_MS` で時間の上限を決め打ちにできる。テストは `test/video-motion.test.mjs`。
