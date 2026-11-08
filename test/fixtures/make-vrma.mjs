#!/usr/bin/env node
// テスト用の VRMA(VRM Animation)をコードで作る。市販のモーション集の動きは再配布できないので、リポジトリに入れる動きは自作のこれだけにする。
//   node test/fixtures/make-vrma.mjs [出力先]     既定は test/fixtures/sample.vrma
// 中身: VRM のヒューマノイド骨(指なし)の階層と、30fps で約 7.3 秒の回転(腰、背骨、首、頭、肩、腕、脚)と腰の移動。乱数は使わず、いつも同じバイト列になる。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const FPS = 30, FRAMES = 219;   // 218 / 30 = 7.2667 秒

// [骨, 親, 親からの位置(m)]。親が先に並ぶ
const SKELETON = [
  ['hips', null, [0, 0.9, 0]], ['spine', 'hips', [0, 0.045, 0.01]], ['chest', 'spine', [0, 0.09, 0]], ['upperChest', 'chest', [0, 0.11, 0]],
  ['neck', 'upperChest', [0, 0.12, 0]], ['head', 'neck', [0, 0.07, 0]],
  ['leftShoulder', 'upperChest', [0.03, 0.08, 0]], ['leftUpperArm', 'leftShoulder', [0.07, 0, 0]], ['leftLowerArm', 'leftUpperArm', [0.26, 0, 0]], ['leftHand', 'leftLowerArm', [0.25, 0, 0]],
  ['rightShoulder', 'upperChest', [-0.03, 0.08, 0]], ['rightUpperArm', 'rightShoulder', [-0.07, 0, 0]], ['rightLowerArm', 'rightUpperArm', [-0.26, 0, 0]], ['rightHand', 'rightLowerArm', [-0.25, 0, 0]],
  ['leftUpperLeg', 'hips', [0.08, -0.05, 0]], ['leftLowerLeg', 'leftUpperLeg', [0, -0.4, 0]], ['leftFoot', 'leftLowerLeg', [0, -0.4, 0]], ['leftToes', 'leftFoot', [0, -0.07, 0.1]],
  ['rightUpperLeg', 'hips', [-0.08, -0.05, 0]], ['rightLowerLeg', 'rightUpperLeg', [0, -0.4, 0]], ['rightFoot', 'rightLowerLeg', [0, -0.4, 0]], ['rightToes', 'rightFoot', [0, -0.07, 0.1]],
];

const rad = d => d * Math.PI / 180;
const axisAngle = ([x, y, z], a) => { const s = Math.sin(a / 2); return [x * s, y * s, z * s, Math.cos(a / 2)]; };
const qmul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];

// 骨ごとの回転: [基準の回転, [軸, 振れ幅(度), 周期(秒), 位相]...]。基準は T ポーズから腕を下ろす回転
const MOTION = {
  hips: [null, [[0, 1, 0], 6, 3.6, 0]], spine: [null, [[1, 0, 0], 3, 1.8, 0.5], [[0, 0, 1], 2, 3.6, 0]], chest: [null, [[1, 0, 0], 2, 1.8, 0.9]], upperChest: [null, [[0, 1, 0], 3, 3.6, 1]],
  neck: [null, [[1, 0, 0], 4, 1.8, 0.2]], head: [null, [[1, 0, 0], 8, 1.8, 0], [[0, 1, 0], 10, 3.6, 0.3]],
  leftShoulder: [null, [[0, 0, 1], 2, 3.6, 0]], rightShoulder: [null, [[0, 0, 1], 2, 3.6, 0]],
  leftUpperArm: [[0, 0, 1], -65, [[1, 0, 0], 12, 1.8, 0], [[0, 0, 1], 8, 3.6, 0]], rightUpperArm: [[0, 0, 1], 65, [[1, 0, 0], 12, 1.8, 0.5], [[0, 0, 1], -8, 3.6, 0]],
  leftLowerArm: [[0, 1, 0], -20, [[0, 1, 0], 15, 1.8, 0.4]], rightLowerArm: [[0, 1, 0], 20, [[0, 1, 0], -15, 1.8, 0.9]],
  leftHand: [null, [[0, 0, 1], 10, 1.2, 0]], rightHand: [null, [[0, 0, 1], -10, 1.2, 0.5]],
  leftUpperLeg: [null, [[1, 0, 0], 10, 1.8, 0]], rightUpperLeg: [null, [[1, 0, 0], 10, 1.8, 0.5]],
  leftLowerLeg: [null, [[1, 0, 0], 6, 1.8, 0.3]], rightLowerLeg: [null, [[1, 0, 0], 6, 1.8, 0.8]],
};

// 基準の回転(軸と度)と振れ(軸、度、周期、位相)から、時刻 t の回転(四元数)を求める
function boneRotation(bone, t) {
  const m = MOTION[bone];
  if (!m) return [0, 0, 0, 1];
  let i = 1, q = [0, 0, 0, 1];
  if (Array.isArray(m[0])) { q = axisAngle(m[0], rad(m[1])); i = 2; }
  for (; i < m.length; i++) { const [axis, deg, period, phase] = m[i]; q = qmul(q, axisAngle(axis, rad(deg) * Math.sin(2 * Math.PI * (t / period + phase)))); }
  return q;
}

function pad4(n) { return (4 - n % 4) % 4; }

export function buildVrma() {
  const nodes = SKELETON.map(([name, , pos]) => ({name: `J_Bip_${name}`, translation: pos}));
  const index = Object.fromEntries(SKELETON.map(([name], i) => [name, i]));
  SKELETON.forEach(([name, parent]) => { if (parent) (nodes[index[parent]].children ??= []).push(index[name]); });
  const times = Float32Array.from({length: FRAMES}, (_, f) => f / FPS);
  const accessors = [], bufferViews = [], chunks = [];
  let offset = 0;
  const addAccessor = (array, type, components, withRange) => {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    bufferViews.push({buffer: 0, byteOffset: offset, byteLength: bytes.length});
    const a = {bufferView: bufferViews.length - 1, componentType: 5126, count: array.length / components, type};
    if (withRange) {
      a.min = Array(components).fill(Infinity); a.max = Array(components).fill(-Infinity);
      for (let i = 0; i < array.length; i++) { a.min[i % components] = Math.min(a.min[i % components], array[i]); a.max[i % components] = Math.max(a.max[i % components], array[i]); }
    }
    accessors.push(a); chunks.push(bytes); offset += bytes.length;
    return accessors.length - 1;
  };
  const timeAcc = addAccessor(times, 'SCALAR', 1, true);
  const samplers = [], channels = [];
  const track = (node, path, accessor) => { samplers.push({input: timeAcc, output: accessor, interpolation: 'LINEAR'}); channels.push({sampler: samplers.length - 1, target: {node, path}}); };
  // 腰の移動: ゆるい上下と左右の揺れ、前へ 0.1 m
  const hip = new Float32Array(FRAMES * 3);
  for (let f = 0; f < FRAMES; f++) {
    const t = f / FPS;
    hip.set([0.02 * Math.sin(2 * Math.PI * t / 3.6), 0.9 + 0.015 * Math.sin(2 * Math.PI * t / 0.9), 0.1 * f / (FRAMES - 1)], f * 3);
  }
  track(index.hips, 'translation', addAccessor(hip, 'VEC3', 3, true));
  for (const [bone] of SKELETON) {
    if (!MOTION[bone]) continue;
    const rot = new Float32Array(FRAMES * 4);
    for (let f = 0; f < FRAMES; f++) rot.set(boneRotation(bone, f / FPS), f * 4);
    track(index[bone], 'rotation', addAccessor(rot, 'VEC4', 4, false));
  }
  const bin = Buffer.concat([...chunks, Buffer.alloc(pad4(offset))]);
  const json = {
    asset: {version: '2.0', generator: 'charasta test fixture (test/fixtures/make-vrma.mjs)'},
    scene: 0, scenes: [{nodes: [index.hips]}], nodes, animations: [{name: 'sample', samplers, channels}],
    accessors, bufferViews, buffers: [{byteLength: bin.length}],
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {VRMC_vrm_animation: {specVersion: '1.0', humanoid: {humanBones: Object.fromEntries(SKELETON.map(([name]) => [name, {node: index[name]}]))}}},
  };
  let jb = Buffer.from(JSON.stringify(json));
  jb = Buffer.concat([jb, Buffer.alloc(pad4(jb.length), 0x20)]);
  const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jb.length + 8 + bin.length, 8);
  jh.writeUInt32LE(jb.length, 0); jh.write('JSON', 4, 'latin1'); bh.writeUInt32LE(bin.length, 0); bh.write('BIN\0', 4, 'latin1');
  return Buffer.concat([head, jh, jb, bh, bin]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'sample.vrma'));
  const data = buildVrma();
  fs.writeFileSync(out, data);
  console.log(`${out} ${data.length} bytes`);
}
