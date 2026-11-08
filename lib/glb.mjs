// glTF バイナリ(.glb / .vrm / .vrma)の読み書き。accessor を型付き配列で読み、使われていない accessor と bufferView を詰めて書き直す。
// 読む側は lib/vrma.mjs が、書く側は lib/game-export.mjs と tools/vrm/decimate.mjs が使う。
export const COMPONENT = {
  5120: {size: 1, array: Int8Array, get: 'getInt8'}, 5121: {size: 1, array: Uint8Array, get: 'getUint8'},
  5122: {size: 2, array: Int16Array, get: 'getInt16'}, 5123: {size: 2, array: Uint16Array, get: 'getUint16'},
  5125: {size: 4, array: Uint32Array, get: 'getUint32'}, 5126: {size: 4, array: Float32Array, get: 'getFloat32'},
};
export const TYPE_WIDTH = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16};

export function parseGlb(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') throw new Error('glb ではない');
  const total = Math.min(buf.readUInt32LE(8), buf.length);
  let p = 12, json = null, bin = null;
  while (p + 8 <= total) {
    const len = buf.readUInt32LE(p), type = buf.readUInt32LE(p + 4), start = p + 8;
    if (type === 0x4e4f534a) json = JSON.parse(buf.toString('utf8', start, start + len));
    else if (type === 0x004e4942 && !bin) bin = buf.subarray(start, start + len);
    p = start + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('glb に JSON チャンクが無い');
  return {json, bin};
}

// JSON と BIN から glb を組む。JSON は空白で、BIN は 0 で 4 バイトにそろえる
export function buildGlb(json, bin) {
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const parts = [js];
  let binLen = 0;
  if (bin && bin.length) {
    const pad = Buffer.alloc((4 - (bin.length % 4)) % 4);
    parts.push(Buffer.from(bin.buffer, bin.byteOffset, bin.length), pad);
    binLen = bin.length + pad.length;
  }
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + js.length + (binLen ? 8 + binLen : 0), 8);
  head.writeUInt32LE(js.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const out = [head, ...parts.slice(0, 1)];
  if (binLen) {
    const bh = Buffer.alloc(8); bh.writeUInt32LE(binLen, 0); bh.writeUInt32LE(0x004e4942, 4);
    out.push(bh, ...parts.slice(1));
  }
  return Buffer.concat(out);
}

// accessor を、型そのままの平らな型付き配列で読む(正規化はしない)。byteStride があれば詰めて返す。sparse は未対応
export function readAccessor(json, bin, index) {
  const a = json.accessors?.[index];
  if (!a) throw new Error(`accessor ${index} が無い`);
  if (a.sparse) throw new Error('sparse accessor には対応していない');
  const comp = COMPONENT[a.componentType], width = TYPE_WIDTH[a.type];
  if (!comp || !width) throw new Error(`accessor ${index} の型が分からない`);
  const out = new comp.array(a.count * width);
  if (a.bufferView == null) return out;   // 全部 0
  const bv = json.bufferViews[a.bufferView], base = (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride || comp.size * width;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < width; k++) out[i * width + k] = dv[comp.get](base + i * stride + k * comp.size, true);
  return out;
}

// 正規化の整数を 0..1(符号付きは -1..1)の浮動小数にする
export function toFloat(arr, componentType, normalized) {
  if (arr instanceof Float32Array || !normalized) return Float32Array.from(arr);
  const max = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535}[componentType];
  return Float32Array.from(arr, v => Math.max(-1, v / max));
}

// メッシュ・皮・アニメーションが指す accessor の番号の集合
function usedAccessors(json) {
  const used = new Set();
  for (const m of json.meshes ?? []) for (const p of m.primitives) {
    for (const v of Object.values(p.attributes)) used.add(v);
    if (p.indices != null) used.add(p.indices);
    for (const t of p.targets ?? []) for (const v of Object.values(t)) used.add(v);
  }
  for (const s of json.skins ?? []) if (s.inverseBindMatrices != null) used.add(s.inverseBindMatrices);
  for (const an of json.animations ?? []) for (const sm of an.samplers) { used.add(sm.input); used.add(sm.output); }
  return used;
}

// 新しい accessor を足す。data は型付き配列(componentType に合う型)。bufferView は pending に貯め、compactGlb が書く
export function addAccessor(json, pending, data, {componentType, type, target, normalized = false, minmax = false}) {
  const width = TYPE_WIDTH[type], count = data.length / width;
  json.bufferViews ??= []; json.accessors ??= [];
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  json.bufferViews.push({buffer: 0, byteLength: bytes.length, ...(target && {target})});
  pending.set(json.bufferViews.length - 1, bytes);
  const acc = {bufferView: json.bufferViews.length - 1, componentType, count, type, ...(normalized && {normalized: true})};
  if (minmax) {
    acc.min = Array(width).fill(Infinity); acc.max = Array(width).fill(-Infinity);
    for (let i = 0; i < count; i++) for (let k = 0; k < width; k++) { const v = data[i * width + k]; if (v < acc.min[k]) acc.min[k] = v; if (v > acc.max[k]) acc.max[k] = v; }
  }
  json.accessors.push(acc);
  return json.accessors.length - 1;
}

// 使われている accessor と画像の bufferView だけを残し、BIN を詰め直す。pending: 新しく足した bufferView の中身(番号 -> Uint8Array)
export function compactGlb(json, bin, pending = new Map()) {
  const used = [...usedAccessors(json)].sort((a, b) => a - b), amap = new Map(used.map((o, n) => [o, n]));
  const accs = used.map(o => json.accessors[o]);
  if (accs.some(a => a.sparse)) throw new Error('sparse accessor には対応していない');
  const viewIds = new Set([...accs.filter(a => a.bufferView != null).map(a => a.bufferView), ...(json.images ?? []).filter(i => i.bufferView != null).map(i => i.bufferView)]);
  const chunks = [], bmap = new Map(), views = [];
  let len = 0;
  for (const o of [...viewIds].sort((a, b) => a - b)) {
    const bv = {...json.bufferViews[o]};
    const data = pending.get(o) ?? bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const pad = (8 - (len % 8)) % 8;
    if (pad) { chunks.push(Buffer.alloc(pad)); len += pad; }
    bv.byteOffset = len; bv.byteLength = data.length; bv.buffer = 0;
    chunks.push(Buffer.from(data.buffer, data.byteOffset, data.length)); len += data.length;
    bmap.set(o, views.length); views.push(bv);
  }
  for (const a of accs) if (a.bufferView != null) a.bufferView = bmap.get(a.bufferView);
  for (const im of json.images ?? []) if (im.bufferView != null) im.bufferView = bmap.get(im.bufferView);
  json.accessors = accs; json.bufferViews = views; json.buffers = [{byteLength: len}];
  const remap = d => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, amap.get(v)]));
  for (const m of json.meshes ?? []) for (const p of m.primitives) {
    p.attributes = remap(p.attributes);
    if (p.indices != null) p.indices = amap.get(p.indices);
    if (p.targets) p.targets = p.targets.map(remap);
  }
  for (const s of json.skins ?? []) if (s.inverseBindMatrices != null) s.inverseBindMatrices = amap.get(s.inverseBindMatrices);
  for (const an of json.animations ?? []) for (const sm of an.samplers) { sm.input = amap.get(sm.input); sm.output = amap.get(sm.output); }
  return Buffer.concat(chunks);
}
