// ショートのカメラの 3 つの軸(public/short-camera.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import {SHORT_CAMERAS} from '../lib/short.mjs';
import {CAMERA_AXES, CAMERA_COMBOS, cameraAxes, camerasFor, chooseCamera, shortKind} from '../public/short-camera.mjs';

test('カメラの軸: 26 のカメラがすべて対応表にあり、軸の値は軸の一覧の中にある', () => {
  assert.equal(SHORT_CAMERAS.length, 26);
  assert.deepEqual(CAMERA_COMBOS.map(c => c.id).sort(), [...SHORT_CAMERAS].sort());
  for (const c of CAMERA_COMBOS) for (const a of CAMERA_AXES) assert.ok(a.values.includes(c[a.key]), `${c.id} の ${a.key}`);
  // 同じ種類の中で 3 つの軸が同じカメラは無い(軸の組で 1 つに決まる)
  for (const kind of ['talk', 'walk', 'creature']) {
    const keys = CAMERA_COMBOS.filter(c => c.kinds.includes(kind)).map(c => `${c.who}|${c.dist}|${c.move}`);
    assert.equal(new Set(keys).size, keys.length, kind);
  }
});

test('カメラの軸: 動画の種類ごとに使えるカメラ。立って話す 14、歩く 5、生き物あり 7', () => {
  assert.equal(shortKind({cuts: []}), 'talk');
  assert.equal(shortKind({take: {motions: []}}), 'walk');
  assert.equal(shortKind({take: {motions: [], creature: {blend: 'x'}}}), 'creature');
  assert.equal(camerasFor('talk').length, 14);
  assert.deepEqual(camerasFor('walk'), ['front_walk', 'side_walk', 'back_walk', 'diag_walk', 'walk_close']);
  assert.deepEqual(camerasFor('creature'), [...camerasFor('walk'), 'crow_close', 'crow_takeoff']);
  assert.deepEqual(camerasFor('talk').sort(), SHORT_CAMERAS.slice(0, 14).sort());   // 前からある 14 のカメラ
});

test('カメラの軸: 1 つの軸を変えると、ほかの軸をなるべく保つカメラを選び、使えない値は null', () => {
  assert.equal(chooseCamera('talk_bust', 'dist', '全身', 'talk').id, 'talk_wide');
  assert.equal(chooseCamera('talk_bust', 'dist', '寄り', 'talk').id, 'talk_close');
  assert.equal(chooseCamera('talk_bust', 'move', '回り込む', 'talk').id, 'orbit');
  assert.equal(chooseCamera('talk_bust', 'who', '話す人', 'talk').id, 'bust_who');   // 距離と角度を保つ
  assert.equal(chooseCamera('close_who', 'who', '手紙', 'talk').id, 'prop_close');
  assert.equal(chooseCamera('talk_bust', 'dist', '胸から上', 'talk').id, 'talk_bust');   // 今の値はそのまま
  assert.equal(chooseCamera('front_walk', 'move', '横', 'creature').id, 'side_walk');
  assert.equal(chooseCamera('front_walk', 'who', '話す人', 'creature').id, 'walk_close');
  assert.equal(chooseCamera('front_walk', 'who', '生き物', 'creature').id, 'crow_close');
  assert.equal(chooseCamera('bust_who', 'who', '話す人', 'walk').id, 'walk_close');   // 種類に無いカメラからも選び直せる
  assert.equal(chooseCamera('front_walk', 'who', '生き物', 'walk'), null);
  assert.equal(chooseCamera('front_walk', 'move', '肩越し', 'creature'), null);
  assert.equal(chooseCamera('talk_bust', 'move', '横', 'talk'), null);
});

test('カメラの軸: 画面のボタン。使えない値は off で理由を持ち、今のカメラが種類に無ければ選び直しを促す', () => {
  const {axes, offNote, hint} = cameraAxes('front_walk', 'creature');
  const who = axes.find(a => a.key === 'who').items;
  assert.deepEqual(who.map(o => [o.value, o.on, o.off]), [['話す人', false, false], ['決まった人', false, true], ['2 人', true, false], ['生き物', false, false], ['手紙', false, true]]);
  assert.equal(who[1].why, '枝の生き物がいる動画では使えない');
  assert.equal(who[3].camera, 'crow_close');
  assert.match(offNote, /^薄い選択肢\(決まった人、手紙、大写し、肩越し、下から、寄っていく、引いていく\)は枝の生き物がいる動画では使えない$/);
  assert.equal(hint, '');
  const talk = cameraAxes('close_who', 'talk');
  assert.equal(talk.axes.find(a => a.key === 'who').items.find(o => o.value === '手紙').why, '手紙を持つカットだけ');
  assert.equal(talk.axes.find(a => a.key === 'who').items.find(o => o.value === '生き物').why, '立って話す動画では使えない');
  assert.equal(cameraAxes('crow_close', 'talk').hint, '立って話す動画では使えないカメラ。軸から選び直す');
});
