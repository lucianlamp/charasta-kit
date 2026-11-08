# 声とセリフ

用語は `CONTEXT.md` の「モーションとセリフ」。キャラのセリフ（文、読み、感情、声の種類、音声ファイル）を作って再生する。画面は完成モデルの「撮る」の中にある（`docs/shoot.md`）。ショートの声（VOICEVOX、ElevenLabs）は出演者が持つ別のもので、`docs/shorts.md` の「声の提供元」。

## 決めたこと

- **セリフの文と読み**: `line.json` に `reading`（かな）を足す。`text` は表示と Grok に渡す文（漢字可）、`reading` は口の動きに使う。`reading` が無いか空なら `text` を使う（前からのセリフはそのまま動く）。漢字をかなに直す仕組みは入れない。
- **声の種類**: `character.json` の `voice`（例 `{"provider":"grok","id":"eve"}`）。画面で変えられる。候補は `ara`、`eve`、`leo`、`rex`（Grok Build 1.0.70 の定義の例。ほかの名前も手で入れられる）。
- **判断の要らない処理はボタンで動く**（ADR に準じる）: 声の生成、動画の書き出し。サーバーの順番待ち（ジョブ）で 1 件ずつ動かす。
- **Grok を呼ぶのはボタンを押したときだけ**。テストと確かめでは、環境変数 `CHARASTA_FAKE_GROK=1` で Grok を呼ばない試しの動き（決まった短い音声を返す）にする。

## line.json

```json
{ "id": "hello", "text": "こんにちは、よろしくね！", "emotion": null, "voice": { "provider": "grok", "id": "eve" },
  "audio": "audio.mp3", "source": { "path": "元の場所" }, "createdAt": "ISO" }
```

`emotion` は感情の表情の名前か null。`reading` が無ければ `text` で口を動かす（上の「決めたこと」）。

## voice ジョブ（声の生成）

入力: `charId`、`verId`（顔を撮る版、省くと最新）、`lineId`（省くと文から作る）、`text`、`reading`、`emotion`、`voice`（省くとキャラの声）。

1. **顔を撮る**: ビューア（`/viewer?char=&ver=`）を Playwright（`tools/gpu_browser.mjs`）で開き、休めの姿勢・瞬きなしで顔に寄って 1280×720 で撮る（`window.viewer.face()`）。
2. **Grok で声付きの動画を作る**: `tools/grok_voice.py`。`grok --prompt-file <依頼文> --always-approve --output-format plain` を 1 回呼ぶ。依頼文は `reference_to_video` を 1 回だけ、引数は `first_frame`（顔の画像）、`voices: [<声>]`、`duration`（文の長さから 3〜8 秒）、`resolution_name: 480p`、`aspect_ratio: 16:9`、`prompt`（`<AUDIO_0>` がこの子で、日本語で「<text>」と一度だけ言う。カメラ固定、音楽なし、声だけ）。失敗しても再試行しない。動画は保管場所の作業フォルダ（`jobs/<jobId>/`）に保存。参考: `<skills>/grok-build-video/scripts/grok_video.py`（依頼文の決まり文句、エラーの見分け方）。
3. **音声を取り出す**: `ffmpeg -vn -ac 1 -ar 48000` で wav、配る用に mp3。
4. **声の区間を確かめる**: 音量から声の区間を求め、声がほとんど無い（合計 0.3 秒未満）なら失敗にする。
5. **セリフとして取り込む**: `lines/<lineId>/audio.mp3` と `line.json`（`text`、`reading`、`emotion`、`voice`、`source: {grokJob, video}`）。生成した動画も `lines/<lineId>/source.mp4` として残す。

## video ジョブ（動画の書き出し）

セリフだけの動画を作る前からのジョブ。画面の「撮る」は `shoot` ジョブを使うようになったので、画面からは積まない（API と、できた動画の一覧は残している）。

入力: `charId`、`verId`（省くと最新）、`lineId`、`framing`（`face` か `upper`、既定 `face`）。

1. `tools/lipsync.mjs`で、セリフの声の時刻を 1/30 秒ずつ進めて撮る（スマホ用でない元の VRM で、720×720）。
2. ffmpeg で音声と合わせて `lines/<lineId>/videos/<verId>-<framing>.mp4`（H.264、AAC）。
3. 結果の URL を返す。

## API

| 道 | 中身 |
|---|---|
| `PATCH /api/characters/<id>` | `{voice: "grok:eve"}` などで声の種類を変える（ほかに変えられる項目は `docs/characters.md`） |
| `DELETE /api/characters/<id>/lines/<lineId>` | セリフを消す（保管場所の `trash/` へ移す。完全には消さない。戻すと完全に消すは `docs/characters.md` の「ごみ箱」） |

`GET /api/characters/<id>` のセリフに、`reading` と、書き出した動画の一覧（`videos: [{verId, framing, url}]`）を足す。撮った動画は `shoots`（`shoot.json` の中身に `url` と `posterUrl`、新しい順）。

## サーバー側の実装メモ

- voice の入力: `charId`、`text`（必須、200 文字まで）、`reading`、`emotion`（happy / angry / sad / relaxed / surprised）、`verId`（省くとキャラの最新）、`lineId`（省くと `line-…` を自動採番。返したジョブの `input.lineId` で分かる）、`voice`（`grok:eve` か `{provider, id}`。省くとキャラの声。provider は grok だけ作れる）。結果は `{lineId, voicedSec, audioUrl, sourceUrl}`。
- video の入力: `charId`、`lineId`（必須）、`verId`、`framing`（face / upper、既定 face）。結果は `{lineId, verId, framing, url}`。同じ版・構図の動画があれば置き換える。
- `PATCH /api/characters/<id>` は更新後のキャラ詳細（`GET` と同じ形）を返す。`DELETE /api/characters/<id>/lines/<lineId>` は `{ok: true, trashed: "trash/…", item}` を返す。

## テスト

- 保管場所: `reading` の保存と既定、声の種類の変更、セリフを `trash/` へ移すこと（`test/trash.test.mjs` も）
- ジョブ: 積む・順番に 1 件ずつ動く・状態とログ・失敗の記録・再起動で `running` が `failed` になること（`CHARASTA_FAKE_GROK=1` と、撮影を省く試しの動き）
- API: 足した道の形と、`PATCH` で変えてはいけない項目を拒否すること

## 確かめ

- `CHARASTA_FAKE_GROK=1` でサーバーを動かし、画面（スマホの幅）からセリフを作る → ジョブが done → 一覧に出る → ビューアで口が動く → 動画にする → mp4 が再生できる。
