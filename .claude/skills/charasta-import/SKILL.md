---
name: charasta-import
description: きゃらすたの保管場所へ、キャラ、バージョン（VRM）、モーション（VRMA）、セリフの音声を CLI で取り込み、バージョンのサムネイルを撮る。利用者が「このキャラをきゃらすたに入れて」「新しいバージョンとして取り込んで」「この VRMA を入れて」と言ったときと、依頼の作業で作った VRM を新しいバージョンにするときに使う。
---

# きゃらすたへ取り込む

キットの root で動かします。共通の決まりは `AGENTS.md` のとおりです。仕様は `docs/characters.md`（キャラとバージョン、保管場所）、`docs/motions.md`（モーション）、`docs/voice-and-lines.md`（セリフ）です。画面からも同じことができます（ライブラリの新しいキャラ、動きの画面の「モーションを足す」の「ファイル」）。

## 決まり

- ID は英小文字、数字、ハイフンです。同じ ID が既にあれば取り込みは止まり、上書きしません。別の ID にします。
- 元のファイルは読むだけです。保管場所へコピーして sha256 を記録します。取り込んだあとに元のファイルを消したり動かしたりしません。
- 試作は全部は取り込みません。比べる価値のある節目のバージョンだけを取り込みます。どれを取り込むか迷ったら利用者に聞きます。
- 取り込む前に、今あるキャラとバージョンを確かめます: `GET http://127.0.0.1:<ポート>/api/characters`（サーバーが動いているとき）か、保管場所の `characters/<キャラ>/character.json` と `versions/` を読みます。

## キャラ

```bash
node scripts/new-character.mjs --id <キャラ> --name <表示名> --style standard|chibi --note "..." [--voice grok:eve]
```

- `--style` はキットでは `standard`（スタンダード体型）か `chibi`（チビ体型）です。
- 一人の人物は 1 つのキャラにします。きゃらくるのプロジェクトがいくつあっても、人物が同じなら新しいキャラは作りません。

## バージョン（VRM）

```bash
node scripts/import-version.mjs --char <キャラ> --id <バージョン> --label "..." --note "前のバージョンからの変更" --src <path.vrm> [--charakuru-project <id>] [--latest]
node scripts/import-version.mjs --char <キャラ> --id <バージョン> --label "..." --note "..." --src-charakit <project.charakit> --member documents/vrm/<sha>.vrm
```

- `--note` には、前のバージョンから何を変えたかを書きます。依頼から作ったバージョンなら、依頼の ID と変えた値も書きます。
- `--latest` は、利用者が最新バージョンにすると決めたときだけ付けます。依頼の作業で作ったバージョンには付けません。
- VRM の作者と利用条件（`character.json` の `vrmMeta`）は利用者に聞いて書きます。推測しません。
- VRoid と同じ中身の作りかを見るときは `node scripts/vroid-check.mjs check --char <キャラ> --ver <バージョン>`（読むだけ。`docs/vroid-format.md`）。

## サムネイル

```bash
node tools/thumb.mjs --char <キャラ> --ver <バージョン> [--port <ポート>]
```

サーバーが要ります。バージョンの正面の全身を 512x512 で撮り、`versions/<バージョン>/thumb.png` に書きます。撮った絵を開いて、キャラが写っているかを見ます。

## モーション（VRMA）

```bash
node scripts/import-motion.mjs --id <モーション> --label <名前> --src <path.vrma> --license-json <file> [--expressions-json <file>]
```

- `--license-json` は `{"holder": "権利者", "summary": "条件の要約", "redistribution": false}` の形の JSON ファイルです。中身は利用者に聞くか、配布元の条件の文から書き、書いた内容を利用者に見せます。分からない項目を推測で埋めません。作ったファイルは保管場所の外の一時フォルダに置きます。
- 二次配布できないモーション（`redistribution: false`）は、取り出せる形で外へ書き出しません。
- 動画から作るモーション、MotionBricks で作るモーションは、画面の動きの「つくる」で作り、確認待ちの結果を利用者が見て「取り込む」を押します。エージェントは利用者に代わって取り込みません。

## セリフ

```bash
node scripts/import-line.mjs --char <キャラ> --id <セリフ> --text "表示する文" [--emotion relaxed] --voice grok:eve --src <音声ファイル>
```

`text` は表示と声に使う文です。口の動きに使う読み（かな）は `docs/voice-and-lines.md` の `reading` です。音声の権利も利用者に確かめます。

## 終わりの報告

取り込んだ物（種類、ID、元のファイル）、撮ったサムネイル、止まった物とそのエラーを利用者に伝えます。
