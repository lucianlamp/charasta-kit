# 体型と揺れもの

きゃらくるで作ったキャラを、きゃらすたで少し直すための画面と道具。直すのは体型（頭の大きさ、首の長さ、肩幅、腕・腰・脚の太さ）と揺れもの（髪、スカート、リボンなどの揺れ方）。人がつまみで直すことも、Claude に頼むこともできる。どちらの結果も、元の版から作った新しい版になる。元の版は変えない（版はあとから変えない。`docs/characters.md`）。両方の版にある。

## 画面

仕上げの工程の中の画面（`#adjust/<キャラ>[/<版>]`、`public/adjust.mjs`）。入口は仕上げの画面の「体型と揺れものを直す」と、完成モデルの右の欄の「体型と揺れものを直す」。版は上部バーの切り替えで選ぶ（選んだ版が直す元になる）。

- 左（スマホでは上）にビューア。下に「直した後」「直す前」の切り替えと、動きの選択（保管場所のモーション）。揺れものは動きを再生しながら見る。
- 右に 体型 / 揺れもの / Claude に頼む の札。
- 体型: 6 つのつまみ。動かすとビューアがすぐに近い見た目にする（下の「下見」）。「体型を元に戻す」。
- 揺れもの: 揺れものの組（下の「組」）ごとに、揺れにくさ、止まりやすさ、重さの 3 つのつまみ。「揺れものを元に戻す」。
- 新しい版として保存: 変えたことの文、版 ID（既定 `v<版の数 + 1>-adjust`）と見出し（畳み）、「最新の版にする」（既定で入れる）、「新しい版として保存」。押すとジョブ `adjust` を積み、できたら「新しい版を開く」を出す。何も変えていなければ押せない。
- Claude に頼む: どこを直すか（体型、揺れもの、その他）、直してほしいこと（1000 字まで）、「今のビューアの絵を付ける」、「頼む」。下に、このキャラの頼んだことを新しい順に出す（状態、どこ、元の版、日時、文、絵、返事。完了は「版 <ID> を見る」、対応待ちは「取り下げる」）。
- 体型を直せない版（VRM 0.x、骨が足りない）は、体型の札に理由だけを出す。揺れものの無い版も同じ。

### 体型の値

| 値 | 範囲 | 中身 |
| --- | --- | --- |
| 頭の大きさ | 0.85〜1.15 倍 | 頭とその子（顔、髪、目、髪の揺れ骨）を一様に拡縮する。首の筒は滑らかにつなぐ。頭のコライダーと、頭の下の揺れ骨の当たりの半径も同じ倍率 |
| 首の長さ | -2〜+2 cm | 頭とその子を上下へ動かし、首の筒を伸ばす（縮める） |
| 肩幅（片側） | -3〜+3 cm | 上腕から先を横へ動かす。正は広く、負は狭く。肩の頂点は胸の上の帯で滑らかにつなぐ |
| 腕の太さ | 0.7〜1.2 倍 | 上腕と前腕の重みの分だけ骨の軸へ寄せる（広げる）。長さは変えない |
| 腰回り | 0.8〜1.2 倍 | spine の重みの分だけ体の中心の縦の線へ寄せる。前後は変化を半分にする |
| 脚の太さ | 0.7〜1.2 倍 | 太ももとすねの重みの分だけ骨の軸へ寄せる。足首からすねの 4 割までは元へ戻す（靴を変えない） |

脚の長さは変えられない（骨の長さを変えると、モーションの足の位置と床の高さが合わなくなるため）。区間と高さはキャラごとの数を書かず、骨の位置から決める（`docs/vrm-edits.md` の「体型」）。

### 組（揺れもの）

`VRMC_springBone` の spring を、spring の名前と最初の揺れ骨の名前から、人の言葉の組に分ける（`public/adjust-plan.mjs` の `SPRING_KINDS`）。上から順に当て、どれにも当たらなければ「その他」。

上着のすそ、胸、髪、スカート、袖、リボン、しっぽ、耳、布、飾り、その他

- 語は単語の頭でだけ当てる（`CoatSkirt` はスカートではなく上着のすそ）。
- 組の値は、組の中の揺れ骨の値の中央値。つまみを動かすと、元の中央値との比を組の中の全部の揺れ骨に掛ける（根元が硬く先が柔らかい、などの差を保つ）。元の中央値が 0 の値（重さが 0 など）は、つまみの値をそのまま入れる。
- 揺れにくさは stiffness（0〜10）、止まりやすさは dragForce（0〜1）、重さは gravityPower（0〜10）。つまみの範囲は 0〜4、0〜1、0〜2（元の値がそれより大きければ元の値まで）。
- ショートの `take.springs`（`docs/shorts.md`）は書き出しのときに版の値を上書きする。版の値はその元になる。

### 下見

画面の下見は、読み込んだ VRM のままビューアで近い見た目を作る（`window.viewer.bodyPreview`、`springPreview`。版のファイルは変えない）。

- 腕、腰、脚: 骨ごとの逆バインド行列に、骨の軸に垂直な縮めを掛ける。重みで混ざるのは書き換える道具と同じなので、静止の姿勢ではほぼ同じ形になる。足首を戻す分と法線は下見では直さない。
- 頭: 頭の骨の大きさを変える（中心は頭の骨。書き換える道具は首の区間の中ほどで、数 mm 違う）。首: 頭の骨を上へ。肩幅: 上腕の骨を横へ（肩の頂点の帯は下見では直さない）。
- 揺れもの: 揺れ骨の設定を入れ替える。保存した版と同じ値になる。

## 保存（ジョブ `adjust`）

`POST /api/jobs` に `{type: 'adjust', charId, verId, newVerId, body?, springs?, label?, note?, latest?}`。`lib/adjust.mjs`。

- `body`: `{head, neck, shoulder, arm, waist, leg}` のうち変えるもの。`neck` と `shoulder` は cm。範囲の外は 400。
- `springs`: `{組の鍵: {stiffness?, dragForce?, gravityPower?}}`。組の鍵は `hair`、`skirt` など（上の組の順に `coat`、`bust`、`hair`、`skirt`、`sleeve`、`ribbon`、`tail`、`ear`、`cloth`、`accessory`、`other`）。元と同じ値の組は入力から外す。
- 体型も揺れものも元のままなら 400。`newVerId` が既にある版か、同じ新しい版 ID のジョブが待っているか動いていれば 409（版は上書きしない）。元の版が無ければ 404。
- `label` の既定は「体型を直した」「揺れものを直した」「体型と揺れものを直した」、`note` の既定は「<元の版> から。<変えたこと>」。
- 手順: 1. 体型を変えたときだけ `python tools/vrm/body_shape.py` で書き換える  2. 揺れものを変えたときだけ glTF の JSON の `VRMC_springBone` を書き換える（BIN は変えない）  3. 新しい版として取り込む  4. 版のフォルダに `adjust.json`（`{from, body, springs, bodyReport, springJoints, jobId, createdAt}`）  5. スマホ用の軽い VRM（`tools/make_lite.py`）  6. サムネイル（`tools/thumb.mjs`。`CHARASTA_FAKE_CAPTURE` のときは撮らない）。5 と 6 の失敗は版を残し、結果の `warnings` に理由を入れる。
- 結果: `{charId, verId: 新しい版, from, version, springJoints, body: {values, report} | null, warnings}`。
- 体型と揺れものの情報: `GET /api/characters/<キャラ>/versions/<版>/adjust` → `{charId, verId, body: {available, reason, neutral}, springs: {available, reason, groups: [{key, label, springs, count, joints: [{node, name, stiffness, dragForce, gravityPower}], values}]}}`。

## 直しの頼みごと

「Claude に頼む」で、人がエージェント（Claude Code など）に直しを頼む。エージェントはコマンドラインで読み、新しい版を作って片付ける。ステージの頼みごと（`docs/stages.md`）と同じ形。

### 保管場所

`adjust-requests/<ID>/request.json` と、今の見た目の絵 `shot.<png|jpg|webp>`（任意、1 枚、8 MB まで）。コードは `lib/adjust-requests.mjs`。

| 項目 | 中身 |
| --- | --- |
| `id` | 日時と乱数（例 `20261109-013000-a1b2`） |
| `charId`、`verId` | キャラと、頼んだときに見ていた版（直す元） |
| `area` | `body`（体型）、`springs`（揺れもの）、`other`（その他） |
| `text` | 直してほしいこと。1000 字まで |
| `shot` | 絵のファイルの名前か `null` |
| `state` | `waiting`（対応待ち）、`working`（作業中）、`done`（完了）、`declined`（見送り） |
| `createdAt` | 頼んだ時刻 |
| `reply`、`repliedAt` | エージェントの返事（400 字まで）と時刻 |
| `newVersion` | 完了のとき、作った新しい版の ID。ほかは `null` |

- 状態は `waiting` → `working` → `done` か `declined`。`waiting` からそのまま `done`、`declined` にもできる。終わったものは動かせない。
- 取り下げは対応待ちのときだけで、フォルダごと消す。

### API

| 要求 | 中身 |
| --- | --- |
| `GET /api/adjust-requests[?char=<キャラ>]` | `{requests: [...]}`。新しい順。絵があれば `shotUrl` |
| `POST /api/adjust-requests` | 本文 `{charId, verId, area, text}`。201。版が無ければ 404、文が空・長すぎ・`area` が違えば 400 |
| `POST /api/adjust-requests/<ID>/shot` | 本文は絵そのもの。201 `{file}`。対応待ちでなければ 409 |
| `GET /api/adjust-requests/<ID>` | 1 件 |
| `GET /api/adjust-requests/<ID>/shot` | 絵 |
| `DELETE /api/adjust-requests/<ID>` | 取り下げ。対応待ちでなければ 409 |

### CLI（エージェント用）

`scripts/adjust-requests.mjs`。保管場所（環境変数 `CHARASTA_LIBRARY` か設定の `libraryDir`）のファイルを直に読み書きするので、サーバーが止まっていても使える。`--json` で JSON を出す（絵のファイルの場所 `shotPath` と、元の版の VRM の場所 `modelPath` が付く）。

```
node scripts/adjust-requests.mjs list [--all] [--char <キャラ>] [--json]   対応待ちと作業中を古い順に。--all は完了と見送りも
node scripts/adjust-requests.mjs show <ID> [--json]
node scripts/adjust-requests.mjs start <ID>                               作業中にする(画面から取り下げられなくなる)
node scripts/adjust-requests.mjs done <ID> --version <新しい版 ID> --reply "何をしたか"
node scripts/adjust-requests.mjs decline <ID> --reply "直さない理由"
```

- `done` は、その版がこのキャラにあり、頼まれたときの版と別のときだけ片付ける。無ければ理由を出して終わる（終了コード 1）。
- 引数の誤りは終了コード 2。

### 頼みごとを進める（エージェントの手順）

1. `node scripts/adjust-requests.mjs list --json` で対応待ちを読む。絵は `shotPath` を開いて見る。元の版は `modelPath`。
2. 直すと決めたら `start <ID>`。直せないもの（道具で直せず、Blender でも形が崩れるもの）は `decline <ID> --reply "理由と、代わりにできること"`。
3. 直す。どれも新しい版を作り、元の版は変えない。
   - つまみで直せる範囲（体型の 6 つ、揺れものの組の値）は、値を決めてジョブ `adjust` を積む（`POST /api/jobs`、上の「保存」）。値を決める前に `python tools/vrm/body_shape.py <元の版の model.vrm> --probe` で骨の高さと区間を見られる。サーバーが止まっていれば、`python tools/vrm/body_shape.py in.vrm out.vrm --arm 0.85 ...` で書き換え、`docs/vrm-edits.md` の手順で取り込む。
   - 揺れものを組より細かく直す（1 本だけ、当たりの半径、コライダー）ときは、glTF の JSON の `VRMC_springBone` を直接書き換える（`lib/glb.mjs` の `parseGlb` と `buildGlb`）。
   - 道具で直せないもの（脚の長さ、手の大きさ、服の形）は Blender で直す。Blender で VRM を読み込んで書き出すと揺れ骨とコライダーの設定が崩れることがあるので、書き出したあとに元の版の `VRMC_springBone` を写し直し、揺れものを動きで確かめる。
4. 直した版をビューアで見る: 動きを 1 本再生し、正面と横で元の版と並べて、頼みごとの所が直ったことと、ほかが崩れていないこと（服のめり込み、首の継ぎ目、揺れものの暴れ）を見る。
5. `node scripts/adjust-requests.mjs done <ID> --version <新しい版> --reply "何をどれだけ変えたか、見て確かめたこと、まだ違う所"` で片付ける。画面の頼んだことに返事と「版 <ID> を見る」が出る。
6. 人に、作った版と返事を伝える。最新の版にするかは人が決める（ジョブ `adjust` の `latest`、または `PATCH /api/characters/<キャラ>` の `latestVersion`）。
