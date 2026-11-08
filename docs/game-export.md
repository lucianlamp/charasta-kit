# ゲーム用の書き出し

版の `model.vrm` から、Web のゲームに入れる軽い VRM と、その場で動く VRMA を作る。元の `model.vrm` と取り込んだモーションは変えない。

```bash
node scripts/game-export.mjs --char chara1 --ver v2-expressions --motions <モーション>,<モーション> [--target 20000] [--springs skirt=1.5,0.6,0.3] [--springs hair=2,0.5,0.1]
```

画面は、版の画面(`#model/<キャラ>/<版>`)の右の欄「ゲーム用に書き出す」。ジョブは `game-export`(`POST /api/jobs`、入力 `{type, charId, verId?, motions[], target, springs}`)。CLI は同じ `runGameExport` をサーバーなしで呼ぶ。GPU は使わない。外部コマンドは `python`(numpy と PIL)だけ。

## 処理の順

1. **primitive をまとめる**: `tools/vrm/merge_prims.py` を全メッシュにかける。材質、属性、モーフの並びが同じものだけが 1 個になる。
2. **三角形を減らす**: `tools/vrm/decimate.mjs`。単独でも `node tools/vrm/decimate.mjs in.vrm out.vrm --target 20000` で動く。
3. **揺れものを硬くする**: `{名前の一部: [硬さ, 抵抗, 重力]}`。名前に一部を含む(大小無視)spring の全 joint を絶対値で書き換える。既定は `skirt: [1.5, 0.6, 0.3]` だけ。髪は既定では変えない(値が決まっていない)。`--springs hair=...` か画面の欄で足せる。形はショートの `take.springs` に合わせた。
4. **meta を埋める**: 下の「meta」。
5. **画像を縮める**: `tools/make_lite.py --body 1024 --atlas 4096`。4096 を超える顔の絵は 4096 のまま。
6. **その場の VRMA**: 選んだモーションごと。下の「その場の VRMA」。

VRM 0.x(`extensions.VRM`)と生き物の版は `bad-input` で断る。同じ版で動いているジョブがあれば `busy`。存在しないモーションは `not-found`。

## 三角形を減らす方式

- 頂点は動かさない。index buffer だけを meshoptimizer(`vendor/meshopt_simplifier.module.js`、0.22.0、MIT。ライセンスは `vendor/meshoptimizer-LICENSE.txt`)の `simplifyWithAttributes` で作り直し、使われなくなった頂点を元の順番のまま詰める。POSITION、NORMAL、TEXCOORD、JOINTS、WEIGHTS と全モーフの差分は、残る頂点では元の値のまま。
- `LockBorder` を付ける。縁の頂点は動かず、primitive の境も縁なので primitive の間に隙間が開かない。UV の継ぎ目で分かれた頂点は meshoptimizer が位置で溶接して扱うので、継ぎ目も開かない(`test/game-export.test.mjs` の球で、溶接した縁の辺が 0 のまま)。
- 表情(`VRMC_vrm.expressions` の preset と custom)の `morphTargetBinds` が指すモーフで、差分が 0.1 mm を超える頂点は固定する。
- 減らさないもの: alphaMode が BLEND の primitive、2,000 三角形以下の MASK の primitive(顔の層、まつ毛、影の板)、1,000 三角形未満の primitive、三角形の index が無い primitive。2,000 三角形を超える MASK は減らす(VRoid の書き出しは体、髪、顔が全部 MASK で、守ると 1 本も減らないため)。alphaCutoff と画像は変えず、UV は simplify が見ながら減らす。
- 割り当て: 目標から守る分を引き、残りを減らす対象へ同じ割合で配る。割合の下限は 0.10。固定した頂点のせいで届かない primitive があれば、届いた primitive の割合を下げて 2 回目をやる。それでも目標(の 1.1 倍)に届かなければ止めずに `reached: false` と理由(`note`)を残す。

## meta

値の出どころは欄ごとに `export.json` の `steps.meta.sources` に残る。

| 順 | 出どころ |
|---|---|
| 1 | `character.json` の `vrmMeta`(ユーザーが入れた値) |
| 2 | 版の `model.vrm` の meta のうち、仮の値でないもの。仮の値は `__CHARAKIT_REVIEW__` を含む文字列、name `Motion review`、version `undefined` |
| 3 | `name` はキャラの name、`version` は版 ID(記録から) |
| 4 | 利用条件の欄が無いときは VRM 1.0 の既定値(`commercialUsage: personalNonProfit`、`allowRedistribution: false`、`modification: prohibited`、`avatarPermission: onlyAuthor`、`creditNotation: required`、`licenseUrl: https://vrm.dev/licenses/1.0/`)。最も制限の強い側 |

- 作者名は 1 と 2 にあるものだけを使う。無ければ作らずに `["未記入"]`(VRM 1.0 は authors を空にできない)を書き、`steps.meta.missing` に `authors` を入れる。画面に入力欄がある。
- 既定値を書いた欄は `steps.meta.defaulted` に載る。
- `allowRedistribution: false` の書き出しは止めない。Web のゲームに入れると VRM ファイルそのものが配信されるので、`warnings` と画面で知らせる。配ってよいかはユーザーが決める。
- `vrmMeta` の欄は `authors`(文字列の配列、8 人まで)、`commercialUsage`、`allowRedistribution`、`modification`、`avatarPermission`、`creditNotation`、`licenseUrl` だけ。`PATCH /api/characters/<id>` の本文 `{vrmMeta: {...}}` で丸ごと置き換え、`null` か空で消す。型が違うか、仮の値を入れると `bad-input`。

## その場の VRMA

`VRMC_vrm_animation` の hips の節点にかかる translation のチャンネルだけを書き換える。hips の親の静止の world 行列(節点の TRS から求める)で world に直し、各キーの x と z を先頭キーの値にそろえ、y はそのまま残して親の空間へ戻す。回転のチャンネルと、ほかのバイト列は変えない。

- 飛ばすもの(理由を `motions[].skipped` に書く): hips の親が動くクリップ、translation のチャンネルが無いクリップ、CUBICSPLINE の translation、float の VEC3 ではない translation。
- 記録するもの: `removedTravel`(消した水平の道のり、m)、`startToEnd`(始点から終点までの水平の差、m。ゲームで移動速度を合わせる)、`vertical`(上下の幅、m。前後で同じ)、`durationSec`。
- 先頭キーへそろえる方式だけ。一定の速さで進む分だけを引いて横の揺れを残す方式は入れていない。
- 保管場所のモーションとしては取り込まない。`motion.json` の `license` を `motions[].license` に写し、`redistribution: false` と `evaluationOnly` は `warnings` と画面の札で知らせる。

## 保管場所の形

```
characters/<charId>/versions/<verId>/game/<exportId>/
  model-game.vrm
  export.json
  motions/<motionId>.vrma
```

- `exportId` は `g20261107-153000`(UTC の日時)。毎回新しいフォルダを作り、前の書き出しは上書きしない。同じ秒のものがあれば次の秒にする。
- 版をごみ箱へ移すと `game/` も一緒に移る。
- 書き出し中は `export.json` に `status: "running"` と `pid` だけが入り、一覧に出る。終わると完全な記録(`status: "done"`)に置き換わる。サーバの停止などで running のまま残ったフォルダは、次の書き出しの開始時に(書いた pid がもう居なければ)消える。
- 積んだあとに消されたモーションは、その 1 本だけ `skipped` に理由を付けて飛ばし、書き出し全体は続ける。
- `export.json`: `{exportId, charId, verId, sourceSha256, createdAt, jobId, options, steps, checks, measure, motions, warnings}`。
  - `steps.merge`: primitive の前後。`steps.decimate`: primitive ごとの前後、割合、固定した頂点の数、守る理由、`reached`、`note`。`steps.springs`: 指定ごとの spring の名前と前後の値。`steps.meta`: `values`、`sources`、`missing`、`defaulted`。`steps.textures`: 画像の前後の MB(圧縮したまま)。
  - `checks`: 表情の数と揺れものの joint の数が元と同じか。
  - `measure.before` / `measure.after`: 三角形、メッシュ、primitive、材質、MToon の輪郭のある材質、表情、揺れものの joint、バイト数。

`GET /api/characters/<c>/versions/<v>/game-exports` が各 `export.json` に `modelUrl` と、各モーションの `url` を足して新しい順に返す。ファイルは `/lib/` から読む。

## この版に入れていないもの

材質を 1 枚の atlas にまとめること、MToon の輪郭を消すこと、髪の揺れものの既定値、横の揺れを残すその場の方式、その場の VRMA を保管場所のモーションとして取り込むこと、読み込む側（ゲーム）の変更。
