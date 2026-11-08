# 動画からモーションを作る（RGB MoCap の ExMR、vrma-pipeline）

動きの画面の「モーションを足す」の「つくる」の動画の区間（区間が 1 つのとき「動画から作る」）で、動画から VRMA を作る。ジョブは VRMA と、元の動画と並べた比較の動画を作って止まる。人が比較を見て「取り込む」を押すまで、モーションにならない。

変換の方法は 2 つ（入力の `engine`）。

| `engine` | 中身 | 条件 |
|---|---|---|
| `exmr`（既定） | RGB MoCap（設定の `rgbmocapDir`）の ExMR で SMPL-X の動き（指を含む）を作り、BVH を FBX にして `tools/compose` で対象の版の骨へ移す（`tools/rgbmocap/exmr_vrma.py`） | ExMR は GVHMR 由来の教育・研究・非営利の利用に限る条件。SMPL-X と MANO は登録して取るモデルで非商用の条件。ジョブは記録（`license.terms`）に書くだけで、使ってよいかは人が確かめる |
| `mediapipe` | vrma-pipeline の `batch_convert.py`（MediaPipe Pose と Hand Landmarker） | MediaPipe は Apache-2.0 |

`engine` を持たない前のジョブは `mediapipe` として扱う。

用語は `CONTEXT.md`。変換そのものの説明と品質の直し方は `video-to-vrma` スキルと vrma-pipeline の `README_WINDOWS.md`。

## 置き場所と準備

- vrma-pipeline: 設定の `vrmaPipelineDir` で指す。きゃらすたからは読むだけ。
- 準備は vrma-pipeline の `scripts\setup.ps1`。`.venv`（Python 3.12）、MediaPipe のモデル、Blender と VRM アドオンを確かめる。
- URL の動画は `tools\fetch_video.ps1` が yt-dlp で取る（`%LOCALAPPDATA%\vrma-ytdlp`）。どちらの変換でも使う。
- RGB MoCap: 設定の `rgbmocapDir` で指す。`install.cmd` で入れ、ExMR の 12 のモデルのファイルを揃える（SMPL-X、MANO、SAM 3D Body は利用者が登録して取る）。きゃらすたは worker を呼ぶだけで、画面（GUI）は使わない。プロジェクトはジョブの作業フォルダ（`exmr/rgbmocap`）に作る。

## 流れ（ジョブ `video-motion`）

1. 画面か API で積む。URL は `POST /api/jobs`、手元の動画は `POST /api/video-motions`（本文は動画、ヘッダ `x-filename` と `x-params`）。手元の動画は入力を確かめてから `uploads/` に流し、ジョブが作業フォルダへ移す。
2. 動画を取る。URL はこのジョブの中で初めて取りに行く（`fetch_video.ps1 -DownloadOnly`）。
3. 切り出す（ffmpeg。開始と終了の秒、切り抜き、ミラー解除、速さ）。音は捨てる。
4. `<動画>.license.json` に権利のメモを書き、VRMA を作る。

   `exmr`: `tools/rgbmocap/exmr_vrma.py` が RGB MoCap の worker を prepare、track、exmr_preprocess、exmr_features、exmr、correct、export の順に動かす（「ExMR の仕上げ」）。`motion.bvh`（Mixamo の骨の名前、30 fps）を Blender で FBX にし、`tools/compose` の `asset` の区間（`handFrame: palm`）で VRM の骨へ移す。手は手のひらの向きまで合わせる（下の「手の向き」）。22 秒（658 コマ）の動画で約 14 分。初めて動かすときはモデルの読み込みでもっとかかる（8 秒で 22 分）。時間の上限は `1800 秒 + 1 コマ 5 秒`。

   `mediapipe`: `batch_convert.py` を動かす（MediaPipe Pose と Hand Landmarker で BVH、Blender で対象の版の `model.vrm` へ移し替えて VRMA、手の検証ループ、測定）。`--anatomy` と検証ループは既定で on で、ジョブは指定しない。ループは VRMA の手を元の動画と比べ、手と顔、両手の関係がずれた区間の手首を腕の IK で動かす（2 回、腕の方向の変化は `--hand-offset-max-deg` 30 度まで、1800 秒で打ち切り）。急な動きが増えた回や腕の方向が 45 度を超えて変わった回は採らない。失敗したときは移し替えた VRMA を残し、`manifest.json` の `outputs.hand_loop` に残す。時間は 1098 コマで約 66 秒、294 コマで約 33 秒増える。ループは CPU で動く。`--anatomy off --hand-loop off` のとき、前の版と一致するのは VRMA と BVH だけで、品質判定は違う。ジョブの画面にはこの 2 つを切る入力がない。
5. Blender（Cycles、GPU）で VRMA を対象の版に当てて全コマ描き、`side_by_side.ps1` で元の動画と並べる（`compare.mp4`）。描いたコマは残さない。
6. `charasta_license.py` が利用条件の記録を作る。
7. 確認待ちで止まる（`job.result.review` が `waiting`）。
8. 画面で「取り込む」（`POST /api/video-motions/<ジョブ>/import`、本文 `{label, motionId}`）か「捨てる」（`.../discard`）。捨てると作業フォルダは保管場所の `trash/` へ移る。確認待ちの結果は、取り込む前に「つくる」の区間（確認待ちの結果）にも使える（`docs/motion-compose.md` の「画面からつなぐ」。利用条件はジョブの `license` のまま）。順番待ちか実行中のつなぐジョブが使っている間は捨てられない。

ジョブの順番待ちは 1 件ずつなので、ほかのジョブの Blender や撮影と GPU を取り合わない。時間の上限は、URL の取得が 15 分、切り出しの ffmpeg と ffprobe が各 5 分、それより後はコマ数から決める（`120 秒 + 1 コマ 3 秒`）。上限を超えると、起動した外部コマンドを子のプロセスごと止める（`taskkill /T`、自分が起動した PID だけ）。

Stage A の MediaPipe は CPU で動く（このパッケージは GPU の処理を切った作り）。GPU を使うのは Blender の描画。

## 入力

| 項目 | 値 | 中身 |
|---|---|---|
| `url` か手元のファイル | どちらか 1 つ | `url` は http か https |
| `charId`、`verId` | 対象のキャラの版 | この `model.vrm` の体に合わせて作る。VRM 1.0 |
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

## ExMR の仕上げ

`exmr_vrma.py` は ExMR の結果に、次の 4 つを既定で on で足す。どれも失敗してもジョブは落とさず、前の結果のまま `exmr.json` の `polish` に理由を残す（ExMR の本体の段階が失敗したときだけ止まる）。

| 順 | 段階 | 内容 | 止めるスイッチ |
| --- | --- | --- | --- |
| 1 | `correct` | RGB MoCap の接地補正（preset normal、足のロックあり）を `exmr` のあとに動かし、`--result corrected_initial` で export する。失敗したら補正なしの export に戻す。接地の区間は `corrected_initial_contacts.npz` | `--no-correct` |
| 2 | 先頭のカット（`bvh_cut.py`） | 先頭 8 回の遷移に、全関節の最大角が 60 度超で、動き全体の中央値の 6 倍超のものがあれば、その次の落ち着いたコマ（最大 3 コマ進む）の行を先頭まで写す | `--no-cut-fix` |
| 3 | 足を床に付ける（`plant_feet.py`） | VRM の体の上で素の再生をして足を測り、接地の区間ごとに爪先を止め、床に合わせる（vrma-pipeline の footlock と 2 ボーン IK、届かないときは腰を下げる）。書き換えるのは脚 3 本の回転と hips の位置だけ。接地の区間が無ければ footlock.detect で検出する | `--no-plant-feet` |
| 4 | 指の形（`hand_shape_fix.py`、手の補正 v3） | vrma-pipeline の Stage A（MediaPipe の Pose と Hand Landmarker、CPU で 5 秒のクリップに約 20 秒）で動画の手を検出し、指の形を MediaPipe に寄せる。開き（外転。閉じる方向だけ）、4 本の指の付け根（MCP）の曲げ、親指を動かす。MCP の曲げは、指全体の曲がり（手のひら側の MCP + PIP + DIP）を MediaPipe の全体の曲がりへ向かって動かす範囲に限る。目標は score 0.8 以上で、手のひらが潰れていないコマ（手首、人差し指と小指の付け根の三角形の比が 0.18 から 0.36）。穴は 15 コマまで補間し、それより外は ExMR の値のまま（開きと親指は 0.5 倍） | `--no-hand-fix` |

順番は ExMR、correct、先頭のカット、retarget（compose）、plant_feet、手の補正、手のめり込みの直し（7 番目。既定は off。下の節）。

ジョブは `VRMA_PIPELINE_DIR`（設定の `vrmaPipelineDir`）を渡す。`plant_feet.py` と `foot_metrics.py` が vrma-pipeline の `vrma_playback` と `footlock` を読む。`exmr.json` の `polish.plantFeet` に、床の高さ、腰の下げの最大、足ごとの接地の区間の数、補正の前後の足の指標（`floatMedianCm`、`floatFrames` = 両足が 3 cm 以上浮いたコマ、`slideMeanCmPerSec`）が入る。

### 手の補正で採らなかった案（v1、v2）と残る限界

採らなかった案:
- v1: 人差し指、薬指、小指の曲げを、中指に対する仰角に合わせた。ExMR の中指の MCP の曲げ自体がずれているので、3 本とも中指のずれを写して指を曲げすぎた。開きも手のひらの面内の方位角で測っていて、曲げた指では暴れた。
- v2: 4 本とも絶対の仰角と外転に直し、潰れた手のひらのコマを外した。MCP だけを MediaPipe に合わせたため、MediaPipe が PIP で折る指を ExMR が MCP で折っている場面で、折れた指を伸ばした。v3 はここに、指全体の曲がりを越えない制限を足したもの。

残る限界:
- PIP と DIP は直さない。MCP の補正が指全体の曲がりを越えないようにするだけで、関節ごとの配分は ExMR のまま。
- 確信度の低いコマ（score 0.8 未満、手が小さい、手のひらが潰れたコマ）は MediaPipe を使えず、15 コマまでの穴は補間、それより外は ExMR の値のまま。
- MediaPipe の 3D の手も誤差を持つので、指標は MediaPipe との差で、真値との差ではない。

テスト: `test/exmr_polish_check.py`（`test/compose.test.mjs` から動く）が、先頭のカットの検出、置き換え、接地の区間、平滑、手の補正の純粋な部分（指全体の曲がりを越えない制限、穴の補間、手のひらの潰れ、外転）を調べる。

### 手のめり込みの直し（`hand_body_fix.py`、既定は off）

ダンスで手や前腕が対象の体（顔、前髪、胴、腰、スカート、脚）にめり込むコマを、手首を体の外へ出して直す。動画の段階 7 で、ジョブの「細かい条件」の「手と腕が体にめり込むコマを直す」（`handBodyFix: true`、ExMR のときだけ）か、`exmr_vrma.py --hand-body-fix` で動く。658 コマで約 22 分かかるので既定では動かさない。ジョブの時間の上限には 1 コマ 4 秒を足す。

1. Blender（`hand_body_pen.py --solve`）でクリップを対象の VRM に当て、全コマで手と前腕の頂点の深さを測る。障害物は腕を除いた体の面で、骨ごとに顔、前髪（頭より前で中心に近い揺れる髪だけ）、胴、腰、スカート、太もも、脚に分ける。点が面の裏にあっても、14 方向の光線の 6 割以上が裏の面に当たらなければ中とみなさない（帽子の裏地など 1 枚の面で誤る）。
2. 3 mm より深いコマで、めり込んだ点の面の法線を深さで重み付けした向きへ手首を動かし、全部の点が 6 mm（`--clear`）外に出る量を探す（最大 12 cm）。腕は肩を止めた 2 関節の IK で解き、手は世界の向きを保つ（手のひらは回らず、指はそのまま）。
3. 時間方向は、6 コマ以下のすき間をつなぎ、前後 6 コマで余弦で出入りさせ、7 コマのハン窓でならす。足りないコマを 2 回まで足し直す。
4. 上腕、前腕、手の回転だけを、動かすコマだけ VRMA に書き換え、もう一度測る。`exmr.json` の `polish.handBodyFix` に、前後の左右ごとの「5 mm 以上めり込むコマの数」と最大の深さ、書き換えたコマ数、IK の残り、腕の角の変化の最大が入る。

既にあるモーションを別の版に合わせ直すときは、単独で動かす。結果はその版の体に合わせた焼き込みになるので、体の形（脚の太さ、首の長さなど）を変えた版では測り直す。

```bash
python tools/rgbmocap/hand_body_fix.py --vrm <版の model.vrm> --vrma <motion.vrma> --out out.vrma --work WORK [--skirt-glb bake.glb] [--report r.json]
```

`--skirt-glb` に stage-studio の `bake_glb.py` で揺れ骨を焼いた GLB を渡すと、静止のスカートの代わりにその揺れたスカートを避ける（ダンス MV 用。658 コマで約 49 分）。

残った区間だけを直し直すときは `--frames a:b`（クリップのコマ番号、両端を含む。測るのは全コマ。a:b を直し、その前後 6〜9 コマも補正の出入りの区間として動く）と `--rounds`（解き直しの回数、既定 2）を使う。

## 手の向き（ExMR の経路）

`tools/compose` は FBX の基準の姿勢の骨の向きを、T ポーズの向きへ最小の回転で合わせる。骨の向きしか見ないので、手の骨のねじれ（手のひらの向き）は基準の姿勢のまま残る。RGB MoCap の BVH の基準の姿勢は手のひらの向きが VRM の T ポーズと違い、そのままでは、BVH と VRMA の手のひらの向きが全コマでほぼ一定の角度だけずれる。

区間の `handFrame: palm` は、手の補正を 2 組の向きで決める。指の向き（手首から中指の付け根）と、手のひらの横（小指の付け根から人差し指の付け根）。指は手と同じねじれから始め、曲がりだけを足す。既定は `bone`（今までどおり）で、Warrior などの FBX の手は変わらない。
