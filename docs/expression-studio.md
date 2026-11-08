# 表情づくり（表情スタジオ）

用語は `CONTEXT.md`、決めごとは `docs/adr/`。顔テクスチャ方式の表情（のっぺらぼうの頭に描いた顔を重ねる方式）を、きゃらすたの画面から作る。手順の中身は `docs/face-atlas.md` と `studio/face_atlas/` で、それを画面とジョブに載せている。

## 表情の方式の使い分け(詳しい説明はここだけ)

表情の作り方は 2 つあり、キャラを作るときに 1 回だけ選ぶ。

| キャラの頭身 | 方式 | 作る場所 |
|---|---|---|
| VRoid に近い頭身 | シェイプキー | きゃらくるのキットの表情工程で作り、`studio/vroid/kit_fcl.py` で `Fcl_` の 57 キーへ移す(`docs/vroid-format.md` の「きゃらくるの表情をそのまま使うとき」) |
| デフォルメのチビ | 画像(顔テクスチャ) | この文書の表情スタジオ。image_gen で表情を描き、顔テクスチャのコマにする(`docs/face-atlas.md`) |

- 判定の目安は「鼻がある顔か、平らな顔か」。鼻があればシェイプキー、平らなら画像。境目はユーザーもまだ迷っているので、目安として使い、迷う顔は作る前にユーザーへ聞く。
- 自前の顔の部品(`studio/vroid/face_own`、`docs/vroid-face.md`)は標準ではなく予備。どちらの方式でもうまくいかないときだけ使う。

## 決めたこと（ADR 0001 から）

- きゃらくるのプロジェクトには書き込まない。材料（骨とウェイト付きの Blender ファイル、頭のテクスチャ）は、表情づくりの作業場所へコピーしてから使う。
- 判断の要らない処理（撮影、位置合わせ、組み立て、測定、確かめの撮影）は画面のボタンで動く（ジョブ。`docs/jobs.md`）。
- 判断が要る処理（何を描くか、デザインが保たれているか、どの案を採るか）は Claude が進め、採用・却下は画面で人が決める。Claude は自分で採用しない。

## 置き場所

`<保管場所>/studio/<キャラ>/<表情づくりの ID>/`（コードのリポジトリの外。版と違って中身は変わる）

```
work.json        状態: 工程ごとの状態、依頼、採用、区画の範囲、ジョブの記録
inputs/          きゃらくるからコピーした材料（character.blend と、それが読む画像）と、その出どころ
face/            FACE_DIR（render_front.py 以降の出力。今の work/face と同じ形）
candidates/<依頼 ID>/   Claude が出した候補の絵
drawn/           採用した絵（neutral.png、neutral_bald.png、… 今の draw/ と同じ名前）
video/           表情の動画（任意。下の「中割り」）
out/             試作の VRM（試作ごとに番号）
checks/<試作>/   確かめの撮影（角度の表、表情、視線、口の形）
```

## 工程

| # | 工程 | 種類 | 中身（今のスクリプト） |
|---|---|---|---|
| 1 | 材料をコピー | ボタン | きゃらくるのプロジェクト（一覧から選ぶ）か、前の表情づくりから `character.blend` と画像をコピー。sha256 を記録 |
| 2 | 正面を撮る | ボタン | `render_front.py`（skin.png、with_hair.png、cam.json）。あごが尖りすぎていれば `smooth_jaw.py` も（口の高さは画面で入れる） |
| 3 | 顔の絵 | 依頼 | 中立の顔（髪あり）→ 髪なし → チークなしとチーク → 目の中の緑塗り → 瞳の切り出しを、Claude が image_gen で作り、画面で採用 |
| 4 | 区画の範囲 | 画面 | 位置合わせした絵の上で、目・眉（upper）と口（mouth）の四角を動かして決める（四角の和集合も可）。Claude が初めの案を入れる |
| 5 | 組み立て | ボタン | `align.py --same` → `face_vrm.py select` → `atlas.py` → `face_vrm.py build` → `paint_gaze.py` → `build_gaze.py` → メタを写す。試作の VRM を `out/` に |
| 6 | 表情の絵 | 依頼 | 表情ごとに、キャラ全体（髪・服あり）の絵で表情を描かせ、髪を除いたものを採用 |
| 7 | 中割り | ボタン（任意） | 表情の動画（最初のコマ = 中立、最後のコマ = 採用した表情の絵）から `expr_video.py build`。動画が無い表情は二値（中割りなし）で入る |
| 8 | 確かめ | ボタン | ビューアで角度の表・表情・視線・口の形・表情と視線の組み合わせを撮り、画面に一覧で出す |
| 9 | 版にする | ボタン | 試作を選び、変えたことを書いて、キャラの版として取り込む（`scripts/import-version.mjs` と同じ） |

- 工程 2・5・7・8 はジョブ（`studio-*` の種類）として 1 件ずつ動く。Blender は背景で動かし、GPU を使う。
- どの工程も、前の工程の入力が変わったら「古い」と画面に出す（work.json に入力のハッシュを残す）。
- 工程 3・6 の依頼の流れ: 画面で依頼を書く → work.json に「未着手」で残る → ユーザーが Claude に「きゃらすたの依頼を進めて」と言う → Claude は CLI（`node scripts/studio.mjs requests`）で未着手の依頼を読み、image_gen で候補を作って `candidates/` に置き、依頼を「候補あり」にする → 画面で候補を並べて採用か却下（却下には理由を書ける。Claude は次の候補で読む）。
- 描いた絵はそのまま使う（`docs/face-atlas.md` の「画像は image_gen で作り、そのまま使う」）。コードで線を抜き出したり描き直したりしない。手で直してよいのは、チークの位置・大きさ・濃さの合わせ込みまで。

## 中割り（動画）について

- 工程 7 は任意にする。動画が無ければ、表情は採用した絵 1 枚の二値で入る（瞬きも一瞬で閉じる）。
- 動画の出どころは、今は「手で置く（mp4 を選ぶ）」だけ。動画を作るボタンは無い。

## 作業場所と工程の詳しい形

スクリプトは `studio/face_atlas/`、手順の文書は `docs/face-atlas.md`。

### 置き場所の中身

上の「置き場所」に、次を足した。

```
inputs/character.blend, review.vrm, images/   きゃらくるからのコピー（images/ は .blend が読む外部の画像。あれば .blend の中の場所を付け替える）
face/pre/          あごを直す前の正面の撮影と、描いた絵の位置合わせ（align.json）
face/front/        直したあとの正面の撮影。cam.json・skin.png・with_hair.png は face/ にも写す
face/align.json    pre の位置合わせを、撮り直しのカメラの差だけずらしたもの
face/rects.json, regions.json, atlas_*.png, face_expr.vrm, gaze/   組み立ての出力（今の work/face と同じ形）
drawn/             採用した絵。drawn/expr/（描いた表情の区画）、drawn/masks/（開いた所のマスク）のように分けてよい
video/<表情>.mp4    中割りの動画（手で置く）
work/              中間のファイル（cheek.blend、face.blend、video/ = expr_video.py の作業フォルダと解析の控え）
out/<NNN>/model.vrm    試作（番号は 001 から）
checks/<NNN>/      試作 NNN の確かめの撮影と index.json
trash/             差し替えた材料・絵・動画・撮り直した確かめの前のもの（消さずにここへ移す）
```

画面と `/lib/studio/<キャラ>/<ID>/` で配るのは `face/`・`drawn/`・`video/`・`out/`・`checks/`・`candidates/` だけ。`inputs/`（.blend）、`work/`、`work.json` は配らない。

### work.json

```json
{
  "id": "<表情づくりの ID>", "charId": "<キャラ>", "note": "…", "createdAt": "…",
  "source": {"type": "charakuru", "project": "<プロジェクト ID>", "dir": "<きゃらくるのアプリ>/projects/<プロジェクト ID>"},
  "inputs": [{"name": "character.blend", "from": "<元のパス>", "sha256": "…", "size": 32516839, "mtimeMs": 0}],
  "adopted": [{"path": "drawn/neutral.png", "from": "<元のパス>", "sha256": "…", "request": null, "candidate": null, "note": "…", "adoptedAt": "…"}],
  "rects": {"upper": [370, 631, 1690, 1271], "mouth": [[860, 1290, 1200, 1591], [925, 1591, 1100, 1618]]},
  "options": {"front": {}, "build": {}, "video": {}, "springTune": []},
  "steps": {"front": {"state": "done", "jobId": "j…", "inputHash": "…", "at": "…", "result": {}}},
  "prototypes": [{"n": 1, "file": "out/001/model.vrm", "step": "build", "from": "face/gaze/face_gaze.vrm", "springTune": [], "sha256": "…", "size": 0, "jobId": "j…", "at": "…"}],
  "checks": [{"proto": 2, "dir": "checks/002", "set": "full", "count": 72, "jobId": "j…", "at": "…"}],
  "versions": [{"verId": "…", "proto": 2, "sha256": "…", "at": "…"}],
  "requests": []
}
```

- `steps` の工程は `copy`・`front`・`rects`・`build`・`video`・`checks`・`promote`。状態は `none`（未実行）・`queued`・`running`・`done`・`failed`。
- `request` / `candidate` と `requests` は依頼と候補で使う（下の「依頼と候補」）。
- `options` はスクリプトの引数と環境変数。キャラごとの値は `studio/recipes/<キャラ>.json` に置き、`node scripts/studio.mjs options` で入れる。

| 設定 | 中身 |
|---|---|
| `front.size` | 正面の撮影の大きさ（既定 2048） |
| `front.align` | 位置合わせする採用した絵（`align.py --same`。最初の絵の値を全部に使う） |
| `front.cheek` | `{overlay, align}`。頭のテクスチャに焼くチークの絵と、置く位置合わせの名前（`bake_overlay.py`） |
| `front.jaw` | `{mouthZ, cuts, iters}`。あごをなめらかにする（`smooth_jaw.py`。口の高さ m は設定で入れる） |
| `build.atlas` | `cells`（区画ごとの絵。無い表情は neutral の絵）、`env`（例 `ATLAS_RAW=1`）、`overlay`（区画に重ねるチーク） |
| `build.gaze` | `env`（例 `GAZE_SIDE=inner MIRROR_TOL=6 IRIS_COLOR=red`）、`holeMask`（目の中の範囲、区画の座標） |
| `build.iris` | `{align, irises: [{file, box}], env}`。瞳の層を描いた瞳で置き直す（`ball_from_iris.py`） |
| `video` | `open`（髪のない中立の区画）、`videos`（手で置いた動画。並びは blink happy angry sad relaxed surprised aa ih ou ee oh）、`drawn`（EXPR_DRAWN）、`masks`（OPENING_MASKS）、`env` |
| `springTune` | 試作を置く前に、髪の揺れ骨の当たりを整える（`spring_tune.py` の引数。null なら整えない） |

### 工程とスクリプト

| 工程 | 動き | 中身（順に） |
|---|---|---|
| 1 材料をコピー | API（その場で終わる） | プロジェクトの `work/character.blend`・`work/review.vrm` と、.blend が読む外部の画像（Blender で調べる）を `inputs/` にコピーし、sha256・大きさ・更新時刻を記録。元は読むだけ。前の材料は trash/ へ |
| 2 正面を撮る | ジョブ `studio-front` | `render_front.py`（face/pre）→ `align.py --same`（face/pre/align.json）→ `bake_overlay.py`（work/cheek.blend）→ `smooth_jaw.py`（work/face.blend）→ `render_front.py`（face/front、face/ へ写す）→ 位置合わせをカメラの差だけずらす（face/align.json） |
| 4 区画の範囲 | API（画面で四角を動かす） | 検査して work.json に置く（組み立てのときに face/rects.json に書く） |
| 5 組み立て | ジョブ `studio-build` | `face_vrm.py select` → `atlas.py` → `face_vrm.py build` → `paint_gaze.py` → `ball_from_iris.py`（設定があれば）→ `build_gaze.py` → `patch_vrm.mjs --meta-from` → 試作（設定があれば `spring_tune.py`） |
| 7 中割り | ジョブ `studio-video` | `expr_video.py build`（組み立ての face_gaze.vrm と手で置いた動画）→ 試作（設定があれば `spring_tune.py`） |
| 8 確かめ | ジョブ `studio-checks` | `tools/studio_checks.mjs` で試作をビューアで撮る（下） |
| 9 版にする | API | 試作を版として取り込み、スマホ用の軽い VRM を作る（`import-version.mjs` と同じ） |

- Blender は `config.json` の `blender`（探し方は `README.md` の設定の表）を背景で動かす。呼び方は既存の .sh と同じで、スクリプトの失敗を拾えるよう `--python-exit-code 1` だけ足した。きゃらくるのアプリのフォルダ（`charakuruApp`）は `mtoon-export.py` を読むだけ。
- `patch_vrm.mjs`（charakuru-claude-code スキル）と `spring_tune.py`は移さず、`config.json` の `patchVrm`・`springTune` で場所を指す。
- 積むときは、前の工程が済んでいるか、同じ表情づくりの前の工程が順番待ちにあれば積める（front・build・video・checks を続けて積める）。同じ工程が順番待ちにあれば 409。動かすときに前の工程が終わっていなければ失敗にする。
- ジョブが順番待ちか実行中の間は、その表情づくりの材料のコピー・採用した絵・動画・区画の範囲・設定を 409 で断る（ジョブが読んでいる途中のファイルを替えないため。CLI は別のプロセスなので、work.json の工程の状態で見る）。サーバーを起動し直したときは、止まったジョブの工程も「失敗」にする。
- 試しの動き: `CHARASTA_FAKE_BLENDER=1` は Blender と Python のスクリプトを呼ばず、小さな決まったファイルを置く。`CHARASTA_FAKE_CAPTURE=1` は確かめをブラウザで撮らない。

### 古いかどうか

工程ごとに、使うファイルの sha256 と設定の JSON をまとめたハッシュ（入力の指紋）を、ジョブを始めたときに残す。今の指紋と違えば「古い」。前の工程が古いか、きゃらくる側の元のファイルが変わった（大きさか更新時刻）ときは、後の工程に「前の工程が古い」を出す。

| 工程 | 指紋に入れるもの |
|---|---|
| 2 | inputs/character.blend（と外部の画像）、`options.front`、そこが指す採用した絵 |
| 4 | face/cam.json（正面の撮影のカメラが変わったら、範囲を見直す） |
| 5 | face/cam.json・skin.png・with_hair.png・align.json、work/face.blend、inputs/review.vrm、区画の範囲、`options.build`・`springTune`、そこが指す採用した絵 |
| 7 | face/gaze/face_gaze.vrm、`options.video`・`springTune`、そこが指す絵と動画（フォルダは中の全部のファイル） |
| 8 | 撮った試作の model.vrm（今の指紋はいちばん新しい試作のもの。古い試作を撮ったときは「古い」） |

### API

| 道 | 中身 |
|---|---|
| `GET /api/charakuru/projects` | きゃらくるのプロジェクト（`{id, name, savedAt, hasBlend, blendModified, hasReview}`。名前は project.charakit の project.json から読む） |
| `GET /api/studio/<キャラ>` | 表情づくりの一覧 |
| `POST /api/studio/<キャラ>` | `{id?, note?}` で作る。201 で状態を返す。同じ ID は 409 |
| `GET /api/studio/<キャラ>/<ID>` | 状態（work.json に、工程ごとの `stale`・`upstreamStale`・`sourceChanged`・ジョブの今の状態 `job`、ファイルと試作と確かめの撮影の URL を足したもの） |
| `POST /api/studio/<キャラ>/<ID>/copy` | `{project}` か `{fromStudio}`。材料をコピーして状態を返す |
| `PUT /api/studio/<キャラ>/<ID>/rects` | `{upper, mouth?}`（四角 `[x0,y0,x1,y1]` か、そのリスト 8 個まで）。正面を撮る前は 400 |
| `PATCH /api/studio/<キャラ>/<ID>/options` | 設定を 2 段目まで重ねる（`{video: {env}}` は `video.videos` を残す。配列と null は置き換える） |
| `POST /api/studio/<キャラ>/<ID>/videos/<表情>` | mp4 の本文で中割りの動画を置く（手で置く） |
| `POST /api/studio/<キャラ>/<ID>/promote` | `{proto, verId, label, note, latest}` で版にする。201 で `{version, lite}` |
| `POST /api/jobs` | `{type: "studio-front" \| "studio-build" \| "studio-video" \| "studio-checks", charId, studioId, proto?, set?}` |

### CLI（`scripts/studio.mjs`）

`create`・`list`・`status`・`projects`・`copy`・`adopt`（既存の絵のフォルダかファイルを採用した絵として取り込む。`--to` で drawn/ の下の行き先、`--pattern` でファイル名の型）・`rects`・`options`・`video`（`--dir` で `<表情>.mp4` をまとめて）・`run`（動いているサーバーにジョブを積む。`--wait` で終わるまで待つ）・`promote`・`requests`（未着手の依頼。下の「依頼と候補」）。保管場所は直接読み書きする（`run` だけサーバーを通す）。使い方は先頭のコメント。

### 画面

- 今の配置は `docs/screens.md`。
- ビューアは `?studio=<ID>&ver=proto-<番号>` で試作を開く（版の一覧の先頭に試作を足す）。

### 確かめの撮影（`tools/studio_checks.mjs`）

休めの姿勢（腕は下ろす）で、ビューアの `face(0.6)`（頭の 7cm 上を 0.6m 前から）を頭のまわりに yaw / pitch だけ回して、720×720 で撮る。視野はビューアの既定（30°）。1 枚ごとに揺れ骨を初めに戻し、1/60 秒を 30 回進めてから撮る。ビューア自身の毎フレームの描画は止め、表情は `window.lock` で固定する。

- `--set accept`（撮り比べ）: ふだん + 表情 6（blink happy angry sad relaxed surprised）+ 口の形 5 + 視線 5（左・右・上・下・左上）を、正面と 45° で 34 枚。
- `--set full`（工程 8 の既定）: accept に、角度の表（yaw -45/0/25/45/65/90 × pitch 25/0/-25）と表情と視線の組み合わせ（感情 5 × 視線 4、正面）を足して 72 枚。
- 同じ VRM を 2 回撮ると 1 枚目だけに小さな差が出るので、1 枚目の前に捨てる 1 枚を撮る。
- 比べるのは `python tools/diff_shots.py A B OUT [--threshold 8] [--limit 0.01]`（差のある画素の割合、差の画像、一覧）。

### 工程の決めごと

1. **位置合わせは工程 2 で行う**（表では工程 5 の最初）。チーク（`bake_overlay.py`）は描いた絵の位置合わせで頭のテクスチャに焼き、それはあごを直す前に行う。そこで工程 2 で、あごを直す前の撮影に `align.py --same` をかけ、撮り直したカメラの中心の差だけずらして `face/align.json` にする（`docs/face-atlas.md` の「あごをなめらかにする」と同じ）。
2. **チークと瞳の層を工程に入れた**。表になかった `bake_overlay.py`（工程 2）と `ball_from_iris.py`（工程 5）は、設定があるときだけ動く。チークの絵を差し替えると工程 2 が古くなる。
3. **材料に review.vrm を足した**。`face_vrm.py build` が書き出すメッシュを決める見本として読むため。
4. **工程 1 はジョブにせず、その場で終わる**（コピーと、Blender で外部の画像を調べる数秒）。
5. **試作は組み立て（工程 5）と中割り（工程 7）のどちらでも番号を振る**。動画が無いキャラは工程 5 の試作をそのまま使える。`spring_tune.py` は設定 `springTune` があるとき、試作を置く前に動く。
6. **区画の範囲は正面の撮影のあとにしか保存できない**（座標がその撮影の画素なので）。撮り直しでカメラが変わると「古い」になる。
7. **目の中の範囲（hole_upper.png）は採用した絵として取り込む**。区画の座標に移したもので、元の緑塗り（hole_green.png）も取り込んで出どころを残した。作り方は下の「目の中の範囲（hole_upper.png）の作り方」。
8. **確かめの撮影の撮り方を決めた**（上）。揺れ骨を 1 枚ごとに戻すのは、撮る順で髪が変わらないようにするため。
9. **作り直しの確かめはテスト用の保管場所で行う**。2 つ目のサーバーが本番の保管場所を指すと、`jobs/` を本番のサーバーと取り合う（起動時に、動いているジョブを「止まった」にしてしまう）。テスト用の保管場所は、別の設定ファイル（`CHARASTA_CONFIG`）と別のポートのサーバーで使う。

## 依頼と候補

工程 3（顔の絵）と 6（表情の絵）は依頼の流れで進める。目の中の範囲（hole_upper.png）も緑塗りの絵から作れる。工程 7（中割り）の動画は手で置く（下の「依頼と候補の決めごと」4）。

### work.json の requests

```json
{"id": "r001", "step": "face", "target": "drawn/neutral_nocheek.png", "text": "ふだんの口を描き直す。…", "state": "採用済み",
 "createdAt": "…", "base": "<依頼を出したときの target の sha256。無ければ null>", "adopted": 1,
 "candidates": [{"n": 1, "file": "candidates/r001/c01.png", "sha256": "…", "base": "<base と同じ>", "note": "…", "from": "<Claude が置いた元のパス>", "state": "採用", "at": "…", "decidedAt": "…"}]}
```

- `step` は `face`（工程 3）か `expr`（工程 6）。`target` は採用したときに替わる絵（`drawn/` の下の .png）。
- 依頼の状態: `未着手`（Claude が読む）→ `候補あり`（画面で決める）→ `採用済み`。候補を全部却下すると `未着手` に戻る。人が閉じたものは `取り下げ`。
- 候補の状態: `候補`・`採用`・`却下`（`reason` に却下の理由。空でもよい）。
- 採用すると、候補を `target.new` に写してから、前の絵を trash/ へ移して `target` に置く（写すのが失敗しても `drawn/` の絵は残り、置くのが失敗すれば trash/ から戻す）。`adopted` に `request` と `candidate` を書く。`target` を設定が指していれば、その工程の入力の指紋が変わって「古い」になる。

### API

| 道 | 中身 |
|---|---|
| `POST /api/studio/<キャラ>/<ID>/requests` | `{step, target, text}` で依頼を出す。状態を返す |
| `POST …/requests/<依頼>/candidates` | 本文が PNG。`x-note`・`x-from`（URL エンコード）。201 で候補 |
| `POST …/requests/<依頼>/candidates/<番号>/adopt` | 採用。ジョブが順番待ちか実行中なら 409 |
| `POST …/requests/<依頼>/candidates/<番号>/reject` | `{reason}` で却下 |
| `POST …/requests/<依頼>/withdraw` | 取り下げ（採用済みは 400） |

### CLI（Claude が使う）

- `node scripts/studio.mjs requests [--char] [--id] [--all]`: 未着手の依頼（`--all` で全部）。作業場所（`dir`）、替える絵の場所（`targetFile`）、前の候補と却下の理由（`candidates[].reason`、`path`）を足して出す。
- `node scripts/studio.mjs candidate --char --id --request r001 --file cand.png [--note] [--port]`: 候補を置く。動いているサーバーを通す（work.json の書き込みをサーバーのジョブと取り合わないため）。
- 採用と却下の CLI は作らない（Claude は採用しない）。

### 画面

- 工程の一覧に「3 顔の絵」「6 表情の絵」の行（依頼の状態ごとの数と「依頼へ」）。
- 「依頼と候補」の欄: 工程・替える絵（今の採用した絵と `drawn/expr/<表情>.png` から選べる。手でも書ける）・依頼の文で依頼を出す。依頼ごとに今の絵と候補を並べ、候補ごとに「採用」（確かめの窓あり）と「却下」（理由の欄）。進行中でない依頼は「済んだ依頼」にたたむ。
- 未着手か候補ありの依頼がある間は 3 秒ごとに読み直す（Claude が CLI で置いた候補が出る）。入力欄に書いている間は画面を作り直さず、書きかけの依頼の文と却下の理由は読み直しで消えない。
- 採用した絵の縮小画像に、どの依頼のどの候補だったかを出す。

### 目の中の範囲（hole_upper.png）の作り方

`studio/face_atlas/hole_mask.py FACE_DIR hole_green.png ALIGN_NAME out.png REF.png` で作る（REF は位置合わせに使った絵。緑塗りと大きさが違えば止まる）。緑（g が r と b より 100 以上大きく、不透明）の画素を、`atlas.py` が描いた絵を置くのと同じ方法（`align.json` の倍率と位置、LANCZOS）で正面の撮影に置き、`regions.json` の upper の bbox で切り出して白黒にする。

- 設定 `build.gaze.holeGreen: {file: "drawn/hole_green.png", align: "neutral"}` があると、組み立て（工程 5）が区画の三角形を選んだあとに `face/hole_upper.png` を作り、`paint_gaze.py` の `HOLE_MASK` に渡す。区画の範囲を変えても作り直される。`holeMask`（作った画像を採用した絵として渡すやり方）とはどちらか一方。
- 緑塗りから作るキャラは、作った範囲を描いた絵に重ねて見て、塗りが目の輪郭の外へ出ていれば image_gen に塗り直させる（コードで削らない）。

### 依頼と候補の決めごと

1. **依頼は替える絵 1 枚ごとにする**。工程 3 の「中立の顔 → 髪なし → チーク → 緑塗り → 瞳」の連なりは、1 枚ずつ別の依頼にする（前の絵を採用してから次を出す）。候補 1 枚が採用した絵 1 枚になる。
2. **一部だけ描き直す依頼の候補は、描き直した所だけを今の絵に貼り込んだものにする**（`docs/face-atlas.md`「ふだんの口は微笑みにする」と同じ）。`studio/face_atlas/paste_area.py` で、四角の縁を混ぜて貼る。混ぜる帯の中で貼る絵と今の絵が `--max-band-diff`（既定 24/255）より違えば、帯が描き直した線にかかっているので出力を書かずに止める。image_gen は描き直させていない所の色も少し変えるため。何をしたかは候補のメモに書く。
3. **採用で替わるのは `target` の 1 枚だけで、設定は変えない**。新しい名前の絵を採用したときに組み立てで使うには、設定（`options`）でその絵を指す。表情の絵（`drawn/expr/<表情>.png`）を `video.drawn` がフォルダで指していれば、採用すると中割りが「古い」になる。`front.align` が指す絵を替えると、正面を撮る工程も「古い」になる（位置合わせは `--same` で最初の絵の値を使うので、撮り直しても値は変わらない）。
5. **候補の置き場所への書き込みはサーバーを通す**。CLI の `candidate` は API に PNG を送る。work.json の読み書きはサーバーの中で順に行われ、ジョブの書き込みと取り合わない。
6. **依頼と候補の追加は、ジョブが動いている間もできる**（drawn/ を変えないので）。採用だけはジョブが順番待ちか実行中なら 409 で断る。
7. **同じ絵を替える依頼が複数あっても、先に採用した変更を黙って消さない**。依頼を出すときの `target` の sha256 を `base` に残し、候補を置くときと採用するときに今の `target` の sha256 と照らす。違えば 409（`code: exists`）で止め、理由（「…は依頼 rNNN のあとに替わった。この依頼は取り下げて、今の絵から出し直す」）が画面の依頼の行に出る。別の依頼の採用だけでなく、依頼のあとの CLI `adopt` で絵が替わった場合も同じ判定で止まる。止まった依頼は取り下げ、今の絵を元に出し直す。
8. **CLI は、同じ表情づくりを持つサーバーが動いている間、`work.json` を直接書かない**。設定のポートで status の GET が通り、返る `dir` が CLI の保管場所の同じ表情づくりを指すとき、`rects`・`options`・`video` は API（`PUT rects`、`PATCH options`、`POST videos/<表情>`）を通す。`adopt` は API が無いので、その間は断る（画面か API で行うか、サーバーを止めてからやる）。`candidate` は、サーバーの `dir` が CLI の保管場所と違えば（`CHARASTA_LIBRARY` だけでテスト用を指して、本番のサーバーに当たる場合）送らずに止める。サーバーが動いていない、または別の保管場所のサーバーなら、`rects`・`options`・`video`・`adopt` は今までどおり直接書く。

## シェイプキー方式の版の確認

### 分担

- 顔画像の方式（ちび体型）: 作るのも管理もきゃらすたの表情スタジオ。この文書の工程のまま。
- シェイプキー方式（普通の頭身。`Fcl_` の 57 キー）: 作るのはきゃらくるのキットの表情工程と `studio/vroid/kit_fcl.py`(使い分けは冒頭の節)。自前の顔の部品(`studio/vroid/face_own`)は予備。どちらでも、きゃらすたは確認と管理だけで、版の VRM を変えない。表情スタジオの工程に、方式の選択、部品の絵の依頼、組み立てのジョブは足さない。

### 版として取り込む

今の経路で足りる。`node scripts/import-version.mjs --char <キャラ> --id <版> --label "…" --note "…" --src <VRM>` が sha256 の記録とスマホ用の軽い VRM を作り、軽い VRM にも 57 キーが残る（`tools/make_lite.py` は画像だけ縮める）。サムネイルは今までどおり `node tools/thumb.mjs --char <キャラ> --ver <版>`。画面の「きゃらくるのプロジェクトから版を取り込む」は `work/review.vrm` を読むので、この VRM には使わない。

### 表情の確認の画面（`#face/<キャラ>[/<版>]`、`public/face-check.mjs`）

上部バーで選んだ版の VRM を見る。`#expression/<キャラ>` は、選んでいる版が `Fcl_` のキー(`Face.M_F00_000_00_Fcl_ALL_Angry` のように材質の前置きが付く β 版も含む)を持つとき、ここへ移る。表情づくりの左の欄と始める画面にも入口がある。

- どの方式の顔かの表示（`Fcl_` のキーがあればシェイプキー方式、`FaceAtlas` の画像か `Face_layers` があれば顔画像の方式、ほかはそのほか）、キーの数、視線の方式。
- プリセット 14 個の切り替え、`Fcl_` のキーのスライダー（眉、目、口、歯、全部のまとまりごと）、視線の左右と上下。割り当ての無いプリセットは押せない。
- 版どうしの比較: 比べる版を選ぶと 2 つのビューアを並べ、同じプリセット、キー、視線を当てる。相手にないキーは飛ばす。
- 確かめの撮影の 3 種類を、ボタンで積んで一覧で見る。

動きはビューアの `window.viewer` を親の画面から操作し、`expressionManager.update` を包んで重みを毎フレーム置く。ビューア本体は変えない。VRM 0.x の版は左の欄に出し、プリセットの割り当ては `extensions.VRM.blendShapeMaster` から読む。

### 確かめの撮影（ジョブ `face-check`）

`POST /api/jobs` に `{type: "face-check", charId, verId, set, motionId?}`。結果は版のフォルダの `checks/<set>/`（`index.json`、`check.json`、絵）に置き、`/lib/characters/...` で配る。撮影は `<set>.tmp` に行い、前の撮影を `<set>.old` へ避けてから入れ替え、置けたら消す（置けなければ戻す。もう一度撮れるので trash へは移さない）。時間の上限は grid と keys が 10 分、motion が 20 分（`CHARASTA_SHOOT_TIMEOUT_MS` で決め打ち）。撮影中のモーションはごみ箱へ移せない。

| set | 道具 | 中身 |
|---|---|---|
| `grid` | `tools/studio_checks.mjs --set full` | 表情、口の形、視線、表情と視線、角度の表。72 枚 |
| `keys` | `tools/face_keys.mjs` | 全部のキーと、開いた口の歯のキーの組み合わせ 5 つ。57 キーで 62 枚。`Fcl_` のキーが無い版は 400 |
| `motion` | `tools/face_motion.mjs`、`tools/face_hair.mjs` | モーション中の顔の寄りを正面と斜めで 90 コマ。髪の頂点が顔の面より内側へ入る数と深さを `check.json` の `hair` に残す。顔の面か髪が見つからなければ `hair` は null で、画面に「髪は測れなかった」と出す |

`GET /api/characters/<キャラ>/versions/<版>/face` は、方式、キー、プリセット、視線、撮影の一覧を返す。試しの動きは `CHARASTA_FAKE_CAPTURE=1`。
