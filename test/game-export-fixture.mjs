// ゲーム用の書き出しのテストが使う、小さな VRM(球 3 個とモーフ 1 つ、揺れもの、仮の meta)と VRMA を作る。
import {buildGlb} from '../lib/glb.mjs';

// 緯度経度の球。継ぎ目(経度の端)の頂点は複製して UV を分ける
export function sphere(nLat, nLon, r = 1, cy = 0) {
  const pos = [], nor = [], uv = [], idx = [];
  for (let i = 0; i <= nLat; i++) for (let j = 0; j <= nLon; j++) {
    const th = Math.PI * i / nLat, ph = 2 * Math.PI * j / nLon, x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
    pos.push(x * r, y * r + cy, z * r); nor.push(x, y, z); uv.push(j / nLon, i / nLat);
  }
  for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
    const a = i * (nLon + 1) + j, b = a + nLon + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return {pos: Float32Array.from(pos), nor: Float32Array.from(nor), uv: Float32Array.from(uv), idx: Uint32Array.from(idx), count: pos.length / 3};
}

class Builder {
  constructor() { this.json = {asset: {version: '2.0'}, buffers: [], bufferViews: [], accessors: []}; this.parts = []; this.len = 0; }
  add(arr, type, componentType, {target, minmax = false, normalized = false} = {}) {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), pad = (4 - (this.len % 4)) % 4;
    if (pad) { this.parts.push(Buffer.alloc(pad)); this.len += pad; }
    this.json.bufferViews.push({buffer: 0, byteOffset: this.len, byteLength: bytes.length, ...(target && {target})});
    this.parts.push(Buffer.from(bytes)); this.len += bytes.length;
    const width = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4}[type], count = arr.length / width, acc = {bufferView: this.json.bufferViews.length - 1, componentType, count, type, ...(normalized && {normalized})};
    if (minmax) {
      acc.min = Array(width).fill(Infinity); acc.max = Array(width).fill(-Infinity);
      for (let i = 0; i < count; i++) for (let k = 0; k < width; k++) { acc.min[k] = Math.min(acc.min[k], arr[i * width + k]); acc.max[k] = Math.max(acc.max[k], arr[i * width + k]); }
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }
  glb() { this.json.buffers = [{byteLength: this.len}]; return buildGlb(this.json, Buffer.concat(this.parts)); }
}

// 球 4 個。prim 0: OPAQUE の本体(モーフ 1 つ)、prim 1: 同じ材質・同じ属性の本体の続き(まとめると 1 個になる)、prim 2: MASK(守る)、prim 3: 三角形 100 の小さな OPAQUE(守る)
export function makeVrm({meta, springs, vrm0 = false} = {}) {
  const b = new Builder(), prims = [];
  const spec = [{s: sphere(40, 60), mat: 0, morph: true}, {s: sphere(30, 40, 0.5, 2), mat: 0, morph: true}, {s: sphere(20, 30, 0.4, 4), mat: 1, morph: false}, {s: sphere(5, 10, 0.2, 6), mat: 2, morph: false}];
  for (const {s, mat, morph} of spec) {
    const joints = new Uint16Array(s.count * 4), weights = new Float32Array(s.count * 4);
    for (let v = 0; v < s.count; v++) { joints[v * 4] = v % 2; joints[v * 4 + 1] = 2; weights[v * 4] = 0.75; weights[v * 4 + 1] = 0.25; }
    const delta = new Float32Array(s.count * 3);
    for (let v = 0; v < s.count; v++) if (s.pos[v * 3 + 1] > 0.3) delta[v * 3 + 1] = 0.02;
    const p = {attributes: {POSITION: b.add(s.pos, 'VEC3', 5126, {target: 34962, minmax: true}), NORMAL: b.add(s.nor, 'VEC3', 5126, {target: 34962}), TEXCOORD_0: b.add(s.uv, 'VEC2', 5126, {target: 34962}),
      JOINTS_0: b.add(joints, 'VEC4', 5123, {target: 34962}), WEIGHTS_0: b.add(weights, 'VEC4', 5126, {target: 34962})},
      indices: b.add(s.idx, 'SCALAR', 5125, {target: 34963}), material: mat};
    if (morph) p.targets = [{POSITION: b.add(delta, 'VEC3', 5126, {minmax: true})}];
    prims.push(p);
  }
  const j = b.json;
  j.materials = [{name: 'skin', alphaMode: 'OPAQUE'}, {name: 'lash', alphaMode: 'MASK'}, {name: 'small'}];
  j.meshes = [{name: 'Body', primitives: [prims[0], prims[1], prims[3]], extras: {targetNames: ['happy_key']}}, {name: 'Face', primitives: [prims[2]]}];
  // prim 0 と prim 1 は両方モーフ 1 つ。prim 3 にはモーフが無いので、まとめの組にならない
  j.nodes = [{name: 'hips', mesh: 0}, {name: 'face', mesh: 1}, {name: 'skirt0'}, {name: 'skirt1'}, {name: 'hair0'}, {name: 'hair1'}];
  j.scenes = [{nodes: [0, 1, 2, 3, 4, 5]}]; j.scene = 0;
  const vrmExt = {specVersion: '1.0', meta: meta ?? {name: 'Motion review', version: 'undefined', authors: ['__CHARAKIT_REVIEW__'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlyAuthor'},
    humanoid: {humanBones: {hips: {node: 0}}}, expressions: {preset: {happy: {morphTargetBinds: [{node: 0, index: 0, weight: 1}]}}}};
  j.extensions = vrm0 ? {VRM: {meta: {}}} : {VRMC_vrm: vrmExt, VRMC_springBone: {specVersion: '1.0', springs: springs ?? [
    {name: 'Skirt-skirt0_0', joints: [{node: 2, hitRadius: 0.02, stiffness: 0.5, gravityPower: 0, dragForce: 0.05}, {node: 3, hitRadius: 0.02, stiffness: 0.5, gravityPower: 0, dragForce: 0.05}]},
    {name: 'Hair-hair_0', joints: [{node: 4, hitRadius: 0.02, stiffness: 0.8, gravityPower: 0, dragForce: 0.4}, {node: 5, hitRadius: 0.02, stiffness: 0.8, gravityPower: 0, dragForce: 0.4}]}]}};
  j.extensionsUsed = Object.keys(j.extensions);
  return b.glb();
}

// VRMA: root(Y 軸まわりに 90 度回し、(1, 0, 2) へ置く)の子に hips。hips の translation は 4 キー、rotation も 4 キー
export function makeVrma({rotateParent = true, translation = true, animateParent = false} = {}) {
  const b = new Builder(), s = Math.SQRT1_2;
  const times = b.add(Float32Array.of(0, 0.1, 0.2, 0.3), 'SCALAR', 5126, {minmax: true});
  const trans = b.add(Float32Array.of(0, 1, 0, 0.1, 1.1, 0.2, 0.2, 1.2, 0.4, 0.3, 1.1, 0.6), 'VEC3', 5126);
  const rot = b.add(Float32Array.of(0, 0, 0, 1, 0, 0.1, 0, 0.995, 0, 0.2, 0, 0.98, 0, 0.3, 0, 0.95), 'VEC4', 5126);
  const j = b.json;
  j.nodes = [{name: 'root', ...(rotateParent && {rotation: [0, s, 0, s]}), translation: [1, 0, 2], children: [1]}, {name: 'hips'}];
  j.scenes = [{nodes: [0]}];
  j.animations = [{samplers: [{input: times, output: rot, interpolation: 'LINEAR'}, {input: times, output: trans, interpolation: 'LINEAR'}],
    channels: [{sampler: 0, target: {node: 1, path: 'rotation'}}, ...(translation ? [{sampler: 1, target: {node: 1, path: 'translation'}}] : []), ...(animateParent ? [{sampler: 0, target: {node: 0, path: 'rotation'}}] : [])]}];
  j.extensions = {VRMC_vrm_animation: {specVersion: '1.0', humanoid: {humanBones: {hips: {node: 1}}}}};
  j.extensionsUsed = ['VRMC_vrm_animation'];
  return b.glb();
}
