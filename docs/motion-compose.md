# モーションをつなぐ（tools/compose）

動画（vrma-pipeline）、FBX のアセット、VRMA、MotionBricks の条件を、同じ形（中間形式）にそろえて、区間の間を MotionBricks で生成し、1 本の VRMA にする。保管場所のモーション、MotionBricks の条件、動画（`video-motion`）や MotionBricks（`motion-gen`）のジョブの取り込む前の結果をつなぐときは、きゃらすたの動きの画面の「つくる」から動かせる（下の「画面からつなぐ」）。計画の `video`、FBX の区間は CLI だけ。用語は `CONTEXT.md`、移し替えは `docs/adr/0003-motionbricks-retarget.md`、足は `docs/foot-ik.md`。

## 流れ

1. 計画を読む。`motion` の区間は保管場所の `motion.vrma` と `motion.json` の `license` をそのまま使う。`path` の区間に `license` が無ければ止まる。推測で埋めない。
2. 素材を中間形式にする。結果は `WORK/cache` に残す。
   - `asset`: `fbx_dump.py` を Blender で動かし、`fbx_clip.py` が移し替える。
   - `video`: vrma-pipeline の `batch_convert.py` で VRMA を作り、`vrma_read.py` で読む。
   - `motionbricks`: 条件（`kind`、`speed`、`direction`、`turn`、`seconds`、`action`、`ending`、`root`）を `lib/motion-gen-options.json` で確かめ（きゃらすたの `motion-gen` と同じ規則と既定）、`tools/motionbricks_gen.py` を MotionBricks の uv の環境で動かして VRMA と接地を作る（`--fake` ではふだんの python の作りものの動き）。`speed` は動きの速さ（m/s）なので、再生の速さには使わない。`root` は compose の区間の `root` として扱い、`motionbricks_gen.py` はいつも進む動きを作る。結果は `WORK/cache/mb-<条件の値>` に残す。許諾は `motion-gen` の取り込みと同じ記録（`lib/model-licenses.json` の `motionbricksGen`。評価用のみ）に使った見本の動きの BVH を入れたもの。`generated.segments[]` に条件、`motionbricks`（モデル、版、コマ数、進んだ距離、使った見本の動き）、`license` を残す。
   - `vrma`: `vrma_read.py` で読む。保管場所のモーションは ID（`motion`）で指定し、読んだ ID、保管場所、sha256、接地のファイル名（`contacts`。無ければ null）を `generated.segments[].motionRecord` に残す。
     `motion.json` に `contacts` があれば、横の `contacts.json` を接地に使い、推定しない。列は `order` の名前で並べ替え、`fps` が 30 でなければ線形に直す。
     `license` に `evaluationOnly` が無く、`terms` に見本の動きの許諾（Sample Data Evaluation License）がある古い MotionBricks の記録は、評価用として読む（`lib/library.mjs` が一覧で補うのと同じ。`motion.json` は書き換えない）。
     保管場所の外の VRMA（`path`）は、計画の `contacts`（contacts.json のパス）があればそれを接地に使い、`motionRecord`（連想配列）をそのまま `generated.segments[].motionRecord` に残す。きゃらすたがジョブの結果を区間にするときに使う。`motion` の区間には書けない。
3. 区間ごとに切り出し、速さを変え、足の高さをそろえ、接地が無ければ推定し、`inplace` なら道筋を引く。
4. 区間を順に前の区間の終わりの向きと位置へ置き、間を MotionBricks（`mb_bridge.py`）か補間で作る。
5. つなげて、最初のコマで体が +Z を向き hips の真下が原点に来るように動かし、VRMA と記録を書く。
6. `check.py` が数値を出す。

## 中間形式（clip.py）

`soma_vrma.retarget()` の返す辞書に、接地と指を足した形。

- 30 fps。入力の fps は回転の球面補間と位置の線形補間で直す（例えば 50 fps の VRMA や 24 fps の FBX）。
- 骨は VRM の正規化した骨（`BONES` の 21 本と指 30 本）のローカルの回転。T ポーズで単位。
- `upperChest` は持たない。素材にあれば、そのワールドの向きを `chest` に入れる（ADR 0003 と同じ理由。首と肩の向きが保たれる）。指の無い素材は指が単位の回転になる。
- hips は REST の体（SOMA、hips の高さ 1.0121 m）のメートル。VRMA の静止姿勢も同じ体で書くので、three-vrm-animation がキャラの hips の高さとの比で縮める。
  - VRMA の素材: `1.0121 / 素材の静止姿勢の hips の高さ` 倍。
  - FBX の素材: `(1.0121 - 0.0216) / 基準の姿勢の hips から足の最低までの高さ` 倍。
- 接地は `contacts.json` と同じ 4 列。保管場所のモーションは横の `contacts.json` を読む。無い素材は `estimate_contacts`（`docs/foot-ik.md` の高さと速さの値を脚の長さの比で延ばした、ヒステリシスなしの判定）。

足の高さは、REST の体で組み立てたときの足の裏の高さの 3 パーセンタイルを床として、hips を一定の量だけずらす。

## FBX の移し替え（fbx_clip.py）

ADR 0003 の差 `D = W(t) * W_rest^-1` は静止姿勢が T ポーズである前提なので、T ポーズでない基準の姿勢のために 2 つの回転を足す。

```
D(t) = B * W(t) * W_ref^-1 * B^-1 * F^-1
```

- `B`: FBX の世界を VRM の世界（Y が上、前が +Z、左が +X）へ向ける回転。基準の姿勢の hips から head を上、右腕の付け根から左腕の付け根を左として求める。Warrior は Z が上で前が -Y、Blender から書いた FBX は別の向きだが、同じ計算で済む。
- `F`: 骨ごとに、基準の姿勢の骨の向き（子の骨への向き）を REST の T ポーズの向きへ向ける最小の回転。子の骨が無い骨（爪先、指の先）は親と同じ。hips と head は基準の姿勢のまま。

腕を下ろした姿勢から最小の回転で T ポーズへ上げると、手のひらは下を向く。これは VRM の T ポーズと同じなので、ねじれの基準が合う。

`W(t)` はワールドの回転だけを見るので、FBX の骨のローカルの軸の取り方に左右されない。根の動き（Warrior の `Motion` の節点）も `W(t)` と hips の位置に入る。

基準の姿勢:

- アーマチュアの FBX: 骨の静止姿勢。
- 骨が Empty になる FBX（Warrior）: 静止姿勢が無いので、`rest` のキャラの FBX の最初のコマ。`Animations/<名前>_*.FBX` は `Characters/<名前>.FBX` を自動で使う。

骨の名前は `bone_maps.py` の表（`unity-humanoid`、`mixamo`、`biped`）で読む。名前は小文字の英数字だけにし、`mixamorig:`、`B_`、`Bip01` は比べる前に除く。hips、spine、head、腕と脚の骨が足りなければ、一番近い表と足りない骨の名前を出して止まる。

## 両手の握り（grip.py）

回転だけの移し替えは、体つきが違うと両手首の位置の関係を保たない。Warrior の 2Handed_Attack1 では、元の動きは 41 コマ全部で右手が鍔の側なのに、移し替えると振りかぶる 14 コマで左手が鍔の側へ出た（骨の表と左右の向きは正しい。肩幅の違いが原因）。

`asset` の区間に `grip`（武器を持つ手）を書くと、両腕を解く。右腕を基準に左腕だけを解くと、肘が元の動きの面に残るので、腕の長さが違う体では左腕がねじれた（2Handed_Attack1、avatar-sample-b で左の上腕 105.8 度、前腕 91.1 度、手首の折れ 134.0 度）。

1. 両手の中点を、肩の骨の付け根から元の体の比の長さで腕を組んだ位置へ戻す。両手首の差は素材のまま。持つ手も動くので、武器の位置も動く。回転は変わらない。
2. 両腕が届かないコマは、両手首の差を保ったまま中点だけを最小の距離で動かす（2 つの球の共通部分への射影）。
3. 肘の向きを 5 度刻みの候補から動的計画法で選ぶ。無理は手首の折れ、手首のひねり、上腕のねじれの 2 乗の和で、コマの間の肘の向きの変化も足す。選んだ向きはならして刻みの段差を消す。
4. 前腕は元の動きから読んだ蝶番の回りにだけ曲げ、手首のひねりの半分を前腕のロールへ移す。ひねりは 1 コマで 180 度近く跳ぶことがある（元の f18 から f19 で 176 度）ので、目標はコマごとに折り返した値の半分にして、ロールは 1 コマ 30 度までで追う。追いきれない分は手首に残す。

両手首の差は持つ手のローカル座標で持ち、線形に補間する（世界の座標で補間すると、手が回るコマで間隔が縮む）。腕は切り出しと `speed` のあとで解く。差と腕の長さは hips から爪先までの高さの比で縮める（`bodyScale` と同じ比。Blender の経路と同じ値になる）。手の向きは素材のまま。

体つきは計画の `model` の VRM で計算し、`model` が無ければ止まる。REST の体で解くときは区間に `gripBody: rest` を書く。使った体（VRM のパスと sha256）は `generated.segments[].retarget.grip.body` に残す。前の解き方が要るときは `gripSolve` に武器を持たない腕（`left-arm` か `right-arm`）を書く。持つ手は動かず、肘は元の曲がる面に残る。

`report.json` の `grip` は、つないだあとの全コマで測る: `gapErrorMaxCm`（両手首の差の誤差）、`solve`（解き方）、`arms`（左右の `upperTwistDegMax`、`lowerTwistDegMax`、`wristTwistDegMax`、`wristBendDegMax` と、この体で手か肘が胴に入るコマの数 `handInBodyFrames`）、`weaponMoveCm`（持つ手の手首が回転だけの位置から動いた距離）、`reachShift`（届かせるために中点を動かしたコマの数と距離）、`unreachedFrames`（それでも届かず両手首の差が崩れたコマ。区間の先頭からの番号）。

`anatomy` は `anatomy.py` の定義で測った肩と肘（挙上、水平内外転、屈曲、上腕の回旋、前腕の回内、肘が向く方向）と、人の可動域を超えるコマの数。

`elbowPrior: true` を計画か区間に書くと、肘の向きの無理に、肘が重力と体の外へ向く事前分布と、肩と前腕の可動域の罰を足し、T ポーズから測る上腕のねじれの重みを 0.25 に下げる。`chestShare: 1` と一緒に使うと、数値では左肘の開きが消えて元の動きへ近づくが、**見た目で既定にしなかった**。既定は `elbowPrior: false`。
## 武器を主に解く（weapon.py、weapon_check.py、weapon_def.py）

`asset` の区間に `grip` の代わりに `weapon`（武器の定義の JSON）を書くと、武器を剛体として、その姿勢から両腕を解く。`grip` は両手首の差を合わせるだけで、武器は計算に入っていない。Warrior の 2Handed_Attack1 を `grip` で解くと、刃が地面へ最大 21 cm 入り、柄頭が右の太ももに入り、1 コマで 176 度回ったまま残る。

### 武器の定義

`weapon_def.py` が FBX のメッシュと動きから作る。数値だけで、メッシュは入れない。定義の JSON もアセットから読んだ値なのでリポジトリには入れない。座標は柄頭が原点、+X が刃先、+Y が刃の幅、単位は FBX のまま。

| 項目 | 中身 |
|---|---|
| `lengthM`、`handleM`、`guardM`、`bladeM` | 全長と、柄、鍔、刃の範囲。範囲は断面の環の間の長さで読む |
| `centerOfMassM` | 密度が一定のときの重心（閉じたメッシュの符号つきの四面体の体積） |
| `profile` | 柄の軸に沿った位置と刃の幅の半分。衝突の点に使う。厚みは見ない |
| `bodyHeightM`、`lengthPerBodyHeight` | 素材の体の hips から爪先までの高さと、それに対する武器の長さの倍数。キャラの大きさはこの倍数で決める。Warrior は 2.1448 倍で、avatar-sample-b では 1.77 m |
| `grips` | 左右の手首の位置 `wristM` と、柄に対する手の向き `hand`（持つ手の回転 = 武器の回転 × `hand`）。持つ手は骨に重み 1 で付いた値、もう一方の手は動きの中で一番多くのコマが集まる値 |

Warrior の武器は `Characters/2Handed.FBX` の `Mesh-TwoHanded-Weapon`（60 頂点、`B_R_Hand` に重み 1）で、`Animations/` の FBX にメッシュは無い。長さ 2.7545、柄 0〜0.47、鍔 0.47〜0.64、重心 1.276（FBX の単位、柄頭から）。右手首は 0.342、左手首は 0.111 の位置で、左手は 41 コマのうち 18 コマが同じ握りにあり、f7〜f18 の間は握りから最大 7.5 cm と 40 度動いている。`weapon` ではこの動きを捨てて、握りに固定する。

### 解き方

1. 持つ手の回転から武器の回転を読む。1 コマの回転が上限（既定 30 度、900 度/秒。`weaponMaxStepDeg`）を超える間だけ時刻を伸ばす。段差が出ないように前後へならす。体も同じ時刻で動く。武器は親の骨を介さず直接補間するので、速い間も 1 本の軸で一定に回る。
2. 持つ手の手首を、肩の付け根から元の体の比の長さで組んだ位置に置く（`grip.source_wrist`）。hips からの位置をそのまま縮めると手が体に近づき、手首の折れが増えた。
3. 武器の点が地面か体のカプセルに入るコマだけ、武器を動かす。回転は変えない。地面は真上へ、体は線分から離れる向きへ動かし、前後 4 コマへ広げてならす。
4. 両手の手首を握り点に、手の向きを柄に対する握りに固定して、`grip` と同じ関数で両腕を解く。肘の向きの無理に、手首のひねり 100 度と折れ 80 度を超えた分の重い罰を足す。罰が無いと、速い間に手首のひねりが 180 度をまたいで腕が裏返った（speed 0.6 で 170 度）。

### 176 度のコマ

2Handed_Attack1 の f18 から f19 は、体全体が 1 コマで次の姿勢へ移るキーの間で、右手は 175.7 度、背中の骨は 97 度、刃先は FBX の単位で 6.2 m 動く。向きは短い回り方が正しい。

- FBX の補間（オイラー角の線形。Blender で 1/8 コマごとに読んだ）は、刃先が頭の上を通って前へ下りる。
- 前のコマの回転の軸との内積は 0.91 で、同じ向きに回り続ける。
- 長い回り方（-184.3 度）は刃先が地面の下 68 cm を通る。

足りないのは回る時間で、向きではない。`generated.segments[].retarget.weapon.fastSteps` に 90 度を超えるコマの間の角度と `sameWay`（前のコマの軸との内積）を残す。長い回り方へ直す処理は持たない。`sameWay` が負の素材が出たら考える。

### 武器の確かめ（report.json の weapon）

| 項目 | 測り方 |
|---|---|
| `rotationStepDegMax`、`angularSpeedDegPerSecMax` | コマの間の武器の回転 |
| `tipSpeedMpsMax`、`centerOfMassSpeedMpsMax`、`tipAccelMps2Max`、`tipJerkMps3Rms` | 刃先と重心の速さ、刃先の加速度と躍度。キャラの体の m |
| `ground`、`body`、`legs`、`head` | 武器の点が入るコマの数と、一番深い距離 |
| `sweptSteps` | コマの間を 3 か所見て、どこかで入るコマの間の数 |
| `gripSlipCm` | もう一方の手首と握り点の距離 |
| `wrist` | 手首の折れの最大と、80 度を超えるコマの数 |
| `pushCm`、`reachShift` | 武器を動かしたコマと量、届かせるために中点を動かしたコマと量 |

世界の高さは three-vrm の再生と同じ（hips はキャラの hips の高さの比、ほかの骨は hips からの差）。カプセルは胴 3 本、頭、太もも、すね、足で、半径は VRM の T ポーズのメッシュの、その骨が支配的な重みの頂点までの距離の 90 パーセンタイル。揺れものの骨の頂点は入らない。腕は入らない。足の IK は入らない。

## 首と胴（neck.py）

ゲームの動きは、胴をひねるときに頭を敵へ向けたまま残すことがある。2Handed_Attack1 は胸に対して頭が左へ最大 108 度回り、41 コマのうち 11 コマ（f8〜f18）が 80 度を超える。腰に対して胸は右へ 84 度回る。人の首のひねりは片側 70〜80 度、胴のひねりは 40〜50 度で、どちらも超える。首の骨は全コマ胸と同じで、回転は全部頭の骨に入る。移し替えの誤りではない。元の FBX の値と VRMA の世界の回転の差は 0.05 度以内で、基準の姿勢の胸、首、頭の軸は 0.04 度以内で同じ。

`asset` の区間は、切り出しと `speed` のあとで次をする。

1. 胸から見た頭の回転の大きさを上限へ収める。上限の 2/3 までは胸から見た頭の回転を変えない。抑えた分は頭が胸へ戻るので、顔の世界の向きは変わる。
2. 首と頭の骨へ半分ずつ分ける。

胸から先の腕には触らないので、腕と握りは変わらない。

`chestShare`（既定 0）を書くと、抑えた分のその割合で胸を頭の向きへ回し、その半分を背骨へも回す。残りは頭が胸へ戻る。1 なら顔の世界の向きは変わらない。腰と脚は動かないので、足の位置と接地は変わらない。このとき `grip` は胴を回す前の動きで両手の位置を決め、回したあとの肩から両腕を解く（順番は胴、両手の位置、肘）。`grip` の無い区間の腕は胸と一緒に回る。数値では首と胴のひねりが可動域に収まるが、**見た目で既定にしなかった**。

上限は `neckLimitDeg`（既定 80 度）に、体の首の長さと元の体の比の首の長さの比（1 まで）を掛けた値。30 度より下げない。体に首の骨が無いとき、180 のときは補正しない。180 は抑えず、首と頭へ分けるだけ。`text`、`video`、`vrma` の区間には当てず、その区間に書くと止まる。`weapon` の区間は `chestShare` を読まず、胸を回さない。首のあとで武器の当たりを測る。

記録は `generated.segments[].retarget.neck`（`limitDeg`、`chestShare`、`overFrames`、`headChestDegMax`、`headChestStepDegMaxBefore`、`headChestStepDegMax`、`headMoveDegMax`、`chestTurnDegMax`）。`asset` の区間のつないだあとの全コマの値は `report.json` の `neck`（`yawDeg`、`pitchDeg`、`rollDeg`、`angleDegMax`、`stepDegMax`、`chestHipsYawDeg`）。
## 指（fingers.py）

指が動かず握っている素材（全関節の動きが 5 度未満で、4 本の指の中間の関節の屈曲の平均が 45 度より大きい手）は、元の回転を移さず、柄の太さの筒を包む固定の姿勢にする。

- 筒の太さは `gripDiameterCm`（既定 3.2 cm、1〜8）で、大人の手の長さ 18 cm での値。手の全長との比で決めるので、どのキャラにも同じ比で当たり、1 本の VRMA を共有する。
- 筒は手のひらに沿わせる。軸は親指の側から手の前へ 20 度倒し、人差し指の付け根から小指の側の手首へ斜めに通す。
- 4 本の指は手の断面で筒に巻く。節を筒の中心から同じ距離の円の上に置き、骨の中点が筒から指の太さだけ離れる距離にする（`wrap_finger`）。
- 親指は中手骨を手のひらの側へ起こし、第 1、第 2 関節を腹の側の蝶番で曲げる。手のひらを見て、付け根から人差し指と中指の先の側へ斜めに横切り、腹がその 2 本の指を向く形。中手骨を軸のまわりに回しすぎると、先の骨が親指の側へ戻って向きが逆に見える。値は全キャラの頂点で探した既定の太さの 1 組で、太さに合わせて第 1、第 2 関節を開く。右手は鏡像。

計画の `handPose` で `fist`（必ず握る）と `source`（元の指を移す）を選べる。`handPose` と `gripDiameterCm` は `{"left": ..., "right": ...}` で手ごとに書ける（盾と剣、弓と矢のように両手で違うとき）。Warrior の指は `2Handed_Attack1` の全コマで動かないので、握りになる。元の値から親指を解く方法は、爪の向きから分かる親指の腹の向きが元の体と VRM で合わず、見た目で合格しなかった。

指が動く素材は次の移し方をする。4 本の指が閉じるコマ（中間の関節の屈曲の平均が 45〜75 度で段階的に）は、親指を握りの形へ寄せる。`handPose: source` と書いた手には行わない。

FBX の指は、骨の向きを T ポーズへ向ける最小の回転では関節の曲がる軸がそろわない。手首の軸のまわりの向きが残り（Warrior の左手で 9.6 度）、人差し指から小指の中間と遠位の関節が横へ 7.5 度曲がり、親指は関節の曲がる面が別の向きになる（親指の遠位で屈曲と同じ大きさの横の開き）。

`asset` の区間の指は次のように移す。

1. 手と指の骨ごとに、骨の軸、屈曲の軸、横の開きの軸の座標を元の体の基準の姿勢から作る。屈曲の軸は手のひらの法線から決める。親指は手のひらと小指の側の中間へ曲がる向き。
2. 親の座標から見た骨の座標の回転を、T ポーズの同じ座標へ置く。
3. 姿勢と動きを分ける。クリップの中央値の関節の回転を、関節ごとに屈曲の軸へ射影して範囲へ収め、固定の姿勢にする。中間と遠位と親指の第 1、第 2 関節は屈曲だけ。中央値からの動きはそのまま足し、緩い範囲だけをかける。
4. 固定の姿勢の親指の中手骨は手の前の向きから 45 度までに戻す。Warrior の親指は 100 度近く開いて手のひらの法線を向く（元の動きの値）。VRM の親指の付け根は手首に近いので、そのままだと親指が手首の側へ折れて柄に届かない。

範囲を超えたコマの数と移さなかった手は `generated.segments[].retarget.fingers` と `report.json` の `fingers`（`overFrames` は関節ごとの屈曲、横の開き、ひねりのコマの数、`skippedHands`）に出る。手の回転には触らないので、腕と握りは変わらない。指の骨が足りない手は前の移し方のまま。`text`、`video`、`vrma` の区間には当たらない。Warrior の指は 2Handed_Attack1 の全コマで動かない（変化 0.08 度以内）ので、握った形のまま。

## Blender の経路（fbx_to_vrma_blender.py）

計画から自動でつなぐときは `compose.py`（Python の移し替え）を使う。動きを Blender で開いて手で直すときは `tools/compose/fbx_to_vrma_blender.py` を使う。

```
blender --background --python-exit-code 1 --python tools/compose/fbx_to_vrma_blender.py -- --fbx A.FBX --rest B.FBX --vrm model.vrm --out out.vrma --grip right --speed 0.6 --save out.blend --info out.json
```

コンストレイントで VRM の骨を FBX に従わせてベイクし、VRM Add-on で VRMA を書く。`--grip` のときは、書いた VRMA を `--speed` のあとで `grip.solve_both` と同じ関数で解き直して上書きし、記録を `--info` の `grip` に残す。`--save` の .blend には解いたあとの動きを読み戻す（両手首の差の違いは 0.0002 cm）。手で直したら Add-on の VRMA の書き出しで出す。出したあとの VRMA は解き直さない。

VRM 0.0 の体は読まずに止まるので、先に vrma-pipeline の `tools/convert_vrm0_to_1.py` で変換する。`--out` は全部終わってから置き換えるので、途中で失敗しても前の出力が残る。

2 つの経路の両手首の間隔は同じ（コマごとの差 0.0001 cm）。手の向きを T ポーズへ向ける回転が違う（Python は REST の体、Blender は VRM の体の骨の向き）ので、ねじれの値は少し違う。

## つなぎ

- 置き方: 次の区間の最初のコマの体の向きを、前の区間の最後のコマの体の向きに合わせる。位置は、`gap`（m）を書けば体の前へその量だけ離す。省くと、つなぎの秒数と両端の hips の速さの平均から決め、1 m/s か前の区間の速さの大きい方までに抑える。
- MotionBricks: context は前の区間の最後の 4 コマ、target は次の区間の最初の 4 コマ。見本の動き（BVH）は使わない。中間形式から SOMA の 77 関節への変換で、VRM に無い関節（Spine2、Neck2、指など）は親の向きに従う。長さはトークンの数で決まり、書き出すコマは `4 × トークン - 8`（6〜16 トークン）。`allowed_token_counts` を 1 つに絞るので、長さは言った秒数に一番近い 4 コマ刻みの値になる。指は動かないので、前後の指の形から補間する（`fill_fingers`）。
- 補間: 回転は smootherstep の球面補間、hips は両端の速さを保つ 3 次の曲線。接地は 0。
- MotionBricks を使えないとき（つなぎが 0.53〜1.87 秒の外、区間が 4 コマ未満、計画で `interpolate`）は補間にして、`generated.bridges[].reason` に理由を書く。

## 継ぎ目の接地

継ぎ目（区間とつなぎの境、全部）の前後 1 コマは、4 列全部の接地を 0 にする（`clip.concat`）。接地の区間が継ぎ目をまたぐと、足の IK が足を留めたまま体だけが次の区間へ動く。

`root: inplace` の区間は接地を持たない（足が床を滑るのが動きそのもの。`docs/foot-ik.md`）。全区間が `inplace` なら `generated.options.root` も `inplace` にする。

## 記録

- `license`（`records.py`）: 区間とつなぎの条件を `terms` に並べる。MotionBricks のつなぎ（`BRIDGE_LICENSE`）の記録は `lib/model-licenses.json` の `motionbricksBridge` にある。`redistribution` は全部 true のときだけ true、`evaluationOnly` はどれかが true なら true。`summary` は一番厳しい区間の文を先に置き、ほかの文を続ける。厳しさは `lib/terms.mjs` の判定の順（評価用のみ > 個人利用 > 公開不可 > 二次配布不可）。
- `generated`: `tool: motion-compose`、区間の出どころ、つなぎの方法と時間、`spans`（コマの範囲）。

## 確かめの値（check.py）

REST の体で組み立てて測る。キャラに当てた値は `tools/motion_shots.mjs`。

| 項目 | 測り方 |
|---|---|
| `seams[].speedMaxMps` | 継ぎ目の前後 2 コマの、手・肘・足・爪先・頭・hips の速さの最大 |
| `seams[].speedChangeMaxMps` | 同じ範囲の 1 コマの速さの変化の最大 |
| `elsewhereP99` | 継ぎ目の前後 6 コマを除いたコマの、同じ値の 99 パーセンタイル |
| `footSlide` | 接地のコマの、足首と爪先の遅い方の水平の速さ（足の IK をかける前の値） |
| `hipsHeight` | 部分ごとの hips の高さの最小と最大 |
| `handInBody` | 手首か肘が胴の軸の 9 cm 以内に入ったコマの数。距離の測り方は `motion_shots.mjs` の `handInBody` と同じで、あちらは手首と肘を別々に数える |

## 画面からつなぐ（motion-recipe）

動きの画面の「モーションを足す」の「つくる」（`public/recipe-motion.mjs`）で 2 つ以上の区間を並べると、ジョブ `motion-recipe`（`lib/motion-recipe.mjs`）を積む。区間が 1 つのときは単体のジョブを積む（下の「つくるの区間が 1 つのとき」）。新しい生成の仕組みは無く、`compose.py` を子プロセスで呼ぶだけ。

- レシピ: 区間は保管場所のモーション（`{source: 'motion', motion, trim?, speed?}`）か、確認待ちのジョブの結果（`{source: 'job', job, n?, trim?, speed?}`）か、MotionBricks の条件（`{source: 'motionbricks', kind?, speed?, direction?, turn?, seconds?, action?, ending?, root?, trim?}`）で、2〜8 本。`job` は動画（`video-motion`）、MotionBricks（`motion-gen`）のジョブ。動画と MotionBricks は 1 本なので `n` を書かない。MotionBricks の条件は `motion-gen` と同じ規則で確かめて既定を埋め（`lib/motion-gen.mjs` の `motionGenConditions`）、そのまま計画の `motionbricks` の区間にする。その `speed` は動きの速さ（m/s）で、再生の速さは無い。`trim` の終わりは動く秒数を超えてよい（止まる分の長さは作るまで分からないので、`compose.py` が最後のコマに収める）。積めるのは確認待ち（`review: waiting`）のジョブだけで、取り込み済みなら取り込んだモーションを使う。`trim` は `[開始の秒, 終了の秒 か null]` でモーションの長さの中、`speed` は 0.25〜4。区間の間は `bridge: {seconds, method}`（0〜3 秒、`motionbricks` か `interpolate`。既定は 1.2 秒の MotionBricks）。全体の `bridge` が既定で、区間の `bridge` はその区間の前のつなぎ。
- ジョブの結果の読み方: 取り込みと同じファイルと利用条件を読む。動画は `jobs/<ジョブ>/out/clip/clip.vrma` と `contacts.json`、利用条件はジョブの結果の `license`（個人利用のみ）。MotionBricks は `jobs/<ジョブ>/motion.vrma` と `contacts.json`、利用条件はジョブの結果の `license`（評価用のみ）。条件は書き換えずに `compose.py` へ渡すので、評価用や個人利用の条件はそのまま全体の条件になる。利用条件の記録が無いジョブは積めない（推測で埋めない）。
- 実行の直前の検査: 「区間を確かめる」で、ジョブがまだあり確認待ちか取り込み済みで、結果のファイルが残っていることを確かめ、作業フォルダの `segments/<番号>/` へ VRMA、接地、`license.json` を写してから使う。写したあとは元のジョブが捨てられても取り込まれても動く。捨てたジョブや、消えた候補のファイルは `compose.py` を呼ぶ前に失敗にする。
- 記録: ジョブの結果の区間は、`generated.segments[].motionRecord` に保管場所のモーションと同じ形（`id` は null、`library`、写した VRMA の `sha256`、`source` の `path` は元のファイルの保管場所からの相対パスと `pack`、`contacts`）で残し、`job` に `{id, type, candidate}`（動画は `candidate: null`）を足す。
- ジョブ: 計画（`plan.json`。区間は `vrma` で、保管場所のモーションは `motion`、ジョブの結果は写した `path`、`contacts`、`license`、`motionRecord`。MotionBricks の条件は `motionbricks` で条件をそのまま書く。名前は「番号: 名前」）を書いて `compose.py` を呼ぶ。外の道具の場所は設定から環境変数で渡す（`MOTIONBRICKS_DIR` は `motionbricksDir`、`VRMA_PIPELINE_DIR` は `vrmaPipelineDir`、`VRMA_BLENDER` は `blender`、`CHARASTA_LIBRARY` は保管場所）。`uv` の場所は `CHARASTA_UV`。時間の上限は 15 分（`CHARASTA_MOTION_RECIPE_TIMEOUT_MS`）。`CHARASTA_FAKE_MOTIONBRICKS` では `--fake` を付ける（MotionBricks の区間は作りものの動き、つなぎは補間）。MotionBricks の条件の区間があると、つなぎが補間でも MotionBricks が要る。見つからなければ `compose.py` を呼ぶ前に失敗にする。
- 結果は確認待ち（`review: waiting`）。画面は `GET /api/motion-recipes`（選べる値、確認待ち、区間に使える確認待ちの結果 `sources`。動画は 1 本で、`{job, n, type, kind, name, durationSec, license, limit}`）、`/api/motion-recipes/<ジョブ>/motion.vrma` と `contacts.json`（確認待ちの間だけ配る）を読み、ビューアの `playCandidate` で再生する。`report.json` の `seams`、`elsewhereP99`、`footSlide`、`hipsHeight`、`handInBody` を並べる。
- 取り込む（`POST /api/motion-recipes/<ジョブ>/import`）: `lib.importMotion` で `compose-<ジョブ>` に入れる。`license` は `license.json`、接地は `contacts.json`、`generated` は `generated.json` に `job`、`fake`、`recipe`（積んだレシピ）、`report`（`report.json` の全部）を足したもの。区間のモーションの `motion.json` は書き換えない（ADR 0002）。捨てる（`.../discard`）は作業フォルダを保管場所の `trash/motion-recipe-<ジョブ>` へ移す。
- 順番待ちか実行中のレシピが使うモーションは、ごみ箱へ移せない。同じく、順番待ちか実行中のレシピが区間に使う確認待ちのジョブは捨てられない（`busy`、409）。
- 画面: 「つくる」は区間の種類（MotionBricks の条件、動画、保管場所のモーション、確認待ちの結果（取り込む前））を選んで「足す」。保管場所のモーションと確認待ちの結果は一覧から選ぶ。MotionBricks の条件、動画は、区間の中に今までの条件のフォームが開く（`public/gen-motion.mjs` の `genFields`、`public/video-motion.mjs` の `videoFields`）。並べたあとに元のジョブを取り込んだか捨てた区間は、注意を出す。
- つくるの区間が 1 つのとき: 動画は `video-motion`、MotionBricks の条件は `motion-gen` をそのまま積む（ボタンは「動画から作る」「MotionBricks で作る」）。結果と確認の流れはそれぞれのジョブのまま。保管場所のモーションか確認待ちの結果が 1 つだけのときは積まない。
- 動画の区間は、2 つ以上並べたときには使えない（ボタンを押せなくし、「先にその区間だけで作り、確認の欄に出た結果を確認待ちの結果として足す」と出す）。動画の区間のジョブを先に積み、終わってから結果を区間にしたレシピを積む形は、ジョブの間の待ち合わせと失敗の扱いが要るので、今回は作らなかった。MotionBricks の条件は `compose.py` の中で作るので、2 つ以上でも使える。
- 許諾: 評価用のみの区間（MotionBricks で作ったモーション、MotionBricks の条件の区間、MotionBricks のジョブの結果）が入ると全体が評価用のみになる。MotionBricks のつなぎ（`BRIDGE_LICENSE`）は二次配布 不可で、見本の動きを使わないので評価用にはしない。画面は積む前にこの 2 つを出す。

## GPU

MotionBricks は TensorRT の GPU、撮影は ANGLE d3d11、エンコードは h264_nvenc を優先する。`compose.py` の numpy の計算は 1 本で 1 秒ほどなので、torch の CUDA へ移す必要が無い。

## テスト

`test/compose.test.mjs`、`test/compose_check.py`、`test/motion-recipe.test.mjs`（MotionBricks の条件の区間の確かめ、`--fake` でつなぐ、条件の確かめが `lib/motion-gen.mjs` と同じこと）、`test/grip_arms_check.py`、`test/neck_check.py`、`test/fingers_check.py`、`test/weapon_solve_check.py`。Blender、MotionBricks は呼ばない（MotionBricks の条件の区間は `--fake` の作りものの動き）。`fbx_to_vrma_blender.py` のベイクは自動のテストに入っていない。解き直しの `grip.solve_vrma` だけを確かめる。`--fake` はつなぎを補間にする。

## 残っている問題

- `fingers.py` は Python の経路だけ。
- 筒の寸法は VRoid の手の比で決める。手の比が違うキャラでは、親指の腹が指を向かないことや、人差し指と小指が筒へ入ることがある。
- `neck.py` は Python の経路だけ。`fbx_to_vrma_blender.py` の動きの首と胴は元のまま。`elbowPrior` は Python の経路だけ。
- 元の動きが 1 コマで大きく跳ぶところは残る。2Handed_Attack1 の f18 から f19 で、胸から見た頭の変化は 93 度から 74.5 度に減るが、上限は設けていない。speed で緩める。
- 既定は左肘が横へ開く（左肘の外の成分の中央 0.83、元の体 0.33）。`elbowPrior` で直るが、見た目で採用しなかった。
- VRMA に武器は入らない。手の動きだけが移る。武器のメッシュを動きに入れるのは素材の規約の確認が要る。
- `weapon` は打ち終わりの右手首が 90 度を超えて折れる。
- `weapon` は `compose.py` の経路だけで、Blender の経路（`fbx_to_vrma_blender.py`）には入っていない。
- `weapon` は素材が 1 本（2Handed_Attack1）と体が 2 つ（avatar-sample-a、b）でしか確かめていない。腕と武器の衝突は測っていない。
- アセットの速い動きは 1 コマで手が大きく動く。`speed` で緩める。
- `grip` は `model` の体に合わせる。ほかのキャラに当てると両手の位置はずれる。
- `grip` は持つ手の位置を動かす（`weaponMoveCm`）。武器が体や地面に当たるかは測らない。測るには `weapon` を使う。
- 動画の VRMA は対象のキャラの体に合わせてある。つないだあとの手の位置は別のキャラではずれる（`fittedTo` は記録しない）。
- つなぎの間に、体の向きが 180 度近く違う区間をつなぐと、MotionBricks の向きの解決は確かめていない（向きは前の区間に合わせるので、ふつうは起きない）。
