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

- キャラとバージョン、ビューア（動きと表情の確かめ）、スタイル。スタイルの ID は `standard` と `chibi` のままで、名前だけを「スタンダード体型」「チビ体型」にする。
- キャラの作り方は きゃらくる（Tripo Studio）だけ。`method` に `tripo` 以外を書くと、作るときも直すときも 400 で断る。
- 表情づくり、撮る、ステージの描画とステージの画面（`docs/screens.md` の「ステージ」）とステージの依頼（`docs/stages.md`）、声（VOICEVOX、ElevenLabs）。
- モーション: VRMA の取り込み、動画から作る（MediaPipe の vrma-pipeline だけ）、MotionBricks（`motionbricksDir` の設定があるときだけ。無ければ理由を出して隠す。作者の版と同じ）。モーションを作る画面（モーションの画面の「新しく作る」）は区間をつなぐ（モーションをつなぐ、`motion-recipe`）。区間の種類は保管場所のモーション、動画から、MotionBricks の条件の 3 つ（確認待ちの結果を区間にもできる）。
- ショート: 対話型とダンス MV の 2 つ。

### モーションをつなぐ

`docs/motion-compose.md` の「画面からつなぐ」を、作者の版と同じに使える。キットでの決まりは次のとおり。

- 区間の間のつなぎは MotionBricks か補間。MotionBricks の設定（`motionbricksDir`）が無いときは、補間だけで動く。画面は MotionBricks の条件の区間を出さず、つなぎの「MotionBricks で作る」を選べなくして理由（`motionbricksDir` の設定）を出し、つなぎの既定を補間にする。サーバーは、つなぎの方法を書かないレシピのつなぎを補間にし、MotionBricks の条件の区間か MotionBricks のつなぎ（0 秒でないもの）を含むレシピを 400 で断る。

### 対話型

出演者どうしの会話のショート。ステージはステージの一覧のどれでもよく、カメラもカットごとに選ぶ（立って話すショートと同じ仕組み）。歩く 1 テイク（`take`）も使える。

対話型の中身は型 `drama` のショートで、名前だけを「対話型」にする。型の名前の表（`public/edition.mjs` の `shortStyles`）は、キットでもフル版の名前（雑学、派手、ニュース）に対話型とダンス MV の名前を重ねるので、保管場所に残るフル版の型のショートも内部名（`trivia` など）でなく名前で出る。新しい型を足さないので、作者の版の型の一覧と書き出しは変わらない。演出は `drama` のまま（落ち着いた転換と字幕、型の既定の BGM）。キットのサーバーは、ショートを作るときと保存するときに型が `drama` か `dance` かを確かめ、型を書かなければ `drama` にする。ほかの型は 400 で断る。

## キットで外す機能

画面から隠し、サーバーも 400（`code: bad-input`）で断る。`GET /api/capabilities` では `available: false`、`setting: 'edition'`、`note: '配布版には無い機能'` にする。

生き物（人以外のキャラ、スタイル `creature`）はキットに無い。作るときも直すときも、ショートで使うときも 400 で断る。

## エージェントの手引き

キットは、画面の依頼（`docs/stages.md`、`docs/adjust.md`、`docs/expression-studio.md`、`docs/shorts.md` の依頼）と取り込みを、Codex でも Claude Code でも進められるようにする。形はきゃらくるのキットにそろえ、root の `AGENTS.md` を共通の入口にし、作業ごとの手順を `skills/<名前>/SKILL.md` に置く。

| キットの場所 | 中身 | 読むエージェント |
| --- | --- | --- |
| `AGENTS.md` | 利用者とエージェントの分担、守ること（バージョンを上書きしない、聞かずに消さない、権利を推測しない、利用条件）、保管場所と起動、依頼の進め方、Skill の一覧 | Codex は root の `AGENTS.md` を読む。ほかのエージェントにも同じ文を読ませる |
| `CLAUDE.md` | `@AGENTS.md` の読み込みと 1 行の案内だけ | Claude Code |
| `skills/charasta-requests/SKILL.md` | 依頼 4 種類（ショートの直し、新しいステージ、体型と揺れもの、表情づくりの絵）の読み方、片付け方、見送り方 | `AGENTS.md` が場所で指す |
| `skills/charasta-import/SKILL.md` | キャラ、バージョン、モーション、セリフの取り込みとサムネイル | 同上 |
| `.agents/skills/` | `skills/` と同じ中身の写し | Codex が作業の場所から探す Skill の置き場 |
| `.claude/skills/` | `skills/` と同じ中身の写し | Claude Code が作業の場所から探す Skill の置き場 |

- 手引きと Skill は、どちらか片方のエージェントだけの道具の名前を書かず、コマンドとファイルで手順を書く。画像の生成は「画像を生成する機能」と書き、使えないエージェントなら作り始める前に利用者に伝える。
- 画面の依頼のボタンと説明の呼び方は、作者の版は「Claude」、キットは「エージェント」(public/edition.mjs の agent)。キットは Codex でも Claude Code でも使うため。
- キットに残す機能は、エージェントの CLI（`claude` など）を自分では呼ばない。依頼は、利用者が開いたエージェントが CLI で読んで片付ける。
