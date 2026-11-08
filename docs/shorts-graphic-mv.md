# グラフィック MV（ダンス MV の演出 music.look = graphic）

ダンス MV（`docs/shorts-dance-mv.md`）の演出の 1 つ。切り抜いた踊る人、平らな色、大きな文字を重ねる。描く道具は stage-studio の `tools/graphic_mv/`、`tools/render_dancer.py`、`tools/make_graphic_mv.py`。描画と重ね合わせは stage-studio、文字、色、表情、確認、ジョブはきゃらすた（`lib/graphic-mv.mjs`）。
- 「演出」の選択に「グラフィック」が出るのは、stage-studio に `tools/make_graphic_mv.py` があるときだけ（`supportsGraphic`）。場面の一覧は `tools/graphic_mv/catalog.json`（`/api/short-options` の `graphic`）。
- グラフィックとほかの演出の間で変えると、カットの形が変わるので画面はカットを空にする。「拍から割る」は `make_graphic_mv.py --plan-only` を呼び、4 拍を 1 場面としてカット `{scene, wipe, word?, seconds}` を作る。頭は INTRO、最後は END、間は seed で並べ替える（seed 0 は catalog の順）。曲があれば拍は `tools/beats.py` で曲から求める。
- シーン、カメラ、カットのテロップは使わない（文字は絵の一部）。カットの欄は場面、言葉、入りのワイプ。
- 値は `music.graphic`: `{text: {title, titleEn, credit, words}, palette: {preset, bg[3], ink, accent, light}, cues: [{from, to, expr, ease?}], skirt: [硬さ, 抵抗], skirtDamp}`。保存のときに色（`#RRGGBB`）、文字の長さ（名前 24、英字の名前 24 で英数字と記号だけ、クレジット 60、言葉 16）、cues（`from < to`、重み 0〜1、秒は動画の長さの中、名前はその版の VRM の表情だけ）を確かめ、正しくなければ 400。
- 既定値（初めて割ったときと「既定に戻す」、`GET /api/shorts/<id>/graphic-defaults?preset=`）: 名前は character.name、英字の名前はキャラ ID を大文字（英字が無ければ DANCE）、クレジットはモーションの表示名の「(」より前を大文字にして `DANCE  ` を前に付ける。言葉は MOVE / STEP / TURN / FEEL / BEAT / RHYTHM / KICK / DANCE を言葉の枠の数だけ順に配る。色は pop（試作の色）、mono、chara（版のサムネイルから彩度の高い色を 2 つ取って作る。絵として成り立つかは未確認）。表情は顔の寄りの場面に happy 0.6 と 3 拍目の片目のウインク、END に blink_smile か happy 0.8（VRM に無い名前は足さない）。スカートは [3, 0.4]、skirtDamp 0.6。
- 作業は `shorts/<id>/work/<quality>/` の `dancer-<dancerKey>`（踊る人。版、モーション、秒、cues、skirt、品質、描画のコード）と `mv-<composeKey>`（重ね。dancerKey、場面の並び、文字、色、拍、重ねのコード）。文字と色だけの直しは重ねると動画にまとめるだけをやり直す。場面の並びを変えたら、足りない踊る人のコマだけ描き足す（`render_dancer.py --skip-existing`）。ダンス MV と同じショートの作業フォルダに置き、ジョブの終わりに今の 2 つ以外を消す。
- ジョブの工程: カットを確かめる、動きを焼く、スカートを確かめる（股の前が見えるコマがあれば描く前に止め、秒を失敗に出す）、踊る人を描く（全身、膝上、顔の寄り。Blender を 1 つずつ）、重ねる（CPU 8 並列。顔に手前の文字がかかったコマは失敗にせず、記録の `short.faceHits` とカットの欄に注意を出す）、動画にまとめる（今の base と曲の mix。base に色の補正を掛けない）。
- 品質（`GRAPHIC_QUALITIES`）: 試しは踊る人を pct 50、16 サンプルで描き、1080x1920 の配置のまま重ねて 540x960 に縮める。本番は pct 100、64 サンプル、1080x1920。3 つの描き方は試しでも省かない（全身から切り出すと顔が約 115px になり、表情を判断できない）。
- 時間の目安（`graphicEstimateSec`）: `60 + 秒×30×(全身の 1 コマ×全身の割合 + 膝上×割合 + 顔の寄り×割合) + 秒×30×重ねる + まとめる`。本番の係数は全身 1.25、膝上 1.8、顔の寄り 2.69、重ねる 0.23 秒、まとめる 40 秒。試しの係数は `GRAPHIC_QUALITIES.preview.sec`（測った値は `docs/notes/shorts-graphic-mv.md`）。上限は目安の 4 倍。
