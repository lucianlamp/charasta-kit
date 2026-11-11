// チビの検査(docs/character-style.md)。バージョンの model.vrm と model-lite.vrm を測り、項目ごとに ok / warn / unknown と測った値を返す。
// measureGlb: glb の JSON と、画像の幅と高さ(画像のバイト列の先頭だけを読む)と、ファイルの大きさを取る。
// chibiCheck: 測った値から項目を作る。項目の形は lib/vroid-format.mjs の item() と同じ { id, label, level, detail }(level に unknown がある)。
// 目安の出典は docs/character-style.md の「チビの検査の目安」。
import fs from 'node:fs/promises';
import {LibraryError} from './library.mjs';
import {faceOf} from './face-check.mjs';
import {profileOf} from './vroid-format.mjs';

// スマホのメインキャラ 1 体の三角形の合計の目安: 1.5 万〜1.8 万(charakuru-claude-code-with-kimi の references/game-ready.md「目安」)
export const TRIANGLES_RANGE = [15000, 18000];
// 軽量版の画像の上限(tools/make_lite.py の既定): 元の画像の一辺が 4096 を超えるもの(顔テクスチャなど)は 4096 まで、それ以外は 2048 まで縮める
export const BODY_MAX_SIDE = 2048, ATLAS_MAX_SIDE = 4096;
const HEAD_BYTES = 256 * 1024;   // JPEG の SOF は EXIF や ICC の後ろにあるので、先頭から広めに読む

// 画像のバイト列の先頭から [幅, 高さ] を読む。PNG と JPEG だけ。読めなければ null
export function imageSize(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

export async function measureGlb(file) {
  const fh = await fs.open(file, 'r');
  try {
    const bytes = (await fh.stat()).size, head = Buffer.alloc(20);
    await fh.read(head, 0, 20, 0);
    if (head.toString('latin1', 0, 4) !== 'glTF') throw new LibraryError('bad-input', 'glb ではない: ' + file);
    const jl = head.readUInt32LE(12), body = Buffer.alloc(jl);
    await fh.read(body, 0, jl, 20);
    const js = JSON.parse(body.toString('utf8')), binStart = 20 + jl + 8;
    const images = [];
    for (const im of js.images ?? []) {
      const bv = js.bufferViews?.[im.bufferView];
      let size = null;
      if (bv) {
        const buf = Buffer.alloc(Math.min(bv.byteLength, HEAD_BYTES));
        await fh.read(buf, 0, buf.length, binStart + (bv.byteOffset ?? 0));
        size = imageSize(buf);
      }
      images.push({name: im.name ?? '', mime: im.mimeType ?? null, w: size?.[0] ?? null, h: size?.[1] ?? null});
    }
    return {bytes, js, images};
  } finally { await fh.close(); }
}

const item = (id, label, level, detail) => ({id, label, level, detail});
const mb = n => (n / 1048576).toFixed(1) + ' MB';
const readable = m => m.images.length > 0 && m.images.every(i => i.w && i.h);
const maxSide = m => Math.max(0, ...m.images.map(side));
const gpuBytes = m => m.images.reduce((t, i) => t + (i.w ?? 0) * (i.h ?? 0) * 4, 0);
const side = i => Math.max(i.w ?? 0, i.h ?? 0);
// make_lite.py と同じ決め方: 元の画像(model.vrm の同じ番号)の一辺が 4096 を超えれば 4096、それ以外は 2048
const capOf = (i, k, model) => (side(model.images[k] ?? i) > ATLAS_MAX_SIDE ? ATLAS_MAX_SIDE : BODY_MAX_SIDE);
const texText = m => `${m.images.length} 枚、最大 ${maxSide(m)} px、展開すると ${mb(gpuBytes(m))}（幅×高さ×4 バイト）`;

// model: measureGlb の結果、lite: 軽量版の測定(無ければ null)、chibi: 文に出すスタイルの名前(キットはチビ体型、public/edition.mjs)
export function chibiCheck(model, lite, {chibi = 'チビ'} = {}) {
  const out = [], prof = profileOf(model.js), face = faceOf(model.js);
  // 1. 軽量版
  out.push(lite
    ? item('lite', '軽量版(model-lite.vrm)がある', 'ok', `model.vrm ${mb(model.bytes)}、model-lite.vrm ${mb(lite.bytes)}`)
    : item('lite', '軽量版(model-lite.vrm)がある', 'warn', `無い（model.vrm は ${mb(model.bytes)}）。python tools/make_lite.py model.vrm model-lite.vrm で作る（画像を縮めて組み直す。形、骨、表情はそのまま）`));
  // 2. 三角形の数
  const [lo, hi] = TRIANGLES_RANGE, liteTris = lite ? profileOf(lite.js).tris : null;
  out.push(item('triangles', `三角形の合計が ${lo}〜${hi} 以下（スマホのメインキャラ 1 体の目安）`, prof.tris <= hi ? 'ok' : 'warn',
    `${prof.tris}${liteTris != null && liteTris !== prof.tris ? `(軽量版は ${liteTris})` : ''}`));
  // 3. 材質の数: 数の目安は資料に無い
  const mats = (model.js.materials ?? []).length;
  out.push(item('materials', '材質の数', 'unknown', `${mats} 個（目安の値は資料に無い）`));
  // 4. テクスチャ: 軽量版があればそれを、無ければ model.vrm を上限(make_lite.py の既定)と比べる
  const judged = lite ?? model;
  const sameCount = judged.images.length === model.images.length;
  const over = judged.images.filter((i, k) => i.w && i.h && side(i) > capOf(i, k, model));
  const compare = lite ? `model.vrm は ${texText(model)}。model-lite.vrm は ${texText(lite)}` : `model.vrm は ${texText(model)}`;
  out.push(item('textures', `テクスチャの一辺が軽量版の上限以下（元が ${ATLAS_MAX_SIDE} 超なら ${ATLAS_MAX_SIDE}、それ以外 ${BODY_MAX_SIDE}）`,
    !readable(judged) || !sameCount ? 'unknown' : over.length ? 'warn' : 'ok',
    !readable(judged) || !sameCount ? `${sameCount ? '画像の大きさを読めなかった' : 'model.vrm と model-lite.vrm の画像の数が違う'}。${compare}`
      : `${compare}${over.length ? `。上限を超える画像: ${over.map(i => `${i.name || '(名前なし)'} ${i.w}×${i.h}`).slice(0, 4).join('、')}${over.length > 4 ? ` ほか ${over.length - 4}` : ''}${lite ? '' : '(軽量版を作ると縮む)'}` : ''}`));
  // 5. 表情の方式: FaceAtlas の画像か Face_layers の節があれば画像の方式。Fcl_ のキーがあればシェイプキー。どちらも無ければ分からない
  out.push(item('expression', '表情が顔テクスチャ（画像）の方式', face.method === 'atlas' ? 'ok' : face.method === 'shapekey' ? 'warn' : 'unknown',
    face.method === 'atlas' ? '顔テクスチャ（FaceAtlas の画像か Face_layers がある）'
      : face.method === 'shapekey' ? `シェイプキーの方式（Fcl_ のキー ${face.keys.length} 個）。${chibi}は顔テクスチャの想定`
        : '顔テクスチャの手がかり（FaceAtlas の画像、Face_layers）も Fcl_ のキーも無い'));
  return out;
}

export const summaryOf = items => ({ok: items.filter(i => i.level === 'ok').length, warn: items.filter(i => i.level === 'warn').length,
  ng: items.filter(i => i.level === 'ng').length, unknown: items.filter(i => i.level === 'unknown').length, total: items.length});
