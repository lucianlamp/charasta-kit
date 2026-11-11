// きゃらくるの VRM 1.0 を VRoid Studio と同じ中身の作りにそろえる変換(docs/vroid-format.md の「変換の手順」の 2 と 4)。
// conformVrm: GLB のバッファを受け、JSON だけを書き換えた新しい GLB を返す。BIN の部分はそのまま書き戻す。
// colliderLayout: 手本の VRM から、コライダーの球の置き方(骨の線分上の割合と、線分に直角な位置を体の大きさで割った値)を取り出す。reference.json の colliderLayout に入る。
// 変換の順: 骨の名前 -> 揺れ骨の名前と値 -> コライダー -> 材質の名前 -> MToon -> メッシュのまとめ -> ノードの詰め直し。
import path from 'node:path';
import {partOf, springKind, MATERIAL_RE} from './vroid-format.mjs';

export class ConformError extends Error {
  constructor(message, stops = [message]) { super(message); this.name = 'ConformError'; this.stops = stops; }
}
const stop = (m, stops) => { throw new ConformError(m, stops); };

// ---- GLB の読み書き ----
export function parseGlb(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') stop('glb ではない');
  const total = buf.readUInt32LE(8);
  if (total !== buf.length) stop(`glb の長さが合わない（ヘッダ ${total}、実際 ${buf.length}）`);
  const chunks = [];
  for (let o = 12; o < buf.length;) {
    const n = buf.readUInt32LE(o), type = buf.toString('latin1', o + 4, o + 8);
    chunks.push({type, data: buf.subarray(o + 8, o + 8 + n)});
    o += 8 + n;
  }
  if (chunks[0]?.type !== 'JSON') stop('先頭のチャンクが JSON ではない');
  return {json: JSON.parse(chunks[0].data.toString('utf8')), rest: chunks.slice(1)};
}
// BIN など JSON 以外のチャンクは、長さも中身もそのまま書く
export function buildGlb(json, rest) {
  let body = Buffer.from(JSON.stringify(json), 'utf8');
  body = Buffer.concat([body, Buffer.alloc((4 - body.length % 4) % 4, 0x20)]);
  const parts = [chunk('JSON', body), ...rest.map(c => chunk(c.type, c.data))];
  const head = Buffer.alloc(12);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + parts.reduce((t, p) => t + p.length, 0), 8);
  return Buffer.concat([head, ...parts]);
}
function chunk(type, data) {
  const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.write(type, 4, 'latin1');
  return Buffer.concat([h, data]);
}

// ---- 行列(列の順、glTF と同じ) ----
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
function localMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
}
function invertAffine(m) {
  // 列の順の m: 列 0 = m[0..2]、列 1 = m[4..6]、列 2 = m[8..10]。3x3 の部分を A(行 r、列 c)として逆にする
  const a = m[0], d = m[1], g = m[2], b = m[4], e = m[5], h = m[6], c = m[8], f = m[9], i = m[10], tx = m[12], ty = m[13], tz = m[14];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) stop('ノードの変換が逆にできない（縮尺が 0）');
  const k = 1 / det;
  // 逆行列の (行, 列)
  const i00 = (e * i - f * h) * k, i01 = (c * h - b * i) * k, i02 = (b * f - c * e) * k;
  const i10 = (f * g - d * i) * k, i11 = (a * i - c * g) * k, i12 = (c * d - a * f) * k;
  const i20 = (d * h - e * g) * k, i21 = (b * g - a * h) * k, i22 = (a * e - b * d) * k;
  // 上の A は列の順で (a,d,g) = 列 0 なので、行の順の係数として並べ直すと次の通り
  const r = [i00, i10, i20, 0, i01, i11, i21, 0, i02, i12, i22, 0, 0, 0, 0, 1];
  r[12] = -(r[0] * tx + r[4] * ty + r[8] * tz); r[13] = -(r[1] * tx + r[5] * ty + r[9] * tz); r[14] = -(r[2] * tx + r[6] * ty + r[10] * tz);
  return r;
}
const apply = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const meanScale = m => (Math.hypot(m[0], m[1], m[2]) + Math.hypot(m[4], m[5], m[6]) + Math.hypot(m[8], m[9], m[10])) / 3;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], len = a => Math.hypot(...a), unit = a => scale(a, 1 / len(a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function worldsOf(js) {
  const parent = new Map(), cache = new Map();
  js.nodes.forEach((n, i) => (n.children ?? []).forEach(c => parent.set(c, i)));
  const world = i => {
    if (cache.has(i)) return cache.get(i);
    const l = localMatrix(js.nodes[i]), p = parent.get(i), w = p == null ? l : mul(world(p), l);
    cache.set(i, w); return w;
  };
  return {parent, world};
}

// ---- コライダーの置き方 ----
// 骨ごとの「線分の先」にする骨。先が無い骨(頭)は、首から頭への向きだけを使う
const TAIL = {spine: ['chest', 'upperChest'], upperChest: ['neck'], neck: ['head'], head: [],
  leftUpperArm: ['leftLowerArm'], leftLowerArm: ['leftHand'], leftHand: ['leftMiddleProximal', 'leftIndexProximal'],
  rightUpperArm: ['rightLowerArm'], rightLowerArm: ['rightHand'], rightHand: ['rightMiddleProximal', 'rightIndexProximal'],
  leftUpperLeg: ['leftLowerLeg'], rightUpperLeg: ['rightLowerLeg']};
// 髪が当たる組は脚以外、スカートが当たる組は脚
const isLegKey = k => /UpperLeg$/.test(k);
const r6 = x => +x.toFixed(6);

function frameOf(js, w) {
  const hb = js.extensions?.VRMC_vrm?.humanoid?.humanBones ?? {};
  const pos = key => { const n = hb[key]?.node; return n == null ? null : apply(w.world(n), [0, 0, 0]); };
  const hips = pos('hips'), head = pos('head');
  if (!hips || !head) stop('hips か head が Humanoid に無い');
  const size = len(sub(head, hips));
  if (!(size > 0)) stop('hips から head の距離が 0');
  const frame = (key, baseKey = key) => {
    const base = pos(baseKey);
    if (!base) stop(`Humanoid に ${baseKey} が無い`);
    let tail = null;
    for (const t of TAIL[key] ?? []) if (pos(t)) { tail = pos(t); break; }
    let axis;
    if (tail) axis = unit(sub(tail, base));
    else { const neck = pos('neck'); if (!neck) stop('Humanoid に neck が無い'); axis = unit(sub(base, neck)); }
    // 線分に直角な 2 方向。世界の前(+Z)を基準にして、腕の向きが違っても同じ側が同じ名前になるようにする
    const e2 = unit(cross([0, 0, 1], axis)), e3 = cross(axis, e2);
    return {base, tail, axis, e2, e3, length: tail ? len(sub(tail, base)) : null};
  };
  return {size, hb, frame};
}

export function colliderLayout(js) {
  const sb = js.extensions?.VRMC_springBone, hb = js.extensions?.VRMC_vrm?.humanoid?.humanBones ?? {};
  if (!sb?.colliders?.length) stop('手本にコライダーが無い');
  const w = worldsOf(js), F = frameOf(js, w), keyOfNode = new Map(Object.entries(hb).map(([k, v]) => [v.node, k]));
  const layout = {};
  for (const c of sb.colliders) {
    const key = keyOfNode.get(c.node), s = c.shape?.sphere;
    if (!key || !s) stop(`手本のコライダーが Humanoid の骨の球ではない: ${js.nodes[c.node]?.name}`);
    const W = w.world(c.node), center = apply(W, s.offset ?? [0, 0, 0]), fr = F.frame(key), rel = sub(center, fr.base), along = dot(rel, fr.axis);
    const e = {u: r6(dot(rel, fr.e2) / F.size), v: r6(dot(rel, fr.e3) / F.size), r: r6(s.radius * meanScale(W) / F.size)};
    if (fr.length) e.t = r6(along / fr.length); else e.a = r6(along / F.size);
    (layout[key] ??= []).push(e);
  }
  return layout;
}

// layout を変換先に置き、colliders と組を作る
function placeColliders(js, layout, names, notes = []) {
  const w = worldsOf(js), F = frameOf(js, w), colliders = [], groups = [];
  for (const [key, spheres] of Object.entries(layout)) {
    // upperChest が無いモデル(Humanoid 53 本)は、その位置にある chest の骨に置く
    const baseKey = F.hb[key] ? key : key === 'upperChest' && F.hb.chest ? 'chest' : null, node = baseKey && F.hb[baseKey].node;
    if (node == null) stop(`コライダーを置く骨が Humanoid に無い: ${key}`);
    if (baseKey !== key) notes.push(`${key} が Humanoid に無いので、${baseKey} の骨に置いた`);
    const fr = F.frame(key, baseKey), W = w.world(node), inv = invertAffine(W), idx = [];
    for (const s of spheres) {
      // 手本では指の骨まで割合で置いた球を、指の骨の無いモデルで手首に寄せない
      if (s.t != null && !fr.length) stop(`${key} の球は手本で ${(TAIL[key] ?? []).join(' か ')} までの割合で置いたが、変換先にその骨が無い`);
      const along = s.t != null ? s.t * fr.length : s.a * F.size;
      const center = add(add(add(fr.base, scale(fr.axis, along)), scale(fr.e2, s.u * F.size)), scale(fr.e3, s.v * F.size));
      idx.push(colliders.length);
      colliders.push({node, shape: {sphere: {offset: apply(inv, center).map(r6), radius: r6(s.r * F.size / meanScale(W))}}});
    }
    groups.push({name: names.get(node) ?? js.nodes[node].name, colliders: idx, key});
  }
  return {colliders, groups};
}

// ---- 材質の既定の名前 ----
// 上から順に最初に合ったものを使う。liner は head を含むので先に見る
const DEFAULT_MATERIALS = [
  [n => n.includes('liner'), 'N00_000_HairBack_00_HAIR'],
  [n => n.includes('eyewhite'), 'N00_000_00_EyeWhite_00_EYE'],
  [n => n.includes('eyeiris'), 'N00_000_00_EyeIris_00_EYE'],
  [n => n.includes('eyehighlight'), 'N00_000_00_EyeHighlight_00_EYE'],
  [n => n.includes('eyelash'), 'N00_000_00_FaceEyelash_00_FACE'],
  [n => n.includes('brow'), 'N00_000_00_FaceBrow_00_FACE'],
  [n => n.includes('mouth'), 'N00_000_00_FaceMouth_00_FACE'],
  [n => n.includes('face_00_skin'), 'N00_000_00_Face_00_SKIN'],
  [n => n.includes('head') && !n.includes('hair'), 'N00_000_00_Face_00_SKIN'],
  [n => n.includes('hair'), 'N00_000_Hair_00_HAIR_01'],
  [n => n.includes('upper_body'), 'N00_000_00_Body_00_SKIN'],
  [n => n.includes('lower_body'), 'N00_001_01_Bottoms_01_CLOTH'],
  [n => n.includes('accessor'), 'N00_002_01_Accessory_01_CLOTH']];
export function defaultMaterialName(name) {
  const n = String(name ?? '').toLowerCase();
  return DEFAULT_MATERIALS.find(([f]) => f(n))?.[1] ?? null;
}
// 部品の種類 -> メッシュの役。手本の MToon の値が無い部品は、近い部品の値を使う
const ROLE_OF_PART = {FaceMouth: 'Face', EyeWhite: 'Face', EyeIris: 'Face', EyeHighlight: 'Face', EyeExtra: 'Face', FaceEyeline: 'Face', FaceEyelash: 'Face', FaceBrow: 'Face', FaceSkin: 'Face', BodySkin: 'Body', Cloth: 'Body', HairBack: 'Body', Hair: 'Hair'};
const MTOON_FALLBACK = {HairBack: 'Hair', EyeWhite: 'EyeIris', EyeExtra: 'EyeIris', FaceEyeline: 'FaceSkin', FaceEyelash: 'FaceSkin', FaceBrow: 'FaceSkin'};
const MESH_NAME = {Face: 'Face (merged).baked', Body: 'Body (merged).baked', Hair: 'Hair001 (merged).baked'};
const SPRING_VALUES = {Hair: {stiffness: 0.8, dragForce: 0.4, gravityPower: 0}, Skirt: {stiffness: 0.5, dragForce: 0.05, gravityPower: 0}, Bust: {stiffness: 0.75, dragForce: 0.05, gravityPower: 0}};
const pad2 = n => String(n).padStart(2, '0');

function kindOf(name, first) {
  const k = springKind(name, first);
  if (k !== 'Other') return k;
  const s = `${name} ${first}`;
  return /hair|lock/i.test(s) ? 'Hair' : /skirt/i.test(s) ? 'Skirt' : /bust|breast/i.test(s) ? 'Bust' : 'Other';
}

// ---- 本体 ----
// opts: ref(reference.json の中身)、map(材質の対応)、from(元のファイル名)
// 顔の部品(partOf の種類)。輪郭線の指定があっても、目、口、眉には線を付けない。顔の肌(輪郭)には付ける(2026-11-04 ユーザー)
const NO_OUTLINE_PARTS = new Set(['FaceMouth', 'EyeWhite', 'EyeIris', 'EyeHighlight', 'EyeExtra', 'FaceEyeline', 'FaceEyelash', 'FaceBrow']);
// 髪の部品。輪郭線の指定があっても、髪は細い線にする(2026-11-05 ユーザー「髪の毛は輪郭線0.4にして」。体と顔の輪郭は 0.8 のまま)
const HAIR_PARTS = new Set(['Hair', 'HairBack']);
export const HAIR_OUTLINE = 0.0004;
// VRoid の体と顔の線の色(AvatarSample B)
const OUTLINE_COLOR = [0.06, 0.01, 0.01];

// outline: 輪郭線の太さ(m、世界座標)。null なら線は元のまま。数なら目、口、眉の部品は線なし、髪は hairOutline(既定 0.4 mm)、ほかはこの太さ
export function conformVrm(buf, {ref, map = {}, from = '', outline = null, hairOutline = HAIR_OUTLINE} = {}) {
  if (outline != null && !(outline >= 0 && outline < 0.01)) stop(`輪郭線の太さは 0 以上 0.01 m 未満: ${outline}`);
  if (!(hairOutline >= 0 && hairOutline < 0.01)) stop(`髪の輪郭線の太さは 0 以上 0.01 m 未満: ${hairOutline}`);
  if (!ref?.human || !ref.colliderLayout) stop('手本(reference.json)に human か colliderLayout が無い。scripts/vroid-check.mjs reference で作り直す');
  const {json: js, rest} = parseGlb(buf);
  const vrm = js.extensions?.VRMC_vrm, sb = js.extensions?.VRMC_springBone;
  if (!vrm) stop('VRM 1.0 ではない（VRMC_vrm が無い）');
  const report = {from: path.basename(from), humanoidBones: 0, springBones: 0, springs: {count: 0, byKind: {}}, colliders: {count: 0, groups: 0}, materials: [], meshes: [], unmergedMeshes: [], removedNodes: [], notes: []};
  const nodes = js.nodes ?? [];
  const names = new Map(), originalNames = nodes.map(n => n.name ?? '');   // 名前を変えたノード -> 新しい名前
  const setName = (i, name) => {
    if (names.has(i) && names.get(i) !== name) stop(`ノード ${originalNames[i]} に別の名前が二重に付く: ${names.get(i)} と ${name}`);
    names.set(i, name);
  };

  // 1. Humanoid の骨の名前
  for (const [key, v] of Object.entries(vrm.humanoid?.humanBones ?? {})) {
    if (!ref.human[key]) continue;
    setName(v.node, ref.human[key]); report.humanoidBones++;
  }

  // 2. 揺れ骨の名前と 3. 揺れものの値
  const springs = sb?.springs ?? [], counters = {Hair: 0, Skirt: 0};
  const inSpring = new Set(springs.flatMap(s => (s.joints ?? []).map(j => j.node)));
  for (const s of springs) {
    const order = (s.joints ?? []).map(j => j.node);
    if (!order.length) continue;
    const kind = kindOf(s.name, originalNames[order[0]]), last = order.at(-1);
    // 末尾が子を持たない End の骨なら、それを _end にして、手前までを段として数える
    const tailIsEnd = order.length > 1 && /end$/i.test(originalNames[last]) && !(nodes[last].children ?? []).length;
    const body = tailIsEnd ? order.slice(0, -1) : order;
    const idx = kind === 'Hair' || kind === 'Skirt' ? ++counters[kind] : 0;
    body.forEach((n, d) => setName(n, idx ? `J_Sec_${kind}${d + 1}_${pad2(idx)}` : `J_Sec_${originalNames[n].replace(/[^A-Za-z0-9]/g, '')}`));
    const lastNew = names.get(body.at(-1));
    if (tailIsEnd) setName(last, `${lastNew}_end`);
    else {
      // 関節に入っていない末端の子の骨
      const ends = (nodes[last].children ?? []).filter(c => !inSpring.has(c) && !(nodes[c].children ?? []).length && nodes[c].mesh == null);
      ends.forEach((c, k) => setName(c, k ? `${lastNew}_end${k + 1}` : `${lastNew}_end`));
    }
    report.springBones += order.length;
    report.springs.count++; report.springs.byKind[kind] = (report.springs.byKind[kind] ?? 0) + 1;
    s.__kind = kind;
    if (SPRING_VALUES[kind]) for (const j of s.joints) Object.assign(j, SPRING_VALUES[kind]);
    const label = String(s.name ?? '');
    if (kind !== 'Other' && label && !label.startsWith(`${kind}-`)) s.name = `${kind}-${label}`;
  }

  // 4. コライダー: 元を捨てて作り直す
  if (sb) {
    const placed = placeColliders(js, ref.colliderLayout, names, report.notes);
    sb.colliders = placed.colliders;
    sb.colliderGroups = placed.groups.map(g => ({name: g.name, colliders: g.colliders}));
    const keyAt = placed.groups.map(g => g.key);
    const hairGroups = keyAt.flatMap((k, i) => (isLegKey(k) ? [] : [i])), skirtGroups = keyAt.flatMap((k, i) => (isLegKey(k) ? [i] : []));
    for (const s of springs) {
      if (s.__kind === 'Hair') s.colliderGroups = hairGroups.slice();
      else if (s.__kind === 'Skirt') s.colliderGroups = skirtGroups.slice();
      else delete s.colliderGroups;
      delete s.__kind;
    }
    report.colliders = {count: sb.colliders.length, groups: sb.colliderGroups.length};
  }

  // 5. 材質の名前(すでに VRoid の形の名前なら、そのまま)
  const unresolved = [], mats = js.materials ?? [];
  const newMat = mats.map(m => {
    const name = map[m.name] ?? (MATERIAL_RE.test(m.name ?? '') ? m.name : defaultMaterialName(m.name));
    if (!name) unresolved.push(m.name ?? '（名前なし）');
    return name;
  });
  if (unresolved.length) stop(`材質の名前が決まらない: ${unresolved.join('、')}（--map で指定する）`, unresolved.map(n => `材質の名前が決まらない: ${n}`));
  const dupMat = newMat.filter((n, i) => newMat.indexOf(n) !== i);
  if (dupMat.length) stop(`材質の新しい名前が重なる: ${[...new Set(dupMat)].join('、')}`);
  const badMat = newMat.filter(n => !MATERIAL_RE.test(n));
  if (badMat.length) stop(`材質の名前が VRoid の決まりに合わない: ${badMat.join('、')}`);
  mats.forEach((m, i) => { report.materials.push({from: m.name ?? '', to: newMat[i], part: partOf(newMat[i])}); m.name = newMat[i]; });

  // 6. MToon: 部品ごとに手本の値
  mats.forEach(m => {
    const part = partOf(m.name), r = ref.mtoon?.[part] ?? ref.mtoon?.[MTOON_FALLBACK[part]];
    if (!r) { report.notes.push(`${m.name}: 手本に ${part} の MToon が無いので変えない`); return; }
    const mt = ((m.extensions ??= {}).VRMC_materials_mtoon ??= {specVersion: '1.0'});
    // 輪郭線は元のまま。VRoid の線は場所ごとの太さのテクスチャで細くしているので、太さの値だけ写すと Tripo の細い房すべてに太い線が付く(2026-11-04、ユーザーの判断で付けない)
    Object.assign(mt, {shadingShiftFactor: r.shift, shadingToonyFactor: r.toony,
      parametricRimFresnelPowerFactor: r.rimFresnel, parametricRimLiftFactor: r.rimLift, giEqualizationFactor: r.gi});
    if (outline != null) {
      const width = HAIR_PARTS.has(part) ? hairOutline : outline;
      const on = outline > 0 && width > 0 && !NO_OUTLINE_PARTS.has(part);
      Object.assign(mt, on ? {outlineWidthMode: 'worldCoordinates', outlineWidthFactor: width, outlineColorFactor: OUTLINE_COLOR.slice(), outlineLightingMixFactor: 0}
        : {outlineWidthMode: 'none', outlineWidthFactor: 0});
      delete mt.outlineWidthMultiplyTexture;
    }
    if (!(js.extensionsUsed ??= []).includes('VRMC_materials_mtoon')) js.extensionsUsed.push('VRMC_materials_mtoon');
  });

  // 7. メッシュ: Face、Body、Hair に組み直す
  const {keep, redirect} = mergeMeshes(js, report);
  for (const [i, name] of names) nodes[i].name = name;
  // 名前を付けたノードが、ほかのノードと同じ名前にならない
  const touched = new Set([...names.keys(), ...report.meshes.map(m => m.nodeIndex)]), seen = new Map();
  nodes.forEach((n, i) => { if (keep.has(i) && n.name) (seen.get(n.name) ?? seen.set(n.name, []).get(n.name)).push(i); });
  const clash = [...seen].filter(([, is]) => is.length > 1 && is.some(i => touched.has(i))).map(([n, is]) => `${n}（ノード ${is.join('、')}）`);
  if (clash.length) stop(`ノードの名前が重なる: ${clash.join('、')}`);

  // 8. ノードを詰めて参照を直し、記録を残す
  compact(js, keep, redirect, report);
  js.extras = {...(js.extras ?? {}), vroidConform: {version: 1, from: path.basename(from)}};
  report.meshes.forEach(m => delete m.nodeIndex);
  return {glb: buildGlb(js, rest), report};
}

// ---- メッシュのまとめ ----
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function nodeSignature(js, i, parentOf) {
  const n = js.nodes[i];
  return {parent: parentOf.get(i) ?? null, skin: n.skin ?? null, t: n.translation ?? [0, 0, 0], r: n.rotation ?? [0, 0, 0, 1], s: n.scale ?? [1, 1, 1], m: n.matrix ?? null};
}
function mergeMeshes(js, report) {
  const nodes = js.nodes, parentOf = new Map();
  nodes.forEach((n, i) => (n.children ?? []).forEach(c => parentOf.set(c, i)));
  const users = new Map();
  nodes.forEach((n, i) => { if (n.mesh != null) (users.get(n.mesh) ?? users.set(n.mesh, []).get(n.mesh)).push(i); });
  for (const [m, us] of users) if (us.length > 1) stop(`メッシュ ${js.meshes[m].name} を複数のノードが使っている(${us.join('、')})`);
  // プリミティブを役ごとに集める。目標(モーフ)の数と名前が違うものは同じメッシュにできない
  const items = [];
  nodes.forEach((n, i) => {
    if (n.mesh == null) return;
    const mesh = js.meshes[n.mesh];
    mesh.primitives.forEach(p => {
      const mat = js.materials?.[p.material];
      if (!mat) stop(`ノード ${n.name} のメッシュに材質の無いプリミティブがある`);
      const role = ROLE_OF_PART[partOf(mat.name)];
      if (!role) stop(`材質 ${mat.name} の部品が決まらず、メッシュの役が決まらない`);
      items.push({node: i, mesh: n.mesh, prim: p, role, count: (p.targets ?? []).length, sig: JSON.stringify({n: (p.targets ?? []).length, names: mesh.extras?.targetNames ?? p.extras?.targetNames ?? null})});
    });
  });
  for (const role of ['Face', 'Body', 'Hair']) {
    const ns = [...new Set(items.filter(it => it.role === role).map(it => it.node))];
    for (const i of ns.slice(1)) if (!same(nodeSignature(js, i, parentOf), nodeSignature(js, ns[0], parentOf)))
      stop(`${role} にまとめるノードの skin か変換が違う: ${nodes[ns[0]].name} と ${nodes[i].name}`);
  }
  const groups = [];
  for (const role of ['Face', 'Body', 'Hair']) {
    const bySig = new Map();
    items.filter(it => it.role === role).forEach(it => (bySig.get(it.sig) ?? bySig.set(it.sig, []).get(it.sig)).push(it));
    // Face は目標(Fcl のキー)を持つまとまりを必ず主にする。ほかは一番多いまとまりが主で、同数なら目標を持つ方
    const hasKeys = g => g[0].count > 0 ? 1 : 0;
    [...bySig.values()].sort((a, b) => (role === 'Face' ? hasKeys(b) - hasKeys(a) : 0) || b.length - a.length || b[0].count - a[0].count).forEach((g, k) => groups.push({role, items: g, primary: k === 0, k}));
  }
  const usedHosts = new Set(), newMeshes = [];
  for (const g of groups) {
    const cands = [...new Set(g.items.map(it => it.node))].sort((a, b) => a - b);
    let host = g.primary ? cands.find(c => !usedHosts.has(c)) : undefined;
    g.morphSrc = g.items.find(it => it.count);
    const src = js.meshes[(g.morphSrc ?? g.items[0]).mesh];
    const mesh = {name: g.primary ? MESH_NAME[g.role] : `${g.role}${g.k + 1} (merged).baked`, primitives: g.items.map(it => it.prim)};
    if (g.morphSrc) { if (src.extras) mesh.extras = {...src.extras}; if (src.weights) mesh.weights = src.weights.slice(); }
    if (host === undefined) {
      // 同じ役の別まとまり、または主のノードがすべて使われている: 同じ変換のノードを足す
      const base = nodes[cands[0]], n = {name: mesh.name.replace(/ .*/, '')};
      for (const k of ['skin', 'translation', 'rotation', 'scale', 'matrix']) if (base[k] != null) n[k] = structuredClone(base[k]);
      nodes.push(n); host = nodes.length - 1;
      const p = parentOf.get(cands[0]);
      (p == null ? js.scenes[js.scene ?? 0].nodes : (nodes[p].children ??= [])).push(host);
    }
    usedHosts.add(host); g.host = host; newMeshes.push(mesh);
  }
  const hosts = new Set(groups.map(g => g.host)), mergedNodes = new Set(items.map(it => it.node));
  groups.forEach((g, k) => { nodes[g.host].mesh = k; nodes[g.host].name = g.primary ? g.role : newMeshes[k].name.replace(/ .*/, ''); });
  const drop = new Set([...mergedNodes].filter(i => !hosts.has(i)));
  for (const i of drop) {
    if ((nodes[i].children ?? []).length) stop(`消すメッシュのノード ${nodes[i].name} に子がある`);
    delete nodes[i].mesh;
  }
  // 消すノードを指す参照(表情の bind など)の行き先。プリミティブが 1 つのまとまりに入り、モーフを持つ場合はそのまとまりの元のメッシュであるときだけ
  const redirect = i => {
    if (!drop.has(i)) return i;
    const gs = groups.filter(g => g.items.some(it => it.node === i));
    if (gs.length !== 1) stop(`消すノード ${nodes[i].name} が複数のメッシュに分かれ、参照先が決まらない`);
    const own = gs[0].items.filter(it => it.node === i);
    if (own.some(it => it.count) && gs[0].morphSrc.node !== i) stop(`消すノード ${nodes[i].name} の表情の目標が、引き継ぐメッシュの目標と別になる`);
    return gs[0].host;
  };
  js.meshes = newMeshes;
  groups.forEach((g, k) => report.meshes.push({role: g.role, mesh: newMeshes[k].name, node: nodes[g.host].name, nodeIndex: g.host, primitives: g.items.length,
    from: [...new Set(g.items.map(it => nodes[it.node].name))], morphTargets: g.morphSrc?.count ?? 0}));
  groups.filter(g => !g.primary).forEach(g => report.unmergedMeshes.push({role: g.role, reason: '目標（モーフ）の数か名前が主のまとまりと違うので、別のメッシュに分けた', primitives: g.items.length}));
  report.removedNodes = [...drop].map(i => nodes[i].name);
  return {keep: new Set(nodes.map((_, i) => i).filter(i => !drop.has(i))), redirect};
}

// ノードを消した後の番号の詰め直し。ノードの番号を持つ所を全部直す
function compact(js, keep, redirect, report) {
  const old2new = new Map(), order = [...keep].sort((a, b) => a - b);
  order.forEach((o, n) => old2new.set(o, n));
  const re = i => { const t = redirect(i); if (!old2new.has(t)) stop(`ノード ${i} の参照先が無い`); return old2new.get(t); };
  const strict = i => { if (!old2new.has(i)) stop(`消したノード ${i} が参照されている`); return old2new.get(i); };
  const nodes = order.map(i => js.nodes[i]);
  for (const n of nodes) if (n.children) { n.children = n.children.filter(c => old2new.has(c)).map(c => old2new.get(c)); if (!n.children.length) delete n.children; }
  js.nodes = nodes;
  for (const s of js.scenes ?? []) if (s.nodes) s.nodes = s.nodes.filter(c => old2new.has(c)).map(c => old2new.get(c));
  for (const s of js.skins ?? []) { s.joints = s.joints.map(strict); if (s.skeleton != null) s.skeleton = strict(s.skeleton); }
  for (const a of js.animations ?? []) for (const c of a.channels ?? []) if (c.target?.node != null) c.target.node = strict(c.target.node);
  for (const n of nodes) {
    const nc = n.extensions?.VRMC_node_constraint?.constraint;
    if (nc) for (const k of Object.keys(nc)) if (nc[k]?.source != null) nc[k].source = strict(nc[k].source);
  }
  const vrm = js.extensions?.VRMC_vrm;
  if (vrm) {
    for (const v of Object.values(vrm.humanoid?.humanBones ?? {})) v.node = strict(v.node);
    for (const a of vrm.firstPerson?.meshAnnotations ?? []) a.node = re(a.node);
    const ex = vrm.expressions ?? {};
    for (const e of [...Object.values(ex.preset ?? {}), ...Object.values(ex.custom ?? {})]) for (const b of e.morphTargetBinds ?? []) b.node = re(b.node);
  }
  const sb = js.extensions?.VRMC_springBone;
  if (sb) {
    for (const s of sb.springs ?? []) { for (const j of s.joints ?? []) j.node = strict(j.node); if (s.center != null) s.center = strict(s.center); }
    for (const c of sb.colliders ?? []) c.node = strict(c.node);
  }
  report.nodeCount = {before: js.nodes.length + (report.removedNodes?.length ?? 0), after: js.nodes.length};
}
