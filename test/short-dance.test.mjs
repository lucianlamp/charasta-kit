// ダンス MV(ショートの型 dance): 型の定義、music の確かめ、拍から割る API、書き出し。Blender は CHARASTA_FAKE_CAPTURE で省く。python と ffmpeg は要る。
//   stage-studio は一時のフォルダに作った偽物(lib/shots.py は本物の plan / assign_stages と同じ割り方、tools/beats.py は決まった拍)を使い、本物は読むだけ
import test from 'node:test';
import {findPython} from '../lib/platform.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {DANCE_LOOKS, DANCE_NEW_LOOK, checkShots, danceBounds, danceKey, lookChoices, ownedFrames, roundHalfEven, shotsFromCuts, splitDanceFrames, supportsShotsIn} from '../lib/dance.mjs';
import {draftInput} from '../lib/short-draft.mjs';
import {buildMix, mixArgs} from '../lib/short-compose.mjs';
import {DRAFT_STYLES, SHORT_STYLES, STYLE_LABEL, direct} from '../public/short-direct.mjs';
import {DANCE_CAMERAS, cameraAxes, camerasFor, shortKind} from '../public/short-camera.mjs';
import {tempDir, fakeGlb, FAKE_ENV, SAMPLE_VRMA, startServer} from './helpers.mjs';

// 本物の stage-studio(環境変数 CHARASTA_REAL_STAGE。読むだけ)。無ければ、それを使うテストは飛ばす
const REAL_STAGE = process.env.CHARASTA_REAL_STAGE || path.join(os.tmpdir(), 'charasta-no-real-stage');
const SHOTS_PY = `import random

FLOW = ['wide_push', 'orbit', 'close', 'low_feet', 'crane_up', 'side_track', 'close', 'orbit', 'high_top', 'crane_down', 'low_feet', 'close']


def beats_of(bpm, seconds, offset=0.0):
    step = 60.0 / bpm
    n = int((seconds - offset) / step) + 2
    return [offset + i * step for i in range(n)]


def plan(beats, seconds, seed=0, beats_per_shot=8, first_beats=8):
    r = random.Random(seed)
    cuts = [0.0]
    i = first_beats
    while i < len(beats) and beats[i] < seconds - 0.6:
        cuts.append(beats[i])
        i += beats_per_shot
    cuts.append(seconds)
    out, angle = [], r.choice([-20, 20])
    for k, (a, b) in enumerate(zip(cuts[:-1], cuts[1:])):
        kind = FLOW[(k + seed) % len(FLOW)] if k else 'wide_push'
        angle = r.choice([-1, 1]) * 12 if k == 0 else max(-42, min(42, angle + r.choice([-50, -30, 30, 50])))
        out.append({'kind': kind, 'start': a, 'end': b, 'a': angle, 'dir': r.choice([-1, 1]), 'seed': r.randint(0, 99999)})
    return out


def assign_stages(shots, stages, shots_per_scene=1):
    return [{**s, 'stage': stages[(k // shots_per_scene) % len(stages)]} for k, s in enumerate(shots)]
`;
// 曲の拍: 0.25 秒から 0.5 秒おき(120 BPM)。標準出力は本物の beats.py と同じ形
const BEATS_PY = `import json, sys
out = sys.argv[2]
json.dump([round(0.25 + 0.5 * i, 4) for i in range(80)], open(out, 'w'))
print('bpm 120.0 offset 0.25 beats 80')
`;

async function stageDir(extra = {}) {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'stages'));
  await fs.mkdir(path.join(dir, 'lib'));
  await fs.mkdir(path.join(dir, 'tools'));
  await fs.writeFile(path.join(dir, 'stages', 'catalog.json'), JSON.stringify([{id: 'concert', label: 'コンサート'}, {id: 'classroom', label: '教室'}]));
  await fs.writeFile(path.join(dir, 'stages', 'concert.py'), '# 1');
  await fs.writeFile(path.join(dir, 'lib', 'shots.py'), SHOTS_PY);
  await fs.writeFile(path.join(dir, 'tools', 'beats.py'), BEATS_PY);
  await fs.writeFile(path.join(dir, 'tools', 'make_mv.py'), '# make_mv(偽物)');
  for (const [name, text] of Object.entries(extra)) await fs.writeFile(path.join(dir, name), text);
  return dir;
}

async function server(extra = {}) {
  const s = await startServer({stageStudioDir: await stageDir(extra), env: FAKE_ENV});
  const lib = s.server.jobs.lib;
  await lib.createCharacter({id: 'c1', name: 'いち'});
  await lib.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({a: 1})});
  await lib.importMotion({id: 'dance', data: await fs.readFile(SAMPLE_VRMA), label: 'ダンス', license: {holder: 'h', summary: '改変可', redistribution: false}});
  const api = async (method, url, body) => {
    const r = await fetch(s.base + url, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)});
    return {status: r.status, json: await r.json().catch(() => null)};
  };
  return {...s, lib, api};
}
const song = async (s, seconds = 30) => {
  const file = path.join(s.libraryDir, 'song.wav');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, file]);
  return s.lib.importAudio({name: 'song.wav', data: await fs.readFile(file)});
};
const lufsOf = file => Number([...spawnSync('ffmpeg', ['-v', 'info', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], {encoding: 'utf8'}).stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1]);

// ---- 型と純粋な計算 ----
test('型: dance は一覧にあり、下書きの対象から外れ、転換と効果音を付けない', () => {
  assert.ok(SHORT_STYLES.includes('dance')); assert.equal(STYLE_LABEL.dance, 'ダンス MV');
  assert.deepEqual(DRAFT_STYLES, ['trivia', 'drama', 'pop', 'news']);
  const cuts = [{text: '', telop: '', stage: 'a'}, {text: '', telop: '字幕', stage: 'b'}, {text: '', telop: '', stage: 'a'}];
  const d = direct(cuts, 'dance');
  assert.deepEqual(d.cuts.map(c => c.transition), ['none', 'none', 'none'], 'シーンが変わっても黒を挟まない');
  assert.equal(d.bgm, null); assert.equal(d.letterbox, false);
  assert.ok(d.cuts.every(c => c.sfx.length === 0), '効果音 0');
  assert.deepEqual(d.cuts.map(c => c.effects), [[], [], []]);
  assert.equal(d.cuts[1].telopText, '字幕');
  assert.equal(d.cuts[0].telopText, '', 'テロップの既定は空');
  assert.equal(direct([{text: 'あ', stage: 'a', sound: 'door', soundGain: 1}], 'dance').cuts[0].sfx[0].name, 'door', '人が選んだ音は鳴らせる');
});

test('下書き: ダンス MV の型は作れない', async () => {
  await assert.rejects(draftInput({}, '', {style: 'dance', theme: 'x', cast: []}), /型は/);
});

test('カメラ: ダンス MV の種類は FLOW の 8 つ。ほかの種類のボタンに新しい動きの語は出ない', () => {
  assert.deepEqual([...DANCE_CAMERAS].sort(), ['close', 'crane_down', 'crane_up', 'high_top', 'low_feet', 'orbit', 'side_track', 'wide_push']);
  assert.equal(shortKind({style: 'dance', cuts: []}), 'dance');
  assert.deepEqual(camerasFor('dance'), DANCE_CAMERAS);
  const moves = kind => cameraAxes('wide_push', kind).axes.find(a => a.key === 'move').items.map(i => i.value);
  assert.ok(moves('dance').includes('上がっていく')); assert.ok(!moves('talk').includes('上がっていく'));
  assert.equal(moves('talk').length, 10);
});

test('コマの数: 偶数丸め、拍の境で shots.json と同じ規則で数える', () => {
  assert.equal(roundHalfEven(1.5), 2); assert.equal(roundHalfEven(2.5), 2); assert.equal(roundHalfEven(449.9999999), 450);
  const shots = [{start: 0, end: 2}, {start: 2, end: 4}, {start: 4, end: 6.01}];
  assert.deepEqual(ownedFrames(shots, 180), [60, 60, 60]);
  assert.deepEqual(ownedFrames([{start: 0, end: 0.5}, {start: 0.5, end: 1}], 30), [15, 15]);
  assert.deepEqual(ownedFrames([{start: 0, end: 1}, {start: 1, end: 2}], 70), [30, 40], '最後のショットは残りのコマを持つ');
});

test('カット表の境: 秒の累積で、shots.json と同じ形にできる', () => {
  const cuts = [{seconds: 2, camera: 'wide_push', angle: 12, stage: 'a', shot: {dir: -1, seed: 5}}, {seconds: 3.5, camera: 'close', angle: -30, stage: 'b'}];
  assert.deepEqual(danceBounds(cuts), [{start: 0, end: 2}, {start: 2, end: 5.5}]);
  assert.deepEqual(shotsFromCuts(cuts), [{kind: 'wide_push', start: 0, end: 2, a: 12, dir: -1, seed: 5, stage: 'a'}, {kind: 'close', start: 2, end: 5.5, a: -30, dir: 1, seed: 0, stage: 'b'}]);
  // 演出の anime は描画の条件に入る。plain と書かないものは前と同じキー
  const m0 = {bpm: 120, seed: 1, beatsPerShot: 8, shotsPerScene: 1, audioStart: 0}, k = music => danceKey({code: 'c', cast: {charId: 'a', verId: 'v'}, cuts, stageCodes: ['x', 'y'], music, pct: 40, samples: 32});
  const kk = (music, lookOn) => danceKey({code: 'c', cast: {charId: 'a', verId: 'v'}, cuts, stageCodes: ['x', 'y'], music, pct: 40, samples: 32, lookOn});
  assert.equal(k(m0), k({...m0, look: 'plain'})); assert.equal(k(m0), k({...m0, look: 'anime'}), 'stage-studio が --look を受けないなら、look はキーに入れない');
  assert.equal(kk(m0, true), kk({...m0, look: 'plain'}, true)); assert.notEqual(kk(m0, true), kk({...m0, look: 'anime'}, true));
  assert.equal(kk(m0, false), kk(m0, true), 'look の無いショートのキーは lookOn で変わらない');
  assert.notEqual(danceKey({code: 'c', cast: {charId: 'a', verId: 'v'}, cuts, stageCodes: ['x', 'y'], music: {bpm: 120, seed: 1, beatsPerShot: 8, shotsPerScene: 1, audioStart: 0}, pct: 40, samples: 32}),
    danceKey({code: 'c', cast: {charId: 'a', verId: 'v'}, cuts: [{...cuts[0], angle: 13}, cuts[1]], stageCodes: ['x', 'y'], music: {bpm: 120, seed: 1, beatsPerShot: 8, shotsPerScene: 1, audioStart: 0}, pct: 40, samples: 32}));
});

test('照合: 時刻、シーン、カメラ、角度、カットの数がずれると理由を付けて失敗にする', () => {
  const cuts = [{seconds: 2, camera: 'wide_push', angle: 12, stage: 'a'}, {seconds: 2, camera: 'close', angle: -30, stage: 'b'}];
  const good = shotsFromCuts(cuts);
  checkShots(cuts, good);
  checkShots(cuts, good.map(s => ({...s, start: s.start + 0.005, end: s.end - 0.005})));   // 許容の中
  assert.throws(() => checkShots(cuts, good.slice(0, 1)), /1 カット/);
  assert.throws(() => checkShots(cuts, [good[0], {...good[1], start: 2.5}]), /カット 2 の時刻/);
  assert.throws(() => checkShots(cuts, [good[0], {...good[1], stage: 'a'}]), /カット 2 のシーン/);
  assert.throws(() => checkShots(cuts, [good[0], {...good[1], kind: 'orbit'}]), /カット 2 のカメラ/);
  assert.throws(() => checkShots(cuts, [{...good[0], a: -12}, good[1]]), /カット 1 の角度/);
});

test('コマの分け方: shots.json の時刻でカットごとのフォルダへハードリンクし、ずれていれば分けない', async () => {
  const dir = await tempDir(), mvDir = path.join(dir, 'mv'), work = path.join(dir, 'work');
  await fs.mkdir(path.join(mvDir, 'frames'), {recursive: true});
  for (let f = 1; f <= 90; f++) await fs.writeFile(path.join(mvDir, 'frames', `${String(f).padStart(5, '0')}.png`), String(f));
  const cuts = [{seconds: 1, camera: 'wide_push', angle: 0, stage: 'a'}, {seconds: 2, camera: 'orbit', angle: 0, stage: 'b'}];
  await fs.writeFile(path.join(mvDir, 'shots.json'), JSON.stringify(shotsFromCuts(cuts)));
  assert.deepEqual(await splitDanceFrames({mvDir, work, ids: ['x', 'y'], cuts, frames: 90}), [30, 60]);
  assert.equal(await fs.readFile(path.join(work, 'y', 'frames', '00001.png'), 'utf8'), '31');
  assert.equal((await fs.stat(path.join(work, 'y', 'frames', '00060.png'))).nlink, 2, 'コピーではなくハードリンク');
  assert.equal((await fs.readdir(path.join(work, 'x', 'frames'))).length, 30);
  await fs.writeFile(path.join(mvDir, 'shots.json'), JSON.stringify(shotsFromCuts(cuts).map((s, i) => ({...s, end: s.end + i * 0.5}))));
  await assert.rejects(splitDanceFrames({mvDir, work, ids: ['x', 'y'], cuts, frames: 90}), /時刻がカット表と違う/);
});

test('音の混ぜ方: 曲の開始位置から使い、語りがあっても BGM を下げない。ラウドネスは指定の値', () => {
  const args = mixArgs({seconds: 10, voices: [{file: 'v.wav', start: 1}], sfx: [], bgm: {file: 'song.wav', start: 12.5, gainDb: -3, duck: false}, out: 'o.wav'});
  const i = args.indexOf('song.wav');
  assert.equal(args[i - 1], '-i'); assert.equal(args[i - 3], '-ss'); assert.equal(args[i - 2], '12.5');
  assert.doesNotMatch(args[args.indexOf('-filter_complex') + 1], /sidechaincompress/);
  const ducked = mixArgs({seconds: 10, voices: [{file: 'v.wav', start: 1}], sfx: [], bgm: {file: 'song.wav', gainDb: -3}, out: 'o.wav'});
  assert.match(ducked[ducked.indexOf('-filter_complex') + 1], /sidechaincompress/);
});

test('make_mv.py が --shots-in を受けるか、ファイルの中身で見分ける', async () => {
  const dir = await stageDir();
  assert.equal(await supportsShotsIn(dir), false);
  await fs.writeFile(path.join(dir, 'tools', 'make_mv.py'), "a.add_argument('--shots-in')");
  assert.equal(await supportsShotsIn(dir), true);
  assert.equal(await supportsShotsIn(path.join(dir, 'none')), false);
});

// ---- カット表の確かめ ----
const danceBody = (o = {}) => ({title: 'MV', style: 'dance', charId: 'c1', cuts: [], music: {motionId: 'dance'}, ...o});

test('API: ダンス MV の music とカットを確かめる。ほかの型は music を持たず、ダンス専用のカメラを選べない', async () => {
  const s = await server();
  try {
    const cut = {stage: 'concert', motionId: 'dance', camera: 'crane_up', seconds: 4, angle: 12, shot: {dir: -1, seed: 7}};
    const made = await s.api('POST', '/api/shorts', danceBody({cuts: [cut, {...cut, camera: 'close', stage: 'classroom'}]}));
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.equal(made.json.style, 'dance'); assert.deepEqual(made.json.music, {bpm: 120, seed: 1, beatsPerShot: 8, shotsPerScene: 1, audioStart: 0, motionId: 'dance'});   // look を書かなければ足さない(plain のまま)
    assert.deepEqual(made.json.cuts[0].shot, {dir: -1, seed: 7}); assert.equal(made.json.cuts[0].text, '');
    // 動きは music.motionId の 1 つ。カットの motionId は省ける
    const bare = await s.api('POST', '/api/shorts', danceBody({cuts: [{stage: 'concert', camera: 'orbit', seconds: 3}]}));
    assert.equal(bare.json.cuts[0].motionId, 'dance');
    const fromCut = await s.api('POST', '/api/shorts', danceBody({music: {}, cuts: [{stage: 'concert', motionId: 'dance', camera: 'orbit', seconds: 3}]}));
    assert.equal(fromCut.json.music.motionId, 'dance');
    const bad = async (o, re) => { const r = await s.api('POST', '/api/shorts', danceBody(o)); assert.equal(r.status, 400, JSON.stringify(o)); if (re) assert.match(r.json.error ?? JSON.stringify(r.json), re); };
    await bad({music: {motionId: 'dance', bpm: 10}}, /bpm/);
    await bad({music: {motionId: 'dance', bpm: 300}}, /bpm/);
    await bad({music: {motionId: 'dance', beatsPerShot: 5}}, /beatsPerShot/);
    await bad({music: {motionId: 'dance', look: 'neon'}}, /look/);
    await bad({music: {motionId: 'dance', shotsPerScene: 3}}, /shotsPerScene/);
    await bad({music: {motionId: 'dance', seed: 10000}}, /seed/);
    await bad({music: {motionId: 'dance', audioStart: -1}}, /audioStart/);
    await bad({music: {motionId: 'dance', stages: ['nowhere']}}, /シーン/);
    await bad({music: {motionId: 'dance', stages: ['concert', 'concert']}}, /2 回/);
    await bad({cuts: [{...cut, camera: 'talk_bust'}]}, /カメラ/);
    await bad({cuts: [{...cut, seconds: 0}]}, /秒/);
    await bad({cuts: [{...cut, shot: {dir: 2}}]}, /shot/);
    await bad({cuts: [{...cut, seconds: 30}, {...cut, seconds: 30}, {...cut, seconds: 30}, {...cut, seconds: 30}, {...cut, seconds: 30}, {...cut, seconds: 30}, {...cut, seconds: 30}]}, /180/);
    await bad({music: {}, cuts: [{stage: 'concert', camera: 'orbit', seconds: 3}]}, /motionId/);
    await bad({cast: [{charId: 'c1', name: 'a'}, {charId: 'c1', name: 'b'}]}, /1 人/);
    assert.equal((await s.api('POST', '/api/shorts', {title: 't', charId: 'c1', speaker: 8, cuts: [{stage: 'concert', motionId: 'dance', camera: 'crane_up'}]})).status, 400, 'ほかの型はダンス専用のカメラを選べない');
    const talk = await s.api('POST', '/api/shorts', {title: 't', charId: 'c1', speaker: 8, music: {bpm: 99}, cuts: [{stage: 'concert', motionId: 'dance', camera: 'orbit'}]});
    assert.equal(talk.status, 201); assert.equal('music' in talk.json, false, 'dance 以外では music を無視する');
    const opts = (await s.api('GET', '/api/short-options')).json;
    assert.ok(opts.cameras.includes('crane_up')); assert.deepEqual(opts.danceCameras, DANCE_CAMERAS);
  } finally { await s.close(); }
});

// ---- 拍から割る ----
test('API: 拍から割る。bpm の経路は shots.plan と assign_stages の割り方、保存したカットは再読み込みでも同じ', async () => {
  const s = await server();
  try {
    const made = await s.api('POST', '/api/dance-shorts', {charId: 'c1', motionId: 'dance', seconds: 10});
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.equal(made.json.style, 'dance'); assert.equal(made.json.cast.length, 1); assert.equal(made.json.cast[0].charId, 'c1');
    assert.deepEqual(made.json.music.stages, ['concert']); assert.equal(made.json.music.motionId, 'dance');
    // 120 BPM、8 拍 = 4 秒ごと。10 秒は [0, 4, 8, 10]。最初のカットは wide_push
    assert.deepEqual(made.json.cuts.map(c => c.seconds), [4, 4, 2]);
    assert.equal(made.json.cuts[0].camera, 'wide_push'); assert.ok(made.json.cuts.every(c => DANCE_CAMERAS.includes(c.camera) && c.motionId === 'dance' && c.shot));
    const id = made.json.id;

    const split = await s.api('POST', `/api/shorts/${id}/beat-cuts`, {stages: ['concert', 'classroom'], seconds: 15, bpm: 100, beatsPerShot: 4, seed: 3, shotsPerScene: 2});
    assert.equal(split.status, 200, JSON.stringify(split.json));
    assert.equal(split.json.source, 'bpm'); assert.equal(split.json.detectedBpm, null);
    // 100 BPM の 4 拍 = 2.4 秒。15 秒は 2.4 刻みで 14.4 は 15 - 0.6 の手前なので 6 カット + 残り
    const cuts = split.json.short.cuts;
    assert.deepEqual(cuts.map(c => c.stage), ['concert', 'concert', 'classroom', 'classroom', 'concert', 'concert', 'classroom']);
    assert.equal(Math.round(cuts.reduce((a, c) => a + c.seconds, 0) * 1e6) / 1e6, 15);
    assert.deepEqual(split.json.short.music, {bpm: 100, seed: 3, beatsPerShot: 4, shotsPerScene: 2, audioStart: 0, look: 'anime', motionId: 'dance', stages: ['concert', 'classroom']});   // 新規作成(dance-shorts)が置いた anime が、割っても残る
    assert.deepEqual((await s.api('GET', '/api/shorts/' + id)).json.cuts, cuts);
    // 同じ条件は同じ割り(乱数の種も同じ)
    const again = await s.api('POST', `/api/shorts/${id}/beat-cuts`, {});
    assert.deepEqual(again.json.short.cuts, cuts);

    assert.equal((await s.api('POST', `/api/shorts/${id}/beat-cuts`, {bpm: 1})).status, 400);
    assert.equal((await s.api('POST', `/api/shorts/${id}/beat-cuts`, {seconds: 1})).status, 400);
    assert.equal((await s.api('POST', `/api/shorts/${id}/beat-cuts`, {stages: ['nowhere']})).status, 400);
    assert.equal((await s.api('GET', `/api/shorts/${id}/beat-cuts`)).status, 405);
    const plain = (await s.api('POST', '/api/shorts', {title: 't', charId: 'c1', speaker: 8, cuts: [{stage: 'concert', motionId: 'dance', camera: 'orbit'}]})).json;
    assert.equal((await s.api('POST', `/api/shorts/${plain.id}/beat-cuts`, {stages: ['concert']})).status, 400, 'ダンス MV の型だけ');
    assert.equal((await s.api('POST', '/api/shorts/none/beat-cuts', {})).status, 404);
  } finally { await s.close(); }
});

test('API: 曲があれば tools/beats.py の拍で割り、audioStart を渡す。動き(motionId)が無ければカットは作らない', async () => {
  const s = await server();
  try {
    const noMotion = await s.api('POST', '/api/dance-shorts', {charId: 'c1'});
    assert.equal(noMotion.status, 201); assert.deepEqual(noMotion.json.cuts, []); assert.equal('stages' in noMotion.json.music, false);
    assert.equal((await s.api('POST', `/api/shorts/${noMotion.json.id}/beat-cuts`, {stages: ['concert']})).status, 400);
    const audio = await song(s);
    const made = await s.api('POST', '/api/dance-shorts', {charId: 'c1', motionId: 'dance', stages: ['concert', 'classroom'], seconds: 12});
    const put = await s.api('PUT', '/api/shorts/' + made.json.id, {...made.json, audioId: audio.id, audioPublic: true});
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const split = await s.api('POST', `/api/shorts/${made.json.id}/beat-cuts`, {audioStart: 2, seconds: 12});
    assert.equal(split.status, 200, JSON.stringify(split.json));
    // 偽の beats.py の拍は 0.25 + 0.5 i。8 拍目 = 4.25、16 拍目 = 8.25、24 拍目 = 12.25 は 12 - 0.6 より後
    assert.equal(split.json.source, 'audio'); assert.equal(split.json.detectedBpm, 120);
    assert.deepEqual(split.json.short.cuts.map(c => c.seconds), [4.25, 4, 3.75]);
    assert.equal(split.json.short.music.audioStart, 2);
  } finally { await s.close(); }
});

test('拍から割る: 本物の stage-studio の plan と assign_stages と同じカットを作る(本物があるときだけ)', { skip: !fsSync.existsSync(path.join(REAL_STAGE, 'lib', 'shots.py')) }, async () => {
  const real = JSON.parse(fsSync.readFileSync(path.join(REAL_STAGE, 'stages', 'catalog.json'), 'utf8')).map(x => x.id).slice(0, 2);
  const s = await startServer({stageStudioDir: REAL_STAGE, env: FAKE_ENV}), lib = s.server.jobs.lib;
  try {
    await lib.createCharacter({id: 'c1', name: 'いち'});
    await lib.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({a: 1})});
    await lib.importMotion({id: 'dance', data: await fs.readFile(SAMPLE_VRMA), label: 'ダンス', license: {holder: 'h', summary: '改変可', redistribution: false}});
    const r = await fetch(s.base + '/api/dance-shorts', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({charId: 'c1', motionId: 'dance', stages: real, seconds: 20, music: {bpm: 128, seed: 4, beatsPerShot: 8, shotsPerScene: 1}})});
    const made = await r.json();
    assert.equal(r.status, 201, JSON.stringify(made));
    const want = JSON.parse(execFileSync(findPython() ?? 'python', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(REAL_STAGE)}); from lib import shots as Sh
b = Sh.beats_of(128.0, 30, 0)
print(json.dumps(Sh.assign_stages(Sh.plan(b, 20.0, 4, 8, 8), ${JSON.stringify(real)}, 1)))`], {encoding: 'utf8'}));
    assert.deepEqual(made.cuts.map(c => [c.stage, c.camera, c.angle, c.shot]), want.map(w => [w.stage, w.kind, w.a, {dir: w.dir, seed: w.seed}]));
    const bounds = danceBounds(made.cuts);
    want.forEach((w, i) => { assert.ok(Math.abs(bounds[i].start - w.start) < 1e-4); assert.ok(Math.abs(bounds[i].end - w.end) < 1e-4); });
  } finally { await s.close(); }
});

// ---- 書き出し ----
test('書き出し: 声を飛ばし、カットごとにコマを分け、曲を -14 LUFS で開始位置から混ぜる。テロップだけの直しでは base を作り直さない', async () => {
  const s = await server();
  try {
    const audio = await song(s, 30), jobs = s.server.jobs;
    const made = await s.api('POST', '/api/dance-shorts', {charId: 'c1', motionId: 'dance', stages: ['concert', 'classroom'], seconds: 6, music: {bpm: 120, beatsPerShot: 4, audioStart: 3}});
    const id = made.json.id;
    assert.deepEqual(made.json.cuts.map(c => c.seconds), [2, 2, 2]);
    assert.equal((await s.api('PUT', '/api/shorts/' + id, {...made.json, audioId: audio.id, audioPublic: true})).status, 200);
    const j = await s.api('POST', '/api/jobs', {type: 'short', shortId: id, quality: 'preview'});
    assert.equal(j.status, 201, JSON.stringify(j.json));
    await jobs.whenIdle();
    const done = await jobs.get(j.json.id);
    assert.equal(done.state, 'done', done.error);
    const [v] = (await s.api('GET', '/api/shoots')).json;
    assert.equal(v.kind, 'short'); assert.equal(v.short.credit, null); assert.deepEqual(v.short.stageLabels, ['コンサート', '教室']); assert.equal(v.short.style, 'dance');
    assert.equal(v.short.music.audioStart, 3); assert.equal(v.audio.start, 3); assert.ok(Math.abs(v.seconds - 6) < 0.05);
    const file = path.join(s.libraryDir, 'characters', 'c1', 'shoots', v.id, 'video.mp4');
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,height:format=duration', '-of', 'json', file]));
    assert.deepEqual(info.streams.map(x => x.codec_type).sort(), ['audio', 'video']); assert.equal(info.streams.find(x => x.height).height, 1920);
    assert.ok(Math.abs(info.format.duration - 6) < 0.15);

    const work = path.join(s.libraryDir, 'shorts', id, 'work', 'preview');
    const plan = JSON.parse(await fs.readFile(path.join(work, 'plan.json'), 'utf8')), t = JSON.parse(await fs.readFile(path.join(work, 't.json'), 'utf8'));
    assert.deepEqual(t.cuts.map(c => c.count), [60, 60, 60]); assert.deepEqual(t.cuts.map(c => c.id), plan.cuts.map(c => c.id));
    assert.deepEqual(t.cuts.map(c => c.start), [0, 2, 4]); assert.equal(t.style, 'dance'); assert.equal(t.bgm, null); assert.deepEqual(t.sfx, []);
    assert.ok(t.cuts.every(c => c.voice === null && c.direction.transition === 'none'));
    for (const c of plan.cuts) assert.equal((await fs.readdir(path.join(work, c.id, 'frames'))).length, 60);
    assert.equal((await fs.stat(path.join(work, plan.cuts[2].id, 'frames', '00060.png'))).nlink, 2);
    assert.deepEqual((await fs.readdir(path.join(s.libraryDir, 'shorts', id, 'voice'))).length, 0, '声は作らない');
    const mix = path.join(work, 'compose', 'mix.wav');
    assert.ok(Math.abs(lufsOf(mix) + 14) < 1.5, `曲は約 -14 LUFS: ${lufsOf(mix)}`);

    // テロップだけの直しは、コマの分け直しも base の作り直しもしない
    const baseFile = path.join(work, 'compose', 'base.mp4'), baseTime = (await fs.stat(baseFile)).mtimeMs, ids = t.cuts.map(c => c.id);
    const cur = (await s.api('GET', '/api/shorts/' + id)).json;
    await s.api('PUT', '/api/shorts/' + id, {...cur, cuts: cur.cuts.map((c, i) => (i === 1 ? {...c, telop: 'サビ'} : c))});
    await s.api('POST', '/api/jobs', {type: 'short', shortId: id});
    await jobs.whenIdle();
    const t2 = JSON.parse(await fs.readFile(path.join(work, 't.json'), 'utf8'));
    assert.deepEqual(t2.cuts.map(c => c.id), ids); assert.equal(t2.cuts[1].telop, 'サビ');
    assert.equal((await fs.stat(baseFile)).mtimeMs, baseTime);

    // 絵に関わる直し(カメラ)は新しい作業フォルダになり、使わなくなった作業は消える
    const cur2 = (await s.api('GET', '/api/shorts/' + id)).json;
    await s.api('PUT', '/api/shorts/' + id, {...cur2, cuts: cur2.cuts.map((c, i) => (i === 0 ? {...c, camera: 'high_top'} : c))});
    await s.api('POST', '/api/jobs', {type: 'short', shortId: id});
    await jobs.whenIdle();
    const left = (await fs.readdir(work)).filter(x => x.startsWith('mv-'));
    assert.equal(left.length, 1);
    assert.notDeepEqual(JSON.parse(await fs.readFile(path.join(work, 't.json'), 'utf8')).cuts.map(c => c.id), ids);
  } finally { await s.close(); }
});

test('書き出し: カットが無い、秒の無いカット、曲の開始位置が曲より後ろのときは断るか失敗にする', async () => {
  const s = await server();
  try {
    const made = await s.api('POST', '/api/dance-shorts', {charId: 'c1'});
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short', shortId: made.json.id})).status, 400, 'カットが無い');
    const audio = await song(s, 5);
    const withCuts = await s.api('POST', '/api/dance-shorts', {charId: 'c1', motionId: 'dance', seconds: 6});
    await s.api('PUT', '/api/shorts/' + withCuts.json.id, {...withCuts.json, audioId: audio.id, audioPublic: true, music: {...withCuts.json.music, audioStart: 20}});
    const j = await s.api('POST', '/api/jobs', {type: 'short', shortId: withCuts.json.id});
    assert.equal(j.status, 201);
    await s.server.jobs.whenIdle();
    const job = await s.server.jobs.get(j.json.id);
    assert.equal(job.state, 'failed'); assert.match(job.error, /開始位置/);
  } finally { await s.close(); }
});

test('音量の測定: ラウドネス指定の曲は、開始位置 0 でも使う区間だけを測る。指定の無い曲は変えない', async () => {
  const dir = await tempDir();
  const calls = [];
  const ctx = {run: async (cmd, args) => {
    if (cmd === 'ffmpeg' && args.some(a => String(a).includes('ebur128'))) {
      calls.push(args);
      await fs.writeFile(path.join(dir, 'r128.txt'), 'lavfi.r128.I=-20.0\n');
    }
  }};
  const t = {seconds: 7, sfx: [], hush: false, style: 'dance'};
  await buildMix(ctx, t, {dir, voices: [], bgm: {file: 'song.wav', start: 0, lufs: -14, duck: false}, ambience: null});
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('-t') + 1], '7'); assert.equal(calls[0].includes('-ss'), false, '開始位置 0 は -ss を付けない');
  calls.length = 0; await fs.rm(path.join(dir, 'mix.key'), {force: true});
  await buildMix(ctx, t, {dir, voices: [], bgm: {file: 'song.wav'}, ambience: null});
  assert.equal(calls[0].includes('-t'), false, 'ラウドネス指定の無い曲は全体を測る');
});

test('API: 曲が開始位置から必要な秒に足りなければ断る(拍から割る、書き出し)。合計の上限は 1e-4 の余裕を見る', async () => {
  const s = await server();
  try {
    const audio = await song(s, 10);
    const made = await s.api('POST', '/api/dance-shorts', {charId: 'c1', motionId: 'dance', stages: ['concert'], seconds: 12});
    await s.api('PUT', '/api/shorts/' + made.json.id, {...made.json, audioId: audio.id, audioPublic: true});
    const split = await s.api('POST', `/api/shorts/${made.json.id}/beat-cuts`, {audioStart: 2, seconds: 12});
    assert.equal(split.status, 400); assert.match(split.json.error, /曲が足りない: 開始位置から 8 秒/);
    assert.equal((await s.api('POST', `/api/shorts/${made.json.id}/beat-cuts`, {audioStart: 2, seconds: 8})).status, 200);

    const short = await s.api('POST', '/api/dance-shorts', {charId: 'c1', motionId: 'dance', seconds: 12});
    await s.api('PUT', '/api/shorts/' + short.json.id, {...short.json, audioId: audio.id, audioPublic: true, music: {...short.json.music, audioStart: 2}});
    const j = await s.api('POST', '/api/jobs', {type: 'short', shortId: short.json.id});
    assert.equal(j.status, 201);
    await s.server.jobs.whenIdle();
    const job = await s.server.jobs.get(j.json.id);
    assert.equal(job.state, 'failed'); assert.match(job.error, /曲が足りない/);

    const cut = {...short.json.cuts[0], seconds: 25.714293};
    const slack = await s.api('PUT', '/api/shorts/' + short.json.id, {...short.json, cuts: Array(7).fill(cut)});
    assert.equal(slack.status, 200, JSON.stringify(slack.json));
    const over = await s.api('PUT', '/api/shorts/' + short.json.id, {...short.json, cuts: Array(7).fill({...cut, seconds: 25.7144})});
    assert.equal(over.status, 400);
  } finally { await s.close(); }
});

test('look: 新規作成だけが anime を置く。look の無い保存済みのショートは、保存や拍から割るで anime を足されない', async () => {
  assert.equal(DANCE_NEW_LOOK, 'anime');
  const s = await server();
  try {
    const fresh = await s.api('POST', '/api/dance-shorts', {charId: 'c1', motionId: 'dance', seconds: 10});
    assert.equal(fresh.json.music.look, 'anime');
    const plain = await s.api('POST', '/api/dance-shorts', {charId: 'c1', motionId: 'dance', seconds: 10, music: {look: 'plain'}});
    assert.equal(plain.json.music.look, 'plain', '指定は尊重する');
    // look の無い前のショート
    const old = await s.api('POST', '/api/shorts', danceBody({cuts: [{stage: 'concert', camera: 'orbit', seconds: 4}]}));
    assert.equal(old.status, 201); assert.equal('look' in old.json.music, false);
    const saved = await s.api('PUT', `/api/shorts/${old.json.id}`, {...old.json, title: '題だけ変える'});
    assert.equal(saved.status, 200, JSON.stringify(saved.json)); assert.equal('look' in saved.json.music, false, '関係ない保存で anime を足さない');
    const again = await s.api('GET', `/api/shorts/${old.json.id}`);
    assert.equal('look' in again.json.music, false);
    const split = await s.api('POST', `/api/shorts/${old.json.id}/beat-cuts`, {stages: ['concert'], seconds: 8});
    assert.equal(split.status, 200, JSON.stringify(split.json)); assert.equal('look' in split.json.short.music, false, '拍から割っても足さない');
  } finally { await s.close(); }
});

test('look cel: make_mv.py の --look の choices に cel があるときだけ選べ、danceKey は anime と分かれる', async () => {
  assert.ok(DANCE_LOOKS.includes('cel'));
  const dir = await stageDir();
  assert.deepEqual(await lookChoices(dir), [], '--look が無い make_mv.py');
  await fs.writeFile(path.join(dir, 'tools', 'make_mv.py'), "a.add_argument('--look', choices=['anime', 'cel'])  # render.py の --look");
  assert.deepEqual(await lookChoices(dir), ['anime', 'cel']);
  await fs.writeFile(path.join(dir, 'tools', 'make_mv.py'), "a.add_argument('--look', choices=['anime'])");
  assert.deepEqual(await lookChoices(dir), ['anime']);
  assert.deepEqual(await lookChoices(path.join(dir, 'none')), []);
  if (fsSync.existsSync(path.join(REAL_STAGE, 'tools', 'make_mv.py'))) assert.ok((await lookChoices(REAL_STAGE)).includes('cel'), '本物の stage-studio は cel を受ける');
  const cuts = [{stage: 'concert', camera: 'orbit', seconds: 4}];
  const m0 = {bpm: 120, seed: 1, beatsPerShot: 8, shotsPerScene: 1, audioStart: 0};
  const kk = look => danceKey({code: 'c', cast: {charId: 'a', verId: 'v'}, cuts, stageCodes: ['x'], music: {...m0, look}, pct: 40, samples: 32, lookOn: true});
  assert.notEqual(kk('cel'), kk('anime')); assert.notEqual(kk('cel'), kk('plain'));
  // API: cel を受けない stage-studio では 400、受けるなら保存でき、拍から割っても残る
  const no = await server();
  try {
    const r = await no.api('POST', '/api/dance-shorts', {charId: 'c1', motionId: 'dance', seconds: 10, music: {look: 'cel'}});
    assert.equal(r.status, 400); assert.match(JSON.stringify(r.json), /cel/);
  } finally { await no.close(); }
  const yes = await server({'tools/make_mv.py': "a.add_argument('--look', choices=['anime', 'cel'])"});
  try {
    const r = await yes.api('POST', '/api/dance-shorts', {charId: 'c1', motionId: 'dance', seconds: 10, music: {look: 'cel'}});
    assert.equal(r.status, 201, JSON.stringify(r.json)); assert.equal(r.json.music.look, 'cel');
    const split = await yes.api('POST', `/api/shorts/${r.json.id}/beat-cuts`, {stages: ['concert'], seconds: 8});
    assert.equal(split.status, 200, JSON.stringify(split.json)); assert.equal(split.json.short.music.look, 'cel');
  } finally { await yes.close(); }
});
