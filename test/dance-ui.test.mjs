// ダンス MV の編集画面の計算(public/mv-plan.mjs)。DOM は使わない。
import test from 'node:test';
import assert from 'node:assert/strict';
import {danceBounds} from '../lib/dance.mjs';
import {beatCutsBody, danceCutBounds, danceEdits, danceShortBody, danceSplitOf, danceTotal, splitConditions, toggleStage} from '../public/mv-plan.mjs';

test('画面の帯の秒の累積は lib/dance.mjs の danceBounds と同じ', () => {
  const cuts = [{seconds: 2}, {seconds: 3.5}, {seconds: 1.0000004}, {seconds: 0.1 + 0.2}];
  assert.deepEqual(danceCutBounds(cuts), danceBounds(cuts));
  assert.equal(danceTotal(cuts), danceBounds(cuts).at(-1).end);
  assert.equal(danceTotal([]), 0);
});

test('拍から割る本文は music の値と長さ。足りない値は既定、動きが無ければ送らない', () => {
  assert.deepEqual(beatCutsBody({stages: ['a', 'b'], bpm: 100, motionId: 'm1'}, 20), {stages: ['a', 'b'], seconds: 20, bpm: 100, seed: 1, beatsPerShot: 8, shotsPerScene: 1, audioStart: 0, motionId: 'm1'});
  assert.equal('motionId' in beatCutsBody({stages: ['a']}, 15), false);
  assert.deepEqual(beatCutsBody({}, 15).stages, []);
});

test('手で直した欄: シーン、カメラ、角度を割ったときの値と比べる', () => {
  const cut = {stage: 'a', camera: 'close', angle: 10, telop: ''}, base = danceSplitOf(cut);
  assert.deepEqual(danceEdits(cut, base), []);
  assert.deepEqual(danceEdits({...cut, telop: 'やあ'}, base), [], 'テロップは割り方に入らない');
  assert.deepEqual(danceEdits({...cut, camera: 'orbit', angle: 0}, base), ['カメラ', '角度']);
  assert.deepEqual(danceEdits({...cut, stage: 'b'}, base), ['ステージ']);
  assert.deepEqual(danceEdits(cut, undefined), [], '覚えていないカットは注意しない');
  assert.deepEqual(danceEdits({stage: 'a', camera: 'close'}, danceSplitOf({stage: 'a', camera: 'close', angle: 0})), [], '角度が無いのは 0');
});

test('割る条件が変わったかは、曲、シーン、テンポ、長さなどで決まる', () => {
  const m = {stages: ['a'], motionId: 'm', bpm: 120};
  assert.equal(splitConditions(m, 15, null), splitConditions({...m}, 15, null));
  assert.equal(splitConditions(m, 15, null), splitConditions({...m, seed: 1, beatsPerShot: 8}, 15, null), '既定値と同じなら変わっていない');
  for (const other of [splitConditions({...m, bpm: 121}, 15, null), splitConditions({...m, stages: ['a', 'b']}, 15, null), splitConditions(m, 16, null), splitConditions(m, 15, 'au1'), splitConditions({...m, audioStart: 2}, 15, null)])
    assert.notEqual(other, splitConditions(m, 15, null));
});

test('シーンは押した順に並び、もう一度押すと外す。空なら undefined', () => {
  assert.deepEqual(toggleStage(undefined, 'a'), ['a']);
  assert.deepEqual(toggleStage(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleStage(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.equal(toggleStage(['a'], 'a'), undefined);
  const before = ['a'];
  toggleStage(before, 'b');
  assert.deepEqual(before, ['a'], '元の並びは変えない');
});

test('#mv から作るショートの本文', () => {
  assert.deepEqual(danceShortBody({id: 'c1', name: 'ミク'}, 'v2'), {charId: 'c1', verId: 'v2', title: 'ミク のダンス MV'});
  assert.deepEqual(danceShortBody({id: 'c1'}, null), {charId: 'c1', title: 'c1 のダンス MV'});
});

test('#mv から作る入口: 送信中の保護はキャラ/バージョンごと。別のキャラは別のショートに着地し、同じキャラは 1 回しか送らない', async () => {
  const el = () => ({append() {}, replaceChildren() {}, setAttribute() {}, addEventListener() {}});
  const saved = {document: globalThis.document, Node: globalThis.Node, fetch: globalThis.fetch, history: globalThis.history, location: globalThis.location};
  const landed = [], posts = [];
  globalThis.document = {createElement: el}; globalThis.Node = class {}; globalThis.history = {replaceState() {}}; globalThis.location = {replace: u => landed.push(u)};
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); posts.push(body.charId);
    await new Promise(r => setTimeout(r, 10));
    return {ok: true, text: async () => JSON.stringify({id: 'short-' + body.charId})};
  };
  try {
    const {startDanceShort} = await import('../public/short-dance.mjs');
    const go = id => startDanceShort({main: el(), char: {id, name: id}, verId: 'v1', alive: () => true});
    await Promise.all([go('A'), go('B'), go('A')]);
    assert.deepEqual(posts.sort(), ['A', 'B']);
    assert.deepEqual(landed.sort(), ['#short/short-A', '#short/short-A', '#short/short-B']);
  } finally { Object.assign(globalThis, saved); for (const k of Object.keys(saved)) if (saved[k] === undefined) delete globalThis[k]; }
});
