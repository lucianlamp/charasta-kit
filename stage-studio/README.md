# stage-studio

きゃらすたのキャラとモーションを、Blender の Cycles のステージで MV の動画にする。

- `tools/bake_motion.mjs`、`tools/bake_glb.py`: ビューアで骨、揺れ骨、表情を焼き込み、GLB にする。`--cues cues.json` で、決めた時刻だけ表情(笑顔、ウインクなど)を出せる
- `lib/studio.py`: Cycles の設定、キャラの読み込み、カメラ
- `lib/shots.py`: 拍に合わせたカメラワーク
- `stages/<名前>.py`: ステージ。`build(ctx)` が場面を作り、mark、bounds、views を返す
- `tools/render.py`: 静止画と全コマ
- `tools/make_mv.py`: 1 本の動画を作る
- `tools/make_graphic_mv.py`: グラフィック MV のコマを作る(切り抜いた踊る人、平らな色、大きな文字)。`--catalog` は場面の一覧、`--plan-only --spec spec.json` は場面の並びと秒、`--spec spec.json --out <作業> --quality preview|final` は焼き込み、スカートの確かめ、踊る人の 3 つの描き方(`tools/render_dancer.py`)、重ね(`tools/graphic_mv/`)までして `frames/`、`shots.json`、`report.json` を書く。動画にはまとめない(きゃらすたがまとめる)。テストは `python -m unittest tests/test_graphic_mv.py`。字体は `assets/fonts/`(OFL 1.1)
- `tools/make_short.py`: カット表からコマを描く。カットごとに 1〜3 人を焼き込み、話す人を追うカメラで撮る
- `tools/test_shots.py`: 対話のカメラの幾何の確かめ（`python tools/test_shots.py`）
- `tools/make_letter.py`: 手紙の小道具のテクスチャ（`assets/props/letter.png`）を作る。無地の便せんの絵は `img.sh` で作った

## 使い方

```
python tools/make_mv.py --stage concert --char avatar-sample-b --ver v2-official --motion illit-itsme-b --seconds 15 --out out/mv1 --seed 1 --audio song.m4a --audio-start 12
```

- ステージは `concert`、`classroom`、`themepark`、`rooftop`、`shrine`、`waterside`、`parkway`。seed を変えるとカメラの順番と角度が変わる
- `--audio` があれば拍を音楽から求め、切り替えと照明を拍に合わせる。無ければ `--bpm`
- まとめて作るときは `python tools/make_batch.py batch.json --out out/batch`
- 止まっても同じ命令で続きから描く
- 動きを焼き込むときに本番のきゃらすた(8870)のビューアを使う。保管場所は読むだけ
- 15 秒は GPU を他で使っていないときで、コンサート 約 30 分、テーマパーク 約 35 分、教室 約 50 分

ステージの目標画像と採点は `.dream-loop/` にある(git には入れない)。

- `--look anime`(render.py と make_mv.py): キャラだけトゥーン、外の輪郭だけの光、顔の光、明るい所だけの奥の霞(Mist のパス)、にじみ、顔に合わせた被写界深度。踊りのショットを膝上から胸上へ寄せ(`Sh.tighten`)、カメラを顔の向きの ±45 度へ寄せる `--face-front` を含む。スカートの中が見えるコマはカメラを上げる(`Lk.skirt_lift`)。シーンの色は `lib/look.py` の表。無ければ前と同じ絵
- `--frame-report x.json --report-only`(render.py): 描かずに、コマごとのスカートの中の見え方と写る大きさ(full / knee / waist / chest)を書き出す
- `--look cel --vrm model.vrm`(render.py。make_mv.py は `--look cel` で VRM の場所を自分で渡す): `--look anime` のカメラと霞に加え、キャラを MToon に寄せた 3 段のセル塗り(光の向きを自分で計算する自己発光。影の色は VRM の MToon の影のテクスチャ)と、反転した殻の線(VRM の線の幅。顔には付けない)にする。推奨の画質は 100% / 128 samples
- `--denoiser oidn`(render.py): デノイズを OpenImageDenoise にする
