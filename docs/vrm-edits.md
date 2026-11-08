# VRM の体を直す

キャラの体の比率は、VRM の glTF を直接書き換えて直す。Blender で読み込んで書き出すと、揺れ骨とコライダーの設定が崩れることがあるため（コライダーの警告が出る）。直した VRM は新しい版として取り込む。版は上書きしない。

```bash
node scripts/import-version.mjs --char <キャラ> --id <新しい版> --label "<何を直したか>" --src out.vrm --latest
python tools/make_lite.py <版>/model.vrm <版>/model-lite.vrm
node tools/thumb.mjs --char <キャラ> --ver <新しい版>
```

体を変えた版では、版に合わせて焼いたモーション（手のめり込みの直し、足を床に付ける焼き込み）を測り直す。

## 首の長さ（`tools/vrm/neck_len.py`）

```bash
python tools/vrm/neck_len.py in.vrm --probe                                  # 首と頭の骨の高さ
python tools/vrm/neck_len.py in.vrm out.vrm --delta 0.0075 --band 1.262 1.272
```

- `--band z0 z1`（m、VRM の座標）の区間を縦に伸ばし（`--delta` が正）、縮める（負）。z1 より上は `--delta` だけ上がる。区間の中は smoothstep でつなぐので段は付かない。区間は首の見えている所（あごの下から襟の上）にとる。
- 頭の骨とその子（髪の揺れ骨、目）の節点を動かし、逆バインド行列も同じだけ平行移動する。静止の形は変わらない。
- 頂点は、`--tube-meshes`（既定 `Body`。首と胴が 1 枚のメッシュ）では首の筒（頭の骨から水平に `--radius` 0.035 m 以内）と z1 より上だけの部品（帽子など）を動かし、肩や襟は動かさない。ほかのメッシュ（顔、髪）は全部の頂点を高さで動かす（区間より下は動かない）。
- モーフの差分は変えない。コライダーは骨の子なので骨と一緒に動く。

## primitive をまとめる(`tools/vrm/merge_prims.py`)

```bash
python tools/vrm/merge_prims.py in.vrm out.vrm --mesh Face_layers
```

同じメッシュの中で、材質、属性、モーフの数が同じ primitive を 1 個にまとめる。three.js は primitive を 1 個ずつ別の描画にするので、顔の層が 60 個に分かれていると draw call が 60 増える。頂点、UV、骨の重み、モーフの差分は連結するだけで、メッシュの番号とモーフの順は変わらないため、表情の割り当てはそのまま動く。使わなくなったデータは詰めて書く。

## UV の余白を島の縁の色で埋める(`tools/vrm/uv_pad.py`)

```bash
python tools/vrm/uv_pad.py in.vrm --mesh Face --ymin 1.18 --ymax 1.36 --probe     # 変わる画素の数だけ出す
python tools/vrm/uv_pad.py in.vrm out.vrm --mesh Face --ymin 1.18 --ymax 1.36 [--pad 16] [--debug dir]
```

テクスチャを塗り直す道具が UV の島の中だけを塗ると、島の外の余白に元の色が残る。描くときの双一次の補間とミップマップで余白の色が島の縁ににじみ、UV の継ぎ目が細い線になって見える。この道具は、どの三角形にも中心を覆われない画素のうち、島から `--pad` 画素(既定 16)以内のものを、いちばん近い覆われた画素の色にする。覆われた画素(島の中)は変えない。`--ymin`/`--ymax`(m、VRM の座標の高さ)を渡すと、その高さの三角形の近くの余白だけを埋める。画像のバイトだけを差し替えるので、頂点、骨、モーフ、揺れ骨は変わらない。
