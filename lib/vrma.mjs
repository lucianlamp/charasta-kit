// VRMA(glTF バイナリ)を読んで、長さと動かす骨を求める。glb の読み書きは lib/glb.mjs。
import {parseGlb} from './glb.mjs';
export {parseGlb};

const COMPONENT = {5120: [1, 'getInt8'], 5121: [1, 'getUint8'], 5122: [2, 'getInt16'], 5123: [2, 'getUint16'], 5125: [4, 'getUint32'], 5126: [4, 'getFloat32']};

function accessorMax(json, bin, idx) {
  const a = json.accessors?.[idx];
  if (!a) return 0;
  if (Array.isArray(a.max) && Number.isFinite(a.max[0])) return a.max[0];
  // max が書かれていないときはデータから求める。
  const bv = json.bufferViews?.[a.bufferView], comp = COMPONENT[a.componentType];
  if (!bv || !bin || !comp) return 0;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const stride = bv.byteStride || comp[0];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  let max = 0;
  for (let i = 0; i < a.count; i++) max = Math.max(max, dv[comp[1]](base + i * stride, true));
  return max;
}

export function parseVrma(buf) {
  const {json, bin} = parseGlb(buf);
  const anims = json.animations ?? [];
  if (!anims.length) throw new Error('VRMA にアニメーションが無い');
  const humanBones = json.extensions?.VRMC_vrm_animation?.humanoid?.humanBones;
  if (!humanBones) throw new Error('VRMC_vrm_animation の humanBones が無い');
  let durationSec = 0;
  const targeted = new Set();
  for (const anim of anims) {
    for (const s of anim.samplers ?? []) durationSec = Math.max(durationSec, accessorMax(json, bin, s.input));
    for (const c of anim.channels ?? []) if (c.target?.node != null) targeted.add(c.target.node);
  }
  const bones = Object.entries(humanBones).filter(([, v]) => targeted.has(v.node)).map(([name]) => name);
  return {durationSec: Math.round(durationSec * 10000) / 10000, bones,
    usesShoulder: bones.includes('leftShoulder') || bones.includes('rightShoulder')};
}

const CHAIN = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
const qmul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
function floats(json, bin, idx, width) {
  const a = json.accessors[idx], bv = json.bufferViews[a.bufferView], base = (bv.byteOffset || 0) + (a.byteOffset || 0), dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  return Array.from({length: a.count}, (_, i) => Array.from({length: width}, (_, k) => dv.getFloat32(base + (bv.byteStride || width * 4) * i + k * 4, true)));
}

// 動きの姿勢を測る。headDown: 顔が水平から下を向く角度の中央値(度。上は負)、turn: 顔の左右の向きの幅(度)、travel: hips の水平の道のり(m)
export function motionPose(buf) {
  const {json, bin} = parseGlb(buf), human = json.extensions?.VRMC_vrm_animation?.humanoid?.humanBones ?? {}, anim = json.animations?.[0], tracks = new Map();
  let hipsPath = [];
  for (const c of anim?.channels ?? []) {
    if (c.target?.path === 'rotation') tracks.set(c.target.node, floats(json, bin, anim.samplers[c.sampler].output, 4));
    else if (c.target?.path === 'translation' && c.target.node === human.hips?.node) hipsPath = floats(json, bin, anim.samplers[c.sampler].output, 3);
  }
  const chain = CHAIN.map(b => human[b]?.node).filter(n => n != null), frames = Math.max(0, ...chain.map(n => tracks.get(n)?.length ?? 0)), down = [], yaw = [];
  for (let f = 0; f < frames; f++) {
    let q = [0, 0, 0, 1];
    for (const n of chain) { const t = tracks.get(n); q = qmul(q, t ? t[Math.min(f, t.length - 1)] : json.nodes[n].rotation ?? [0, 0, 0, 1]); }
    const [x, y, z, w] = q, fx = 2 * (x * z + w * y), fy = 2 * (y * z - w * x), fz = 1 - 2 * (x * x + y * y);   // 回した +Z(顔の向き)
    down.push(-Math.asin(Math.max(-1, Math.min(1, fy))) * 180 / Math.PI);
    yaw.push(Math.atan2(fx, fz) * 180 / Math.PI);
  }
  const travel = hipsPath.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - hipsPath[i][0], p[2] - hipsPath[i][2]), 0);
  return {headDown: [...down].sort((a, b) => a - b)[down.length >> 1] ?? 0, turn: yaw.length ? Math.max(...yaw) - Math.min(...yaw) : 0, travel};
}
