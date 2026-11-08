import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseGlb, buildGlb, conformVrm, colliderLayout, defaultMaterialName, ConformError} from '../lib/vroid-conform.mjs';
import {profileOf, checkVroid, partOf} from '../lib/vroid-format.mjs';

const ref = JSON.parse(fs.readFileSync(new URL('../studio/vroid/reference.json', import.meta.url), 'utf8'));
const BIN = Buffer.from('0123456789abcdef0123456789abcdef');
const BIN_TYPE = 'BIN\u0000';

// きゃらくる風の小さな VRM。T ポーズで正面は +Z
function build({materials, skinOf = () => 0, upperChest = true} = {}) {
  const nodes = [], by = {};
  const add = (name, parent, t, extra = {}) => { const i = nodes.length; nodes.push({name, translation: t, ...extra}); by[name] = i; if (parent != null) (nodes[by[parent]].children ??= []).push(i); return i; };
  add('root', null, [0, 0, 0]); add('hips', 'root', [0, 1, 0]); add('spine', 'hips', [0, 0.1, 0]); add('chest', 'spine', [0, 0.1, 0]);
  if (upperChest) add('upperChest', 'chest', [0, 0.1, 0]);
  const top = upperChest ? 'upperChest' : 'chest';
  add('neck', top, [0, 0.1, 0]); add('head', 'neck', [0, 0.1, 0]); add('eye.L', 'head', [0.03, 0.05, 0.08]); add('eye.R', 'head', [-0.03, 0.05, 0.08]);
  for (const [s, x] of [['L', 1], ['R', -1]]) {
    add(`ua.${s}`, top, [0.1 * x, 0.05, 0]); add(`la.${s}`, `ua.${s}`, [0.25 * x, 0, 0]); add(`hand.${s}`, `la.${s}`, [0.25 * x, 0, 0]); add(`mid.${s}`, `hand.${s}`, [0.05 * x, 0, 0]);
    add(`ul.${s}`, 'hips', [0.08 * x, -0.05, 0]); add(`ll.${s}`, `ul.${s}`, [0, -0.4, 0]);
  }
  add('Hair_0_0', 'head', [0, 0.05, -0.05]); add('Hair_0_1', 'Hair_0_0', [0, -0.1, 0]); add('Hair_0_1_CharakitEnd', 'Hair_0_1', [0, -0.1, 0]);
  add('Hair_1_0', 'head', [0.02, 0.05, -0.05]); add('Hair_1_1', 'Hair_1_0', [0, -0.1, 0]); add('tip', 'Hair_1_1', [0, -0.1, 0]);
  add('Skirt0_0_0', 'hips', [0, 0, 0.1]); add('Skirt0_0_1', 'Skirt0_0_0', [0, -0.2, 0]);
  add('Bust_L_0', 'chest', [0.05, 0, 0.05]); add('Bust_L_1', 'Bust_L_0', [0, -0.05, 0]);
  const bones = nodes.map((_, i) => i);
  const meshNode = (name, mesh) => { const i = add(name, null, undefined, {mesh, skin: skinOf(name)}); delete nodes[i].translation; return i; };
  const mats = materials ?? ['Material_upper_body', 'Material_lower_body', 'Material_hair', 'Material_accessories', 'Material_head', 'head_liner'];
  const prim = (m, targets) => ({attributes: {POSITION: 0}, material: m, ...(targets ? {targets: Array.from({length: targets}, () => ({POSITION: 0}))} : {})});
  const n = {body: meshNode('Body', 0), hair: meshNode('Hair', 1), head: meshNode('Head', 2), skirt: meshNode('Spring_01_skirt', 3), liner: meshNode('Head_liner', 4)};
  const hb = {hips: 'hips', spine: 'spine', chest: 'chest', neck: 'neck', head: 'head', leftEye: 'eye.L', rightEye: 'eye.R', leftUpperArm: 'ua.L', leftLowerArm: 'la.L', leftHand: 'hand.L', leftMiddleProximal: 'mid.L',
    rightUpperArm: 'ua.R', rightLowerArm: 'la.R', rightHand: 'hand.R', rightMiddleProximal: 'mid.R', leftUpperLeg: 'ul.L', leftLowerLeg: 'll.L', rightUpperLeg: 'ul.R', rightLowerLeg: 'll.R'};
  if (upperChest) hb.upperChest = 'upperChest';
  const joint = (name, extra = {}) => ({node: by[name], hitRadius: 0.02, stiffness: 1, dragForce: 0.5, gravityPower: 0.3, gravityDir: [0, -1, 0], ...extra});
  const js = {asset: {version: '2.0', generator: 'test gen'}, scene: 0, scenes: [{nodes: [by.root, n.body, n.hair, n.head, n.skirt, n.liner]}], nodes,
    skins: [{joints: bones, skeleton: by.hips}],
    accessors: [{bufferView: 0, componentType: 5126, count: 1, type: 'VEC3'}], bufferViews: [{buffer: 0, byteOffset: 0, byteLength: 12}], buffers: [{byteLength: BIN.length}],
    materials: mats.map(name => ({name, extensions: {VRMC_materials_mtoon: {specVersion: '1.0', shadingShiftFactor: 0, shadingToonyFactor: 0.9, outlineWidthMode: 'none', outlineWidthFactor: 0}}})),
    meshes: [{name: 'body_00001.001', primitives: [prim(0), prim(1)]}, {name: 'head_00001', primitives: [prim(2), prim(3)]}, {name: 'head_00014.001', primitives: [prim(4, 2)], extras: {targetNames: ['blink', 'happy']}},
      {name: 'body_00182.001', primitives: [prim(1)]}, {name: 'Head_liner', primitives: [prim(5)]}],
    extensionsUsed: ['VRMC_vrm', 'VRMC_springBone', 'VRMC_materials_mtoon'],
    extensions: {
      VRMC_vrm: {humanoid: {humanBones: Object.fromEntries(Object.entries(hb).map(([k, v]) => [k, {node: by[v]}]))}, firstPerson: {meshAnnotations: [{node: n.hair, type: 'auto'}]},
        expressions: {preset: {blink: {morphTargetBinds: [{node: n.head, index: 0, weight: 1}]}}, custom: {smile: {morphTargetBinds: [{node: n.head, index: 1, weight: 0.6}]}}}},
      VRMC_springBone: {specVersion: '1.0',
        springs: [{name: 'hair_0', joints: ['Hair_0_0', 'Hair_0_1', 'Hair_0_1_CharakitEnd'].map(x => joint(x)), colliderGroups: [0]}, {name: 'hair_1', joints: ['Hair_1_0', 'Hair_1_1'].map(x => joint(x)), colliderGroups: [0]},
          {name: 'skirt0_0', joints: ['Skirt0_0_0', 'Skirt0_0_1'].map(x => joint(x, {hitRadius: 0.0181})), colliderGroups: [0]}, {name: 'bust', joints: ['Bust_L_0', 'Bust_L_1'].map(x => joint(x)), colliderGroups: [0]}],
        colliders: [{node: by.chest, shape: {capsule: {offset: [0, 0, 0], radius: 0.1, tail: [0, 1, 0]}}}], colliderGroups: [{name: 'old', colliders: [0]}]}}};
  return {glb: buildGlb(js, [{type: BIN_TYPE, data: BIN}]), by, n};
}
const conform = (buf, o = {}) => { const r = conformVrm(buf, {ref, from: 'D:/lib/model.vrm', ...o}), p = parseGlb(r.glb); return {...r, js: p.json, rest: p.rest}; };
const nameOf = (js, i) => js.nodes[i].name;

test('骨の名前を手本の J_Bip と J_Adj にし、手本に無い骨はそのまま', () => {
  const {js, report} = conform(build().glb);
  const hb = js.extensions.VRMC_vrm.humanoid.humanBones;
  assert.equal(nameOf(js, hb.hips.node), 'J_Bip_C_Hips');
  assert.equal(nameOf(js, hb.leftUpperArm.node), 'J_Bip_L_UpperArm');
  assert.equal(nameOf(js, hb.rightMiddleProximal.node), 'J_Bip_R_Middle1');
  assert.equal(nameOf(js, hb.leftEye.node), 'J_Adj_L_FaceEye');
  assert.equal(report.humanoidBones, Object.keys(hb).length);
  assert.ok(js.nodes.some(n => n.name === 'root'), '手本に無い root はそのまま');
});

test('揺れ骨: 髪は J_Sec_Hair<深さ>_<番号>、スカートは J_Sec_Skirt、末尾は _end、そのほかは英数字', () => {
  const {js, report} = conform(build().glb);
  const sb = js.extensions.VRMC_springBone, chain = s => s.joints.map(j => nameOf(js, j.node));
  assert.deepEqual(chain(sb.springs[0]), ['J_Sec_Hair1_01', 'J_Sec_Hair2_01', 'J_Sec_Hair2_01_end'], 'CharakitEnd は関節のまま _end');
  assert.deepEqual(chain(sb.springs[1]), ['J_Sec_Hair1_02', 'J_Sec_Hair2_02']);
  assert.ok(js.nodes.some(n => n.name === 'J_Sec_Hair2_02_end'), '関節に入っていない末端の子の骨');
  assert.deepEqual(chain(sb.springs[2]), ['J_Sec_Skirt1_01', 'J_Sec_Skirt2_01']);
  assert.deepEqual(chain(sb.springs[3]), ['J_Sec_BustL0', 'J_Sec_BustL1']);
  assert.deepEqual(sb.springs.map(s => s.name), ['Hair-hair_0', 'Hair-hair_1', 'Skirt-skirt0_0', 'Bust-bust']);
  assert.deepEqual(report.springs.byKind, {Hair: 2, Skirt: 1, Bust: 1});
});

test('揺れものの値は種類ごとに VRoid の値、hitRadius は元のまま', () => {
  const {js} = conform(build().glb), sp = js.extensions.VRMC_springBone.springs;
  for (const j of sp[0].joints) assert.deepEqual([j.stiffness, j.dragForce, j.gravityPower, j.hitRadius], [0.8, 0.4, 0, 0.02]);
  for (const j of sp[2].joints) assert.deepEqual([j.stiffness, j.dragForce, j.gravityPower, j.hitRadius], [0.5, 0.05, 0, 0.0181]);
  for (const j of sp[3].joints) assert.deepEqual([j.stiffness, j.dragForce, j.gravityPower], [0.75, 0.05, 0]);
});

test('コライダー: 骨ごとに組 1 つ、球の数は手本どおり、髪は脚以外、スカートは脚、胸は無し', () => {
  const {js, report} = conform(build().glb), sb = js.extensions.VRMC_springBone;
  assert.equal(sb.colliders.length, 28);
  assert.equal(report.colliders.count, 28);
  assert.ok(sb.colliders.every(c => c.shape.sphere && !c.shape.capsule));
  const count = Object.fromEntries(sb.colliderGroups.map(g => [g.name, g.colliders.length]));
  assert.deepEqual(count, ref.colliders);
  assert.deepEqual(sb.colliderGroups.map(g => nameOf(js, sb.colliders[g.colliders[0]].node)), sb.colliderGroups.map(g => g.name));
  const legs = sb.colliderGroups.map((g, i) => (/UpperLeg/.test(g.name) ? i : -1)).filter(i => i >= 0);
  assert.equal(legs.length, 2);
  assert.equal(sb.springs[0].colliderGroups.length, 10);
  assert.ok(sb.springs[0].colliderGroups.every(g => !legs.includes(g)));
  assert.deepEqual(sb.springs[2].colliderGroups, legs);
  assert.equal(sb.springs[3].colliderGroups, undefined);
});

test('球の位置は手本の置き方を体の大きさで移す(出力から読み直すと同じ置き方になる)', () => {
  const {js} = conform(build().glb), got = colliderLayout(js);
  for (const [k, list] of Object.entries(ref.colliderLayout)) list.forEach((e, i) => { for (const f of Object.keys(e)) assert.ok(Math.abs(e[f] - got[k][i][f]) < 1e-4, `${k}[${i}].${f}`); });
  // 体の大きさ(hips から head = 0.5)に比例する: 頭の球の半径
  const sb = js.extensions.VRMC_springBone, headBone = js.extensions.VRMC_vrm.humanoid.humanBones.head.node;
  const head = sb.colliders.find(c => c.node === headBone).shape.sphere.radius;
  assert.ok(Math.abs(head - ref.colliderLayout.head[0].r * 0.5) < 1e-4);
});

test('upperChest が無いモデルは、その球を chest の骨に置いて記録する', () => {
  const {js, report} = conform(build({upperChest: false}).glb);
  assert.equal(js.extensions.VRMC_springBone.colliders.length, 28);
  assert.ok(report.notes.some(n => n.includes('upperChest')));
});

test('材質の名前: 既定の対応、--map、すでに VRoid の名前なら維持、決まらなければ止める', () => {
  assert.equal(defaultMaterialName('head_liner'), 'N00_000_HairBack_00_HAIR');
  assert.equal(defaultMaterialName('Material_head'), 'N00_000_00_Face_00_SKIN');
  assert.equal(defaultMaterialName('EyeIris'), 'N00_000_00_EyeIris_00_EYE');
  assert.equal(defaultMaterialName('FaceMouth'), 'N00_000_00_FaceMouth_00_FACE');
  assert.equal(defaultMaterialName('mystery'), null);
  const {js} = conform(build().glb);
  assert.deepEqual(js.materials.map(m => m.name), ['N00_000_00_Body_00_SKIN', 'N00_001_01_Bottoms_01_CLOTH', 'N00_000_Hair_00_HAIR_01', 'N00_002_01_Accessory_01_CLOTH', 'N00_000_00_Face_00_SKIN', 'N00_000_HairBack_00_HAIR']);
  const mapped = conform(build().glb, {map: {Material_accessories: 'N00_009_01_Shoes_01_CLOTH'}}).js;
  assert.equal(mapped.materials[3].name, 'N00_009_01_Shoes_01_CLOTH');
  const keep = conform(build({materials: ['N00_000_00_Body_00_SKIN', 'lower_body', 'hair', 'accessories', 'head', 'liner']}).glb).js;
  assert.equal(keep.materials[0].name, 'N00_000_00_Body_00_SKIN');
  assert.throws(() => conform(build({materials: ['upper_body', 'lower_body', 'hair', 'accessories', 'head', 'mystery']}).glb), e => e instanceof ConformError && /mystery/.test(e.message));
  assert.throws(() => conform(build().glb, {map: {Material_accessories: 'N00_000_00_Body_00_SKIN'}}), /重なる/);
});

test('MToon: 部品ごとに手本の値、テクスチャは触らない', () => {
  const parsed = parseGlb(build().glb);
  parsed.json.materials[0].extensions.VRMC_materials_mtoon.shadeMultiplyTexture = {index: 3};
  const {js} = conform(buildGlb(parsed.json, parsed.rest));
  const mt = i => js.materials[i].extensions.VRMC_materials_mtoon;
  assert.equal(mt(0).shadingShiftFactor, 1); assert.equal(mt(0).outlineWidthMode, 'none', '輪郭線は元のまま'); assert.equal(mt(0).outlineWidthFactor, 0);
  assert.equal(mt(2).shadingShiftFactor, -0.35); assert.equal(mt(2).shadingToonyFactor, 0.35);
  assert.equal(mt(4).shadingShiftFactor, -0.05); assert.equal(mt(4).parametricRimFresnelPowerFactor, 8);
  assert.equal(mt(5).shadingShiftFactor, -0.35, 'HairBack は髪の値');
  assert.deepEqual(mt(0).shadeMultiplyTexture, {index: 3});
});

test('メッシュ: Face・Body・Hair に組み直し、使わないノードとメッシュを消す', () => {
  const b = build(), before = parseGlb(b.glb).json, {js, report} = conform(b.glb);
  assert.deepEqual(js.meshes.map(m => m.name), ['Face (merged).baked', 'Body (merged).baked', 'Hair001 (merged).baked']);
  assert.deepEqual(js.meshes.map(m => m.primitives.length), [1, 5, 1]);
  const face = js.meshes[0];
  assert.deepEqual(face.extras.targetNames, ['blink', 'happy']);
  assert.equal(face.primitives[0].targets.length, 2);
  assert.deepEqual(js.nodes.filter(n => n.mesh != null).map(n => n.name).sort(), ['Body', 'Face', 'Hair']);
  assert.equal(js.nodes.length, before.nodes.length - 2, 'スカートと liner のノードが消える');
  assert.deepEqual(report.removedNodes.sort(), ['Head_liner', 'Spring_01_skirt']);
  assert.ok(report.meshes.every(m => m.nodeIndex === undefined));
  const p = profileOf(js);
  assert.equal(p.meshes.find(m => m.role === 'Body').materials.includes('N00_000_HairBack_00_HAIR'), true);
  assert.equal(p.meshes.find(m => m.role === 'Hair').materials.join(), 'N00_000_Hair_00_HAIR_01');
  assert.equal(p.meshes.find(m => m.role === 'Face').materials.join(), 'N00_000_00_Face_00_SKIN');
});

test('インデックスの詰め直し: skin、Humanoid、表情、firstPerson、揺れ骨が同じノードを指し続ける', () => {
  const b = build(), before = parseGlb(b.glb).json, {js} = conform(b.glb);
  assert.equal(js.skins[0].joints.length, before.skins[0].joints.length);
  assert.equal(nameOf(js, js.skins[0].skeleton), 'J_Bip_C_Hips');
  assert.ok(js.nodes.every((n, i) => (n.children ?? []).every(c => c < js.nodes.length && c !== i)));
  assert.deepEqual(js.scenes[0].nodes.map(i => nameOf(js, i)), ['root', 'Body', 'Hair', 'Face']);
  const ex = js.extensions.VRMC_vrm.expressions;
  assert.equal(nameOf(js, ex.preset.blink.morphTargetBinds[0].node), 'Face');
  const bind = ex.custom.smile.morphTargetBinds[0];
  assert.equal(js.meshes[js.nodes[bind.node].mesh].extras.targetNames[bind.index], 'happy');
  assert.equal(nameOf(js, js.extensions.VRMC_vrm.firstPerson.meshAnnotations[0].node), 'Hair');
  const sb = js.extensions.VRMC_springBone;
  assert.ok(sb.springs.every(s => s.joints.every(j => /^J_Sec_/.test(nameOf(js, j.node)))));
  assert.ok(sb.colliders.every(c => /^J_Bip_/.test(nameOf(js, c.node))));
  assert.equal(new Set(js.nodes.map(n => n.name)).size, js.nodes.length, 'ノード名は重ならない');
  assert.ok(!js.nodes.some(n => n.name === 'Head_liner'));
});

test('BIN はそのまま、GLB の長さと JSON の区切りが合う', () => {
  const {glb, rest, js} = conform(build().glb);
  assert.equal(glb.readUInt32LE(8), glb.length);
  const jsonLen = glb.readUInt32LE(12);
  assert.equal(jsonLen % 4, 0);
  assert.equal(glb.toString('latin1', 16, 20), 'JSON');
  assert.equal(glb.toString('latin1', 20 + jsonLen + 4, 20 + jsonLen + 8), BIN_TYPE);
  assert.equal(rest.length, 1);
  assert.ok(Buffer.compare(rest[0].data, BIN) === 0);
  assert.equal(glb.readUInt32LE(20 + jsonLen), BIN.length);
  assert.deepEqual(js.extras, {vroidConform: {version: 1, from: 'model.vrm'}});
  assert.equal(js.asset.generator, 'test gen');
});

test('検査: 変換後の骨、揺れ骨、揺れもの、コライダー、MToon、材質、メッシュが ○ になる', () => {
  const {js} = conform(build().glb), items = Object.fromEntries(checkVroid(profileOf(js), ref).map(i => [i.id, i.level]));
  assert.notEqual(items.bones, 'ng', '小さなモデルは Humanoid が 54 本に足りず warn');
  for (const id of ['spring-names', 'spring-values', 'colliders', 'mtoon', 'material-names', 'material-place', 'meshes']) assert.equal(items[id], 'ok', id);
});

test('止める: skin が違うノードはまとめない、名前が重なる、VRM でない', () => {
  assert.throws(() => conform(build({skinOf: name => (name === 'Head_liner' ? 1 : 0)}).glb), e => e instanceof ConformError && /skin か変換/.test(e.message));
  const clash = parseGlb(build().glb); clash.json.nodes.push({name: 'J_Bip_C_Hips'}); clash.json.scenes[0].nodes.push(clash.json.nodes.length - 1);
  assert.throws(() => conform(buildGlb(clash.json, clash.rest)), /名前が重なる|二重/);
  const plain = parseGlb(build().glb); delete plain.json.extensions.VRMC_vrm;
  assert.throws(() => conform(buildGlb(plain.json, plain.rest)), /VRM 1.0 ではない/);
  assert.throws(() => conform(Buffer.from('not a glb at all, really not')), /glb ではない/);
});

test('顔のメッシュにキーあり・なしが混ざるときは、少ない方を別のメッシュに分けて報告する(目標の数をそろえる決まり)', () => {
  const parsed = parseGlb(build().glb), js = parsed.json;
  js.meshes[4].primitives[0].material = 4;   // liner のノードに顔の材質(目標なし)を付ける
  const out = conform(buildGlb(js, parsed.rest));
  assert.equal(out.report.unmergedMeshes.length, 1);
  for (const m of out.js.meshes) assert.equal(new Set(m.primitives.map(p => (p.targets ?? []).length)).size, 1, m.name);
  assert.equal(out.js.meshes.filter(m => /^Face/.test(m.name)).length, 2);
  assert.equal(new Set(out.js.nodes.map(n => n.name)).size, out.js.nodes.length);
});

test('CLI: 入力は変えず、出力と報告を書き、止めたときは報告に理由を書く', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vconf-')), inp = path.join(dir, 'in.vrm'), out = path.join(dir, 'out.vrm'), rep = path.join(dir, 'r.json');
  const orig = build().glb; fs.writeFileSync(inp, orig);
  const script = fileURLToPath(new URL('../scripts/vroid-conform.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [script, ...args], {encoding: 'utf8'});
  const ok = run(['--in', inp, '--out', out, '--report', rep]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(Buffer.compare(fs.readFileSync(inp), orig) === 0);
  assert.equal(JSON.parse(fs.readFileSync(rep, 'utf8')).colliders.count, 28);
  assert.equal(parseGlb(fs.readFileSync(out)).json.meshes.length, 3);
  const bad = parseGlb(orig); bad.json.materials[5].name = 'mystery'; fs.writeFileSync(inp, buildGlb(bad.json, bad.rest));
  const stopped = run(['--in', inp, '--out', path.join(dir, 'out2.vrm'), '--report', rep]);
  assert.equal(stopped.status, 3);
  assert.match(JSON.parse(fs.readFileSync(rep, 'utf8')).stopped[0], /mystery/);
  assert.ok(!fs.existsSync(path.join(dir, 'out2.vrm')));
  assert.equal(run(['--in', inp, '--out', inp]).status, 2);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('顔のキーなしの面の方が多くても、キーを持つまとまりを Face の主にし、検査はメッシュを △ にする', () => {
  const parsed = parseGlb(build().glb), js = parsed.json;
  js.meshes[4].primitives = [{attributes: {POSITION: 0}, material: 4}, {attributes: {POSITION: 0}, material: 4}];   // 目標なしの顔の面を 2 つ(キーのある面は 1 つ)
  const out = conform(buildGlb(js, parsed.rest));
  const main = out.js.meshes.find(m => m.name === 'Face (merged).baked');
  assert.deepEqual(main.extras?.targetNames, ['blink', 'happy']);
  const faceNode = out.js.nodes.findIndex(n => n.name === 'Face');
  assert.equal(out.js.extensions.VRMC_vrm.expressions.preset.blink.morphTargetBinds[0].node, faceNode);
  const meshes = checkVroid(profileOf(out.js), ref).find(i => i.id === 'meshes');
  assert.equal(meshes.level, 'warn');
  assert.match(meshes.detail, /同じ役/);
});

test('手本で指の骨まで割合で置いた手の球は、指の骨が無いモデルでは手首へ寄せずに止める', () => {
  const parsed = parseGlb(build().glb), hb = parsed.json.extensions.VRMC_vrm.humanoid.humanBones;
  delete hb.leftMiddleProximal;
  assert.throws(() => conform(buildGlb(parsed.json, parsed.rest)), e => e instanceof ConformError && /leftHand/.test(e.message));
});

test('輪郭線の指定: 目、口、眉は線なし、顔の輪郭とほかは指定の太さ、元の太さのテクスチャは外す', () => {
  const parsed = parseGlb(build().glb);
  parsed.json.materials[0].extensions.VRMC_materials_mtoon.outlineWidthMultiplyTexture = {index: 2};
  parsed.json.materials[4].extensions.VRMC_materials_mtoon.outlineWidthMode = 'worldCoordinates';
  const {js} = conform(buildGlb(parsed.json, parsed.rest), {outline: 0.0008});
  const mt = i => js.materials[i].extensions.VRMC_materials_mtoon;
  assert.equal(mt(0).outlineWidthMode, 'worldCoordinates'); assert.equal(mt(0).outlineWidthFactor, 0.0008); assert.equal(mt(0).outlineWidthMultiplyTexture, undefined);
  assert.equal(mt(2).outlineWidthFactor, 0.0004, '髪は 0.4 mm の線');
  assert.equal(mt(4).outlineWidthFactor, 0.0008, '顔の肌(輪郭)にも線');
  const hair6 = conform(buildGlb(parsed.json, parsed.rest), {outline: 0.0008, hairOutline: 0.0006}).js.materials[2].extensions.VRMC_materials_mtoon;
  assert.equal(hair6.outlineWidthFactor, 0.0006, '髪の太さは指定できる');
  const off = conform(buildGlb(parsed.json, parsed.rest), {outline: 0}).js.materials[2].extensions.VRMC_materials_mtoon;
  assert.equal(off.outlineWidthMode, 'none', '線を消すと髪も消える');
  const noLine = ['FaceMouth', 'EyeWhite', 'EyeIris', 'EyeHighlight', 'EyeExtra', 'FaceEyeline', 'FaceEyelash', 'FaceBrow'];
  const withParts = conform(build({materials: ['Material_upper_body', 'Material_lower_body', 'Material_hair', 'Material_accessories', 'Face_00_SKIN', 'FaceMouth', 'EyeIris', 'FaceBrow']}).glb, {outline: 0.0008}).js;
  const faceParts = withParts.materials.filter(m => noLine.includes(partOf(m.name)));
  assert.equal(faceParts.length, 3, '口、虹彩、眉の 3 つ');
  assert.equal(withParts.materials.find(m => partOf(m.name) === 'FaceSkin')?.extensions.VRMC_materials_mtoon.outlineWidthFactor, 0.0008, '顔の肌には線');
  for (const m of faceParts) assert.equal(m.extensions.VRMC_materials_mtoon.outlineWidthMode, 'none', `${m.name} は線なし`);
  assert.throws(() => conform(build().glb, {outline: 0.5}), e => e instanceof ConformError);
});
