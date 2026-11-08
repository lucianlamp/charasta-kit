// 撮るジョブ shoot、利用条件の判定、撮影の長さとカメラの計算。ブラウザは CHARASTA_FAKE_CAPTURE で省く(ffmpeg は要る)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {execFileSync, spawnSync} from 'node:child_process';
import {Library} from '../lib/library.mjs';
import {JobQueue} from '../lib/jobs.mjs';
import {limitOf, videoTerms} from '../lib/terms.mjs';
import {encodeArgs, shootSize, shootTimeoutMs} from '../lib/shoot.mjs';
import {fitFull, frameHead, distanceFor, shootSeconds, smoothTrack, trackAt, zoomTrack, MAX_SECONDS} from '../public/shoot-plan.mjs';
import {tempDir, fakeGlb, FAKE_ENV, SAMPLE_VRMA, startServer} from './helpers.mjs';

const EVAL = {holder: 'NVIDIA', summary: '評価用', redistribution: false, evaluationOnly: true};
const PERSONAL = {holder: '各権利者', summary: '個人利用のみ。公開・再配布・商用利用は不可（動画の公開も不可）', redistribution: false};
const PIXIV = {holder: 'ピクシブ株式会社', summary: '改変可。取り出せる状態での二次配布は禁止', redistribution: false};

async function setup(env = FAKE_ENV) {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'c1', name: 'C1', voice: 'grok:eve'});
  await lib.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({a: 1})});
  const data = await fs.readFile(SAMPLE_VRMA);
  await lib.importMotion({id: 'dance', data, license: PERSONAL, label: 'ダンス'});
  await lib.importMotion({id: 'pack', data, license: PIXIV});
  return {lib, q: new JobQueue({lib, env})};
}
const exists = f => fs.access(f).then(() => true, () => false);
const probe = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,profile,width,height,r_frame_rate:format=duration', '-of', 'json', file], {encoding: 'utf8'}));
const tone = (file, seconds) => execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, file]);
const songFrom = async (lib, seconds, name = 'song.wav') => {
  const f = path.join(await tempDir(), name); tone(f, seconds);
  return lib.importAudio({name, data: await fs.readFile(f)});
};

test('利用条件: 評価用と個人利用は公開できない、記録が無いものは確かめる、音声は書いた条件で判定する', () => {
  const name = (license, id = 'm') => ({id, label: 'モ', license});
  assert.equal(videoTerms({motion: name(EVAL)}).level, 'no');
  assert.equal(videoTerms({motion: name(EVAL)}).tag, '公開できない');
  assert.match(videoTerms({motion: name(PERSONAL)}).notes[0].text, /個人利用のみ。この動画は公開できない/);
  assert.equal(videoTerms({motion: name(PIXIV)}).level, 'ok');
  assert.match(videoTerms({motion: name(PIXIV)}).notes[0].text, /改変可/);
  assert.equal(videoTerms({motion: {id: 'x'}}).level, 'check');
  assert.equal(videoTerms({motion: name({holder: '', summary: ''})}).level, 'check');
  assert.equal(videoTerms({}).level, 'ok');
  assert.deepEqual(videoTerms({}).notes, []);
  assert.equal(videoTerms({motion: name(PIXIV), audio: {name: 'a.mp3', summary: ''}}).level, 'check');
  assert.equal(videoTerms({motion: name(PIXIV), audio: {name: 'a.mp3', summary: '自作の曲'}}).level, 'check');   // 自由文だけでは ok にしない
  assert.equal(videoTerms({motion: name(PIXIV), audio: {name: 'a.mp3', summary: '自作の曲', publishOk: true}}).level, 'ok');
  assert.equal(videoTerms({motion: name(PIXIV), audio: {name: 'a.mp3', summary: '個人利用のみ'}}).level, 'no');
  assert.equal(videoTerms({motion: name(PIXIV), audio: {name: 'a.mp3', summary: '個人利用のみ', publishOk: true}}).level, 'no');   // 選んでも、書いた条件が公開不可なら公開できない
  const both = videoTerms({motion: name(EVAL), audio: {name: 'a.mp3', summary: ''}});
  assert.equal(both.level, 'no'); assert.equal(both.notes.length, 2);   // 重い方が全体の扱いになる
  assert.equal(limitOf({license: PERSONAL}).warn, true);
});

test('利用条件: 公開できないの書き方を広く拾い、二次利用禁止と商用利用不可は確かめる扱いにする', () => {
  const lic = summary => ({id: 'm', label: 'モ', license: {holder: 'x', summary, redistribution: true}});
  for (const s of ['個人利用のみ', '私的利用に限る', '動画の公開不可', '公開禁止', '公開できない', '非公開で使うこと']) {
    assert.equal(videoTerms({motion: lic(s)}).level, 'no', s);
    assert.equal(videoTerms({audio: {name: 'a.mp3', summary: s, publishOk: true}}).level, 'no', s);
    assert.equal(limitOf(lic(s)).warn, true, s);
  }
  for (const s of ['二次利用禁止', '商用利用不可', '改変可。商用利用不可']) {
    assert.equal(videoTerms({motion: lic(s)}).level, 'check', s);
    assert.equal(videoTerms({audio: {name: 'a.mp3', summary: s, publishOk: true}}).level, 'check', s);
    assert.equal(limitOf(lic(s)).warn, false, s);
  }
  assert.equal(videoTerms({motion: lic('改変可。取り出せる状態での二次配布は禁止')}).level, 'ok');
  assert.match(videoTerms({audio: {name: 'a.mp3', summary: '自作の曲'}}).notes[0].text, /公開してよいと選ばれていない/);
  assert.equal(videoTerms({audio: {name: 'a.mp3', summary: '', publishOk: true}}).level, 'ok');   // 選んだなら、メモが空でも ok
});

test('長さ: モーション × 繰り返し、セリフが長ければ伸ばす、音声はモーションの長さを変えない、上限で切る', () => {
  assert.equal(shootSeconds({motionSec: 22, loops: 2}), 44);
  assert.equal(shootSeconds({motionSec: 2, loops: 1, lineSec: 3}), 3);
  assert.equal(shootSeconds({motionSec: 22, audioSec: 200}), 22);
  assert.equal(shootSeconds({audioSec: 7, lineSec: 2}), 7);
  assert.equal(shootSeconds({seconds: 9, audioSec: 30}), 9);
  assert.equal(shootSeconds({}), 5);
  assert.equal(shootSeconds({audioSec: 600}), MAX_SECONDS);
});

test('大きさ: 縦横と画質から画素の数と fps を決める', () => {
  assert.deepEqual(shootSize('9:16', '1080p30'), {width: 1080, height: 1920, fps: 30});
  assert.deepEqual(shootSize('16:9', '1080p60'), {width: 1920, height: 1080, fps: 60});
  assert.deepEqual(shootSize('1:1', '720p30'), {width: 720, height: 720, fps: 30});
  assert.deepEqual(shootSize('9:16', '720p30'), {width: 720, height: 1280, fps: 30});
  assert.ok(shootTimeoutMs(1200) > shootTimeoutMs(300));
});

test('全身のカメラ: 測った点が全部枠に入り、背の高さと腕の広がりに合わせて距離が変わる', () => {
  const fov = 30, body = h => [{x: 0, y: 0, z: 0, rx: 0.05, ry: 0.05}, {x: 0, y: h, z: 0, rx: 0.15, ry: 0.2}];
  const inside = (points, {cy, dist}, aspect) => points.every(p => {
    const tan = Math.tan(fov * Math.PI / 360) * (dist - p.z);
    return Math.abs(p.y - cy) + p.ry <= tan + 1e-9 && Math.abs(p.x) + p.rx <= tan * aspect + 1e-9;
  });
  for (const aspect of [9 / 16, 16 / 9, 1]) for (const h of [0.85, 1.45]) {
    const pts = [...body(h), {x: 0.7, y: 1, z: 0.3, rx: 0.1, ry: 0.1}];
    assert.ok(inside(pts, fitFull(pts, {fov, aspect}), aspect), `aspect ${aspect} h ${h}`);
  }
  assert.ok(fitFull(body(0.85), {fov, aspect: 1}).dist < fitFull(body(1.45), {fov, aspect: 1}).dist);   // チビは寄る
  const narrow = fitFull([...body(1.45), {x: 0.7, y: 1, z: 0, rx: 0.1, ry: 0.1}], {fov, aspect: 9 / 16});
  assert.ok(narrow.dist > fitFull(body(1.45), {fov, aspect: 9 / 16}).dist);   // 縦長は手が届く幅まで引く
  assert.ok(fitFull([{x: 0, y: 2, z: 0, rx: 0, ry: 0}], {fov, aspect: 1}).cy === 1);   // 床は枠に入れる
});

test('上半身と顔のカメラ: 頭の大きさと胴の長さで枠の高さが決まり、てっぺんが枠に入る', () => {
  const big = {headTop: 0.3, headH: 0.4, torso: 0.5}, tall = {headTop: 0.2, headH: 0.25, torso: 0.55};
  for (const body of [big, tall]) for (const aspect of [9 / 16, 16 / 9, 1]) for (const framing of ['face', 'upper']) {
    const {frameH, dy} = frameHead(framing, body, aspect);
    assert.ok(body.headTop - dy < frameH / 2, `${framing} ${aspect}`);
  }
  assert.ok(frameHead('face', big, 1).frameH > frameHead('face', tall, 1).frameH);
  assert.ok(frameHead('face', tall, 9 / 16).frameH > frameHead('face', tall, 1).frameH);   // 縦長は頭の幅が入るまで引く
  assert.ok(Math.abs(distanceFor(1, 30) - 0.5 / Math.tan(Math.PI / 12)) < 1e-9);
});

test('頭の道筋: ならすと揺れが減り、時刻の間は直線でつなぐ', () => {
  const track = Array.from({length: 30}, (_, i) => [i / 10, i % 2 ? 0.1 : -0.1, 1, 0]);
  const smooth = smoothTrack(track, 0.4);
  assert.ok(Math.max(...smooth.map(p => Math.abs(p[1]))) < 0.05);
  assert.deepEqual(trackAt([[0, 0, 0, 0], [1, 2, 4, 6]], 0.5), [1, 2, 3]);
  assert.deepEqual(trackAt([[0, 0, 0, 0], [1, 2, 4, 6]], 5), [2, 4, 6]);
  assert.deepEqual(trackAt([[1, 2, 4, 6]], 0), [2, 4, 6]);
});

test('ffmpeg の引数: 音の無い動画は音声を作らず、音声が長いときだけ終わりを小さくし、セリフと重ねると曲を下げる', () => {
  const base = {frames: 'F', fps: 30, seconds: 4, out: 'O.mp4'}, graph = a => a[a.indexOf('-filter_complex') + 1];
  const silent = encodeArgs(base);
  assert.equal(silent.includes('-filter_complex'), false); assert.equal(silent.includes('aac'), false);
  assert.ok(silent.includes('+faststart')); assert.ok(silent.at(-1) === 'O.mp4');
  assert.match(graph(encodeArgs({...base, song: 'S', songSec: 10})), /afade=t=out:st=3\.500:d=0\.5/);
  assert.doesNotMatch(graph(encodeArgs({...base, song: 'S', songSec: 3})), /afade/);
  assert.match(graph(encodeArgs({...base, seconds: 0.3, song: 'S', songSec: 2})), /afade=t=out:st=0.000:d=0.3/);   // 0.5 秒より短い動画でも開始が負にならない
  const seek = encodeArgs({...base, song: 'S', songStart: 12.5, songSec: 10});
  assert.deepEqual(seek.slice(seek.indexOf('-ss'), seek.indexOf('-ss') + 3), ['-ss', '12.5', '-i']);   // 音声の入力だけを頭出しする
  assert.equal(encodeArgs({...base, song: 'S', songSec: 10}).includes('-ss'), false);
  const both = graph(encodeArgs({...base, voice: 'V', song: 'S', songSec: 3}));
  assert.match(both, /amix=inputs=2/); assert.match(both, /volume=0\.5/);
});

test('shoot の入力を確かめる: 選べない値、無いモーション・セリフ・音声は積まない', async () => {
  const {q} = await setup();
  const body = {type: 'shoot', charId: 'c1'};
  for (const [bad, re] of [[{framing: 'side'}, /framing/], [{aspect: '4:3'}, /aspect/], [{quality: '4k'}, /quality/], [{expression: 'cry'}, /expression/],
    [{motionId: 'dance', loops: 0}, /loops/], [{motionId: 'dance', loops: 1.5}, /loops/], [{motionId: 'dance', loops: 11}, /loops/], [{seconds: 0}, /seconds/], [{seconds: 181}, /seconds/],
    [{background: 'red'}, /background/], [{background: ['#ffffff']}, /background/], [{seconds: 0.03}, /seconds/]]) await assert.rejects(q.enqueue({...body, ...bad}), re);
  await assert.rejects(q.enqueue({...body, motionId: 'nope'}), e => e.code === 'not-found');
  await assert.rejects(q.enqueue({...body, lineId: 'nope'}), e => e.code === 'not-found');
  await assert.rejects(q.enqueue({...body, audioId: 'anope'}), e => e.code === 'not-found');
  await assert.rejects(q.enqueue({...body, motionId: '../x'}), e => e.code === 'bad-id');
  const job = await q.enqueue({...body, motionId: 'pack', background: '#FFFFFF'});
  assert.deepEqual([job.input.verId, job.input.framing, job.input.aspect, job.input.quality, job.input.expression, job.input.background], ['v1', 'full', '9:16', '1080p30', 'motion', '#ffffff']);
  await q.whenIdle();
});

test('shoot ジョブ: 音声なしは H.264 yuv420p の映像だけで、記録と札が残り、作業のコマは片づける', async () => {
  const {lib, q} = await setup();
  const job = await q.enqueue({type: 'shoot', charId: 'c1', motionId: 'dance', aspect: '1:1', quality: '720p30'});
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.timeoutMs, shootTimeoutMs(Math.round(done.result.seconds * 30)));
  const file = path.join(lib.shootDir('c1', job.id), 'video.mp4'), info = probe(file);
  assert.deepEqual(info.streams.map(s => [s.codec_type, s.codec_name, s.pix_fmt, s.width, s.height]), [['video', 'h264', 'yuv420p', 720, 720]]);
  const moov = (await fs.readFile(file)).indexOf('moov'), mdat = (await fs.readFile(file)).indexOf('mdat');
  assert.ok(moov > 0 && moov < mdat, 'faststart: moov が mdat の前');
  const {shoots} = await lib.getCharacter('c1');
  assert.equal(shoots.length, 1);
  assert.equal(shoots[0].terms.tag, '公開できない'); assert.equal(shoots[0].motionLabel, 'ダンス');
  assert.equal(shoots[0].url, `/lib/characters/c1/shoots/${job.id}/video.mp4`);
  assert.equal(shoots[0].posterUrl, `/lib/characters/c1/shoots/${job.id}/poster.jpg`);
  await fs.access(path.join(lib.shootDir('c1', job.id), 'poster.jpg'));
  await assert.rejects(fs.access(path.join(lib.dir, 'jobs', job.id, 'frames')));
  assert.equal(done.result.terms.level, 'no');
});

test('shoot ジョブ: 長い音声は動画の長さで切って AAC になり、短い音声は無音で埋める。モーションなしは音声の長さになる', async () => {
  const {lib, q} = await setup();
  const long = await songFrom(lib, 3), short = await songFrom(lib, 1, 'short.wav');
  const a = await q.enqueue({type: 'shoot', charId: 'c1', seconds: 2, quality: '720p30', audioId: long.id});
  const b = await q.enqueue({type: 'shoot', charId: 'c1', seconds: 2, quality: '720p30', audioId: short.id, audioSummary: '自作の曲', audioPublic: true});
  const c = await q.enqueue({type: 'shoot', charId: 'c1', quality: '720p30', audioId: short.id});
  await q.whenIdle();
  for (const j of [a, b, c]) assert.equal((await q.get(j.id)).state, 'done', (await q.get(j.id)).error);
  const dur = (id, kind) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', kind, '-show_entries', 'stream=duration,codec_name', '-of', 'json', path.join(lib.shootDir('c1', id), 'video.mp4')], {encoding: 'utf8'})).streams[0];
  assert.equal(dur(a.id, 'a:0').codec_name, 'aac');
  for (const j of [a, b]) { assert.ok(Math.abs(dur(j.id, 'a:0').duration - 2) < 0.1); assert.ok(Math.abs(dur(j.id, 'v:0').duration - 2) < 0.1); }
  assert.ok(Math.abs(dur(c.id, 'v:0').duration - 1) < 0.1);
  const shoots = (await lib.getCharacter('c1')).shoots, of = j => shoots.find(s => s.id === j.id);
  assert.equal(of(a).audio.cut, true); assert.equal(of(b).audio.cut, false);
  assert.equal(of(a).terms.level, 'check'); assert.equal(of(b).terms.level, 'ok');
  assert.equal(of(b).audio.publicOk, true);
});

test('shoot ジョブ: 音声の開始位置から使い、動画の長さも開始位置から後ろで決まる。音声より後ろは積めても failed', async () => {
  const {lib, q} = await setup();
  const song = await songFrom(lib, 4), body = {type: 'shoot', charId: 'c1', quality: '720p30', audioId: song.id};
  for (const bad of [-1, 'x', 40000]) await assert.rejects(q.enqueue({...body, audioStart: bad}), /audioStart/);
  await assert.rejects(q.enqueue({...body, audioPublic: 'yes'}), /audioPublic/);
  const a = await q.enqueue({...body, audioStart: 3}), b = await q.enqueue({...body, seconds: 2, audioStart: 1.5}), c = await q.enqueue({...body, audioStart: 4});
  await q.whenIdle();
  for (const j of [a, b]) assert.equal((await q.get(j.id)).state, 'done', (await q.get(j.id)).error);
  const len = j => Number(probe(path.join(lib.shootDir('c1', j.id), 'video.mp4')).format.duration);
  assert.ok(Math.abs(len(a) - 1) < 0.1, len(a));   // 4 秒の音声の 3 秒から: 残り 1 秒
  assert.ok(Math.abs(len(b) - 2) < 0.1, len(b));
  const shoots = (await lib.getCharacter('c1')).shoots, of = j => shoots.find(s => s.id === j.id);
  assert.equal(of(a).audio.start, 3); assert.ok(Math.abs(of(a).audio.seconds - 1) < 0.1); assert.equal(of(b).audio.cut, true);
  const failed = await q.get(c.id);
  assert.equal(failed.state, 'failed'); assert.match(failed.error, /開始位置/);
});

test('shoot ジョブ: 開始位置は音声の中身に効く(開始位置を変えると、同じ長さの音が別の音になる)', async () => {
  const {lib, q} = await setup();
  const f = path.join(await tempDir(), 'two.wav');   // 前半 2 秒は 440 Hz、後半 2 秒は無音
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-af', 'apad=whole_dur=4', f]);
  const song = await lib.importAudio({name: 'two.wav', data: await fs.readFile(f)});
  const a = await q.enqueue({type: 'shoot', charId: 'c1', seconds: 2, quality: '720p30', audioId: song.id}), b = await q.enqueue({type: 'shoot', charId: 'c1', seconds: 2, quality: '720p30', audioId: song.id, audioStart: 2});
  await q.whenIdle();
  const mean = j => spawnSync('ffmpeg', ['-v', 'info', '-i', path.join(lib.shootDir('c1', j.id), 'video.mp4'), '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'], {encoding: 'utf8'}).stderr;   // volumedetect は stderr に書く
  const vol = s => Number(/mean_volume: (-?[0-9.]+) dB/.exec(s)?.[1] ?? -99);
  assert.ok(vol(mean(a)) > -30, mean(a)); assert.ok(vol(mean(b)) < -60, mean(b));
});

test('shoot ジョブ: セリフと音声を重ねても音声は 1 本で、セリフの長さが効く', async () => {
  const {lib, q} = await setup();
  await q.enqueue({type: 'voice', charId: 'c1', lineId: 'hello', text: 'こんにちは'});
  await q.whenIdle();
  const song = await songFrom(lib, 5);
  const job = await q.enqueue({type: 'shoot', charId: 'c1', lineId: 'hello', audioId: song.id, seconds: 1, quality: '720p30'});
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error);
  const info = probe(path.join(lib.shootDir('c1', job.id), 'video.mp4'));
  assert.deepEqual(info.streams.map(s => s.codec_name).sort(), ['aac', 'h264']);
  assert.ok(Math.abs(Number(info.format.duration) - 2) < 0.2, info.format.duration);   // 1 秒の指定よりセリフ(2 秒)が長い
});

test('shoot ジョブ: 音の無いファイルと、時間の上限を超えた撮影は failed で、動画を残さない', async () => {
  const {lib, q} = await setup({...FAKE_ENV, CHARASTA_FAKE_CAPTURE: 'hang', CHARASTA_SHOOT_TIMEOUT_MS: '300'});
  const job = await q.enqueue({type: 'shoot', charId: 'c1', seconds: 1});
  await q.whenIdle();
  const f = await q.get(job.id);
  assert.equal(f.state, 'failed'); assert.match(f.error, /秒で終わらなかった/);
  assert.equal(f.timeoutMs, 300);
  assert.deepEqual((await lib.getCharacter('c1')).shoots, []);
  assert.deepEqual(await fs.readdir(path.join(lib.dir, 'jobs', job.id)).then(l => l.filter(n => ['frames', 'video.mp4', 'poster.jpg'].includes(n))), []);   // 失敗しても作業のコマを残さない
  const v = path.join(await tempDir(), 'mute.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mov', v]);
  const mute = await lib.importAudio({name: 'mute.m4a', data: await fs.readFile(v)});
  const g = await q.enqueue({type: 'shoot', charId: 'c1', audioId: mute.id});
  await q.whenIdle();
  assert.match((await q.get(g.id)).error, /音が入っていない/);
});

test('音声の取り込み: 同じ中身は 1 つにまとまり、形式と空を確かめる。保管場所の audio/ は配らない', async () => {
  const s = await startServer({env: FAKE_ENV});
  try {
    const f = path.join(await tempDir(), 't.wav'); tone(f, 0.2);
    const data = await fs.readFile(f), post = (name, body) => fetch(s.base + '/api/audio', {method: 'POST', headers: {'x-filename': encodeURIComponent(name)}, body});
    const r = await post('曲.wav', data), a = await r.json();
    assert.equal(r.status, 201); assert.equal(a.name, '曲.wav'); assert.equal(a.sizeBytes, data.length);
    assert.equal((await (await post('別名.wav', data)).json()).id, a.id);
    assert.equal((await post('a.txt', data)).status, 400);
    assert.equal((await post('a.wav', Buffer.alloc(0))).status, 400);
    assert.equal((await fetch(`${s.base}/lib/audio/${a.id}/audio.wav`)).status, 404);
    assert.equal((await fetch(s.base + '/api/audio')).status, 405);
  } finally { await s.close(); }
});

test('GET /api/terms と /api/motions: 判定をサーバーが返す', async () => {
  const s = await startServer({env: FAKE_ENV});
  try {
    const lib = new Library(s.libraryDir), data = await fs.readFile(SAMPLE_VRMA);
    await lib.importMotion({id: 'dance', data, license: PERSONAL});
    const terms = async q => (await fetch(s.base + '/api/terms?' + q)).json();
    assert.equal((await terms('motion=dance')).tag, '公開できない');
    assert.equal((await terms('audioName=a.mp3')).level, 'check');
    assert.equal((await terms('audioName=a.mp3&audioSummary=' + encodeURIComponent('自作'))).level, 'check');   // 自由文だけでは ok にしない
    assert.equal((await fetch(s.base + '/api/terms?motion=nope')).status, 404);
    assert.deepEqual((await (await fetch(s.base + '/api/motions')).json())[0].limit, {text: '個人利用のみ', warn: true});
  } finally { await s.close(); }
});

test('GET /api/terms: 音声の「公開してよい」を選んだときだけ ok になり、メモの前後の空白は無視する', async () => {
  const s = await startServer({env: FAKE_ENV});
  try {
    const terms = async q => (await fetch(s.base + '/api/terms?' + q)).json(), memo = encodeURIComponent('  自作の曲  ');
    assert.equal((await terms('audioName=a.mp3&audioSummary=' + memo)).level, 'check');
    const ok = await terms('audioName=a.mp3&audioSummary=' + memo + '&audioPublic=1');
    assert.equal(ok.level, 'ok'); assert.match(ok.notes[0].text, /（自作の曲）/);
    assert.equal((await terms('audioName=a.mp3&audioSummary=' + encodeURIComponent('私的利用のみ') + '&audioPublic=1')).level, 'no');
    assert.equal((await terms('audioName=a.mp3&audioSummary=%20%20')).level, 'check');
  } finally { await s.close(); }
});

test('大きすぎる本文は 413 で断り、サーバーは落ちない(Content-Length が大きい、chunked で超える、JSON の 1 MB 超)', async () => {
  const s = await startServer({env: FAKE_ENV});
  const url = new URL(s.base);
  // 本文を途中までしか送らない。サーバーが読み切らずに断っても、こちらは結果(413 か、切れた接続)だけ見る
  const post = (p, headers, chunks) => new Promise(resolve => {
    const req = http.request({host: url.hostname, port: url.port, method: 'POST', path: p, headers}, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', e => resolve(e.code));
    (async () => { for (const c of chunks) { if (!req.write(c)) await new Promise(r => req.once('drain', r)); if (req.destroyed) return; } req.end(); })().catch(() => {});
  });
  const alive = async () => assert.equal((await fetch(s.base + '/api/characters')).status, 200);
  try {
    const over = 64 * 1024 * 1024 + 1;
    // 長さを先に宣言: 本文を送る前に 413
    assert.equal(await post('/api/audio', {'x-filename': 'a.wav', 'content-length': over}, [Buffer.alloc(1024)]), 413);
    await alive();
    // chunked で超える(長さを宣言しない)
    const chunk = Buffer.alloc(1024 * 1024);
    const r = await post('/api/audio', {'x-filename': 'a.wav', 'transfer-encoding': 'chunked'}, Array.from({length: 66}, () => chunk));
    // 断られて接続が切れたときの code は OS で違う(Windows は書き込み中に切れると ECANCELED のことがある)
    const CUT = [413, 'ECONNRESET', 'EPIPE', 'ECANCELED'];
    assert.ok(CUT.includes(r), String(r));
    await alive();
    // JSON の上限は 1 MB
    assert.equal(await post('/api/jobs', {'content-type': 'application/json', 'content-length': 1024 * 1024 + 1}, [Buffer.alloc(1024)]), 413);
    const r2 = await post('/api/jobs', {'content-type': 'application/json', 'transfer-encoding': 'chunked'}, Array.from({length: 3}, () => chunk));
    assert.ok(CUT.includes(r2), String(r2));
    await alive();
  } finally { await s.close(); }
});

test('全身のカメラの距離: どのコマでも入る距離以上で、広がる前に引き、狭い間は寄る', () => {
  const times = Array.from({length: 101}, (_, i) => i * 0.1), dists = times.map(t => t >= 5 && t < 5.5 ? 8 : 4);
  const track = zoomTrack(times, dists);
  track.forEach(([t, d], i) => { assert.equal(t, times[i]); assert.ok(d >= dists[i] - 1e-9, `t ${t}`); });
  assert.ok(Math.abs(trackAt(track, 1)[0] - 4) < 1e-9 && Math.abs(trackAt(track, 9)[0] - 4) < 1e-9);
  assert.ok(trackAt(track, 4.6)[0] > 4.5);   // 広がる前に引き始める
  for (let i = 1; i < track.length; i++) assert.ok(Math.abs(track[i][1] - track[i - 1][1]) <= 0.45);   // 急に動かない
});

test('shoot ジョブ: エンコード中に時間切れになると(e.stopped)libx264 で書き直さず、動画を残さない', async () => {
  // 撮影の偽物には時間の上限を付けないので、上限 1 ミリ秒が効くのは動画にまとめる ffmpeg だけ
  const {lib, q} = await setup({...FAKE_ENV, CHARASTA_SHOOT_TIMEOUT_MS: '1'});
  const job = await q.enqueue({type: 'shoot', charId: 'c1', seconds: 1});
  await q.whenIdle();
  const f = await q.get(job.id);
  assert.equal(f.state, 'failed'); assert.match(f.error, /秒で終わらなかったので止めた/);
  const log = await fs.readFile(path.join(lib.dir, 'jobs', job.id + '.log'), 'utf8');
  assert.equal(log.split('\n').filter(l => /^\$ ffmpeg .*-c:v/.test(l)).length, 1, 'エンコードの ffmpeg は 1 回だけ');
  assert.doesNotMatch(log, /書き直す/);
  assert.equal(await exists(path.join(lib.dir, 'jobs', job.id, 'video.mp4')), false);
});
