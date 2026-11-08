// 1 つの時間の流れで撮る take の確かめ(lib/short.mjs の takeBody)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {takeBody} from '../lib/short.mjs';
import {footstepCues, stopCues, withFootsteps} from '../lib/short-timeline.mjs';
import {SFX, mixArgs, resolveSfx} from '../lib/short-compose.mjs';

const lib = {getMotion: async () => ({})};
const take = extra => ({motions: ['walk-a', 'walk-b'], mark: [0, 31, 0], ...extra});

test('take: springs は出演者ごとの揺れ骨の値として残る', async () => {
  const t = await takeBody(lib, take({springs: [null, {skirt: [1.5, 0.3]}]}), 2);
  assert.deepEqual(t.springs, [null, {skirt: [1.5, 0.3]}]);
});

test('take: springs が無い、または全員 null なら持たない', async () => {
  assert.equal('springs' in await takeBody(lib, take(), 2), false);
  assert.equal('springs' in await takeBody(lib, take({springs: [null, null]}), 2), false);
});

test('take: springs の形と範囲を確かめる', async () => {
  for (const springs of [[{skirt: [1.5, 0.3]}], {skirt: [1, 0.3]}, [{skirt: [11, 0.3]}, null], [{skirt: [1, 2]}, null], [{'a b': [1, 0.3]}, null], [{skirt: [1]}, null], ['skirt', null]])
    await assert.rejects(takeBody(lib, take({springs}), 2), {code: 'bad-input'}, JSON.stringify(springs));
});

test('take: stop と footsteps は残り、無ければ持たない', async () => {
  const t = await takeBody(lib, take({stop: 21.5, footsteps: true}), 2);
  assert.equal(t.stop, 21.5);
  assert.equal(t.footsteps, true);
  const none = await takeBody(lib, take({footsteps: false}), 2);
  assert.equal('stop' in none, false);
  assert.equal('footsteps' in none, false);
});

test('take: stop の範囲と footsteps の型を確かめる', async () => {
  for (const extra of [{stop: 0.5}, {stop: 601}, {stop: 'x'}, {footsteps: 'yes'}, {footsteps: 1}])
    await assert.rejects(takeBody(lib, take(extra), 2), {code: 'bad-input'}, JSON.stringify(extra));
});

const walk = [{t: 0.5, side: 'right'}, {t: 1.03, side: 'left'}, {t: 1.57, side: 'right'}];

test('足音: 焼き込みの steps の時刻ごとに 1 つ、強さは歩の番号で決まる', () => {
  const cues = footstepCues([walk, walk]);
  assert.deepEqual(cues.map(c => c.name), Array(6).fill('gravel'));
  assert.deepEqual(cues.slice(0, 3).map(c => c.t), [0.5, 1.03, 1.57]);
  assert.deepEqual(footstepCues([walk, walk]), cues, '同じ入力は同じ強さ');
  assert.ok(cues.every(c => c.gain >= 0.7 && c.gain <= 1));
  assert.notEqual(cues[0].gain, cues[1].gain, '隣り合う歩は同じ強さにしない');
  assert.notEqual(cues[0].gain, cues[3].gain, '2 人の同じ番号の歩は同じ強さにしない');
  assert.deepEqual(footstepCues([null, walk]).map(c => c.t), [0.5, 1.03, 1.57], '焼き込みの無い人は鳴らさない');
  assert.deepEqual(footstepCues([walk], 1 / 30).map(c => c.t), [0.467, 0.997, 1.537], '動画は焼き込みより 1 コマ早い');
  assert.equal(footstepCues([[{t: 0.02, side: 'left'}]], 1 / 30)[0].t, 0, '0 秒より前には鳴らさない');
});

test('足音: 時刻順にほかの効果音へ混ぜ、元の timeline は変えない', () => {
  const timeline = {sfx: [{name: 'whoosh', t: 1, gain: 1}]};
  const mixed = withFootsteps(timeline, [walk, [{t: 0.9, side: 'left'}]]);
  assert.deepEqual(mixed.sfx.map(c => `${c.name}@${c.t}`), ['gravel@0.5', 'gravel@0.9', 'whoosh@1', 'gravel@1.03', 'gravel@1.57']);
  assert.equal(timeline.sfx.length, 1);
});

test('止まる音: 焼き込みの stop の時刻に 1 人 1 回、止まらない人は鳴らさない', () => {
  assert.deepEqual(stopCues([{t: 21.1333, from: 21}, null], 1 / 30), [{name: 'scuff', t: 21.1, gain: 1}]);
  assert.deepEqual(stopCues([{}, undefined]), []);
  const mixed = withFootsteps({sfx: []}, [walk, walk], 0, [{t: 1.2}, {t: 1.6}]);
  assert.deepEqual(mixed.sfx.filter(c => c.name === 'scuff').map(c => c.t), [1.2, 1.6]);
  assert.deepEqual(mixed.sfx.map(c => c.t), [...mixed.sfx.map(c => c.t)].sort((a, b) => a - b));
});

test('止まる音: scuff の素材を混ぜるとき、ピークを約 -9 dBFS にそろえる音量で 0.5 秒で切って混ざる', () => {
  const args = mixArgs({seconds: 3, voices: [], sfx: [{...SFX.scuff, file: 'scuff.mp3', t: 1, gain: 1}], bgm: null, out: 'out.wav'});
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /atrim=0:0\.5,/);
  assert.match(graph, /volume=-6.00dB/);
});

test('足音: gravel の素材を混ぜるとき、ピークを約 -15 dBFS にそろえる音量で 0.45 秒で切って混ざる', () => {
  const args = mixArgs({seconds: 3, voices: [], sfx: [{...SFX.gravel, file: 'gravel.mp3', t: 1, gain: 1}], bgm: null, out: 'out.wav'});
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /atrim=0:0\.45/);
  assert.match(graph, /volume=-14.00dB/);
});

test('効果音の素材: 本来の素材があればそれ、pixabay は自作の wav で代え、drama は無ければ null でログに残す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));
  const touch = f => { fs.mkdirSync(path.dirname(path.join(dir, f)), {recursive: true}); fs.writeFileSync(path.join(dir, f), ''); };
  const logs = [], log = m => logs.push(m);
  try {
    for (const f of ['whoosh.wav', 'pop.wav', 'impact.wav', 'glitch.wav', 'ding.wav']) touch(f);
    assert.equal(resolveSfx('whoosh', {dir, log}).file, path.join(dir, 'whoosh.wav'), 'pixabay が無ければ自作に代わる');
    assert.equal(resolveSfx('glitch', {dir, log}).seconds, 0.45);
    assert.equal(resolveSfx('ding', {dir, log}).file, path.join(dir, 'ding.wav'));
    assert.equal(logs.length, 2);
    assert.equal(resolveSfx('door', {dir, log}), null, 'drama が無ければ鳴らさない');
    assert.match(logs.at(-1), /door.*鳴らさない/);
    assert.equal(resolveSfx('nothing', {dir, log}), null);
    touch('pixabay/pop.mp3'); touch('drama/door.mp3');
    assert.equal(resolveSfx('pop', {dir}).file, path.join(dir, 'pixabay', 'pop.mp3'), '作者の手元では本来の素材を使う');
    assert.equal(resolveSfx('door', {dir}).db, SFX.door.db);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('効果音の素材: 同梱の自作 wav はすべて assets/sfx/ にある', () => {
  for (const f of ['whoosh.wav', 'pop.wav', 'impact.wav', 'glitch.wav', 'ding.wav', 'sparkle.wav']) assert.ok(fs.existsSync(new URL('../assets/sfx/' + f, import.meta.url)), f);
});
