# 顔テクスチャ方式の表情（平らな顔向け）

スクリプトは `studio/face_atlas/`（以下の `$S`、`S=<キットの場所>/studio/face_atlas`）。きゃらすたの表情づくりの画面とジョブで動かす手順は [expression-studio.md](expression-studio.md)（どの工程がどのスクリプトをどの順で呼ぶか）。with-kimi の文書へのリンクは with-kimi の場所（`<skills>/charakuru-claude-code-with-kimi/references/`）を指す。ビューアの撮影（`viewer/serve.mjs`、`vshots.mjs`、`vrecord.mjs`）は with-kimi のもので、きゃらすたでは `tools/shots.mjs`・`tools/record.mjs`・`tools/studio_checks.mjs` を使う。

鼻のない平らな顔（のっぺり系のチビ）に使います。鼻のある顔はシェイプキー方式にします（使い分けは [expressions.md](<skills>/charakuru-claude-code-with-kimi/references/expressions.md#方式の選び方-顔の形で決める)）。

顔のメッシュの目・眉・頬と口の範囲を別の材質に分けます。表情ごとの絵を並べた画像（アトラス）を正面から投影で貼り、VRM 1.0 の `textureTransformBinds` で表示する区画をずらします。三角形はほとんど増えず、顔と同じ MToon 設定なので明るさのむらが出ません。

表情は、中立の顔から表情になって止まる動画から作ります（下の「表情（動画から作る）」）。中割りが付き、表情の値をシェイプキーだけで動かせます。

## 前提: 顔の形

- 頭は、のっぺらぼう（目・眉・口のない顔）の4方向画像から作ります。
- Kimi では `--face-limit 20000 --texture-quality detailed` で作り、分割は `--granularity balanced` にします。
- 頭の差し替えの手順は [expressions.md](<skills>/charakuru-claude-code-with-kimi/references/expressions.md#頭を差し替える顔の絵を変えて作り直すとき) にあります。

## 顔の絵（Codex image_gen）

1. 中立の顔: 頭ののっぺらぼうの正面画像を元画像に、キャラ画像と前の顔の絵を参考にして、目・眉・口・頬の赤みだけを描かせます。
2. 表情は描かせない（下の「表情（動画から作る）」で動画から作る）。口の形（aa, ih, ou, ee, oh）は、口があるキャラだけ、中立の顔を元画像にして口だけを編集させます。
3. 絵の指示に入れる目の描き方（夏森轄「目を可愛く仕上げるモデリングのコツ 5選」より）:
   - 上まつ毛を太く盛る（印象は上まぶたで決まる）。
   - 白目を少なくする。
   - 瞳は、縁・瞳孔・上の影・下の明るみ・ハイライト2つを重ねて描く。
   - ほんの少し寄り目にする。
4. 1枚ずつ別のエージェントに判定させます。髪と輪郭のずれ（不透明部分の IoU）や瞳の位置を数値で見て、だめなら指示に直しを足して描き直します（3回まで）。

## 画像は image_gen で作り、そのまま使う

顔の絵・髪のない顔・目の中の範囲・チークなど、絵はすべて Codex の image_gen で生成・編集します。コードで線を抜き出したり、色で見分けて切り抜いたり、差分から層を作ったりしません。コードで絵から作り直したアトラスは、下まぶたが薄くなり、目の端が切れ、赤い瞳が消えた。

1. 正面の撮影（髪あり）に、image_gen で中立の顔を描かせる（`neutral.png`）。
2. image_gen に「髪・帽子をすべて除いて禿頭に」と編集させる（`neutral_bald.png`）。目・眉・口の位置は 1 画素未満しか動かなかった。
3. チークがある絵は、image_gen にチークだけ消させる（`neutral_nocheek.png`）。チークは別に、image_gen で透過 PNG として描かせる。
   - 顔の絵を入力にして「チークだけ残して他を透明に」と頼むと、安全フィルタに拒否された（3 回）。顔や頬の言葉を外し、「丸い薄ピンクのぼかし 2 つ」の図形として、入力画像なしで描かせると通った。
   - 位置と大きさは、元の絵と `neutral_nocheek.png` の差で測ったチークの広がりに合わせて置く。色は元の絵の色に寄せ、不透明度で濃さを決める。ここまでは手元で直してよい（ユーザー可）。
4. 目の中（瞳と白目）の範囲は、image_gen に「目の中を #00FF00 で塗って」と頼んで作る（`hole_green.png`）。色で見分ける方法は、赤い瞳とまつ毛の暗い赤が区別できなかった。

```bash
python $S/align.py $F $C/neutral.png $C/neutral_bald.png $C/neutral_nocheek.png --same
ATLAS_RAW=1 OVERLAY=$C/cheek_final.png OVERLAY_ALIGN=neutral_bald python $S/atlas.py $F neutral=$C/neutral_nocheek.png ...
"$BLENDER" -b work/character.blend --python $S/bake_overlay.py -- $F $C/cheek_final.png neutral_bald work/character_cheek.blend
MIRROR_TOL=6 HOLE_MASK=$F/hole_upper.png IRIS_COLOR=red python $S/paint_gaze.py $F $F/gaze
```

- `atlas.py` の `ATLAS_RAW=1`: 描いた絵をそのまま区画に貼る（肌の色だけ 1 回合わせる）。`--mirror` と `--hair-width` は使わない。
- チークは区画の中と外の両方に同じ投影で入れる。外は `bake_overlay.py` で頭のテクスチャに焼き込み、中は `OVERLAY` で区画に重ねる。区画の境目で切れない。デカール（別メッシュ）は浮いて明るさが違い、頂点の色は MToon が使わないので、使わない。
- `HOLE_MASK` は緑の範囲を区画の座標に移した画像（白 = 開いた所）。`python $S/hole_mask.py $F $C/hole_green.png neutral $F/hole_upper.png $C/neutral.png` で作る（最後の絵は位置合わせに使った絵で、緑塗りと大きさが違えば止まる。`face_vrm.py select` のあと。きゃらすたの組み立てでは設定 `build.gaze.holeGreen`）。`MIRROR_TOL` は、描いたままの左右の目のずれを何画素まで許すか。
- 区画の範囲（rects.json）は、描いた線がすべて余裕をもって入るように取る。目の範囲の上端が眉の途中にあると眉が途切れ、下端がチークの途中にあるとチークが三角形に切れた。

## 瞳の層を image_gen の瞳で作る

顔の絵の瞳はまぶたで隠れた所が描かれていないので、視線を動かすと欠けて見えた。片目ずつ顔の絵から切り出し、image_gen に「瞳だけを残し、隠れた所を瞳の形のまま描き足し、他は透明に」と編集させる（形は指示しない。楕円や円と指示すると元の形から離れた）。

```bash
IRIS_MATCH_HEIGHT=1 python $S/ball_from_iris.py $F neutral_bald $C/iris_R.png:X0,Y0,X1,Y1 $C/iris_L.png:X0,Y0,X1,Y1   # 切り出した範囲（描いた絵の画素）
```

- 置く前に、見えている瞳の左右と下の端を元の絵と比べる（元の絵の瞳は、目の中の緑塗りの範囲のうち白目より暗い所で測る）。ずれていれば置く範囲を直す（絵には手を入れない）。
- 左右の瞳の縦の大きさもそろえる。`IRIS_MATCH_HEIGHT=1` で、2 つ目以降の瞳を下端を固定して 1 つ目と同じ高さに伸び縮みさせる。
- 白目は元の絵の白目の色で塗る。
- 目頭側の白目が狭い目は `GAZE_SIDE=inner`（paint_gaze.py）で、動く量を目頭側に合わせる。平均で決めると、目頭へ動いた瞳の 4 分の 1 が目頭の縁に隠れて切れて見えた。

## あごをなめらかにする（尖りすぎた頭）

Kimi が元絵の細い V 字のあごをそのまま立体にすると、あご先から首まで三角形 1 枚になり、横顔の角が鋭く残る。尖りすぎたあごは、顔の区画を作る前に毎回なめらかにする。

```bash
"$BLENDER" -b work/character_cheek.blend --python $S/smooth_jaw.py -- work/character_face.blend <口の高さ m> 2 6
```

- 口より下の前半分の面を細かく分け（UV とウェイトは引き継がれる）、外周は固定してなめらかにする。
- 左右方向の平均も取ると、三角形の分け方が左右で違うため、あご先が 5mm 横にずれた。中心線から `CENTRE_HOLD`（2cm）以内は左右に動かさない。直す前と後で、あご先の x を必ず比べる。
- 頂点を動かすだけ（`round_chin.py`）では、横顔は変わらなかった。
- 正面の撮影の中心が変わる。倍率は同じなので、位置合わせ（align.json）と rects.json をその分だけずらして使う。

## 組み立て（順番が大事）

```bash
F=<制作フォルダ>/work/face; S=<キットの場所>/studio/face_atlas; C=<顔の絵のフォルダ>
"$BLENDER" -b work/character.blend --python $S/render_front.py -- $F 2048      # 正面の撮影と、テクスチャから写した肌
python $S/align.py $F $C/neutral.png $C/blink.png ... --same                    # 全部 neutral の位置合わせを使う
# rects.json に目・眉の範囲（upper）と、口があれば口の範囲（mouth）を render 画素で書く（align_neutral.png に目盛りを描いて読む）
"$BLENDER" -b work/character.blend --python $S/face_vrm.py -- select $F $F/rects.json
python $S/atlas.py $F neutral=... blink=... happy=... angry=... sad=... relaxed=... surprised=... [aa=... ih=... ou=... ee=... oh=...]
"$BLENDER" -b --factory-startup --python-exit-code 1 --python $S/face_vrm.py -- build <app> work/character.blend $F work/review.vrm $F/face_expr.vrm
```

- 区画の肌は、描いた絵からではなくモデル自身のテクスチャから写します（`render_front.py` が三角形ごとに UV からテクスチャを読む）。放射の撮影で作ると2割暗くなり、範囲が灰色に見えました。
- 顔と首の肌の色は `skin_tone.py` で合わせ、three-vrm の撮影で差（ΔE）を測ります。
- `align.py` は1枚ずつ合わせると、口を開けた絵などで 12% ずれました。編集で作った絵はキャンバスが同じなので、`--same` で中立の値を使います。
- `atlas.py` は、描いた髪の塊だけを消します。色だけで消すと瞳まで消えました。
  - `--mirror` を付けると、片目を鏡写しにして両目をそろえます。このときハイライトも鏡写しになるので、視線を入れるときに `paint_gaze.py` が直します。
  - 髪と瞳の色は、既定ではミントの髪と緑（オリーブ）の瞳で見分けます。色が違うキャラは環境変数で切り替えます。青い髪・赤い瞳のキャラは `HAIR_COLOR=blue`（描いた髪を青で見分けて消す）と `IRIS_COLOR=red`（`--mirror` の軸を赤い瞳で探す）にします。
- 表情はすべて `isBinary` にします（区画のずらしは混ぜられない）。感情の表情は、まばたきと口を `block` します。
- 口の形は、口の材質だけをずらします。口の形を2つ同時に 0.5 以上にすると、ずらしが足されて別の区画が出ます（動画から作った表情では、口の形も板になり、この問題はなくなる。下の「リップシンク」）。
- 範囲は四角のリストでも書ける（和集合）。例えば口は `[[860,1290,1200,1591],[925,1591,1100,1618]]`（口の真下だけ下へ広げ、あごの横の三角形は入れない）。
- 口の範囲（rects の mouth）は、いちばん大きく開いた口の上下に余白をとる。三角形は中心が範囲に入るかで選ぶので、口のまわりの大きな三角形が範囲から外れ、そこだけ口のコマが貼られない。範囲が狭いと、`aa` / `oh` を開ききったときに口の上下の縁が三角に欠ける。上端を上げ、下は口の真下に細い四角を足す。
- `iris_concave.py`（任意）は、瞳を 2.5mm 奥へ下げて、斜めから見たとき視線がカメラを追うようにします。使うときは `select` より前に実行します。瞳の分割で範囲の外枠が変わり、`select` を先にすると `build` が「the atlas no longer fits」で止まります。

## 視線（目を2層にする）

```bash
python $S/paint_gaze.py $F $F/gaze                     # lid_upper.png（前の層）、ball.png（後ろの層）、gaze.json
"$BLENDER" -b --factory-startup --python-exit-code 1 --python $S/build_gaze.py -- <app> $F/face_expr.blend $F $F/gaze $F/gaze/face_gaze.vrm
node <base-skill>/scripts/patch_vrm.mjs $F/gaze/face_gaze.vrm $F/gaze/face_gaze.vrm --meta-from $F/face_expr.vrm
```

- 前の層は、アトラスの区画ごとに白目の穴を抜き、アルファモードを MASK にします。閉じ目の区画には穴がないので、目を全部覆います。
- 後ろの層（EyeBall）は、顔の目のまわりの三角形を写し、正面の投影の向き（+Y）に 0.3mm 下げたものです。
  - 法線の向きに下げると、投影した UV が約1テクセルずれました。
- 視線は、lookAt を expression 型にし、lookLeft/Right/Up/Down で後ろの層の UV をずらします。ずらす量は、いっぱいに見たとき瞳の端がまぶたの下に少し入る程度です。
- 穴の輪郭はぼかしてなめらかにし、描かれた瞳を全部含めます。欠けや、前の層に残った瞳の画素は、瞳を動かすと点になって見えます。
- ミップマップは穴の縁の外の色まで読みます。後ろの層では縁の明るい色を穴の外へ 3px 延ばし、前の層では穴の中の RGB に周りの色をにじませておきます。
- three-vrm の expression 型 lookAt は、下向きの pitch（値が負）で lookUp、yaw が正で lookLeft が入ります。
- 絵の中で、まぶたのすぐ下の瞳が暗く描かれている表情（例えば relaxed）は、下を見るとその暗さが瞳と一緒に下がります。`SHADE_CELLS`（既定 relaxed）の表情は、暗さを動かない半透明の層に移します。
- 瞳が小さい表情（例えば surprised）は、いっぱいに見ると瞳が白目の縁で切れます。`SCALED_CELLS`（例 `surprised:0.5`）で、その表情だけ動く量を小さくします。
- 動く量は `GAZE_H` / `GAZE_V`（瞳の幅と高さに対する、白目の縁を越える割合。既定 0.10 / 0.08）、入力の角度の上限は `LOOK_H_DEG` / `LOOK_V_DEG`（30 / 20）です。
- `paint_gaze.py` も瞳・まつ毛・肌を色で見分けます。赤い瞳のキャラは `IRIS_COLOR=red` にします。赤い瞳は茶色の眉や影の肌と色が近いので、瞳は緑より青が強い所、まつ毛はほぼ黒の所として見分けます。

## 表情（動画から作る）

口がある顔は、`expr_video.py face-open FACE_DIR open.png` で目から口までの OPEN を作り、`build ... --face-dir FACE_DIR` で目の区画（Face_upper）と口の区画（Face_mouth）の両方に貼ります。`blink_layers.py` は口の区画にも板を作ります（口のない顔では出力は以前と同じ）。

表情はすべて、中立の顔から表情になって止まる動画から作ります。表情ごとに動画を 1 本作り、最後に止まった顔を表情の区画に、変わっていく途中のコマを中割りにします。瞬きも同じで、「目を閉じて、閉じたまま止まる」動画にします。開くときは閉じるときのコマを逆に使います。

表情の形（閉じ目の形、眉の角度など）は動画に任せます。指示に「^ ^ の形」などと書いても、そのとおりにはならないことが多いです。見て自然なら、それを採用します。

1. 中立の顔の絵を描かせ（上の「顔の絵」）、アトラスを組み立てる。表情の絵はまだ要らない。`atlas.py` の表情の欄には中立の絵を入れておく（あとで動画の表情に差し替わる）。
2. 髪のない中立の顔（OPEN）を用意し、16:9 にする。OPEN は区画と同じ大きさで、アトラスの 1 区画目の、縁につながる黒だけを白にしたもの（まつ毛の黒まで白にすると白い点が出た）、または髪のない顔をあらためて描かせて区画に合わせたもの。

   ```bash
   python $S/expr_video.py prep open.png open_169.png      # 外側が白い区画は白で、そうでなければ縁の少し内側の肌の色で埋める
   ```

   区画の縦横比のまま渡すと、縦横別の倍率で引き伸ばされた。
3. 表情ごとに、Grok Build で 720p・4 秒の動画を作る（grok-build-video スキル）。最初のコマだけ `open_169.png` に固定する。

   ```bash
   python ~/.claude/skills/grok-build-video/scripts/grok_video.py expr/angry.mp4 --first open_169.png \
     --duration 4 --resolution 720p --aspect 16:9 --prompt "<顔の説明> <表情の動き> <止まる・固定の指示>"
   ```

   - 顔の説明: 平らな正面のアニメの顔のテクスチャで、肌・目・眉だけ（髪・口なし）。
   - 表情の動き（使った指示の例）:
     - blink: 最初の 1.5 秒で上まぶたが下りて閉じきる。
     - happy: 最初の 1.5 秒で目が笑った形に閉じ、眉が少し上がる。
     - angry: 最初の 1.5 秒で眉が内側に下がってしかめ面になり、上まぶたが少し下がってにらむ。目は開いたまま。
     - sad: 最初の 1.5 秒で眉の内側が上がって困った形になり、上まぶたが少し垂れる。目は開いたまま。
     - relaxed: 最初の 1.5 秒で上まぶたが半分まで下がり、眉がゆるむ。
     - surprised: 最初の 1 秒で目を大きく開き、瞳が少し小さくなり、眉が高く上がる。
   - 止まる・固定の指示: そのあと最後まで表情を止める。カメラは完全に固定（ズーム・平行移動・揺れなし）。構図と顔の外の肌は変えない。動くのはまぶた・まつ毛・眉だけ。髪・口・鼻・涙・汗・影を描き足さない。
   - Kimi の動画生成は最初のコマしか固定できず、画面全体を少しずらすことがあった。Grok Build の方が 1 コマ目が入力とよく合い、ちらつきも少なかった（grok-build-video スキルの「画質」）。
4. 全部の動画をまとめて VRM に入れる。

   ```bash
   python $S/expr_video.py build in.vrm out.vrm open.png work/ --video blink=expr/blink.mp4 --video happy=expr/happy.mp4 \
     --video angry=expr/angry.mp4 --video sad=expr/sad.mp4 --video relaxed=expr/relaxed.mp4 --video surprised=expr/surprised.mp4
   ```

   - 位置合わせ: 1 コマ目は OPEN そのものなので、1 コマ目と OPEN の全体で縦横別の倍率と平行移動を合わせる（Powell）。色も 1 コマ目で合わせる。
   - 表情のコマ: 最後に止まっている区間（最後のコマとの差が、1 コマ目との差の 15% 以内）の真ん中。surprised は途中で一瞬もっと大きく開いてから少し戻ったので、いちばん離れたコマは使わない。
   - 貼る範囲: 1 コマ目と表情のコマが違う所すべて（目と、動いた眉）を広げてぼかしたもの。開いた目のまつ毛は必ず含める（ぼかしの端から透けた）。表情の区画は、中立の区画にこの範囲を貼って作る（前に描いた表情の絵は残らない）。blink は blinkLeft / blinkRight の閉じた側にも貼る。
   - 貼る前に、肌とほとんど同じ色の画素と、まつ毛より上の灰色っぽい画素（動画に残った開いた目の輪郭）を肌の色にそろえ、区画の肌の陰影に合わせる。合わせないと three-vrm で目のまわりが白っぽく浮いた。
   - 途中のコマ: 表情に変わっていく途中で絵が変わるコマ（Grok の 24fps の動画も同じ絵が 2〜3 コマ続いた）から、進み具合が等間隔に近いものを 4 枚（`--inbetweens N`）選ぶ。進み具合 0.1 未満と 0.97 以上のコマは使わない。
   - 区画は 8192px に収まる列数で並べ直す。Face_upper（と、あれば EyeShade）の UV と、既存の表情のずらし量も新しい並びに変換する。
   - 書き出すもの: `out.vrm`（標準）、`work/atlas.vrm`（途中のコマをカスタム表情 `NAME_1`〜`NAME_N` にした二値の版）、`work/sheet.png`（全部の区画の一覧）、`work/NAME/`（コマ、範囲、scores.csv）。
5. `work/sheet.png` を見てから、three-vrm で表情ごとに値を 0〜1 で動かして撮る（ビューアを `serve.mjs --vrm out.vrm` で開き、`SWEEP=angry SHOTS=sweep node viewer/vshots.mjs URL 出力先`）。表情を出したままの視線は `SHOTS=eg` で撮る。

再生（`blink_layers.py`、`build` の最後に自動で実行）:
- VRM 1.0 の表情で、値に応じて段階的に切り替えられるのはシェイプキーだけ。テクスチャのずらしは途中の値だと区画の間を連続して滑るので、中割りに使えない。
- 表情ごとに、途中のコマと表情のコマを貼った板（Face_upper の三角形の複製）を、左右の目ごとに瞳の層より奥へ隠す。表情のシェイプキーで板が前に出る。板ごとに前に出る速さを変えてあり（`z = A_k × 値 − B_k` の一番手前が見える）、一番手前の板が値 0.15 / 0.35 / 0.55 / 0.75 / 0.92 で順に入れ替わる。
- 表情を出しきったとき、板は顔の面から約 2.7mm 前に出る。
- 表情は二値でないシェイプキーの表情になり、Face_upper と瞳の層（EyeBall）のずらしは外す。EyeShade のずらしが残る表情は二値のままで、最後のコマだけが出る。
- 表情を出している間も視線が動く。
  - `build` は、貼ったコマの目の開いた所（瞳と、横の白目）を、中立の区画と同じく透明にする。開いた所は色で見分ける。OPEN の中で中立の区画が透明な所を「中」、目のまわりの残りを「外」として色を覚え（k-means 12 色ずつ）、目ごとの塊を凸包にする（瞳の縁のハイライトが欠けないように）。
  - 白目が肌に近い色のキャラは、色では見分けられない。閉じたまぶたまで透明になり、blink と happy で閉じた目の下から瞳が見えた。この場合は、コマごとの開いた所を image_gen に緑で塗らせる（`OPENING_MASKS=DIR`、下の手順）。1 コマ目との差で見分ける方法は、閉じたまつ毛と瞳孔の色が同じで失敗した。まつ毛の線より下を開いた所にする方法（`OPENING=lash`）は使えるが、半分閉じたコマは透明にしないので、その間は瞳が動かない。

    ```bash
    # 1) 一度 build して work/NAME/between_K_Face_upper.png と expression_Face_upper.png を作る
    # 2) 各コマを白で正方形にして、image_gen に「目の開いた所全体（瞳・瞳孔・光・白目）を #00FF00 で塗る。
    #    まぶたが覆う所はまつ毛の線で止める。閉じた目には塗らない。まつ毛・まぶたの線・眉・肌はそのまま」と編集させ、
    #    DIR/out_NAME_between_K.png、out_NAME_expression.png に置く
    # 3) 並べて見て、閉じた目に塗ったものは「両目とも閉じている、何も塗らない」と足してやり直す
    OPENING_MASKS=DIR OPENING_GROW=40 python $S/expr_video.py build ...   # 塗った所を透明にする（位置のずれは位相相関で測る）
    ```

    `OPENING_GROW=N` は、中立の穴から N 画素外まで塗った所を透明にする。穴の中だけにすると、中立より大きく開いた surprised で、描いた瞳の上端が動く瞳の上に二重に残った（瞳の層の白目は区画の外まであるので、穴の外を透明にしても後ろは白目になる）。
  - 表情の最後のコマは、image_gen で描いた表情の絵をそのまま使う（`EXPR_DRAWN=DIR`、DIR/NAME.png は描いた絵から OPEN と同じ作り方で `face-open` したもの）。動画のコマ（720p を約 2 倍に引き伸ばし、Grok が描き直した）はまつ毛が薄くぼけて、描いた中立の顔の横で透けて見えた。途中のコマは動画のままで、動画の表情のコマから描いた絵への色の対応（チャンネルごとの分位点）を、暗い線（明るさ 0.75 未満）にだけかけてまつ毛の濃さをそろえる（肌にまでかけると眉のまわりがまだらになった）。描いた絵の目のマスクは `out_NAME_drawn.png`（目が閉じた表情は不要）。
  - 区画の外枠が変わって OPEN が下に数行伸びただけなら、`analysis.npz` の配列の下に行を足し、鍵を新しい OPEN に書き換えれば解析をやり直さずに済む。
  - 動画の解析（位置合わせ・コマ選び）は `work/NAME/analysis.npz` に保存し、同じ動画・OPEN・中割りの数なら読み直す。
  - `blink_layers.py` は、どの板にも、そのすぐ後ろ（0.02mm）に瞳の層の三角形の複製を置き、板と同じシェイプキーで前に出す。複製は EyeBall の材質なので、lookAt のずらしで瞳が動く。
  - 複製は全部を 1 つの primitive にまとめる。three-vrm は同じ材質の primitive の数だけテクスチャのずらしを足すので、板ごとに分けた 60 個では瞳が 60 倍動いて目から消えた。
  - 複製は中立の瞳の区画を使う。表情ごとの瞳の区画（前に描いた絵）には古いまぶたの線が描いてあり、瞳を動かすと見えた。そのため surprised の瞳は小さくならない。
- `blinkLeft` / `blinkRight` は blink の板の片目だけを動かす。感情の表情は blink を止める（block）ので、表情を出している間は瞬きの板が出ない。
- アプリは表情の値を連続で上げ下げすればよい。VMagicMirror の自動まばたきは 50ms で 0→1、40ms そのまま、100ms で 1→0、UniVRM の見本（Blinker）は 0.1 秒で直線に上げ下げする。ビューア（`viewer/viewer.mjs`）は、瞬きを 80ms で 0→1、60ms そのまま、140ms で 1→0、感情を 0.25 秒で上げ下げする。
- リップシンク（口がある顔）: `aa` / `ih` / `ou` / `ee` / `oh` も二値でないシェイプキーの表情になる。アプリが音声に合わせて値を 0〜1 で上げ下げすると、値に応じて口が開いていく。
  - 口の形を 2 つ同時に入れると（`aa` 0.6 と `oh` 0.3）、値の大きい方の口が出る。同じ値どうしは板が同じ奥行きで重なるので、ちらつくことがある。
  - 感情の表情は口を止めない（`overrideMouth: none`）。口の形は、共通のシェイプキー `mouth_back` を一緒に動かし、感情の口の板を奥へ下げる（値 1 あたり約 21mm、口の形が値 0.135 で感情の口が隠れる）。話している間は口の形が出て、目は感情のまま残る。
  - 最後のコマの板は、値 1 で 1 つ前の板より 0.2mm 前に出るよう傾きを大きくしてある（`LAST_GAP`。元の 0.024mm でも重なりは出なかったが、差が小さすぎた）。
  - 確認用の動画は `viewer/vrecord.mjs URL OUT_DIR [MOTION.vrma]` でコマごとに撮り、ffmpeg でつなぐ（瞬き・視線・感情 5 種・あいうえお・話す・感情のまま話す・片目の瞬き、39 秒）。撮影は GPU で行う（`viewer/gpu_browser.mjs` が GPU の描画を選び、WebGL の描画先が SwiftShader のときだけ CPU に戻る。`ANGLE=...` で指定もできる。`vshots.mjs` も同じ）。SwiftShader（CPU）では遅く、画面の保存が止まることがある。モーション VRMA_01 は顔が後ろを向く場面があるので、表情を見せる動画では使わない。
  - `SHOTS=lip`（`viewer/vshots.mjs`）で、口の形ごとの値 0.1〜1、2 つ同時、感情と口の形の組み合わせを撮る。
- three-vrm 以外のアプリでは試していない。VRM 0.x のアプリ（VSeeFace など）には 0.x 形式への変換が要る。

使わない方法: 動画の各コマを画像編集で高解像度にする（コマごとに描き直されるので、線・まつ毛・瞳の光がコマごとに変わり、眉が二重に写ったコマも出た）。

## 登録

顔テクスチャ方式の表情は、キットに登録できません。キットの検査は、面・UV・材質が元のモデルのままであることと、表情ごとにシェイプキーがあることを求めます。表情は VRM ファイルの中に入れて渡します。メタ情報（名前・作者・利用条件）は、アプリで書き出した VRM から `patch_vrm.mjs --meta-from` で写すか、ユーザーから聞いた値を JSON にして `set_vrm_meta.mjs` で書き込みます（VRM 1.0 の値かを確かめ、書いていない項目は残す）。

```bash
node <skills>/charakuru-claude-code-with-kimi/scripts/set_vrm_meta.mjs $F/gaze/face_gaze.vrm <out>.vrm meta.json
```

## 確かめ方

ビューア（`viewer/serve.mjs --vrm $F/face_expr.vrm`）で、次のように止めてから、表情のボタンを押して撮ります。

```js
window.viewer.paused = true; window.viewer.vrm.humanoid.resetNormalizedPose(); window.viewer.face(0.6)
```

コードから感情の値を入れても、ボタンの状態で毎フレーム上書きされます。口の形は `expressionManager.setValue('aa', 1)` で入ります。

撮るもの:
- 角度の表（左右 -45, 0, 25, 45, 65, 90° × 上下 -25, 0, +25°）
- 表情を正面と 45° で
- 視線5方向
- 表情と視線の組み合わせ

## 口の形（あいうえお）の開き方の曲線

`blink_layers.py` の `VISEME_T`（既定 `0.04,0.10,0.18,0.30,0.50`）で、口の形の途中のコマが前に出る値を、目や感情の `T` と分けた。

- 多くのアプリは、口の形を切り替えるとき 2 つを半分ずつ重ねる。`T` のままだと値 0.5 で小さい途中のコマが出て、話すたびに口が閉じかけて見えた。
- 今は値 0.3 でほぼ開き、2 つを 0.5 ずつ混ぜると、前にある方が開いた形で出る。
- `mouth_back`（感情の口を奥へ押す量）は `VISEME_T[0]` から計算する。
- 確かめるときは、ビューアの `window.viewer.mouthOverride = {aa: 0.5, oh: 0.5}` で口の値を直接指定して撮る。

## ふだんの口は微笑みにする

話していない間と句の切れ目は、ふだんの顔（neutral）の口に戻る。まっすぐな一本線だと、話していても無表情に見えた。

- image_gen で neutral の絵の口だけを、口角を少し上げた閉じた微笑みに描き直す。
- 口のまわり（ぼかした四角）だけを元の絵に貼り込み、ほかの所の色のずれを持ち込まない（`python $S/paste_area.py 元の絵 編集した絵 out.png --box X0,Y0,X1,Y1`）。
- `atlas.py` は位置合わせをファイル名で引くので、同じ名前で置き換える（元の絵は控えておく）。
- そのあと顔を作り直す（約 5 分）。

感情の happy を弱めて微笑みの代わりにする方法は使えない。0.2 では目が二重に重なった途中の絵になり、0.35 からは目を閉じた ＾＾ になる。
