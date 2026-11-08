import test from 'node:test';
import assert from 'node:assert/strict';
import {partOf, meshRole, springKind, profileOf, referenceOf, checkVroid, summary, MATERIAL_RE} from '../lib/vroid-format.mjs';

// VRoid 1.26 の形を小さく真似た VRM 1.0 の JSON
const KEYS = ['Fcl_ALL_Neutral', 'Fcl_ALL_Joy', 'Fcl_EYE_Close', 'Fcl_EYE_Close_L', 'Fcl_EYE_Close_R', 'Fcl_MTH_A'];
function vroidLike({keys = KEYS, eyeNames = ['J_Adj_L_FaceEye', 'J_Adj_R_FaceEye'], springJoint = 'J_Sec_Hair1_01', shift = -0.05} = {}) {
  const nodes = [{name: 'J_Bip_C_Hips'}, {name: 'J_Bip_C_Head'}, {name: eyeNames[0]}, {name: eyeNames[1]}, {name: springJoint}, {name: 'Face', mesh: 0}, {name: 'Body', mesh: 1}, {name: 'Hair', mesh: 2}];
  const mt = s => ({extensions: {VRMC_materials_mtoon: {shadingShiftFactor: s, shadingToonyFactor: Math.abs(s), outlineWidthMode: 'worldCoordinates'}}});
  const materials = [{name: 'N00_000_00_FaceMouth_00_FACE (Instance)', ...mt(shift)}, {name: 'N00_000_00_EyeIris_00_EYE (Instance)', ...mt(shift)}, {name: 'N00_000_00_EyeHighlight_00_EYE (Instance)', ...mt(shift)}, {name: 'N00_000_00_Face_00_SKIN (Instance)', ...mt(shift)},
    {name: 'N00_000_00_Body_00_SKIN (Instance)', ...mt(1)}, {name: 'N00_000_Hair_00_HAIR_01 (Instance)', ...mt(-0.35)}];
  const accessors = [{count: 30}];
  const prim = m => ({material: m, indices: 0, attributes: {POSITION: 0}});
  const pre = (k, i) => ({morphTargetBinds: [{node: 5, index: keys.indexOf(k), weight: 1}]});
  const preset = {neutral: 'Fcl_ALL_Neutral', happy: 'Fcl_ALL_Joy', blink: 'Fcl_EYE_Close', blinkLeft: 'Fcl_EYE_Close_L', blinkRight: 'Fcl_EYE_Close_R', aa: 'Fcl_MTH_A'};
  return {nodes, materials, accessors, meshes: [{name: 'Face (merged).baked', primitives: [0, 1, 2, 3].map(prim), extras: {targetNames: keys}}, {name: 'Body (merged).baked', primitives: [prim(4)]}, {name: 'Hair001 (merged).baked', primitives: [prim(5)]}],
    extensions: {VRMC_vrm: {humanoid: {humanBones: {hips: {node: 0}, head: {node: 1}, leftEye: {node: 2}, rightEye: {node: 3}}}, lookAt: {type: 'bone'}, expressions: {preset: Object.fromEntries(Object.entries(preset).filter(([, k]) => keys.includes(k)).map(([p, k]) => [p, pre(k)]))}},
      VRMC_springBone: {springs: [{name: 'Hair-123', joints: [{node: 4, stiffness: 0.8, dragForce: 0.4, gravityPower: 0}]}], colliders: [{node: 1, shape: {sphere: {radius: 0.1}}}]}}};
}

test('材質の名前から部品の種類を決める', () => {
  assert.equal(partOf('N00_000_00_FaceMouth_00_FACE (Instance)'), 'FaceMouth');
  assert.equal(partOf('F00_000_00_Face_00_SKIN'), 'FaceSkin');
  assert.equal(partOf('N00_005_01_Shoes_01_CLOTH (Instance)'), 'Cloth');
  assert.equal(partOf('F00_000_Hair_00_HAIR_02'), 'Hair');
  assert.equal(partOf('Material_hair'), null);
  assert.ok(MATERIAL_RE.test('N00_000_00_Face_00_SKIN'));
  assert.ok(!MATERIAL_RE.test('Material_hair'));
  assert.equal(meshRole('Hair001 (merged).baked'), 'Hair');
  assert.equal(meshRole('Face2 (merged).baked'), 'Face');
  assert.equal(meshRole('Hairpin'), null);
  assert.equal(meshRole('Body'), 'Body');
  assert.equal(springKind('Skirt-abc', 'J_Sec_L_Skirt1'), 'Skirt');
  assert.equal(springKind('', 'J_Sec_Hair3_05'), 'Hair');
});

test('VRoid と同じ形なら全部合格し、違う所は × か △ になる', () => {
  const ref = referenceOf([profileOf(vroidLike())]);
  const good = checkVroid(profileOf(vroidLike()), ref);
  assert.equal(summary(good).ng, 0, JSON.stringify(good.filter(i => i.level !== 'ok')));
  const bad = checkVroid(profileOf(vroidLike({keys: KEYS.slice(0, 4), eyeNames: ['eye.L', 'eye.R'], springJoint: 'Skirt0_0_0', shift: 0.8})), ref);
  const level = id => bad.find(i => i.id === id).level;
  assert.equal(level('fcl-keys'), 'ng');
  assert.equal(level('presets'), 'ng');
  assert.equal(level('look-at'), 'ng');
  assert.equal(level('spring-names'), 'ng');
  assert.equal(level('mtoon'), 'warn');
});

test('手本どうしでキーが違うと手本を作らない', () => {
  assert.throws(() => referenceOf([profileOf(vroidLike()), profileOf(vroidLike({keys: KEYS.slice(0, 3)}))]), /キーが違う/);
});
