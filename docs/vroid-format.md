# VRoid 形式(Tripo Studio で作ったキャラを VRoid と同じ中身にする)

きゃらくる(Tripo Studio)で作ったキャラの VRM を、VRoid Studio 1.26 のモデルと同じ中身の作りにそろえる。そろえると、VRoid 向けの表情、視線、モーション、揺れものの扱いがそのまま使える。

解析の元: VRoid Hub の公式サンプル 7 体(1.26 の AvatarSample A、B、C と β 版 4 体)。

## 何をそろえるか

中身の作りを VRoid と同じにする。髪の形は Tripo のまま(VRoid の帯の束には作り直さない)。顔は 57 個の Fcl のキー。キーはきゃらくるの表情を移して作るのが標準(下の「きゃらくるの表情をそのまま使うとき」)で、自前の部品(own4 の方法)は予備。表情の方式の使い分けは `docs/expression-studio.md` の「表情の方式の使い分け」。

| 項目 | VRoid 1.26 の作り | 検査の ID |
|---|---|---|
| メッシュ | `Face`、`Body`、`Hair` の 3 つ(名前の頭) | `meshes` |
| 材質の名前 | `N00_000_00_Face_00_SKIN` の形。末尾の種類は SKIN、FACE、EYE、CLOTH、HAIR | `material-names` |
| 材質の置き場所 | 顔の部品は Face、体と服は Body、髪は Hair | `material-place` |
| 顔の部品 | 口の中(FaceMouth)、虹彩(EyeIris)、ハイライト(EyeHighlight)、顔の肌(Face_00_SKIN)が別の材質 | `face-parts` |
| 表情のキー | Face に `Fcl_` の 57 個を、手本と同じ名前と順で | `fcl-keys` |
| プリセット | 14 個(neutral、blink×3、happy など 5、aa など 5)が Fcl のキーを 1 つずつ 100% で呼ぶ | `presets` |
| 視線 | lookAt は bone。目の骨は `J_Adj_L_FaceEye`、`J_Adj_R_FaceEye` | `look-at` |
| 骨 | Humanoid の 54 本が `J_Bip_*`(手本と同じ名前) | `bones` |
| 揺れ骨 | `J_Sec_*`。髪は `J_Sec_Hair<組>_<番号>` | `spring-names` |
| 揺れものの値 | 髪: 硬さ 0.70〜0.85、抵抗 0.4。スカート: 0.5、0.05。胸: 0.75、0.05 | `spring-values` |
| コライダー | 12 本の骨に球: 背骨 1、胸 3、首 1、頭 1、上腕 3、前腕 4、手 1、太もも 3(左右) | `colliders` |
| MToon | 顔の影の位置 -0.05(ほぼ影なし)、体と服 1.0、髪 -0.35。輪郭線はそろえない(下) | `mtoon` |
| 三角形 | 約 3 万(手本 29,221〜32,847)。1.5 倍を超えると △ | `triangles` |

## 検査

```bash
node scripts/vroid-check.mjs check --char <キャラ> [--ver <版>]   # 保管場所の版
node scripts/vroid-check.mjs check --file <model.vrm> [--json]
node scripts/vroid-check.mjs reference --file <A> --file <B> --file <C>   # 手本を作り直す
```

- 手本は `studio/vroid/reference.json`。AvatarSample A、B、C から作った。キー 57、骨 54、コライダーの骨 12。手本どうしでキーか骨の名前が違うと作らない。
- 読むのは VRM の JSON の部分だけ(`lib/vroid-format.mjs` の `profileOf`)。保管場所にもファイルにも書かない。
- 結果は項目ごとに ○(合う)、△(作りは合うが値か数が違う)、×(作りが違う)。

## 組み立ての手順

1. きゃらくる(`charakuru-claude-code`、Tripo Studio)で rig 工程まで作る。表情工程まで進めるなら、手順 2 の代わりに下の「きゃらくるの表情をそのまま使うとき」へ進む。自前の顔(予備)にするなら表情工程はやらず、頭の殻に後頭部が無ければ内張りは手順 2 の組み立てで足す。
2. 予備の道: 顔の部品と Fcl の 57 個を自前で作る(`docs/vroid-face.md`、道具は `studio/vroid/face_own/`)。目の骨は J_Adj_L/R_FaceEye、視線は bone になる。
3. 変換: `node scripts/vroid-conform.mjs --in <顔を作った VRM> --out <VRoid 形式の VRM> [--map <材質の対応>] [--report <json>]`(`lib/vroid-conform.mjs`)。
   - Humanoid の骨を手本の J_Bip の名前へ、揺れ骨を J_Sec_ へ(髪 `J_Sec_Hair<深さ>_<番号>`、スカート `J_Sec_Skirt<深さ>_<列>`、末尾は `_end`)。
   - 揺れものの値を VRoid へ(髪 0.8 / 0.4 / 0、スカート 0.5 / 0.05 / 0、胸 0.75 / 0.05 / 0。当たりの半径は元のまま)。
   - コライダーを捨てて、手本 B の 12 本の骨の配置(球 28 個)を体の大きさの比で移す。置き方は `reference.json` の `colliderLayout`(`reference --layout <B>`)。髪は脚以外の 10 組、スカートは太ももの 2 組と当たる。
   - 材質の名前を VRoid の形へ(既定の対応は `lib/vroid-conform.mjs`、決まらない材質があれば止まる)。MToon の影の値を部品ごとに手本へ。輪郭線は元のまま残す。VRoid の線(1.2 mm、世界座標)は場所ごとの太さのテクスチャで細くしたり消したりしているので、太さの値だけ写すと Tripo の細い房の 1 本ずつに太い黒い線が付いた(そのため付けない)。
   - メッシュを Face・Body・Hair にまとめる(同じスキンと変換のノードだけ。モーフの有無が混ざるときは分ける)。BIN は変えない。
   - 輪郭線を付けるときは `--outline <mm>`(標準は 0.8)。髪だけは 0.4 mm(`--hair-outline <mm>` で変えられる)。目、口、眉の部品は線なし、顔の肌とそのほかはその太さで、色は VRoid の暗い赤茶。きゃらくるの頭は顔が 1 つの材質なので、このままだと目と鼻にも線が出る。続けて `python studio/vroid/outline_mask.py <変換後> <出力> --eyes <左の虹彩 x>,<右の虹彩 x>,<高さ>`(m)で、目、鼻、口のまわりの線を消し、あごと頬の輪郭だけに残す(VRoid と同じく太さのテクスチャを使う)。きゃらくるの目の骨は回転の中心で虹彩より内側にあるので、虹彩の位置は正面の撮影で測って渡す。
4. `node scripts/vroid-check.mjs check --file <出力>` で × が 0 か確かめ、版として取り込む。

## きゃらくるの表情をそのまま使うとき(顔を作り直さない。通常の頭身の標準)

VRoid に近い頭身のキャラはこの道で作る(ちびは顔画像の方式で、`docs/expression-studio.md` の「表情の方式の使い分け」)。このときは手順 2 の代わりに、きゃらくるの表情工程まで進めた VRM を使う。

1. `python studio/vroid/kit_fcl.py <きゃらくるの表情付き VRM> <出力>`: キットの EA_ のキーから Fcl の 57 個を作り、14 のプリセットを Fcl のキー 1 つ 100% に付け替える。`Fcl_ALL_Joy` は `EA_happy_eye`、`EA_happy_mouth`、`EA_brow_happy` の和のように、キットのプリセットが足していたキーを足して作るので、表情の見た目は変わらない。`Fcl_EYE_Joy` はキットの `EA_blink_smile`。牙(`Fcl_HA_`)、`Fcl_MTH_Large` などキットに無い動きは動かないキーになる。1 つの Fcl に当たらない `EA_happy_eye` は 57 個の後ろに残り、それを呼ぶ独自の表情も残る(`fcl-keys` は △)。頭と同じメッシュにあってキーが全部 0 の面(Tripo の頭に入っている飾り)は、キーの無い別のメッシュとノードに分ける。分けないと変換で Body が 2 つになる(`meshes` が △)。
2. 手順 3 の変換(`--outline 0.8`)と outline_mask。
3. 検査。`face-parts` の × は残る。目やまつ毛が別のメッシュで EA_ のキーを持つ頭は、kit_fcl が止める(顔が 1 つのメッシュの頭だけを扱う)。キットの顔は 1 つの材質で、口の中、虹彩、ハイライトの板が無いため。

確かめは `python test/kit_fcl_check.py`。
