# きゃらすたの文書

機能ごとの仕様。利用者と開発者が読む。用語は `CONTEXT.md`、起動と設定は `README.md`。

## キャラと画面

| 文書 | 中身 |
|---|---|
| `characters.md` | キャラと版、保管場所の形、`character.json` と `version.json`、サーバーの API、ごみ箱、取り込みの CLI |
| `character-style.md` | キャラのスタイル（スタンダード体型、チビ体型）、スタイルの画面、版の検査 |
| `creature.md` | 生き物（Blender の骨と動きのキャラ）の版、取り込み、ショートから使う書き方、生き物のページ |
| `edition.md` | 版の種類（作者の版 full と配るキット kit）、キットで外した機能、決め方 |
| `screens.md` | 画面の全体（ファイル、URL、ジョブの引き出し、ビューア、4 工程の進み具合、完成モデルとプロフィール、デザインと違えた所、削除とごみ箱） |
| `jobs.md` | ジョブの動き方、形と API、ジョブの種類と、それぞれの文書 |

## 撮ると声

| 文書 | 中身 |
|---|---|
| `shoot.md` | 完成モデルの動画を撮る（撮るの欄、利用条件の札、`shoot` ジョブ、カメラ） |
| `voice-and-lines.md` | セリフと声の種類、`line.json`、声を作る `voice` ジョブ、口の動きの `video` ジョブ |

## モーション

| 文書 | 中身 |
|---|---|
| `motions.md` | モーションの記録 `motion.json`、VRMA の取り込み、作り方ごとの文書の一覧 |
| `motionbricks.md` | MotionBricks の条件から作る（`motion-gen`）、選べる条件、SOMA からの移し替え |
| `video-to-vrma.md` | 動画から作る（MediaPipe、`video-motion`）、仕上げ、手の直し |
| `motion-compose.md` | 区間をつなぐ（`tools/compose`、画面からの `motion-recipe`）、FBX の移し替え、両手の握り、武器、首、指 |
| `foot-ik.md` | 再生のときに接地中の足を床に留める IK |

## 表情

| 文書 | 中身 |
|---|---|
| `expression-studio.md` | 表情の方式の使い分け、表情づくり（顔テクスチャ方式）の工程・依頼・候補、シェイプキー方式の版の確認 |
| `face-atlas.md` | 顔テクスチャ方式の表情の作り方（顔の絵、区画、視線、動画からの中割り、リップシンク） |
| `vroid-format.md` | Tripo Studio で作ったキャラを VRoid と同じ中身にそろえる変換と検査、きゃらくるの表情を `Fcl_` の 57 キーへ移す |
| `vroid-face.md` | 自前の部品で VRoid 形式の顔を作る（予備の方法） |

## ショート

| 文書 | 中身 |
|---|---|
| `shorts.md` | ショート（対話型）の編集画面、`short` ジョブ、歩く 1 テイク、声の提供元、2 人の描画、timeline と自動演出、合成、図 |
| `shorts-dance-mv.md` | ダンス MV（型 `dance`）、拍から割る、演出 `music.look`、前からの `mv` ジョブ |
| `shorts-graphic-mv.md` | グラフィック MV（`music.look = graphic`）、切り抜いた踊る人と大きな文字 |

## VRM の手直し

| 文書 | 中身 |
|---|---|
| `vrm-edits.md` | VRM の glTF を直接書き換える道具（首の長さ、primitive をまとめる、UV の余白） |

## `adr/`

- `adr/`: 設計の決めごとの記録（ADR）。決めた理由と、考えた別の案を残す。
