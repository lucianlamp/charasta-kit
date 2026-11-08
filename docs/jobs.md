# ジョブ

時間のかかる、判断の要らない処理は、ボタンで積むジョブとしてサーバーが 1 件ずつ動かす（`CONTEXT.md` の「ジョブ」）。画面では上部バーのジョブの引き出しに出る（`docs/screens.md`）。

## 動き方

- 状態: `queued` → `running` → `done` / `failed`。進み具合の文（`step`）と、終わったら結果（作ったセリフや動画の URL）か、エラーの文。
- 保管場所の `jobs/<jobId>.json` に書く（サーバーを再起動しても一覧が残る。`running` のまま止まったものは、起動時に `failed`「サーバーが止まった」にする）。
- 一度に動くのは 1 件。ログは `jobs/<jobId>.log`。
- 再起動で `queued` のまま残ったジョブも `failed`「サーバーが止まった」にする（再開しない）。

## 形と API

- ジョブ: `{id, type, state, step, input, result, error, createdAt, startedAt, finishedAt}`。`POST /api/jobs` は 201 で積んだ時点のジョブを返す。`GET /api/jobs/<id>` だけ、ログの末尾 4000 文字 `logTail` を足す。入力の誤りは 400 / 404、同じ `lineId` が既にある（作成済み、または順番待ち中）と 409。

| 道 | 中身 |
|---|---|
| `POST /api/jobs` | `{type, ...入力}` でジョブを積む。返すのはジョブ |
| `GET /api/jobs` | 新しい順のジョブの一覧（最大 50） |
| `GET /api/jobs/<id>` | 1 件 |

## ジョブの種類

`POST /api/jobs` の `type`（`lib/jobs.mjs` の `JOB_TYPES`）。

| `type` | 中身 | 文書 |
|---|---|---|
| `voice` | 声を作ってセリフにする | `docs/voice-and-lines.md` |
| `video` | セリフの口の動きを動画にする（画面からは積まない） | `docs/voice-and-lines.md` |
| `shoot` | 完成モデルの動画を撮る | `docs/shoot.md` |
| `mv` | 前からの MV。画面からは MV の試しの「本番で書き出す」だけが積む | `docs/shorts-dance-mv.md` |
| `short` | ショートを書き出す（ダンス MV、グラフィック MV も） | `docs/shorts.md` |
| `short-draft` | ショートの下書きを作る | `docs/shorts-draft.md` |
| `short-figures` | ショートの図を作る | `docs/shorts.md` |
| `motion-gen` | MotionBricks でモーションを作る | `docs/motionbricks.md` |
| `motion-text` | 文章からモーションを作る | `docs/motion-text.md` |
| `video-motion` | 動画からモーションを作る | `docs/video-to-vrma.md` |
| `motion-recipe` | 区間をつないだモーションを作る | `docs/motion-compose.md` |
| `studio-front`、`studio-build`、`studio-video`、`studio-checks` | 表情づくりの工程 | `docs/expression-studio.md` |
| `face-check` | シェイプキー方式の版の確かめの撮影 | `docs/expression-studio.md` |
| `game-export` | ゲーム用の書き出し | `docs/game-export.md` |

## 試しの動き

- 試しの動き（環境変数、またはサーバー設定の `env`）: `CHARASTA_FAKE_GROK=1`（`silent` は無音、`fail` は失敗）、`CHARASTA_FAKE_CAPTURE=1`（`shoot` の `hang` は撮影が終わらない）、`CHARASTA_SHOOT_TIMEOUT_MS`（`shoot` の時間の上限を決め打ちにする）。設定ファイルの差し替えは `CHARASTA_CONFIG`。

ほかの道具の試しの動き（`CHARASTA_FAKE_*`）は、それぞれの文書の「試しの動き」にある。
