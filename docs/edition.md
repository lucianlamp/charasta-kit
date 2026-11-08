# 版の種類（edition）

きゃらすたには 2 つの版の種類がある。

- `full`: 作者の版。既定。すべての機能を使う。
- `kit`: 配るキット。キャラを作って動かし、対話型のショートとダンス MV を作るまでに絞った、簡単なスタジオ。

## 決め方

`lib/config.mjs` の `loadConfig` が次の順に読み、最初に見つかった値を使う。どれも無ければ `full`。

1. 環境変数 `CHARASTA_EDITION`（テスト用）
2. `config.json` の `edition`
3. root の `edition.json` の `edition`。キットの root には `{"edition":"kit"}` がある

`full` と `kit` のほかの値は起動のときに止める。`GET /api/overview` は `edition` と `labels`（画面の名前、`public/edition.mjs`）を返す。`GET /api/capabilities` も `edition` を持つ。

## キットに残す機能

- キャラと版、ビューア（動きと表情の確かめ）、スタイル。スタイルの ID は `standard` と `chibi` のままで、名前だけを「スタンダード体型」「チビ体型」にする。
- キャラの作り方は きゃらくる（Tripo Studio）だけ。`method` に `tripo` 以外を書くと、作るときも直すときも 400 で断る。
- 表情づくり、生き物、撮る、ステージの描画、声（VOICEVOX、ElevenLabs）。
- モーション: VRMA の取り込み、動画から作る（MediaPipe の vrma-pipeline だけ）、MotionBricks（`motionbricksDir` の設定があるときだけ。無ければ理由を出して隠す。作者の版と同じ）。動きの画面の「つくる」は区間をつなぐ（モーションをつなぐ、`motion-recipe`）。区間の種類は保管場所のモーション、動画から、MotionBricks の条件の 3 つ（確認待ちの結果を区間にもできる）。
- ショート: 対話型とダンス MV の 2 つ。

### モーションをつなぐ

`docs/motion-compose.md` の「画面からつなぐ」を、作者の版と同じに使える。キットでの決まりは次のとおり。

- 区間の間のつなぎは MotionBricks か補間。MotionBricks の設定（`motionbricksDir`）が無いときは、補間だけで動く。画面は MotionBricks の条件の区間を出さず、つなぎの「MotionBricks で作る」を選べなくして理由（`motionbricksDir` の設定）を出し、つなぎの既定を補間にする。サーバーは、つなぎの方法を書かないレシピのつなぎを補間にし、MotionBricks の条件の区間か MotionBricks のつなぎ（0 秒でないもの）を含むレシピを 400 で断る。

### 対話型

出演者どうしの会話のショート。シーンはシーンの一覧のどれでもよく、カメラもカットごとに選ぶ（立って話すショートと同じ仕組み）。歩く 1 テイク（`take`）も使える。

対話型の中身は型 `drama` のショートで、名前だけを「対話型」にする。新しい型を足さないので、作者の版の型の一覧と書き出しは変わらない。演出は `drama` のまま（落ち着いた転換と字幕、型の既定の BGM）。キットのサーバーは、ショートを作るときと保存するときに型が `drama` か `dance` かを確かめ、型を書かなければ `drama` にする。ほかの型は 400 で断る。

## キットで外す機能

画面から隠し、サーバーも 400（`code: bad-input`）で断る。`GET /api/capabilities` では `available: false`、`setting: 'edition'`、`note: '配布版には無い機能'` にする。
