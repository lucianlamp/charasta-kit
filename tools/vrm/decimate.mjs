// VRM の三角形を減らす(docs/game-export.md)。頂点は変えず、index buffer だけを meshoptimizer の simplify で作り直し、使われなくなった頂点を詰める。
//   node tools/vrm/decimate.mjs in.vrm out.vrm [--target 20000] [--min-ratio 0.10] [--error 0.05]
// 骨の重み(JOINTS / WEIGHTS)、UV、法線、モーフの差分は、残る頂点では元の値のまま並べ替えるだけ。
// 減らさないもの: alphaMode が BLEND の primitive、三角形が maskMinTris 以下の MASK の primitive(顔の層、まつ毛、影の板)、三角形が minPrimTris 未満の primitive、三角形以外の primitive。
// 大きい MASK(VRoid の書き出しは体、髪、顔が全部 MASK)は減らす。alphaCutoff と画像はそのままで、UV は simplifyWithAttributes が見ながら減らす。
// 動かさないもの: 縁の頂点(LockBorder。primitive の境も縁なので、primitive の間に隙間が開かない)と、表情が動かすモーフの頂点。
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseGlb, buildGlb, readAccessor, toFloat, addAccessor, compactGlb} from '../../lib/glb.mjs';
import {MeshoptSimplifier} from '../../vendor/meshopt_simplifier.module.js';

export const DEFAULTS = {target: 20000, minRatio: 0.10, minPrimTris: 1000, maskMinTris: 2000, lockDelta: 1e-4, targetError: 0.05};

const alphaOf = (json, p) => json.materials?.[p.material]?.alphaMode ?? 'OPAQUE';
const triangles = p => ((p.mode ?? 4) === 4 && p.indices != null ? p._count : 0);

// 目標の三角形の数から、primitive ごとの残す割合を決める(純粋な関数)。
//   prims: [{id, triangles, alphaMode, mode, indexed}]
//   戻り: {protectedTriangles, reducibleTriangles, ratio, reached, items: [{id, ratio, reason}]}  reason は守る理由(減らす primitive は null)
export function planBudget(prims, {target = DEFAULTS.target, minRatio = DEFAULTS.minRatio, minPrimTris = DEFAULTS.minPrimTris, maskMinTris = DEFAULTS.maskMinTris} = {}) {
  const items = prims.map(p => {
    const reason = !p.indexed || (p.mode ?? 4) !== 4 ? '三角形の index が無い' : p.alphaMode === 'BLEND' || (p.alphaMode === 'MASK' && p.triangles <= maskMinTris) ? `alphaMode ${p.alphaMode}` : p.triangles < minPrimTris ? `三角形が ${minPrimTris} 未満` : null;
    return {id: p.id, triangles: p.triangles, reason, ratio: 1};
  });
  const protectedTriangles = items.filter(i => i.reason).reduce((s, i) => s + i.triangles, 0);
  const reducibleTriangles = items.filter(i => !i.reason).reduce((s, i) => s + i.triangles, 0);
  const wanted = reducibleTriangles ? Math.max(0, target - protectedTriangles) / reducibleTriangles : 1;
  const ratio = Math.min(1, Math.max(minRatio, wanted));
  for (const i of items) if (!i.reason) i.ratio = ratio;
  const planned = protectedTriangles + Math.round(reducibleTriangles * ratio);
  return {protectedTriangles, reducibleTriangles, ratio, planned, reached: planned <= target, items};
}

// 表情(VRMC_vrm の expressions)が参照するモーフ: Map<メッシュ番号, Set<モーフ番号>>
export function expressionMorphs(json) {
  const out = new Map(), ex = json.extensions?.VRMC_vrm?.expressions ?? {};
  for (const e of [...Object.values(ex.preset ?? {}), ...Object.values(ex.custom ?? {})]) {
    for (const b of e?.morphTargetBinds ?? []) {
      const mesh = json.nodes?.[b.node]?.mesh;
      if (mesh == null || !Number.isInteger(b.index)) continue;
      if (!out.has(mesh)) out.set(mesh, new Set());
      out.get(mesh).add(b.index);
    }
  }
  return out;
}

// 表情のモーフが動かす頂点に印を付ける(差分の長さが lockDelta m を超えるもの)。戻りは [印の配列, 印の数]
function lockVertices(json, bin, prim, morphs, count, lockDelta) {
  const lock = new Uint8Array(count);
  let n = 0;
  for (const mi of morphs ?? []) {
    const t = prim.targets?.[mi];
    if (t?.POSITION == null) continue;
    const d = readAccessor(json, bin, t.POSITION);
    for (let v = 0; v < count; v++) {
      if (!lock[v] && Math.hypot(d[v * 3], d[v * 3 + 1], d[v * 3 + 2]) > lockDelta) { lock[v] = 1; n++; }
    }
  }
  return [lock, n];
}

// 頂点ごとの属性(法線、UV、骨の重み)を並べた配列と重み。減らす向きの判断に使うだけで、書き出す値は変えない
function attributeStream(json, bin, prim, count) {
  const parts = [];
  const take = (name, weight) => {
    const idx = prim.attributes[name];
    if (idx == null) return;
    const a = json.accessors[idx], width = {VEC2: 2, VEC3: 3, VEC4: 4}[a.type];
    if (!width) return;
    parts.push({arr: toFloat(readAccessor(json, bin, idx), a.componentType, a.normalized), width, weight});
  };
  take('NORMAL', 0.5); take('TEXCOORD_0', 1); take('WEIGHTS_0', 0.25);
  const stride = parts.reduce((s, p) => s + p.width, 0), data = new Float32Array(count * stride), weights = [];
  let off = 0;
  for (const p of parts) {
    for (let v = 0; v < count; v++) for (let k = 0; k < p.width; k++) data[v * stride + off + k] = p.arr[v * p.width + k];
    for (let k = 0; k < p.width; k++) weights.push(p.weight);
    off += p.width;
  }
  return {data, stride, weights};
}

const pick = (arr, width, order) => {
  const out = new arr.constructor(order.length * width);
  for (let i = 0; i < order.length; i++) for (let k = 0; k < width; k++) out[i * width + k] = arr[order[i] * width + k];
  return out;
};

// primitive 1 つの simplify。戻りは {next: 新しい index, locked: 固定した頂点の数, error, goal: 目標の三角形の数}
function simplifyPrim(json, bin, prim, morphs, ratio, o) {
  const vcount = json.accessors[prim.attributes.POSITION].count;
  const indices = Uint32Array.from(readAccessor(json, bin, prim.indices));
  const positions = readAccessor(json, bin, prim.attributes.POSITION);
  const [lock, locked] = lockVertices(json, bin, prim, morphs, vcount, o.lockDelta);
  const {data, stride, weights} = attributeStream(json, bin, prim, vcount);
  const goal = Math.max(3, Math.round(indices.length / 3 * ratio) * 3);
  const [next, error] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, data, stride, weights, locked ? lock : null, goal, o.targetError, ['LockBorder']);
  return {next, locked, error, goal: goal / 3};
}

// simplify の結果を primitive に書く。使われている頂点だけを、元の順番のまま詰める
function applyReduction(json, bin, pending, prim, next) {
  const vcount = json.accessors[prim.attributes.POSITION].count;
  const seen = new Uint8Array(vcount);
  for (const i of next) seen[i] = 1;
  const order = [], remap = new Int32Array(vcount).fill(-1);
  for (let v = 0; v < vcount; v++) if (seen[v]) { remap[v] = order.length; order.push(v); }
  const newIdx = next.map(i => remap[i]);
  const copy = (idx, extra = {}) => {
    const a = json.accessors[idx], width = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4}[a.type];
    return addAccessor(json, pending, pick(readAccessor(json, bin, idx), width, order), {componentType: a.componentType, type: a.type, target: 34962, normalized: a.normalized, ...extra});
  };
  const attributes = {};
  for (const [name, idx] of Object.entries(prim.attributes)) attributes[name] = copy(idx, {minmax: name === 'POSITION'});
  const targets = (prim.targets ?? []).map(t => Object.fromEntries(Object.entries(t).map(([name, idx]) => [name, copy(idx, {target: undefined, minmax: json.accessors[idx].min != null})])));
  const big = order.length > 65535;
  const idxData = big ? newIdx : Uint16Array.from(newIdx);
  prim.attributes = attributes;
  if (targets.length) prim.targets = targets;
  prim.indices = addAccessor(json, pending, idxData, {componentType: big ? 5125 : 5123, type: 'SCALAR', target: 34963});
  return {triangles: newIdx.length / 3, vertices: order.length};
}

// json / bin を読んで、三角形を減らした json / bin を返す。引数の json は書き換える
export async function decimate(json, bin, options = {}) {
  const o = {...DEFAULTS, ...options};
  await MeshoptSimplifier.ready;
  MeshoptSimplifier.useExperimentalFeatures = true;
  const prims = [];
  (json.meshes ?? []).forEach((m, mi) => m.primitives.forEach((p, pi) => {
    p._count = p.indices != null ? json.accessors[p.indices].count / 3 : 0;
    prims.push({id: `${m.name ?? 'mesh' + mi}#${pi}`, mi, pi, prim: p, triangles: triangles(p), alphaMode: alphaOf(json, p), mode: p.mode, indexed: p.indices != null && p.attributes.POSITION != null});
  }));
  const plan = planBudget(prims, o), morphs = expressionMorphs(json), pending = new Map();
  // 1 回目は全部同じ割合で試す。固定した頂点のせいで届かなかった primitive の不足は、届いた primitive の割合を下げて補い、2 回目をやる
  const result = new Map();
  prims.forEach((p, i) => { if (!plan.items[i].reason) result.set(i, simplifyPrim(json, bin, p.prim, morphs.get(p.mi), plan.items[i].ratio, o)); });
  const stuck = [...result].filter(([, r]) => r.next.length / 3 > r.goal * 1.02), free = [...result].filter(([, r]) => r.next.length / 3 <= r.goal * 1.02);
  let passes = 1;
  if (stuck.length && free.length) {
    const stuckTris = stuck.reduce((s, [, r]) => s + r.next.length / 3, 0), freeTris = free.reduce((s, [i]) => s + prims[i].triangles, 0);
    const ratio = Math.min(plan.ratio, Math.max(o.minRatio, (o.target - plan.protectedTriangles - stuckTris) / freeTris));
    for (const [i] of free) result.set(i, simplifyPrim(json, bin, prims[i].prim, morphs.get(prims[i].mi), ratio, o));
    passes = 2;
  }
  const report = [];
  prims.forEach((p, i) => {
    const item = plan.items[i], material = json.materials?.[p.prim.material]?.name ?? null;
    const row = {mesh: json.meshes[p.mi].name ?? null, primitive: p.pi, material, alphaMode: p.alphaMode, before: p.triangles, after: p.triangles, ratio: 1, locked: 0, protectedBy: item.reason};
    if (!item.reason) {
      const r = result.get(i), a = applyReduction(json, bin, pending, p.prim, r.next);
      Object.assign(row, {after: a.triangles, ratio: Math.round(a.triangles / p.triangles * 1000) / 1000, locked: r.locked, error: Math.round(r.error * 1e5) / 1e5});
    }
    report.push(row);
  });
  for (const m of json.meshes ?? []) for (const p of m.primitives) delete p._count;
  const total = report.reduce((s, r) => s + r.after, 0), before = report.reduce((s, r) => s + r.before, 0);
  const reached = total <= o.target * 1.1;
  const out = compactGlb(json, bin, pending);
  return {json, bin: out, report: {target: o.target, passes, before, after: total, reached, protectedTriangles: plan.protectedTriangles,
    note: reached ? null : `目標 ${o.target} に届かない。守る分 ${plan.protectedTriangles}、減らした結果 ${total}`, primitives: report}};
}

export async function decimateGlb(buf, options) {
  const {json, bin} = parseGlb(buf);
  const r = await decimate(json, bin, options);
  return {glb: buildGlb(r.json, r.bin), report: r.report};
}

function cli(argv) {
  const [inp, out, ...rest] = argv, opt = {};
  const num = (k, name) => { const i = rest.indexOf(k); if (i >= 0) opt[name] = Number(rest[i + 1]); };
  num('--target', 'target'); num('--min-ratio', 'minRatio'); num('--error', 'targetError');
  if (!inp || !out) { console.error('使い方: node tools/vrm/decimate.mjs in.vrm out.vrm [--target 20000] [--min-ratio 0.10] [--error 0.05]'); process.exit(2); }
  decimateGlb(fs.readFileSync(inp), opt).then(({glb, report}) => {
    fs.writeFileSync(out, glb);
    console.log(JSON.stringify({...report, primitives: undefined}), '\n' + report.primitives.map(r => `${r.mesh}#${r.primitive} ${r.material} ${r.before} -> ${r.after}${r.protectedBy ? ' (守る: ' + r.protectedBy + ')' : ` 固定 ${r.locked}`}`).join('\n'));
  }, e => { console.error(e.message); process.exit(1); });
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) cli(process.argv.slice(2));
