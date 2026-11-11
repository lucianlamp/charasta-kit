# キャラとバージョン、保管場所

用語は `CONTEXT.md`、決めごとは `docs/adr/` を見る。サーバーは 127.0.0.1 だけで待ち受ける。

## 置き場所

- コード: このリポジトリ（配布版はキットのフォルダ）。
- 保管場所: 設定の `libraryDir`（git に入れない）。既定の場所は `README.md` の設定の表。
- 設定: `config.json`（git に入れない）。無くても動く。変えたいときだけ `config.example.json` を写して作る。

```json
{ "libraryDir": "<保管場所>", "port": 8870, "charakuruApp": "<きゃらくるのアプリのフォルダ>" }
```

`charakuruApp` は読むだけ（ADR 0001）。

## 作り

- Node（22）のサーバー 1 つ（`server.mjs`、依存パッケージなし、`node:` の標準モジュールだけ）。
- 画面はビルドなしの ES モジュール（`public/`）。three.js・three-vrm・three-vrm-animation は `vendor/` に置く（MIT。ライセンスの文も一緒に置く）。元はきゃらくるのアプリの `public/vendor/` の同じファイル。
- 撮影などの道具は `tools/`（Playwright と、GPU で動かす `gpu_browser.mjs`）。
- テストは `node --test`（`test/`）。

## 保管場所の形

```
<保管場所>/
  characters/<charId>/
    character.json
    versions/<verId>/model.vrm, version.json, thumb.png, check.json(検査の結果。消してよい), adjust.json(体型と揺れものの直しで作ったバージョンの値。docs/adjust.md)
    lines/<lineId>/audio.(mp3|wav|m4a), line.json
  motions/<motionId>/
    motion.vrma, motion.json
  adjust-requests/<ID>/request.json, shot.png(直しの依頼。docs/adjust.md)
  trash/<ごみ箱 ID>/
    trash.json, files/<元のパス>
  server.pid
```

- `server.pid` は動いているサーバーの PID。ポートを取れたときに書き、終わるときに自分の PID のときだけ消す(`lib/pidfile.mjs`)。Windows で外から止めると残るが、次の起動で書き直す。止める前に、その PID が `node server.mjs` かを確かめる。

- ID は英小文字・数字・ハイフン（例: `chara1`、`v2-expressions`、`vrma-02`）。パスの外へ出る ID は拒否する。
- 取り込んだファイルは変えない（ADR 0002）。`version.json` と `motion.json` に sha256 を記録する。

### character.json

```json
{ "id": "chara1", "name": "キャラ1", "note": "見た目や作り方のメモ",
  "voice": { "provider": "grok", "id": "eve" }, "latestVersion": "v2-expressions", "tags": ["赤髪", "ロング"], "style": "standard", "createdAt": "ISO" }
```

`tags` は任意の文字列の配列。各タグは前後の空白を除いて 1〜20 文字、最大 8 個で、重複は先に出たものを残す。無いキャラは `[]` として扱う。`PATCH /api/characters/<id>` で変える（不正なら `bad-input`）。

`vrmMeta` は任意で、VRM の meta に入れる作者と利用条件(`authors`、`commercialUsage`、`allowRedistribution`、`modification`、`avatarPermission`、`creditNotation`、`licenseUrl`)。`PATCH` で丸ごと置き換え、`null` か空で消す。

`style` はキャラのスタイルで、`standard`（スタンダード体型、表情はシェイプキー）、`chibi`（チビ体型、表情は画像）のどれか。仕様は `docs/character-style.md`。新しいキャラは作るときに必ず選ぶ（`POST /api/characters` と `scripts/new-character.mjs --style` で必須。ライブラリ層の `createCharacter` は省略できる）。前からのキャラで character.json に `style` が無いものは、`GET` の応答で `style: null`（未設定）になる。自動では決めない。`PATCH /api/characters/<id>` で `standard` / `chibi` に変えられる。それ以外の値と `null` は `bad-input`。

### version.json

```json
{ "id": "v2-expressions", "charId": "chara1", "label": "表情を入れた", "order": 2,
  "note": "前のバージョンから何を変えたか", "source": { "path": "元の場所", "charakuruProject": "<きゃらくるのプロジェクト ID> または null" },
  "sha256": "...", "sizeBytes": 0, "importedAt": "ISO" }
```

`order` は同じキャラの中での並び（古い順に 1 から）。

### line.json と motion.json

セリフの記録 `line.json` は `docs/voice-and-lines.md`、モーションの記録 `motion.json` は `docs/motions.md`。

## サーバーの API（すべて 127.0.0.1）

| 道 | 返すもの |
|---|---|
| `GET /` | ギャラリーの画面（`public/index.html`） |
| `GET /viewer?char=<id>&ver=<id>` | ビューアの画面（`public/viewer.html`）。ver を省くと最新バージョン |
| `GET /api/characters` | `[{ id, name, note, style, latest: { id, label, thumb }, versionCount, lineCount }]` |
| `GET /api/characters/<id>` | `{ ...character, tags, style, versions: [...version.json に kind、thumb、model の URL を足したもの], lines: [...line.json に audio の URL を足したもの], appearances: [{ shortId, title, style, updatedAt }] }`。`appearances` は `shorts/*/short.json` のうち `cast[].charId`、`charId` のどれかがこのキャラのもので、`updatedAt` の新しい順。読めない short.json は飛ばす |
| `POST /api/characters` | 本文 `{ id, name, style, note?, voice?, method? }`。`style` は必須（`standard` か `chibi`、無いか不正なら 400 `bad-input`）。成功は 201 で character.json を返す |
| `PATCH /api/characters/<id>` | 本文に `voice` / `note` / `latestVersion` / `method` / `tags` / `style` / `vrmMeta` のどれかを入れる。成功は 200 で `GET /api/characters/<id>` と同じ形を返す |
| `GET /api/overview` の `chars[]` | 各キャラに `style`（`standard` / `chibi` / `null`）と `kind`（`vrm`）を含む。 |
| `GET /api/characters/<id>/versions/<ver>/check` | バージョンの検査。`{ charId, verId, style, applicable, reason?, unavailable?, items: [{id, label, level, detail}], summary: {ok, warn, ng, unknown, total}, cached, checkedAt }`。`style` が `standard` なら VRoid 形式の検査、`chibi` ならチビの検査(軽量版、三角形、材質、テクスチャ、表情の方式)。未設定は `applicable: false` で `reason` を返す。スタンダードで手本(`studio/vroid/reference.json`)が無ければ `unavailable` に理由を入れて `items` は空。バージョンが無ければ 404。結果はバージョンのフォルダの `check.json` に置き、model.vrm と model-lite.vrm の大きさと更新時刻が同じなら読み直さない（docs/character-style.md） |
| `GET /api/characters/<id>/versions/<ver>/adjust` | 体型を直せるかと、揺れものの組と今の値（`docs/adjust.md`）。直すのはジョブ `adjust` |
| `GET /api/motions` | `[...motion.json に file の URL を足したもの]` |
| `POST /api/motions` | VRMA の取り込み。本文は VRMA そのもの、ヘッダ `x-filename`（元の名前）と `x-license`（JSON: holder、summary、redistribution）。返すのは作った motion.json |
| `GET /lib/<保管場所の中のパス>` | 保管場所のファイル（読むだけ。パスの外へ出るものは 404） |
| `GET /vendor/<file>`、`GET /app/<file>` | vendor と public の静的ファイル |

書き込みの API は `POST /api/motions` と、下の「ごみ箱」の消す・戻す・完全に消す。バージョンとセリフの取り込みは `scripts/` の CLI で行う。

## ごみ箱

消す操作は保管場所の `trash/` への移動で、すぐには失わない（`lib/trash.mjs`）。対象は、キャラ（バージョン、セリフ、撮った動画、表情づくり `studio/<キャラ>` ごと）、バージョン、セリフ、撮った動画、モーション。音声ファイル（`audio/`）は対象にしない（撮った動画の記録が ID で指していて、同じファイルが 1 つにまとまっているため）。

```
trash/<日時>-<種類>-<ID>/trash.json   { kind, id, charId, charName, label, paths, trashedAt, sizeBytes, meta }
trash/<日時>-<種類>-<ID>/files/<元のパス>   例 files/characters/c1/versions/v2/、キャラは characters/c1 と studio/c1 の 2 か所
```

- `kind` は `character` / `version` / `line` / `shoot` / `motion`。`paths` は保管場所からの元のパス。`meta` はバージョンの `{wasLatest, movedTo}`。
- `trash.json` が無い項目は、この仕組みより前に移したもの（動画からのモーションを捨てた作業フォルダ、前の形のセリフ）。一覧には `kind: "other"` で出し、戻せない（完全に消すことはできる）。動画からのモーションを「捨てる」操作は、今は `kind: "video-motion"`、`paths: []` の記録を付ける。つないだモーションを「捨てる」操作は `kind: "motion-recipe"`、`paths: []`。
- 同じ名前の項目が既にあれば、別の名前にする（前の項目を上書きしない）。

| 道 | 中身 |
|---|---|
| `DELETE /api/characters/<id>` | キャラを移す |
| `DELETE /api/characters/<id>/versions/<ver>` | バージョンを移す |
| `DELETE /api/characters/<id>/lines/<lineId>` | セリフを移す |
| `DELETE /api/characters/<id>/shoots/<動画 ID>` | 撮った動画を移す |
| `DELETE /api/motions/<id>` | モーションを移す |
| `GET` 上の道の末尾に `/impact` | 消す前の影響 `{kind, charId, id, label, sizeBytes, effects: [{key, count, text}], refusal}`。`refusal` が null でなければ移せない理由 `{code, message}` |
| `GET /api/trash` | `{items, count, totalBytes}`。新しい順。各項目は `trash.json` に `trashId` と `restorable` を足したもの |
| `POST /api/trash/<trashId>/restore` | 元の場所へ戻す。`{ok, item}` |
| `DELETE /api/trash/<trashId>` | 完全に消す |
| `DELETE /api/trash` | ごみ箱を空にする（旧形式の項目も消す）。`{purged}` |

移す操作は `{ok: true, trashed: "trash/<ごみ箱 ID>", item}` を返す。

断る条件（`LibraryError`。理由は文で返す）:

- `busy`（409）: 順番待ちか実行中の処理が対象を使っている。キャラは `charId` が同じジョブ全部（表情づくりの工程を含む）と、表情づくりの `work.json` で動いている工程（ジョブでない材料のコピーや CLI の実行も。`lib/studio.mjs` の `busyOf`）、バージョンは `charId` と `verId` が同じジョブ、セリフは `charId` と `lineId` が同じジョブ、モーションは `motionId` が同じジョブ。ファイルが開かれていて移せないときも `busy`（Windows）。
- `last-version`（409）: バージョンが 1 つしか無いキャラのバージョン。キャラの削除へ案内する。
- `exists`（409）: 戻す先に同じ ID があるとき。何も動かさない。バージョン・セリフ・撮った動画は、消したときのキャラの `createdAt`（`meta.charCreatedAt`）が今のキャラと違うとき（同じ ID で作り直した別のキャラ）も戻さない。
- `not-found`（404）: 戻すとき、バージョン・セリフ・撮った動画の持ち主のキャラが無い。先にキャラを戻す。
- `bad-id`（400）/ `outside`（404）: ID やごみ箱 ID がパスを越える形。ごみ箱 ID は英数字と `._-` だけで、戻すときの元の場所は、`trash.json` の `kind`、`charId`、`id` から作り直し、記録の `paths` がその場所のどれかでなければ（バックスラッシュ、`..`、別の場所）`bad-input`（400）で断る。

動き:

- 最新バージョンを消したら、`latestVersion` を残りのバージョンのうち `order` が最大のものへ移す。戻すバージョンが最新だったもので、今の最新バージョンより `order` が大きければ、`latestVersion` も戻す（v3、v2 の順に消して同じ順に戻しても v3 になる）。
- 消したバージョン・キャラを指す記録（撮った動画の `verId`、セリフの動画、表情づくりの `versions`、動画から作ったモーションの `fittedTo`）は書き換えない（ADR 0002）。画面は記録の名前のまま出し、動きの一覧では「削除済み」と添える。
- 取り込むバージョンの `order` は、残っているバージョンの最大の次にする（消したあとに取り込んでも並びが重ならない）。
- 戻すと、一覧とサムネイル（バージョンのフォルダの `thumb.png`）は元どおりになる。
- 移す順は、先に `trash.json`（`paths` は全部、`sizeBytes` は移す前に数える）を書き、そのあとフォルダを移す。途中で止まっても、記録の `paths` のうち `files/` に残っているものだけを「戻す」で戻せる（`files/` に無い `paths` は飛ばし、全部が元の場所にあれば項目だけ消す）。
- 移す途中や戻す途中で失敗したら、動かした分を `renameRetry` で元へ戻す。全部戻せたときだけ項目を消す。戻せなかった分は `trash.json` の `paths` を更新してごみ箱に残し、理由を `busy` で返す（キャラのデータをここで失わない）。戻す途中の失敗で元の場所へ出たままの分は、記録の `paths` から外す。
- 場所を作るときは、確かめ済みの ID（URL の `charId`、`id`）を使い、`character.json` や `motion.json` の中の `id` は使わない。
- 完全に消す・空にするは `fs.rm` で、symlink と Windows の junction はたどらずリンクだけを消す（`test/trash.test.mjs` で確かめている）。大きさの計算もリンクをたどらない（`lstat`）。
- ファイルは Windows では開いたままだとフォルダを移せない。サーバーはファイルを返すとき、接続が切れたら読み込みを閉じる（`server.mjs` の `sendFile`）。移すときは短く待って試し直す。

## 取り込みの CLI

```bash
node scripts/import-version.mjs --char chara1 --id v2-expressions --label "表情を入れた" --note "..." --src <path.vrm> [--charakuru-project <id>] [--latest]
node scripts/import-version.mjs --char chara2 ... --src-charakit <project.charakit> --member documents/vrm/<sha>.vrm   # 正本の中の VRM を読み出す（unzip、読むだけ）
node scripts/new-character.mjs --id chara1 --name キャラ1 --style standard|chibi --note "..." [--voice grok:eve]
node scripts/import-motion.mjs --id vrma-02 --label 挨拶 --src <path.vrma> --license-json <file> [--expressions-json <file>]
node scripts/import-line.mjs --char chara1 --id hello --text "こんにちは、よろしくね！" [--emotion relaxed] --voice grok:eve --src <audio>
node tools/thumb.mjs --char chara1 --ver v2-expressions   # サーバーが動いている前提。thumb.png を書く（512×512、正面の全身）
```

同じ ID が既にあれば止まる（上書きしない）。
