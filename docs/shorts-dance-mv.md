# ダンス MV（ショートの型 dance）

完成モデルを Blender のシーンで踊らせ、拍に合わせたカット割りの縦動画にする。ショートの型 `dance`（表示名「ダンス MV」）で、編集画面と `short` ジョブはほかの型と同じものを使う（`docs/shorts.md`）。動画の種類は 1 つのカット表の上の「型」として並べる（雑学、2 人のドラマ、歩きながら話す、ダンス MV、1 カットの確かめ）。グラフィックの演出は `docs/shorts-graphic-mv.md`。

## 作る入口

前の「MV を撮る」画面(`public/mv.mjs`)は、ショートの型 `dance` へ移して消した。完成モデルの右の欄と動画ギャラリーの「ダンス MV を作る」は `#mv/<キャラ>/<版>` を開く。

- `#mv/<キャラ>[/<版>]` は `POST /api/dance-shorts`(`{charId, verId, title: "<名前> のダンス MV"}`)でショートを作り、`location.replace` で `#short/<ID>` へ移る。待つ間は「ダンス MV のショートを作っている…」、失敗すると理由と完成モデルへ戻るリンクを出す。
- 送る前に URL を `#shorts` に置き換える(`history.replaceState`)ので、送っている途中で読み直しても 2 本目はできない。送っている間にもう一度開いても同じ送信を待つ。`#short/<ID>` へは置き換えで移るので、戻るで `#mv` に戻って作り直すこともない。
- 動きは渡さないので、できたショートはカットが空。編集画面の「曲とシーン」で動きとシーンを選んで「拍から割る」を押す。
- 前に書き出した MV(`kind: 'mv'`)はギャラリーと完成モデルに残り、MV の試しのカードの「本番で書き出す」は `mv` ジョブの `previewOf` で同じカット割りの本番を積む。

## データと描画

決めた経緯は `docs/notes/shorts-dance-mv.md`。コードは `lib/dance.mjs`、`tools/dance_plan.py`、`lib/short.mjs` の `runShort`（`short.style === 'dance'` の分岐）。

- `short.json` の `music`: `{bpm, seed, beatsPerShot, shotsPerScene, audioStart, motionId?, stages?}`。範囲は MV と同じ（bpm 40〜240、seed 0〜9999、beatsPerShot 4 / 8 / 16、shotsPerScene 1 / 2、audioStart は 0 以上の秒）。`dance` 以外では保存しない。動きは `music.motionId` の 1 つで、保存するとき全カットの `motionId` に写す（カットの `motionId` は省ける。`music.motionId` が無ければ最初のカットのものを使う）。出演者は `cast[0]` の 1 人。曲は `short.audioId`（`audioStart` 秒から使う）。`stages` は拍から割ったときに選んだシーンの並びで、描画には使わず（カット表のシーンを使う）、画面が選び直すために残す。
- カットは今の形（`stage`、`camera`、`seconds`、`telop`、`transition`）に、`angle`（stage-studio の `shots.plan` の `a`）と `shot: {dir: 1 か -1, seed: 0〜99999}`（`plan` の `dir`、`seed`）を足す。`camera` は `lib/shots.py` の FLOW にある `wide_push`、`orbit`、`close`、`low_feet`、`crane_up`、`side_track`、`crane_down`、`high_top` だけで、ほかの型のカットはこの 5 つ（`close`、`crane_up`、`crane_down`、`side_track`、`high_top`）を選べない。`seconds` は必須で、セリフ（`text`）は空に固定する。カットの秒の合計は 180 秒まで。
- **拍から割る**: `lib/dance.mjs` の `danceSplit`。曲があれば `tools/beats.py`（`--start audioStart --seconds 長さ+5`）の拍、無ければ `bpm` から、`tools/dance_plan.py` が stage-studio の `lib/shots.py` の `plan(beats, seconds, seed, bps, bps)` と `assign_stages(..., stages, shotsPerScene)` をそのまま呼んで割る。乱数は Python の `random` なので JS へ移さない。結果をカットにして `short.json` へ保存する。描くときに拍は求め直さない（画面と本番の秒を一致させる）。
- ジョブ（`runShort`）は声の工程を飛ばす。`python tools/make_mv.py ... --frames-only` を `mv` ジョブと同じ引数で呼ぶ（`--seconds` はカットの秒の合計、`--stage` はカット表に出たシーンを出た順に並べたもの）。作業は `work/<quality>/mv-<条件のハッシュ>/`。コマが揃っていれば Blender を起動しない。
- 描いたあと、`shots.json` の時刻・シーン・カメラ・角度をカット表と照らし、0.02 秒を超えてずれたら失敗にする（`checkShots`）。カットごとのコマの数は `shots.json` の時刻から `camera_at` と同じ規則で数え（`ownedFrames`）、`work/<quality>/<カットの id>/frames/` へハードリンクで分ける。カットの id は条件のハッシュ + 番号で、テロップなど絵に関わらない直しでは変わらない。以降の合成（`buildBase`、`buildMix`、HyperFrames）は他の型と同じ。
- stage-studio の `make_mv.py` が `--shots-in` を受けるなら（ファイルに文字列があるかで判定）、カット表から作った shots を渡す。カメラやシーンを手で直したカットもそのまま描ける。受けない今の stage-studio では、手で直した分は照合で失敗になり、「拍から割り直す」と案内する。
- 音: 曲を `audioStart` から使い、使う区間の積分ラウドネスが約 -14 LUFS になる音量にする（`DANCE_LUFS`）。語りがないのでサイドチェインはなし。効果音は鳴らさない（型の `sfxGain` が 0）。曲が無ければ無音。
- 記録（`kind: 'short'`）の `short` に `style: 'dance'` と `music` を足し、`audio.start` は `audioStart`。
- 型 `dance` の定義: 転換 none(シーンが変わっても黒を挟まない `hardCut`)、calm、reactive なし、kenburns 0、字幕 none、hook なし、既定の BGM なし、効果音 0(`sfxGain` 0 は効果音の合図を作らない)。
- 作業フォルダ `work/<quality>/mv-<ハッシュ>/` は、描画に効く条件(モデル、動き、シーンのコード、カット表の stage / camera / angle / shot / seconds、music、曲、画質)が変わると新しくなる。1 カットだけ直しても全カットを描き直す(未対応の最適化)。テロップ、転換、曲の音量などは条件に入らず、描き直さない。

## 演出（music.look）

- `music.look` は `anime`（既定）、`cel`、`plain` のどれか（`graphic` は `docs/shorts-graphic-mv.md`）。`anime` は stage-studio の `make_mv.py --look anime` を渡す: キャラのトゥーン、輪郭の光、顔の光、霞、被写界深度、ブルーム、顔を正面寄りに寄りで撮るカメラ、スカートの中を映さないカメラ。カットの種類と時間（shots.json）は変えず、各カットの距離・レンズ・角度・高さだけを変える。
- `plain` は前の見た目。`look` を持たない前のショートは `plain` のまま（保存しても `anime` を足さない。足すと関係ない保存で `danceKey` が変わり、全コマを描き直すため）。新しく作るショートだけ `anime` を置く。
- `make_mv.py` に `--look` の文字が無い stage-studio には渡さない（`supportsLook`）。
- `anime` は描画の条件（`danceKey`）に入る。ただし stage-studio が `--look` を受けるとき（`supportsLook`）だけ。
- `cel` は `make_mv.py --look cel` を渡す: VRM の MToon の影の色（影のテクスチャ、無ければ基本色に赤紫を掛けた色）を使った 3 段のセル塗りと、反転した殻の輪郭線（stage-studio の `lib/look.py` の `cel_material` と `add_outline`）。カメラ（顔を正面寄りに寄りで撮る `face_front`、スカートの中を映さない `skirt_lift`）、顔の光、霞、ぼけは `anime` と同じ（`render.py` は `--look` があれば値に関わらず有効にする）。体は顔と同じ明るさに塗る。
- `cel` を選べるのは、`make_mv.py` の `--look` の `choices` に `cel` があるときだけ（`lookChoices`）。無ければ保存と拍から割るが 400 になる。`danceKey` には `anime` と同じ形で入るので、`anime` と `cel` は別の描画になる。

## 画面

データとジョブは上の「データと描画」。画面は `public/short.mjs` の編集画面に、`public/short-dance.mjs` の「曲とシーン」の欄を足したもの。

- 左の列の一番上に「曲とシーン」の欄: この型は声が無く送った曲が主な音になるという注意、踊る動き(`music.motionId`。変えると全カットの `motionId` も変える)、シーンを選ぶボタン(前の MV の画面のもの。押した順に番号が付き、もう一度押すと外す。`music.stages` に保存)、曲の音声ファイルと利用条件(`audioId`)、長さ(秒。保存はせず、拍から割るときに送る。開いたときはカットの秒の合計か 15)、曲の開始位置(`audioStart`)。畳み「細かい条件」に拍ごとのカット数(4、8、16)、シーンごとのカット数(1、2)、テンポ(`bpm`)、カット割りの番号(`seed`)。
- 「拍から割る」: 先に保存してから `POST /api/shorts/<id>/beat-cuts`(本文は欄の値。`mv-plan.mjs` の `beatCutsBody`)を送り、答えの `short` で画面のショートを中身ごと置き換えて、もう一度保存する(割っている間に古いカットの保存が届いても今のカットに戻す)。曲があれば「曲の拍から n カットに割った(曲のテンポ 約 x)」、無ければ「テンポ x で n カットに割った」と出す。動きかシーンが無いときは送らずに理由を出す。
- カット割りの帯: 割ったあとは保存したカットの秒の累積(`danceCutBounds`。`lib/dance.mjs` の `danceBounds` と同じ)で、カットを押すとそのカットを選ぶ。まだ割っていなければ `mvCuts` のテンポからの目安を薄く出す。帯の下に、カットの数と秒、書き出しの時間の目安、回らないシーン、動きを繰り返すこと、条件を変えてまだ割っていないこと(`splitConditions` で最後に割ったときと比べる)を出す。
- 手で直したカット: 開いたときと割ったときのシーン、カメラ、角度を覚えておき(`danceSplitOf`)、変えたカットの右の欄と「曲とシーン」の欄に「書き出しで止まることがある。戻すときは拍から割る」を出す(`danceEdits`)。覚えるのはその画面を開いている間だけなので、前に開いたときに直したカットには出ない。止まったときはジョブの失敗の文が割り直しを促す。
- 右の欄: セリフ、声を聞く、話す人、動き、表情、長さ、演じ方、音、BGM を止める、話者の名札を出さない。テロップ(既定は空)、カメラ、直してほしいこと、確認、畳みの中のシーン、角度、転換、効果、テロップの型、図は出す。カメラは `shortKind(short) === 'dance'` のとき `camerasFor('dance')`(`DANCE_CAMERAS`、8 つ)だけを押せる。ダンス MV だけの軸の値(上がっていく、下がっていく、並走する、真上から)はほかの種類のボタンに出ない。`shot`(`dir`、`seed`)は画面で変えずに保存し直す。
- 左の列: 出演者は 1 人で、「出演者を直す」はキャラと版だけ(名前、声、出演者を足す、1 回の会話で読ませる、は出さない)。音の欄は「曲」になり、環境音と既定の BGM は出さない。型は変えられない(ほかの型の選ぶ欄にもダンス MV は出さない。ほかの型は `DRAFT_STYLES` から選ぶ)。
- 上の欄とタイムライン: 秒は拍で決まっているので「約」を付けない。動画の種類の札は型の札と同じなので出さない。タイムラインにセリフの段は無く、BGM の段は「曲」。カットを足す、消す、前へ、後へ は出さない(カットは拍から割って作る)。
- 書き出しは `short` ジョブのまま。時間の目安は使うシーンの数で求め、カットを 1 つ直しても全カットを描き直すと出す。

## mv ジョブ（前からの MV）

完成モデルとモーションを Blender のシーンで踊らせ、カメラワーク付きの動画を作る。コードは `lib/mv.mjs`（ジョブ）と stage-studio（`config.stageStudioDir`）の `tools/make_mv.py`。

入力: `charId`、`verId`、`motionId`、`stages`（シーンの ID の配列。`stages/catalog.json` にあるもの）、`seconds`（3〜180 の整数に丸める）、`bpm`、`seed`（カット割りの番号）、`beatsPerShot`（4、8、16）、`shotsPerScene`（1、2）、`quality`（`preview`、`final`）、`audioId`、`audioSummary`、`audioPublic`、`audioStart`。`previewOf` に試しの動画の ID を渡すと、ほかの入力を無視してその試しと同じ条件の本番にする。

1. **コマを描く**: `make_mv.py --frames-only` が、ビューアから動きを焼き込み（`tools/bake_motion.mjs`、このサーバーを読むだけ）、カット割りを決めて `shots.json` に書き、シーンごとに Blender を 1 回起動して、そのシーンのカットのコマだけ描く。ジョブの工程に描いたコマの数を 15 秒ごとに出す。
2. **動画にまとめる**: 撮るジョブと同じ `encodeArgs`（H.264、BT.709 のリミテッドレンジ、音声は動画の長さちょうど）。
3. **記録する**: 撮った動画として `characters/<キャラ>/shoots/<ジョブ ID>/` に置く。`shoot.json` に `kind: 'mv'`、`quality`、`mv`（シーン、拍、カット割り、`previewOf`）が足される。ギャラリー、利用条件、ごみ箱は撮った動画と同じ扱い。

作業は保管場所の `mv-work/<条件のハッシュ>/` に置く。ハッシュは入力のほか、版、モーション、シーンのコードの中身も含む。Blender のコマは残るので、失敗やサーバーの停止のあと同じ条件で積み直すと続きから描く。成功すると消す。14 日より古い残りは次の MV のときに消す。同じ条件のジョブが動いている間は積めない（409）。

時間の上限は目安（`mvEstimateSec`）の 4 倍。

画面からこのジョブを積むのは、動画ギャラリーの MV の試しの「本番で書き出す」（`previewOf`）だけ。新しいダンス MV は `short` ジョブで書き出す。

## API

| 道 | 中身 |
|---|---|
| `POST /api/dance-shorts` | ダンス MV のショートを新しく作る。`{charId, verId?, motionId?, stages?, seconds?, title?, music?}`。`motionId` があれば `stages`（既定はシーンの最初の 1 つ）と `seconds`（既定 15）で拍から割ったカットも入れる。返すのは保存したショート（割れなかったときは理由を `cutsError` に入れ、カットは空） |
| `POST /api/shorts/<id>/beat-cuts` | 拍から割ってカットと `music` を保存する（ダンス MV の型だけ）。`{stages?, seconds?, bpm?, seed?, beatsPerShot?, shotsPerScene?, audioStart?, motionId?}`（省くと今の `music` とカットの合計の秒）。返すのは `{short, source: "audio" か "bpm", detectedBpm}` |

## stage-studio に足してほしい変更(足すだけ。既定の動作は変えない)
`tools/make_mv.py` に引数 `--shots-in FILE` を足す。指定があれば、`plan = Sh.assign_stages(...)` の結果の代わりに FILE の JSON(`[{kind, start, end, a, dir, seed, stage}]`)を読んで `plan` にする。charasta は、この文字列が `make_mv.py` にあるときだけ `--shots-in` を渡す。

```python
a.add_argument('--shots-in')
...
plan = Sh.assign_stages(Sh.plan(beats, x.seconds, x.seed, x.beats_per_shot, x.beats_per_shot), stages, x.shots_per_scene)
if x.shots_in:  # 手で直したカット表をそのまま使う
    plan = json.load(open(x.shots_in, encoding='utf8'))
```
