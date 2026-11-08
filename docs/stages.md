# ステージの頼みごと

ステージの画面（`docs/screens.md` の「ステージ」）の「新しいステージを頼む」で、人が新しいシーンを頼む。作るのはエージェント（Claude Code など）で、コマンドラインで頼みごとを読み、stage-studio にシーンを足して片付ける。ショートの頼みごと（`docs/shorts.md`）と同じ形で、画面は頼む・取り下げる・結果を見るだけ。両方の版にある。

## 保管場所

`stage-requests/<ID>/request.json` と、参考の絵 `ref-<番号>.<png|jpg|webp>`。コードは `lib/stage-requests.mjs`。

| 項目 | 中身 |
| --- | --- |
| `id` | 日時と乱数（例 `20261109-013000-a1b2`）。作るときに決まる |
| `label` | 欲しいシーンの名前。40 字まで |
| `description` | どんな場所か。1000 字まで |
| `refs` | 参考の絵 `[{file, name}]`。`name` は元のファイルの名前 |
| `state` | `waiting`（対応待ち）、`working`（作業中）、`done`（完了）、`declined`（見送り） |
| `createdAt` | 頼んだ時刻（ISO） |
| `reply` | エージェントの返事（何をしたか、作らない理由）。400 字まで。返事の前は空 |
| `repliedAt` | 返事の時刻。返事の前は `null` |
| `stageId` | 完了のとき、足したシーンの ID。ほかは `null` |

- 状態は `waiting` → `working` → `done` か `declined`。`waiting` からそのまま `done`、`declined` にもできる。終わったものは動かせない。
- 参考の絵は 4 枚まで、1 枚 8 MB まで、PNG・JPEG・WebP だけ。種類はファイルの中身の先頭で見る（拡張子は見ない）。足せるのは対応待ちのときだけ。
- 取り下げは対応待ちのときだけで、フォルダごと消す（ごみ箱に入れない）。作業中になったら画面からは取り下げられない。

## API

| 要求 | 中身 |
| --- | --- |
| `GET /api/stage-requests` | `{requests: [...]}`。新しい順。参考の絵に `url` を付ける |
| `POST /api/stage-requests` | 本文 `{label, description}`。201 で作った頼みごと。名前か説明が空、長すぎるときは 400 |
| `POST /api/stage-requests/<ID>/refs` | 本文は絵そのもの、ヘッダ `x-filename`。201 で `{file, name}`。対応待ちでなければ 409 |
| `GET /api/stage-requests/<ID>` | 1 件 |
| `DELETE /api/stage-requests/<ID>` | 取り下げ。対応待ちでなければ 409 |
| `GET /api/stage-requests/<ID>/refs/<file>` | 参考の絵。`request.json` に書いたファイルだけ配る |

始める・片付ける・見送るは API に無い。エージェントは次の CLI を使う。

## CLI（エージェント用）

`scripts/stage-requests.mjs`。保管場所（環境変数 `CHARASTA_LIBRARY` か設定の `libraryDir`）のファイルを直に読み書きするので、サーバーが止まっていても使える。どれも `--json` を付けると JSON を出す（参考の絵に、ファイルの場所 `path` が付く）。

```
node scripts/stage-requests.mjs list [--all] [--json]       対応待ちと作業中を古い順に。--all は完了と見送りも
node scripts/stage-requests.mjs show <ID> [--json]          1 件の全部
node scripts/stage-requests.mjs start <ID>                  作業中にする
node scripts/stage-requests.mjs done <ID> --stage <シーン ID> --reply "何をしたか" [--stage-studio <dir>]
node scripts/stage-requests.mjs decline <ID> --reply "作らない理由"
```

- `done` は、シーン ID が stage-studio（`--stage-studio` か設定の `stageStudioDir`）の `stages/catalog.json` にあり、`assets/thumbs/<シーン ID>.jpg` があるときだけ片付ける。無ければ理由を出して終わる（終了コード 1）。
- 引数の誤りは終了コード 2。

## 画面

- 上の右の「新しいステージを頼む」で、名前、どんな場所か（字数を出す）、参考の絵（任意）の欄を開く。「頼む」で頼みごとを作ってから絵を 1 枚ずつ送る。送る前に枚数、大きさ、種類を確かめる。絵を送れなかったときは、頼みごとは残し、送れなかった絵の名前を出す。
- 下の「頼んだステージ」に新しい順のカード。状態、名前、頼んだ日時、説明、参考の絵（押すと別のタブで開く）、返事と日時。完了はできたシーンへのリンク（`#stages/<シーン ID>`）、対応待ちは「取り下げる」（確かめの枠を出す）。
- stage-studio が設定されていなければ、頼む欄も出さない（作れないため）。シーンが 1 つも無いときも頼める。

## 頼みごとを進める（エージェントの手順）

人が画面で頼み、エージェントが次の順に進める。「きゃらすたの依頼を進めて」と言われたら、ほかの依頼と一緒にこれも見る。

1. `node scripts/stage-requests.mjs list --json` で対応待ちを読む。参考の絵は `refs[].path` のファイルを開いて見る。
2. 作ると決めたら `start <ID>` で作業中にする。作れないもの（stage-studio の決まりで描けない、説明だけでは場所が決まらない）は `decline <ID> --reply "理由と、代わりに作れるもの"` で見送る。
3. stage-studio の `README.md` の決まりのとおりにシーンを作る。stage-studio の中だけを変え、きゃらすたは変えない。
   - シーン ID は英小文字と数字（例 `harbor`）。既にある ID と重ねない。
   - 目標の絵を先に作る: 説明と参考の絵から、`target` の視点（キャラが立つ所を正面から見る、縦 9:16）の絵を画像の生成で作り、`.dream-loop/targets/<シーン ID>.png` に置く。
   - `stages/<シーン ID>.py` に `build(ctx)` を書く（見本は `stages/_blank.py`）。`mark`、`facing`、`bounds`、`views`（`target`、`hold1`、`hold2`）を返す。テクスチャなどの素材は `assets/<シーン ID>/` に置く。カメラは `lib/shots.py` が決めるので、どの向きから撮っても背景が切れないようにし、`mark` の周り 3 m 四方は踊れるよう空ける。
   - 静止画を描いて目標と比べ、直す: `blender -b --factory-startup --python-exit-code 1 --python tools/render.py -- --stage <シーン ID> --view target --out out/<シーン ID>/target.png --pct 50 --samples 32`。`hold1`、`hold2` も描いて、裏側や端の切れを見る。
   - `stages/catalog.json` の終わりに `{"id": "<シーン ID>", "label": "<名前>"}` を足す。名前は頼みごとの `label` を基にする。
   - サムネイル: `target` の絵を 270x480 の JPEG にして `assets/thumbs/<シーン ID>.jpg` に置く。
4. 試しの書き出しで確かめる: きゃらすたでそのシーンのカットを持つショートか MV の試しを書き出し、キャラの入ったコマで、顔が見えるか、背景と馴染むか、カメラが物に入らないかを見る。歩く 1 テイクを使う頼みなら、その試しも書き出す。
5. `node scripts/stage-requests.mjs done <ID> --stage <シーン ID> --reply "何を作ったか、試しで見たこと、まだ違う所"` で片付ける。画面のカードに返事と、シーンへのリンクが出る。
6. 人に、足したシーンと返事を伝える。
