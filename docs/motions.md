# モーションの記録と取り込み

用語は `CONTEXT.md` の「モーションとセリフ」。モーションは VRMA ファイル 1 つで、全キャラ共通。保管場所の `motions/<motionId>/` に `motion.vrma` と `motion.json` を置き、取り込んだファイルは変えない（ADR 0002）。モーションはきゃらすたの外へ書き出さない。

作り方ごとの文書:

- VRMA のファイルを取り込む: このページ
- MotionBricks の条件から作る: `docs/motionbricks.md`
- 文章から作る（Kimodo）: `docs/motion-text.md`
- 動画から作る: `docs/video-to-vrma.md`
- 区間をつなぐ（compose）: `docs/motion-compose.md`
- 再生のときに接地中の足を床に留める: `docs/foot-ik.md`

## motion.json

```json
{ "id": "vrma-02", "name": "VRMA_02", "label": "挨拶",
  "source": { "path": "元の場所", "pack": "VRoid Project VRMA Motion Pack" },
  "license": { "holder": "ピクシブ株式会社", "summary": "改変可。取り出せる状態での二次配布は禁止", "redistribution": false },
  "durationSec": 0, "bones": ["hips", "spine", "..."], "usesShoulder": true,
  "expressions": [ { "from": 0.1, "to": 0.4, "expression": "happy" } ],
  "sha256": "...", "importedAt": "ISO" }
```

- `license.evaluationOnly`（省くと false）: true なら、評価・テストの目的だけで使える（動画にして公開するのも不可）。`redistribution` は「取り出せる状態での二次配布」だけを指すので、動画への利用が許されるかはこの項目で分ける。MotionBricks で作ったモーションが true（見本の動きの NVIDIA Sample Data Evaluation License による）。ギャラリーに「評価用のみ」の札を出し、`tools/record.mjs` はそのモーションで撮るときに警告する。取り込み済みの `motion.json` は書き換えない（ADR 0002）ので、この項目を持たない MotionBricks 製のモーションは、`terms` に見本の動きの許諾があることから、API が読むときに true を補う。
- `generated`（省略可）: 作ったときの記録。MotionBricks（`docs/motionbricks.md`）か、動画から作ったモーション（`tool` が `vrma-pipeline`、`docs/video-to-vrma.md`）か、文章から作ったモーション（`tool` が `Kimodo`、`docs/motion-text.md`。原文、英語の説明文、seed、区間を持つ。見本の動きを使わないので `evaluationOnly` は付かない）。保管場所のモーションをつないだモーション（`tool` が `motion-compose`、`docs/motion-compose.md`。画面から作ったものは `recipe` と `report` も持つ）。
- `fittedTo`（省略可）: 体を合わせたキャラの版 `{charId, charName, verId}`。動画から作ったモーションに付く。画面に出す。
- `contacts`（省略可）: 足の接地の横の情報のファイル名（`contacts.json`）。MotionBricks で作ったモーションに付く。一覧の API は `contactsUrl` を足す。`docs/foot-ik.md`。
- `durationSec` と `bones` は、取り込むときに VRMA（glTF）を読んで求める（アニメーションの入力の最大時刻、`VRMC_vrm_animation` の humanBones のうち、チャンネルの対象になっているもの）。
- `expressions` は今のビューアの `motions.json` の時刻表を写す（`from`・`to` は長さに対する割合 0〜1）。

## 取り込み

- 画面: 動きの画面の「モーションを足す」の「ファイル」。ファイルを落とすか選ぶと `POST /api/motions` で取り込む。取り込むときに利用条件の欄（権利者、要約、二次配布の可否）を入れる。「書き出す」ボタンは付けない。
- API: `POST /api/motions`（本文は VRMA そのもの、ヘッダ `x-filename`（元の名前）と `x-license`（JSON: holder、summary、redistribution））。一覧は `GET /api/motions`。消すのは `DELETE /api/motions/<id>` で、ごみ箱へ移す（`docs/characters.md` の「ごみ箱」）。
- CLI: `node scripts/import-motion.mjs --id vrma-02 --label 挨拶 --src <path.vrma> --license-json <file> [--expressions-json <file>]`。同じ ID が既にあれば止まる。

## 利用条件の札

モーションの札と、動画にしたときの扱いは `lib/terms.mjs` の 1 か所で決める。判定の表は `docs/shoot.md` の「画面」。
