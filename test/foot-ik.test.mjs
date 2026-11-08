// 接地中の足を床に留める IK（public/foot-ik.mjs）。判定、2 本の骨の解、計画と適用を、作りものの骨で確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import {hysteresis, spansOf, cleanSpans, contactsFromSidecar, contactsFromHeight, solveLeg, buildFootPlan, applyFootPlan, applyFootLayers, footPlanFor, FPS} from '../public/foot-ik.mjs';

const near = (a, b, eps = 1e-3, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} と ${b} の差`);

test('hysteresis: enter で入り、exit を超えるまで出ない', () => {
  assert.deepEqual(hysteresis([3, 2, 1, 2, 2.5, 3, 2], 1, 2.5), [false, false, true, true, true, false, false]);
});

test('spansOf と cleanSpans: 短い切れ目を埋め、短い区間を捨てる', () => {
  const on = s => [...s].map(c => c === '#');
  assert.deepEqual(spansOf(on('.##..#')), [[1, 2], [5, 5]]);
  assert.deepEqual(spansOf(cleanSpans(on('###..###......##....'), 4, 2)), [[0, 7]]);
  assert.deepEqual(spansOf(cleanSpans(on('##......'), 2, 2)), [[0, 1]]);
});

test('contactsFromSidecar: 左かかと・左爪先・右かかと・右爪先の信頼度をヒステリシスで読み、足りないコマは最後の値を使う', () => {
  const c = contactsFromSidecar({frames: [[1, 0, 0.5, 0], [0.5, 0, 0.5, 1], [0.3, 0, 0.7, 1]]}, 4);
  assert.deepEqual(c.left.heel, [true, true, false, false]);
  assert.deepEqual(c.left.toe, [false, false, false, false]);
  assert.deepEqual(c.right.heel, [false, false, true, true]);
  assert.deepEqual(c.right.toe, [false, true, true, true]);
});

test('contactsFromHeight: 低くても速い足（振り出し）は接地にしない。しきい値は脚の長さに比例する', () => {
  const height = Array(12).fill(0.005), slowFast = Array.from({length: 12}, (_, i) => i < 6 ? 0.05 : 1.5);
  const c = contactsFromHeight({heel: {height, speed: slowFast}, toe: {height, speed: slowFast}}, 0.6);
  assert.deepEqual(c.heel, slowFast.map(s => s < 1));
  // 同じ 0.3 m/s は、脚の長さ 0.6 m なら接地、0.3 m（入る速さが半分）なら接地ではない
  const speed = Array(5).fill(0.3), big = contactsFromHeight({heel: {height: Array(5).fill(0), speed}, toe: {height: Array(5).fill(0), speed}}, 0.6);
  const small = contactsFromHeight({heel: {height: Array(5).fill(0), speed}, toe: {height: Array(5).fill(0), speed}}, 0.3);
  assert.ok(big.heel.every(Boolean)); assert.ok(!small.heel.some(Boolean));
});

test('contactsFromHeight: 体つきで足が浮く動きでも、遅いコマの高さを床として判定する', () => {
  const height = [0.04, 0.04, 0.04, 0.04, 0.2, 0.2, 0.04, 0.04], speed = height.map(h => h > 0.1 ? 0.1 : 0.05);
  assert.deepEqual(contactsFromHeight({heel: {height, speed}, toe: {height, speed}}, 0.6).heel, height.map(h => h < 0.1));
});

test('contactsFromHeight: 足を上げたまま保つ間は接地にしない。床に着いているコマは接地のまま', () => {
  const still = n => Array(n).fill(0), lifted = Array(12).fill(0.2);
  assert.ok(!contactsFromHeight({heel: {height: lifted, speed: still(12)}, toe: {height: lifted, speed: still(12)}}, 0.6).heel.some(Boolean));
  // 床に 4 コマ、そのあと上げたまま 8 コマ（遅いコマの中央の値は上げた高さ）
  const height = [0, 0, 0, 0, ...Array(8).fill(0.2)];
  assert.deepEqual(contactsFromHeight({heel: {height, speed: still(12)}, toe: {height, speed: still(12)}}, 0.6).heel, height.map(h => h === 0));
  // しきい値は脚の長さに比例する: 同じ 8 cm が、脚の長さ 1.2 m では接地の高さ
  const low = Array(6).fill(0.08);
  assert.ok(contactsFromHeight({heel: {height: low, speed: still(6)}, toe: {height: low, speed: still(6)}}, 1.2).heel.every(Boolean));
  assert.ok(!contactsFromHeight({heel: {height: low, speed: still(6)}, toe: {height: low, speed: still(6)}}, 0.6).heel.some(Boolean));
});

const leg = (hip, knee, ankle) => [new THREE.Vector3(...hip), new THREE.Vector3(...knee), new THREE.Vector3(...ankle)];
const BEND = new THREE.Vector3(1, 0, 0);   // 体の左（VRM 1.0 は +X が左、+Z が前）
function solved(hip, knee, ankle, target) {
  const {upper, lower} = solveLeg(hip, knee, ankle, target, BEND);
  const k = knee.clone().sub(hip).applyQuaternion(upper).add(hip);
  // 下の骨は、膝からの向きを lower で回す
  return {k, a: ankle.clone().sub(knee).applyQuaternion(lower).add(k)};
}

test('solveLeg: 足首が target に来て、骨の長さは変わらず、膝は同じ向きのまま', () => {
  const [hip, knee, ankle] = leg([0, 1, 0], [0, 0.55, 0.1], [0, 0.1, 0]), target = new THREE.Vector3(0.1, 0.2, -0.15);
  const {k, a} = solved(hip, knee, ankle, target);
  near(a.distanceTo(target), 0, 1e-4, '足首');
  near(k.distanceTo(hip), knee.distanceTo(hip), 1e-4, '上の骨'); near(a.distanceTo(k), ankle.distanceTo(knee), 1e-4, '下の骨');
  assert.ok(k.z > hip.z, '膝は前のまま');
});

test('solveLeg: 届かない target には伸ばし切るまで。まっすぐな脚を縮めると膝は前へ曲がる', () => {
  const [hip, knee, ankle] = leg([0, 1, 0], [0, 0.55, 0.05], [0, 0.1, 0]), far = new THREE.Vector3(0, -1, 0);
  const a = solved(hip, knee, ankle, far).a;
  near(a.distanceTo(hip), knee.distanceTo(hip) + ankle.distanceTo(knee), 1e-3, '伸び切る');
  near(a.x, 0, 1e-4); assert.ok(a.y < 0.1);
  const [h2, k2, a2] = leg([0, 1, 0], [0, 0.55, 0], [0, 0.1, 0]);
  const r = solved(h2, k2, a2, new THREE.Vector3(0, 0.25, 0));
  assert.ok(r.k.z > 0.05, `膝が前へ ${r.k.z}`);
  // わずかに後ろへ曲がった脚でも、縮めるときは前へ曲げる
  const [h3, k3, a3] = leg([0, 1, 0], [0, 0.55, -0.005], [0, 0.1, 0]);
  assert.ok(solved(h3, k3, a3, new THREE.Vector3(0, 0.25, 0)).k.z > 0.05);
});

// 作りものの VRM。腰の高さ 0.85、脚の長さ 0.8、足首 0.05、爪先 0.02（前へ 0.1）。normalized な骨の親子だけ。
// shin: すねの長さ。vrm0: VRM 0 の形（骨は左が -X、前が -Z で並び、rotateVRM0 と同じに全体を 180 度回す）
function fakeVrm({toes = true, shin = 0.4, vrm0 = false} = {}) {
  const scene = new THREE.Group(), root = new THREE.Group(); scene.add(root);
  const flip = vrm0 ? -1 : 1;
  if (vrm0) root.rotation.y = Math.PI;
  const add = (name, parent, x, y, z) => { const o = new THREE.Object3D(); o.name = name; o.position.set(x, y, z); parent.add(o); return o; };
  const bones = {hips: add('hips', root, 0, 0.85, 0)};
  for (const [side, x] of [['left', 0.1 * flip], ['right', -0.1 * flip]]) {
    bones[side + 'UpperLeg'] = add(side + 'UpperLeg', bones.hips, x, 0, 0);
    bones[side + 'LowerLeg'] = add(side + 'LowerLeg', bones[side + 'UpperLeg'], 0, -0.4, 0);
    bones[side + 'Foot'] = add(side + 'Foot', bones[side + 'LowerLeg'], 0, -shin, 0);
    if (toes) bones[side + 'Toes'] = add(side + 'Toes', bones[side + 'Foot'], 0, -0.03, 0.1 * flip);
  }
  const rest = new Map(Object.values(bones).map(b => [b, b.position.clone()]));
  const humanoid = {
    getNormalizedBoneNode: name => bones[name] ?? null,
    normalizedHumanBones: Object.fromEntries(Object.entries(bones).map(([k, node]) => [k, {node}])),
    resetNormalizedPose() { for (const [b, p] of rest) { b.position.copy(p); b.quaternion.identity(); } },
  };
  return {scene, humanoid, bones};
}
// 腰が +Z へ speed m/s で進む（脚は固定）クリップ。止まった足を hips と一緒に滑らせる動き。y は hips の高さの差
function slideClip(vrm, seconds, speed, y = 0) {
  const n = Math.round(seconds * FPS) + 1, times = Array.from({length: n}, (_, i) => i / FPS);
  const values = times.flatMap(t => [0, 0.85 + y, t * speed]);
  return new THREE.AnimationClip('slide', seconds, [new THREE.VectorKeyframeTrack(vrm.bones.hips.name + '.position', times, values)]);
}
// 脚を少し曲げたままにするトラック（届く余裕を作る）。計画は休めの姿勢から作るので、姿勢はクリップに入れる
function bentTracks(vrm, skip = []) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.4), r = q.clone().invert();
  const pose = {UpperLeg: q, LowerLeg: r.clone().multiply(r), Foot: q}, tracks = [];
  for (const s of ['left', 'right']) {
    for (const [k, v] of Object.entries(pose)) {
      vrm.bones[s + k].quaternion.copy(v);
      if (!skip.includes(s + k)) tracks.push(new THREE.QuaternionKeyframeTrack(s + k + '.quaternion', [0, 1], [...v.toArray(), ...v.toArray()]));
    }
  }
  return tracks;
}
const worldOf = o => { o.updateWorldMatrix(true, false); return o.getWorldPosition(new THREE.Vector3()); };
const contactsAll = n => ({fps: FPS, frames: Array.from({length: n}, () => [1, 1, 1, 1])});

test('buildFootPlan: 骨の姿勢を変えず、接地の出どころを持つ', () => {
  const vrm = fakeVrm(), clip = slideClip(vrm, 0.5, 0.1);
  vrm.bones.leftUpperLeg.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2);
  const before = vrm.bones.leftUpperLeg.quaternion.clone(), hipsZ = vrm.bones.hips.position.z;
  const plan = buildFootPlan(vrm, clip, null);
  assert.equal(plan.source, 'height'); assert.equal(plan.frames, 16);
  assert.ok(vrm.bones.leftUpperLeg.quaternion.equals(before)); assert.equal(vrm.bones.hips.position.z, hipsZ);
  assert.equal(buildFootPlan(vrm, clip, contactsAll(16)).source, 'contacts');
});

test('applyFootPlan: 接地の間は足が最初の位置に留まり、コマの途中の時刻でも同じ。足の向きは元のまま。戻すと元の姿勢', () => {
  const vrm = fakeVrm(), clip = slideClip(vrm, 1, 0.15);
  const plan = buildFootPlan(vrm, clip, contactsAll(31));
  const hips = vrm.bones.hips, foot = vrm.bones.leftFoot, toes = vrm.bones.leftToes;
  hips.position.set(0, 0.85, 0); hips.updateWorldMatrix(true, true);
  const start = worldOf(foot), q0 = foot.getWorldQuaternion(new THREE.Quaternion());
  for (const t of [0.1, 0.25, 0.26, 0.4]) {
    hips.position.set(0, 0.85, t * 0.15);
    const before = vrm.bones.leftUpperLeg.quaternion.clone();
    const undo = applyFootPlan(plan, t);
    const p = worldOf(foot);
    near(p.x, start.x, 2e-3, `x ${t}`); near(p.z, start.z, 2e-3, `z ${t}`);
    assert.ok(foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(q0) < 1e-3, '足の向き');
    assert.ok(worldOf(toes).distanceTo(p) > 0.09);
    undo();
    assert.ok(vrm.bones.leftUpperLeg.quaternion.equals(before), '戻す');
    near(worldOf(foot).z, t * 0.15, 1e-6);
  }
});

test('applyFootPlan: weight 0 は何もせず、途中の weight は元の位置との間。計画が無くても動く', () => {
  const vrm = fakeVrm(), clip = slideClip(vrm, 1, 0.15), plan = buildFootPlan(vrm, clip, contactsAll(31));
  assert.equal(applyFootPlan(plan, 0.5, 0), null); assert.equal(applyFootPlan(null, 0.5), null);
  vrm.bones.hips.position.set(0, 0.85, 0.075);
  const undo = applyFootPlan(plan, 0.5, 0.5);
  near(worldOf(vrm.bones.leftFoot).z, 0.0375, 2e-3, '半分');
  undo();
});

test('床より下の足は足の裏を床へ上げる。振り出しの足も沈まない', () => {
  const vrm = fakeVrm(), clip = slideClip(vrm, 0.5, 0, -0.03);   // hips が 3 cm 低く、足首と爪先が床の下
  for (const sidecar of [contactsAll(16), {frames: Array.from({length: 16}, () => [0, 0, 0, 0])}]) {
    const plan = buildFootPlan(vrm, clip, sidecar);
    vrm.bones.hips.position.y = 0.82;
    const undo = applyFootPlan(plan, 0.25);
    near(worldOf(vrm.bones.leftFoot).y, 0.05, 2e-3, '足首'); near(worldOf(vrm.bones.leftToes).y, 0.02, 2e-3, '爪先');
    undo();
  }
});

test('届かないとき: hips を下げ、それでも足りなければ目標を元の足の位置へ寄せる', () => {
  const vrm = fakeVrm(), plan = buildFootPlan(vrm, slideClip(vrm, 2, 0.6), contactsAll(61));   // 1.2 m 進む間ずっと接地
  assert.ok(plan.maxDrop > 0.03 && plan.maxDrop <= 0.04 + 1e-6, `hips を下げる ${plan.maxDrop}`);
  assert.ok(plan.pulled > 0, '目標を寄せたコマがある');
  vrm.bones.hips.position.set(0, 0.85, 1.2);
  const undo = applyFootPlan(plan, 2);
  const hip = worldOf(vrm.bones.leftUpperLeg), a = worldOf(vrm.bones.leftFoot);
  assert.ok(a.distanceTo(hip) <= 0.8 + 1e-3); assert.ok(a.z > 0.5, `足は hips についていく ${a.z}`);
  undo();
});

test('接地の外: 区間の終わりのずれを数コマで元の動きへ戻す', () => {
  const vrm = fakeVrm();
  const tracks = bentTracks(vrm);
  const n = 31, c = {frames: Array.from({length: n}, (_, i) => i <= 15 ? [1, 1, 1, 1] : [0, 0, 0, 0])};
  const clip = slideClip(vrm, 1, 0.1); clip.tracks.push(...tracks);
  const plan = buildFootPlan(vrm, clip, c), t = plan.target.left;
  const z = i => t[i * 3 + 2], base = z(0);
  assert.equal(plan.pulled, 0); near(z(15), base, 1e-5, '留まる');
  const steps = Array.from({length: 8}, (_, k) => z(16 + k) - z(15 + k));
  assert.ok(steps.every(s => s > 0), '戻る間はずっと前へ'); assert.ok(Math.max(...steps) < 0.05, `急に跳ばない ${Math.max(...steps)}`);
  near(z(25) - z(24), 0.1 / FPS, 1e-4, '戻ったら元の速さ');
});

test('爪先で立つ間は、爪先を留めて足首を足の向きの分だけ動かす', () => {
  const vrm = fakeVrm();
  const tracks = bentTracks(vrm, ['leftFoot']);
  const n = 31, heelUntil = 15, frames = Array.from({length: n}, (_, i) => i <= heelUntil ? [1, 1, 1, 1] : [0, 1, 1, 1]);
  const times = Array.from({length: n}, (_, i) => i / FPS), axis = new THREE.Vector3(0, 1, 0), base = vrm.bones.leftFoot.quaternion.clone();
  const q = times.flatMap(t => new THREE.Quaternion().setFromAxisAngle(axis, Math.max(0, t - 0.5) * 2).multiply(base).toArray());
  const clip = new THREE.AnimationClip('turn', 1, [new THREE.QuaternionKeyframeTrack('leftFoot.quaternion', times, q), ...tracks]);
  const plan = buildFootPlan(vrm, clip, {frames});
  assert.equal(plan.pulled, 0);
  // 爪先の位置は最後まで動かない
  vrm.bones.hips.position.set(0, 0.85, 0);
  const toeAt = t => { const foot = vrm.bones.leftFoot, save = foot.quaternion.clone(); foot.quaternion.fromArray(clip.tracks[0].createInterpolant().evaluate(t)); const undo = applyFootPlan(plan, t); const p = worldOf(vrm.bones.leftToes); undo(); foot.quaternion.copy(save); return p; };
  const a = toeAt(0.6), b = toeAt(0.95);
  near(a.x, b.x, 2e-3, 'x'); near(a.z, b.z, 2e-3, 'z');
});

test('足を上げたまま保つ動きでは、上げた足を床へ押し下げず、立っている足だけ留める', () => {
  const vrm = fakeVrm(), up = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -1.2), back = up.clone().invert();
  const hold = (name, q) => new THREE.QuaternionKeyframeTrack(name + '.quaternion', [0, 1], [...q.toArray(), ...q.toArray()]);
  const clip = slideClip(vrm, 1, 0); clip.tracks.push(hold('leftUpperLeg', up), hold('leftLowerLeg', back));
  const plan = buildFootPlan(vrm, clip, null);
  assert.equal(plan.source, 'height');
  assert.deepEqual(plan.spans.left, []); assert.deepEqual(plan.spans.right, [[0, 30]]);
  vrm.bones.leftUpperLeg.quaternion.copy(up); vrm.bones.leftLowerLeg.quaternion.copy(back);
  const raised = worldOf(vrm.bones.leftFoot).y;
  assert.ok(raised > 0.25, `足は上がっている ${raised}`);
  const undo = applyFootPlan(plan, 0.5);
  near(worldOf(vrm.bones.leftFoot).y, raised, 1e-3, '上げた足の高さ');
  undo();
});

test('VRM 0: hips が 180 度回っていても、まっすぐな脚を縮めると膝は前へ曲がる', () => {
  const vrm = fakeVrm({vrm0: true}), plan = buildFootPlan(vrm, slideClip(vrm, 0.5, 0, -0.15), contactsAll(16));
  vrm.bones.hips.position.y = 0.7;
  const undo = applyFootPlan(plan, 0.25);
  for (const side of ['left', 'right']) {
    near(worldOf(vrm.bones[side + 'Foot']).y, 0.05, 2e-3, '足首');
    assert.ok(worldOf(vrm.bones[side + 'LowerLeg']).z > 0.1, `${side} の膝が前へ ${worldOf(vrm.bones[side + 'LowerLeg']).z}`);
  }
  undo();
});

// hips が z(i)（m）だけ進み、y(i) だけ上がるクリップ
function hipsClip(vrm, seconds, z, y = () => 0) {
  const n = Math.round(seconds * FPS) + 1, times = Array.from({length: n}, (_, i) => i / FPS);
  return new THREE.AnimationClip('hips', seconds, [new THREE.VectorKeyframeTrack('hips.position', times, times.flatMap((_, i) => [0, 0.85 + y(i, n), z(i, n)]))]);
}

test('継ぎ目のない繰り返し: 終わりまで続く接地の区間は、留めたまま最後のコマを最初のコマの足へつなぐ', () => {
  const vrm = fakeVrm(), z = (i, n) => 0.03 * Math.min(i / 20, (n - 1 - i) / (n - 21), 1);   // 行って戻る。接地の区間の中で足が動く
  const frames = Array.from({length: 31}, (_, i) => i < 10 || i >= 20 ? [1, 1, 1, 1] : [0, 0, 0, 0]);
  const plan = buildFootPlan(vrm, hipsClip(vrm, 1, z), {frames}), t = plan.target.left, Z = i => t[i * 3 + 2];
  assert.ok(plan.loop);
  near(Z(30), Z(0), 1e-5, '最後のコマは最初のコマの足'); near(t[30 * 3], t[0], 1e-5);
  for (let i = 21; i <= 30; i++) near(Z(i), Z(20), 1e-5, `接地の区間は留まる ${i}`);
});

test('継ぎ目のない繰り返し: 片方の端だけが接地でも、もう一方の端のずれへつなぐ', () => {
  // 足は休めの姿勢より少し高いので、接地のコマは足を下げる（高さのずれが出る）
  for (const contact of [i => i < 10, i => i >= 20]) {
    const vrm = fakeVrm(), frames = Array.from({length: 31}, (_, i) => contact(i) ? [1, 1, 1, 1] : [0, 0, 0, 0]);
    const clip = hipsClip(vrm, 1, (i, n) => 0.02 * Math.sin(Math.PI * i / (n - 1)), () => -0.05); clip.tracks.push(...bentTracks(vrm));
    const plan = buildFootPlan(vrm, clip, {frames}), t = plan.target.left;
    assert.ok(plan.loop); assert.ok(plan.spans.left.length === 1);
    near(t[30 * 3 + 2], t[2], 2e-3, '継ぎ目の前後'); near(t[30 * 3 + 1], t[1], 2e-3, '継ぎ目の高さ');
  }
});

test('継ぎ目のない繰り返し: 全体が 1 つの区間で留める点が動いたら、終わりの数十コマで少しずつ抜く', () => {
  const vrm = fakeVrm(), n = 61, axis = new THREE.Vector3(0, 1, 0);
  const times = Array.from({length: n}, (_, i) => i / FPS), yaw = i => Math.min(1, i / 20, (n - 1 - i) / 20) * 0.6;
  const q = times.flatMap((_, i) => new THREE.Quaternion().setFromAxisAngle(axis, yaw(i)).toArray());
  const clip = new THREE.AnimationClip('turn', 2, [new THREE.QuaternionKeyframeTrack('leftFoot.quaternion', times, q)]);
  // かかと → 爪先だけ → かかと（留める点が足の向きの分だけ入れ替わる）
  const frames = times.map((_, i) => i >= 20 && i < 40 ? [0, 1, 1, 1] : [1, 1, 1, 1]);
  const plan = buildFootPlan(vrm, clip, {frames}), t = plan.target.left, P = i => [t[i * 3], t[i * 3 + 2]];
  assert.ok(plan.loop); assert.deepEqual(plan.spans.left, [[0, 60]]);
  near(P(60)[0], P(0)[0], 1e-5); near(P(60)[1], P(0)[1], 1e-5);
  for (let i = 41; i <= 60; i++) assert.ok(Math.hypot(P(i)[0] - P(i - 1)[0], P(i)[1] - P(i - 1)[1]) < 0.01, `急に動かない ${i}`);
});

test('継ぎ目のない繰り返し: hips を下げる量は最初と最後のコマで同じ', () => {
  const vrm = fakeVrm(), bump = (i, n) => -0.08 + (Math.abs(i - (n - 6)) <= 2 ? 0.1 : 0);   // 終わりの近くだけ脚が届かない
  const clip = hipsClip(vrm, 1, () => 0, bump); clip.tracks.push(...bentTracks(vrm));
  const plan = buildFootPlan(vrm, clip, contactsAll(31));
  assert.ok(plan.loop); assert.ok(plan.drop[0] > 0, `最初のコマも下げる ${plan.drop[0]}`);
  near(plan.drop[30], plan.drop[0], 1e-6);
});

test('進むモーションは繰り返しとして扱わない', () => {
  const vrm = fakeVrm();
  assert.equal(buildFootPlan(vrm, slideClip(vrm, 1, 0.15), contactsAll(31)).loop, false);
});

test('buildFootPlan: 長さが 1/30 秒の倍数より少し短くても、最後のコマまで数える', () => {
  const vrm = fakeVrm(), clip = slideClip(vrm, 1, 0); clip.duration = 7.566666;
  assert.equal(buildFootPlan(vrm, clip, null).frames, 228);
});

test('applyFootLayers: 前の計画、今の計画の順に当て、逆の順に戻す', () => {
  const vrm = fakeVrm(), clip = slideClip(vrm, 1, 0.1), hips = vrm.bones.hips, foot = vrm.bones.leftFoot;
  const a = buildFootPlan(vrm, clip, contactsAll(31)), b = buildFootPlan(vrm, clip, contactsAll(31));
  a.drop.fill(0.01); b.drop.fill(0.02); b.target.left.forEach((_, i, t) => { if (i % 3 === 2) t[i] += 0.03; });
  hips.position.set(0, 0.85, 0.05);
  const action = weight => ({time: 0.5, getEffectiveWeight: () => weight});
  const q = vrm.bones.leftUpperLeg.quaternion.clone();
  let undo = applyFootLayers([{action: action(1), plan: a}, {action: action(1), plan: b}]);
  near(hips.position.y, 0.82, 1e-6, '両方の計画の hips'); near(worldOf(foot).z, 0.03, 2e-3, 'あとの計画の足');
  undo();
  near(hips.position.y, 0.85, 1e-6, '元の hips'); assert.ok(vrm.bones.leftUpperLeg.quaternion.equals(q), '元の骨');
  undo = applyFootLayers([{action: action(1), plan: a}, {action: action(0), plan: b}, {action: action(1), plan: null}]);
  near(worldOf(foot).z, 0, 2e-3, '重み 0 の計画は当てない');
  undo();
});

test('切り替えの 1 コマで足が跳ばず、フェードが終わると前のアクションは止まる', () => {
  const vrm = fakeVrm(), walk = hipsClip(vrm, 1, i => i * 0.15 / FPS), stay = hipsClip(vrm, 1, () => 0.075);
  const plan = buildFootPlan(vrm, walk, contactsAll(31)), foot = vrm.bones.leftFoot;
  const run = layersAfter => {
    const mixer = new THREE.AnimationMixer(vrm.scene), a = mixer.clipAction(walk), b = mixer.clipAction(stay);
    const frame = layers => { mixer.update(1 / 60); const undo = applyFootLayers(layers), p = worldOf(foot); undo(); return p; };
    a.play();
    for (let i = 0; i < 30; i++) frame([{action: a, plan}]);
    const p0 = frame([{action: a, plan}]);
    b.reset().play(); a.crossFadeTo(b, 0.3, false);
    const jump = p0.distanceTo(frame(layersAfter(a, b)));
    for (let i = 0; i < 24; i++) frame(layersAfter(a, b));
    const running = a.isRunning();
    mixer.stopAllAction(); mixer.uncacheRoot(vrm.scene);
    return {jump, running};
  };
  const both = run((a, b) => [{action: a, plan}, {action: b, plan: null}]), only = run((a, b) => [{action: b, plan: null}]);
  assert.ok(both.jump < 0.01, `前の計画も当てる ${both.jump}`); assert.ok(only.jump > 0.05, `今の計画だけなら跳ぶ ${only.jump}`);
  assert.equal(both.running, false, 'フェードが終わった');
});

test('爪先の骨が無いキャラでも動く。脚が無ければ計画を作らない', () => {
  const vrm = fakeVrm({toes: false}), clip = slideClip(vrm, 0.5, 0.1);
  const plan = buildFootPlan(vrm, clip, contactsAll(16));
  vrm.bones.hips.position.set(0, 0.85, 0.05);
  const undo = applyFootPlan(plan, 0.5);
  near(worldOf(vrm.bones.leftFoot).z, 0, 2e-3); undo();
  vrm.humanoid.getNormalizedBoneNode = name => name === 'leftFoot' ? null : vrm.bones[name];
  assert.equal(buildFootPlan(vrm, clip, null), null);
});

test('hips が無いキャラと、長さ 0 の骨のキャラは計画を作らず、姿勢も変えない', () => {
  const vrm = fakeVrm(), clip = slideClip(vrm, 0.5, 0.1);
  vrm.humanoid.getNormalizedBoneNode = name => name === 'hips' ? null : vrm.bones[name];
  assert.equal(buildFootPlan(vrm, clip, null), null);
  const short = fakeVrm({shin: 0}), knee = short.bones.leftLowerLeg;
  knee.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3);
  const q = knee.quaternion.clone();
  assert.equal(buildFootPlan(short, slideClip(short, 0.5, 0.1), null), null);
  assert.ok(knee.quaternion.equals(q));
});

test('footPlanFor: 横の情報を読む。その場のモーションは留めない', async t => {
  const vrm = fakeVrm(), clip = slideClip(vrm, 0.5, 0.1), urls = [];
  t.mock.method(globalThis, 'fetch', async url => { urls.push(url); return {ok: true, json: async () => contactsAll(16)}; });
  assert.equal(await footPlanFor({generated: {options: {root: 'inplace'}}}, vrm, clip), null);   // MotionBricks の記録の形
  assert.equal(await footPlanFor({generated: {root: 'inplace'}}, vrm, clip), null);   // 文章から作ったモーションの記録の形
  assert.equal((await footPlanFor({generated: {root: 'keep'}}, vrm, clip)).source, 'height');
  assert.equal((await footPlanFor({generated: {options: {root: 'keep'}}}, vrm, clip)).source, 'height');
  assert.equal((await footPlanFor({}, vrm, clip)).source, 'height');
  assert.deepEqual(urls, []);
  assert.equal((await footPlanFor({contactsUrl: '/lib/motions/a/contacts.json'}, vrm, clip)).source, 'contacts');
  assert.deepEqual(urls, ['/lib/motions/a/contacts.json']);
});

test('footPlanFor: 横の情報が使えないときは、再生を止めず高さの判定へ落とす', async t => {
  const vrm = fakeVrm(), clip = slideClip(vrm, 0.5, 0.1), m = {contactsUrl: '/lib/motions/a/contacts.json'};
  const body = value => async () => ({ok: true, json: async () => value});
  const cases = {
    '404': async () => ({ok: false, status: 404}),
    '通信の失敗': async () => { throw Error('offline'); },
    '壊れた JSON': async () => ({ok: true, json: async () => { throw SyntaxError('bad json'); }}),
    '中身が null': body(null),
    'frames が無い': body({fps: FPS}),
    'frames が空': body({fps: FPS, frames: []}),
    'コマの形が違う': body({fps: FPS, frames: Array.from({length: 16}, () => [1, 1])}),
    '数でない値': body({fps: FPS, frames: Array.from({length: 16}, () => [1, 1, null, 1])}),
    'コマの数が大きく違う': body(contactsAll(60)),
    'fps が違う': body({...contactsAll(16), fps: 60}),
    'fps が無い': body({frames: contactsAll(16).frames}),
  };
  let answer;
  t.mock.method(globalThis, 'fetch', url => answer(url));
  const warn = t.mock.method(console, 'warn', () => {});
  for (const [name, a] of Object.entries(cases)) {
    answer = a;
    assert.equal((await footPlanFor(m, vrm, clip)).source, 'height', name);
  }
  assert.equal(warn.mock.callCount(), Object.keys(cases).length);
  answer = body(contactsAll(17));   // 1 コマの違いはそのまま使う（足りないコマは最後の値）
  assert.equal((await footPlanFor(m, vrm, clip)).source, 'contacts');
});
