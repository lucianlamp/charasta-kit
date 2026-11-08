# 生き物(人以外のキャラ)

カラスのような人以外も、キャラの一覧で管理する。スタイルの 3 つ目「生き物」(id `creature`)。スタンダードとチビは VRM、生き物は Blender のファイル(骨と動き)。

## データ
- character.json の `style` に `creature` を足す(`standard` / `chibi` / `creature`)。
- 生き物の版(`versions/<verId>/`):
  - `model.blend`: 骨(Armature)と動き(Action)を持つ Blender のファイル。取り込んだファイルは変えない(ADR 0002)。sha256 を version.json に記録。
  - `creature.json`: stage-studio の `lib/creature.py` の spec のうち、生き物そのものの値だけ。`rest`、`clips`、`fly`(どれも [Action の名前, 始めのコマ, 終わりのコマ])、`scale`、`drop`、`fps`、`yaw`(既定の向き)。撮る場面ごとの値(`perch`、`path`、`flight`、`events`)は入れない。
  - `thumb.png`: Blender で撮ったサムネイル(rest の姿勢、512x512)。
  - version.json は今の形に `kind: "creature"` を足す。model.vrm と model-lite.vrm は作らない。
- 取り込み: `node scripts/import-creature.mjs --char <id> --id <verId> --label "..." --src <blend> --spec <creature.json> [--latest]`。spec の Action の名前が blend に無ければ止める(Blender で確かめる)。サムネイルも撮る。
- キャラの作成: `new-character.mjs --style creature` と `POST /api/characters {style: "creature"}`。

## ショートから使う
- `take.creature` は今の書き方(`blend` のパスと全部の値)をそのまま受ける。
- 新しい書き方: `{"charId": "crow", "verId"?: "...", "perch", "yaw"?, "path", "flight"?}`。サーバーが版の `model.blend` のパスと `creature.json` の値を入れて stage-studio へ渡す(場面ごとの値が優先)。stage-studio は変えない。
- 生き物を使うショートは、そのキャラの「出演した動画」に出る(appearances に take.creature.charId も数える)。

## 画面

`#model/<キャラ>[/<版>]` で、キャラが生き物のときは `public/creature.mjs` を出す。3D のビューアは載せない(`/viewer` は VRM だけ)。

- 上にプロフィール(名前、スタイル、タグ、メモ、出演した動画)。声は使わないので出さない。出演した動画は `take.creature.charId` でこのキャラを使うショートも含む(サーバーが数える)。
- 左にサムネイルを大きく(暗い地に、切らずに収める)。スマホでは 1 列にし、幅 360px まで。
- 右に「版（N）」の一覧(版 ID、最新の札、ラベル、取り込んだ日)。押すとその版を選ぶ(`#model/<キャラ>/<版>`)。選んだ版の Blender のファイル(`blend`)のダウンロード。版が無ければ、取り込むコマンドの形を出す。
- 「動き（<版>）」の表: 止まる(rest)、羽ばたく(fly)、clips の各動きを、動き / Action / 始め / 終わり の列で。表の下に「コマは 24 fps・scale 0.4・yaw 0」のように fps と値。
- 「ショートで使う」: short.json の `take.creature` にキャラ ID で書くことと見本 `"creature": {"charId": "<キャラ>", "perch": 0, "path": [[0,0,0],[1,0.5,0],[2,1,0]]}`。`verId` を省くと最新の版、上書きできる値、カットの `creature`(tilt、down、stare、takeoff)が使う動き。
- 上部バー: 4 工程のタブを出さず、「完成モデル」のリンクは「キャラのページ」にする。キャラの切り替えの欄から生き物を選ぶと、今の工程に関わらず `#model/<キャラ>` へ移る(`stageHref` が生き物の工程の先を `#model` にする)。スマホの欄の「工程」も出さない。
- スマホの下のナビ: 生き物のときは ライブラリ、キャラ、動画 の 3 つ(動きと表情を出さない)。
- 生き物は、ショートの出演者の選択、ショートの下書き、見本のショート、動画ギャラリーの「ダンス MV を作る」、`/viewer` のキャラの選択に出さない(`vrmChars`。サーバーも VRM が前提の入口で断る)。

## 実装で決めたこと
- 取り込みの順: creature.json の形 → Blender の背景で blend の Action を列挙(`tools/creature_actions.py`)→ 名前の照合 → コピー → サムネイル(`tools/creature_thumb.py`)。名前が無ければ何も作らず、終了コード 1 で止まる。spec のコマが Action の範囲の外のときは注意を出すだけで止めない(Action の外のコマは最後の値を保つ)。
- creature.json に必須なのは `rest`、`scale`、`yaw`、`fps`(stage-studio の `lib/creature.py` が必ず読む値)。`drop` と `clips`、`fly` は任意。`perch`、`path`、`flight`、`events`、`blend` と知らない項目は入れると断る。`clips` の名前は英数字と `_` `-` の 1〜32 文字。
- サムネイル: rest の姿勢のコマを、前から左へ 38 度、少し上から、50mm、Cycles の GPU(OPTIX、無ければ CUDA、無ければ CPU)で描く。主光、補助光、逆光の 3 灯(太陽光)。背景は透明の PNG。Armature の子か Armature で変形するメッシュだけを描き、blend の中のカメラと灯りは使わない。撮れなかったときは版を残し、`thumbError` を返す(CLI は理由を出す)。
- 生き物のキャラは VRM の版を取り込めず(`importVersion`、きゃらくるからの取り込み、表情づくりの「版にする」)、生き物の版は生き物のキャラにしか取り込めない。版があるキャラは `creature` とそれ以外のあいだで `style` を変えられない。
- VRM が前提の入口は生き物のキャラを `bad-input` で断る: 撮影と MV と声のジョブ(`POST /api/jobs` の `shoot` / `mv` / `video-motion` ほか charId を取るもの)、`face-check` と `GET .../versions/<ver>/face`、表情づくりの作成、ショートの出演者(`cast`、`charId`)、`tools/` のビューアで撮る道具(`viewerUrl`)。
- `take.creature` の新しい書き方は保存の前に確かめる: `charId` が `style: creature` のキャラ、`verId`(省くと最新)が生き物の版、`perch`(0 以上の整数)、`path`(`[x, y, z]` を 3 つ)。ほかに上書きできるのは `yaw`、`flight`、`scale`、`drop`。保存するのは参照のままで、撮るときに解く(blend を取り込み直した版が使われる)。解いた spec の `blend` は版の `model.blend` の絶対パス。コマの ID には版の sha256 を混ぜる。前からの書き方(`blend` を持つ)を使うショートの ID は変わらない。
- カットの `creature`(`tilt`、`down`、`stare`、`takeoff`)が使う動きが spec に無ければ撮る前に断る。`takeoff` は `clips.caw` と `fly` を使う。
- API の形は `docs/characters.md`。画面は、`GET /api/overview` の `chars[].kind`(`creature` か `vrm`)、`chars[].creature.clipNames`、`chars[].thumb` を使う。
- 外部の画像: 取り込みは blend を `versions/<verId>/model.blend` へコピーするので、相対パスの外部画像(パックされていない画像)は見つからなくなる。`tools/creature_actions.py` がパックされていない外部の画像を `externalImages` に列挙し、取り込みは注意に出す(止めない)。サムネイルもコピーした `model.blend` から描くので、撮るときと同じ見た目になる。先に Blender で「全てをパック」してから取り込む。
- ごみ箱: 生き物のキャラと版は、`take.creature`(と `cast[]`)で参照するショートのジョブが順番待ちか実行中のあいだは移せない。影響の一覧に、参照するショートの件数(`shorts`)が出る。
