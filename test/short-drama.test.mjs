// ショートドラマ: 出演者、話す人、声の提供元、口の動き、ドラマの型。Blender、VOICEVOX、HyperFrames、ElevenLabs は呼ばない(CHARASTA_FAKE_CAPTURE、CHARASTA_FAKE_VOICEVOX、CHARASTA_FAKE_ELEVENLABS)。ffmpeg は要る。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DIALOGUE_TAGS, ElevenLabs, alignedChars, elevenPhrases, evenAlignment, speechEnd, usableVoice} from '../lib/elevenlabs.mjs';
import {DIALOGUE_TEMPO, castDialogue, checkDialogueCuts, dialogueCuts, speakDialogue, storedDialogue, useDialogue, voiceLips, voiceOf, warnDialogueCuts} from '../lib/short-voice.mjs';
import {lipsOfMoras} from '../lib/voicevox.mjs';
import {mixArgs} from '../lib/short-compose.mjs';
import {buildTimeline, captionsOf, takeFrames} from '../lib/short-timeline.mjs';
import {castOf, direct} from '../public/short-direct.mjs';
import {tempDir, fakeGlb, FAKE_ENV, SAMPLE_VRMA, startServer} from './helpers.mjs';

const ENV = {...FAKE_ENV, CHARASTA_FAKE_VOICEVOX: '1', CHARASTA_FAKE_ELEVENLABS: '1'};

async function server() {
  const stage = await tempDir();
  await fs.mkdir(path.join(stage, 'stages'));
  await fs.writeFile(path.join(stage, 'stages', 'catalog.json'), JSON.stringify([{id: 'classroom', label: '教室'}, {id: 'concert', label: 'コンサート'}]));
  await fs.writeFile(path.join(stage, 'stages', 'classroom.py'), '# 1');
  const s = await startServer({stageStudioDir: stage, env: ENV}), lib = s.server.jobs.lib;
  for (const id of ['c1', 'c2']) { await lib.createCharacter({id, name: id}); await lib.importVersion({charId: id, id: 'v1', data: fakeGlb({id})}); }
  await lib.importMotion({id: 'talk', data: await fs.readFile(SAMPLE_VRMA), label: '話す', license: {holder: 'h', summary: '改変可', redistribution: false}});
  await lib.importMotion({id: 'nod', data: await fs.readFile(SAMPLE_VRMA), label: '相づち', license: {holder: 'h', summary: '改変可', redistribution: false}});
  const api = async (method, url, body) => {
    const r = await fetch(s.base + url, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)});
    return {status: r.status, json: await r.json().catch(() => null)};
  };
  return {...s, lib, api};
}
const A = {name: '凛', charId: 'c1', verId: 'v1', provider: 'elevenlabs', voiceId: 'fake-voice', voiceName: '試しの声'}, B = {name: 'ひより', charId: 'c2', verId: 'v1', provider: 'voicevox', speaker: 3, speakerName: 'ずんだもん', speed: 1.1};
const CUT = {stage: 'classroom', motionId: 'talk', expression: 'neutral', camera: 'close_who'};
const drama = (o = {}) => ({title: '手紙', style: 'drama', defaultBgm: true, ambience: 'wind', cast: [A, B], cuts: [
  {...CUT, who: '凛', text: 'これを書いたのは[あなた]でしょ。', telop: '差出人のない手紙', sound: 'paper', soundGain: 2},
  {...CUT, who: 'ひより', camera: 'over_shoulder', text: '違う。', actors: [{motionId: 'nod', expression: 'afraid', prop: 'letter_open', hold: true}, {motionId: 'talk', expression: 'angry'}]},
  {...CUT, who: 'ひより', camera: 'two_shot', text: '', seconds: 3, actors: [{absent: true}, {}]},
  {...CUT, who: '凛', camera: 'pull_back', text: '（まだ言えない。）', telop: 'つづく', tone: 'whispers'}], ...o});

test('出演者: cast の無い古いショートは 1 人として読み、人数と名前を確かめる', async () => {
  assert.deepEqual(castOf({charId: 'c', verId: 'v', speaker: 8, speakerName: 'x', speed: 1.2}), [{name: '', charId: 'c', verId: 'v', provider: 'voicevox', speaker: 8, speakerName: 'x', speed: 1.2}]);
  const s = await server();
  try {
    assert.equal((await s.api('POST', '/api/shorts', drama())).status, 201);
    for (const cast of [[], [A, B, {...A, name: 'c'}, {...A, name: 'd'}], [A, {...B, name: A.name}], [A, {...B, name: ''}], [{...A, voiceId: ''}], [{...A, provider: 'other'}], [{...A, charId: 'nobody'}]]) assert.notEqual((await s.api('POST', '/api/shorts', drama({cast}))).status, 201, JSON.stringify(cast));
    assert.equal((await s.api('POST', '/api/shorts', drama({cuts: [{...CUT, sound: 'nope'}]}))).status, 400);
    assert.equal((await s.api('POST', '/api/shorts', drama({cuts: [{...CUT, tone: 'nope'}]}))).status, 400);
    assert.equal((await s.api('POST', '/api/shorts', drama({ambience: 'nope'}))).status, 400);
    assert.equal((await s.api('POST', '/api/shorts', drama({cuts: [{...CUT, actors: [{}, {}, {}]}]}))).status, 400);
  } finally { await s.close(); }
});

test('2 人のドラマの書き出し: 話す人だけ口が動き、声はキャッシュされ、古い 1 人のショートも動く', async () => {
  const s = await server();
  try {
    const jobs = s.server.jobs, synth = jobs.eleven.synth.bind(jobs.eleven);
    let calls = 0;
    jobs.eleven.synth = (...a) => { calls++; return synth(...a); };
    const id = (await s.api('POST', '/api/shorts', drama())).json.id;
    const job = await s.api('POST', '/api/jobs', {type: 'short', shortId: id, quality: 'preview'});
    await jobs.whenIdle();
    const done = await jobs.get(job.json.id);
    assert.equal(done.state, 'done', done.error);
    assert.equal(calls, 2);   // 凛の 2 文。ひよりは VOICEVOX
    const work = path.join(s.libraryDir, 'shorts', id, 'work', 'preview'), plan = JSON.parse(await fs.readFile(path.join(work, 'plan.json'), 'utf8')), t = JSON.parse(await fs.readFile(path.join(work, 't.json'), 'utf8'));
    const lips = (c, slot) => c.actors.find(a => a.slot === slot).lips.filter(f => Object.keys(f).length).length;
    assert.deepEqual(plan.cuts.map(c => c.who), [0, 1, 1, 0]);
    assert.ok(lips(plan.cuts[0], 0) > 0); assert.equal(lips(plan.cuts[0], 1), 0);    // 凛が話す
    assert.ok(lips(plan.cuts[1], 1) > 0); assert.equal(lips(plan.cuts[1], 0), 0);    // ひよりが話す
    assert.equal(plan.cuts[3].actors[0].lips.length, 0);                              // 心の声は口が動かない
    assert.deepEqual(plan.cuts[2].actors.map(a => a.slot), [1]);                      // 居ない人は読み込まない
    assert.deepEqual(plan.cuts[1].actors.map(a => [a.motion, a.expression, a.once, a.prop, a.hold]), [['nod', 'afraid', true, 'letter_open', true], ['talk', 'angry', true, undefined, undefined]]);
    assert.ok(plan.cuts.every(c => c.count === 2));
    assert.ok(plan.cuts[0].actors[0].lips.slice(0, 3).every(f => !Object.keys(f).length));   // 声の前の間は閉じている
    assert.equal(t.cuts[0].captions[0].chars[0].from, 0.1);        // 字幕は ElevenLabs の文字の時刻(間のあと)
    assert.equal(t.cuts[3].direction.thought, true); assert.equal(t.cuts[0].direction.telopType, 'title'); assert.equal(t.cuts[3].direction.telopType, 'title');
    assert.deepEqual(t.cuts.map(c => c.side), [-1, 1, 1, -1]); assert.notEqual(t.cuts[0].whoColor, t.cuts[1].whoColor);
    assert.ok(t.sfx.some(q => q.name === 'paper' && q.gain === 2));
    const [v] = (await s.api('GET', '/api/shoots')).json;
    assert.equal(v.short.credit, 'ElevenLabs、VOICEVOX:ずんだもん');
    const preview = await fetch(`${s.base}/api/shorts/${id}/compose/index.html`);
    assert.equal(preview.status, 200);

    // 同じ文は別のショートでも生成しない
    const other = (await s.api('POST', '/api/shorts', drama({title: '別'}))).json.id;
    await s.api('POST', '/api/jobs', {type: 'short', shortId: other, quality: 'preview'});
    await jobs.whenIdle();
    assert.equal(calls, 2);
    const voice = await fetch(s.base + '/api/short-voice', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({text: 'これを書いたのは[あなた]でしょ。', provider: 'elevenlabs', voiceId: 'fake-voice'})});
    assert.equal(voice.status, 200); assert.equal(calls, 2);

    // 古い形の short.json(cast が無い)も書き出せる
    const old = 'sold';
    await fs.mkdir(s.lib.shortDir(old), {recursive: true});
    await fs.writeFile(path.join(s.lib.shortDir(old), 'short.json'), JSON.stringify({id: old, title: '古い', style: 'trivia', charId: 'c1', verId: 'v1', speaker: 8, speakerName: 'x', speed: 1.25, cuts: [{stage: 'classroom', motionId: 'talk', expression: 'neutral', camera: 'talk_bust', angle: 0, text: 'こんにちは', telop: '', seconds: 0}]}));
    const j2 = await s.api('POST', '/api/jobs', {type: 'short', shortId: old});
    await jobs.whenIdle();
    assert.equal((await jobs.get(j2.json.id)).state, 'done');
    const oldPlan = JSON.parse(await fs.readFile(path.join(s.lib.shortDir(old), 'work', 'preview', 'plan.json'), 'utf8'));
    assert.deepEqual(oldPlan.cuts[0].actors.map(a => [a.slot, a.char, a.once]), [[0, 'c1', false]]); assert.equal(oldPlan.cuts[0].count, 1);
    await fs.writeFile(path.join(s.lib.shortDir(old), 'short.json'), JSON.stringify({...JSON.parse(await fs.readFile(path.join(s.lib.shortDir(old), 'short.json'), 'utf8')), cuts: [{stage: 'classroom', motionId: 'talk', expression: 'neutral', camera: 'talk_bust', angle: 0, text: '', telop: '', seconds: 1, actors: [{hold: true}]}]}));
    await s.api('POST', '/api/jobs', {type: 'short', shortId: old});
    await jobs.whenIdle();
    assert.equal(JSON.parse(await fs.readFile(path.join(s.lib.shortDir(old), 'work', 'preview', 'plan.json'), 'utf8')).cuts[0].actors[0].once, true);   // hold は最後の姿勢で止める
    assert.ok(oldPlan.cuts[0].actors[0].lips.some(f => Object.keys(f).length));
  } finally { await s.close(); }
});

test('声の選択: 日本語の professional だけで、LUCIAN と cloned は使わない', async () => {
  const v = (name, category, language) => ({name, category, labels: {language}});
  assert.ok(usableVoice(v('Nao', 'professional', 'ja')));
  assert.ok(!usableVoice(v('LUCIAN', 'professional', 'ja'))); assert.ok(!usableVoice(v('Lucian - x', 'professional', 'ja'))); assert.ok(!usableVoice(v('Aki', 'cloned', 'ja'))); assert.ok(!usableVoice(v('Bea', 'professional', 'en')));
  const key = 'secret-key-for-test', real = globalThis.fetch;
  globalThis.fetch = async () => new Response(`bad key ${key}`, {status: 401});
  try {
    const e = new ElevenLabs({env: {ELEVENLABS_API_KEY: key}});
    await assert.rejects(e.voices(), err => !err.message.includes(key) && /401/.test(err.message));
    globalThis.fetch = async () => Response.json({voices: [{voice_id: 'ok', name: 'Nao', category: 'professional', labels: {language: 'ja'}}, {voice_id: 'no', name: 'LUCIAN', category: 'cloned', labels: {language: 'ja'}}]});
    assert.deepEqual((await e.voices()).map(x => x.id), ['ok']);
    await assert.rejects(e.synth('文', 'no'), /使えない声/);
  } finally { globalThis.fetch = real; }
});

test('ElevenLabs の時刻: タグと括弧を飛ばして文字に合わせ、読みを区間ごとに伸縮する', () => {
  const text = [...'[whispers] 違う、私。'], a = {characters: text, character_start_times_seconds: text.map((_, i) => i * 0.1), character_end_times_seconds: text.map((_, i) => (i + 1) * 0.1)};
  const chars = alignedChars('（違う、私。）', a);
  assert.equal(chars.map(c => c.c).join(''), '（違う、私。）');
  assert.equal(chars[0].from, 0); assert.equal(chars[0].to, 0);                       // 括弧は声に無い
  assert.ok(Math.abs(chars[1].from - 1.1) < 1e-9); assert.ok(Math.abs(chars.at(-1).to - chars.at(-2).to) < 1e-9);
  const q = {speedScale: 1, prePhonemeLength: 0.1, postPhonemeLength: 0.1, pauseLengthScale: 1, accent_phrases: [{moras: [{text: 'チ', vowel: 'i', vowel_length: 0.1, consonant_length: 0.1}, {text: 'ガ', vowel: 'a', vowel_length: 0.2, consonant_length: null}], pause_mora: {vowel: 'pau', vowel_length: 0.3}}, {moras: [{text: 'ワ', vowel: 'a', vowel_length: 0.2, consonant_length: null}], pause_mora: null}]};
  const [first, second] = elevenPhrases(chars, q);
  assert.ok(Math.abs(first.from - 1.1) < 1e-9); assert.ok(Math.abs(first.to - 1.3) < 1e-9); assert.equal(first.moras[0].vowel, 'i');
  assert.ok(Math.abs(second.from - 1.4) < 1e-9); assert.equal(second.moras.at(-1).to, second.to);
  assert.ok(Math.abs(speechEnd(chars) - (chars.at(-3).to + 0.15)) < 1e-9);   // 文末の句点と括弧は数えない
  const noReading = elevenPhrases(chars, null);
  assert.equal(noReading.length, 2); assert.equal(noReading[0].moras[0].text, '違');
  const lips = lipsOfMoras(first.moras, 60, 30);
  assert.ok(lips[38].aa > 0.5); assert.deepEqual(lips[0], {});
});

test('キーの扱い: ElevenLabs だけが持ち、環境と子プロセスへ渡らない', async t => {
  const before = process.env.ELEVENLABS_API_KEY, key = 'secret-for-env-test';
  process.env.ELEVENLABS_API_KEY = key;
  t.after(() => { if (before === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = before; });
  const s = await startServer({env: {...FAKE_ENV, ELEVENLABS_API_KEY: key}});
  try {
    const jobs = s.server.jobs;
    assert.equal(process.env.ELEVENLABS_API_KEY, undefined); assert.equal(jobs.env.ELEVENLABS_API_KEY, undefined); assert.equal(jobs.eleven.ready, true);
    const seen = await jobs.run('node', ['-e', 'process.stdout.write(String(process.env.ELEVENLABS_API_KEY))'], () => {}, {capture: true});
    assert.equal(seen, 'undefined');
    assert.ok(!JSON.stringify(jobs.eleven).includes(key));
  } finally { await s.close(); }
});

test('文字の時刻が無い応答: 音の長さを文字数で割り、課金済みの音を保存する', async t => {
  const real = globalThis.fetch, audio = Buffer.alloc(16000);   // 128 kbps で 1 秒
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async url => (String(url).includes('/v1/voices') ? Response.json({voices: [{voice_id: 'v', name: 'Nao', category: 'professional', labels: {language: 'ja'}}]}) : Response.json({audio_base64: audio.toString('base64')}));
  const made = await new ElevenLabs({env: {ELEVENLABS_API_KEY: 'k'}}).synth('あいうえ', 'v');
  assert.deepEqual(made.alignment.characters, [...'あいうえ']); assert.equal(made.alignment.character_end_times_seconds.at(-1), 1); assert.equal(made.alignment.character_start_times_seconds[2], 0.5);
  assert.deepEqual(evenAlignment('', 1).characters, []);
});

test('同じ文の同時の生成は 1 回だけ課金する', async () => {
  const dir = await tempDir(), lib = {dir};
  let calls = 0;
  const eleven = {synth: async () => { calls++; await new Promise(r => setTimeout(r, 30)); return {audio: Buffer.from('x'), ext: 'mp3', alignment: {characters: [...'文'], character_start_times_seconds: [0], character_end_times_seconds: [1]}, cost: 1}; }};
  const voicevox = {reading: async () => null}, member = {provider: 'elevenlabs', voiceId: 'v'};
  const [a, b] = await Promise.all([voiceOf({lib, voicevox, eleven}, member, '文'), voiceOf({lib, voicevox, eleven}, member, '文')]);
  assert.equal(calls, 1); assert.equal(a.file, b.file);
  await voiceOf({lib, voicevox, eleven}, member, '文');
  assert.equal(calls, 1);
});

test('字幕: 全文が欠けずに出る。ドラマは句読点で切らずに続けて出す', () => {
  const line = 'ねえ。最後の一行は、もう読んだ？', chars = alignedChars(line, {characters: [...line], character_start_times_seconds: [...line].map((_, i) => i * 0.1), character_end_times_seconds: [...line].map((_, i) => (i + 1) * 0.1)});
  for (const together of [false, true]) {
    const groups = captionsOf(line, [], elevenPhrases(chars, null), chars, together);
    assert.equal(groups.map(g => g.text).join(''), line);
    groups.forEach(g => assert.ok(g.lines.reduce((a, b) => a + b, 0) === [...g.text].length));
    if (together) assert.equal(groups.length, 1);
  }
});

test('BGM を止める区間: 続くカットをまとめて mix に渡す', () => {
  const short = {style: 'drama', cuts: [{stage: 'a', text: ''}, {stage: 'a', text: '', hush: true}, {stage: 'a', text: '', hush: true}]}, timed = short.cuts.map((c, i) => ({...c, id: String(i), start: i, end: i + 1, count: 30}));
  const t = buildTimeline({short, timed, speech: [null, null, null], width: 432, height: 768, fps: 30});
  assert.deepEqual(t.hush, [[1, 3]]);
  const args = mixArgs({seconds: 3, voices: [], sfx: [], bgm: {file: 'b.m4a', gainDb: -3}, hush: t.hush, out: 'o.wav'});
  assert.match(args[args.indexOf('-filter_complex') + 1], /between\(t\\,1\\,3\)/);
});

test('ドラマの演出と音: 場所が変わると黒を挟み、環境音を混ぜる', () => {
  const d = direct([{stage: 'a', text: 'はじめ', telop: '題'}, {stage: 'a', text: '次'}, {stage: 'b', text: '場所'}, {stage: 'b', text: '終わり', telop: 'つづく', sound: 'chime'}], 'drama');
  assert.deepEqual(d.cuts.map(c => c.transition), ['none', 'none', 'fade', 'none']);
  assert.equal(d.cuts[2].transitionFrames, 34); assert.equal(d.cuts[3].telopType, 'title'); assert.ok(d.cuts[3].sfx.some(q => q.name === 'chime' && q.at === 'sound' && q.gain === 1));
  const args = mixArgs({seconds: 3, voices: [{file: 'v.wav', start: 0.3, db: 2}], sfx: [], bgm: null, ambience: {file: 'wind.mp3', gainDb: -12}, out: 'o.wav'});
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /volume=2\.00dB/); assert.match(graph, /volume=-12\.00dB\[amb\]/); assert.ok(args.includes('-stream_loop'));
});

test('1 テイクのコマ: 話す人だけ口が動き、表情はカットごと、首は相手の方へなだらかに回る', () => {
  const cuts = [{lips: Array(40).fill({aa: 0.5}), count: 40, slot: 0, expressions: ['neutral', 'surprised']}, {lips: Array(40).fill({oh: 0.5}), count: 40, slot: 1, expressions: ['shocked', 'neutral']}];
  const rin = takeFrames(cuts, 0, 28), hiyori = takeFrames(cuts, 1, 28);
  assert.equal(rin.length, 80);
  assert.equal(rin[10].aa, 0.5);
  assert.equal(hiyori[10].aa, undefined);
  assert.equal(hiyori[10].emotion, 'surprised');
  assert.equal(rin[50].face, 'shocked');
  assert.ok(rin[39].look > 25 && rin[39].look <= 28, '話す人は相手を向く');
  assert.ok(hiyori[39].look < -12 && hiyori[39].look >= -14, '聞く人は半分返す');
  assert.ok(Math.abs(rin[1].look - rin[0].look) < 3, 'いきなり回らない');
});

test('1 テイクの視線: up は前を向いたまま見上げ、each は話す人に関係なく 2 人とも相手の方を向く', () => {
  const lips = Array(60).fill({aa: 0.5}), cuts = [{lips, count: 60, slot: 1, expressions: ['neutral', 'neutral']}, {lips: [], count: 60, slot: -1, expressions: ['surprised', 'surprised'], gazes: ['up', 'up']}, {lips: [], count: 60, slot: -1, expressions: ['surprised', 'surprised'], gazes: ['each', 'each']}];
  const rin = takeFrames(cuts, 0, 28), hiyori = takeFrames(cuts, 1, 28);
  assert.ok(rin[119].lift > 20 && Math.abs(rin[119].look ?? 0) < 1, '見上げるときは前を向く');
  assert.ok(rin[179].look > 55 && hiyori[179].look < -55, '2 人とも相手の方へ回る');
  assert.ok((rin[179].lift ?? 0) < 1, '見合わせるときは見上げをやめる');
  assert.equal(rin[179].emotion, 'surprised');
  assert.equal(rin[30].lift, undefined, 'gaze の無いカットは見上げない');
});

test('会話の口: 会話の経路は開きの最大を 1 にし、1 文ずつの経路は 0.8 のまま', async () => {
  const moras = Array.from({length: 10}, (_, i) => ({from: i * 0.2, to: i * 0.2 + 0.2, vowel: 'a'}));
  const voice = {reading: true, phrases: [{moras}]}, peak = l => Math.max(...l.map(x => x.aa ?? 0));
  assert.ok(peak(await voiceLips(null, voice, 60, 30)) <= 0.8);
  assert.ok(peak(await voiceLips(null, {...voice, dialogue: true}, 60, 30)) > 0.95);
});

test('声の条件: Sakuya と Kuon は通り、Lucian と cloned は通らない', () => {
  const pro = {category: 'professional', labels: {language: 'ja'}};
  assert.ok(usableVoice({...pro, name: 'sakuya - Anime Cute Voice'}));
  assert.ok(usableVoice({...pro, name: 'kuon - Anime Cute Voice'}));
  assert.ok(!usableVoice({...pro, name: 'Lucian'}));
  assert.ok(!usableVoice({...pro, category: 'cloned', name: 'sakuya'}));
});

test('会話の経路: 全員 ElevenLabs の 2 人以上だけ。1 人と VOICEVOX が混ざるときは 1 文ずつ', () => {
  const E = {provider: 'elevenlabs'}, V = {provider: 'voicevox'};
  assert.ok(useDialogue({dialogue: true}, [E, E]));
  assert.ok(!useDialogue({}, [E, E]), 'dialogue の欄が無い既存のショートは 1 文ずつ');
  assert.ok(!useDialogue({dialogue: false}, [E, E]));
  assert.ok(!useDialogue({dialogue: true}, [E]));
  assert.ok(!useDialogue({dialogue: true}, [E, V]));
  assert.ok(castDialogue([E, E]) && !castDialogue([E]) && !castDialogue([E, V]));
});

test('会話の API: 全行を 1 回で送り、モデル、言語、seed を付ける。使えない声は送らない', async t => {
  const real = globalThis.fetch, sent = [];
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async (url, o) => {
    if (String(url).includes('/v1/voices')) return Response.json({voices: [{voice_id: 'v', name: 'kuon', category: 'professional', labels: {language: 'ja'}}]});
    sent.push({url: String(url), body: JSON.parse(o.body)});
    return new Response(JSON.stringify({audio_base64: 'AAAA', alignment: {characters: ['あ']}, voice_segments: [{dialogue_input_index: 0}]}), {headers: {'character-cost': '47'}});
  };
  const made = await new ElevenLabs({env: {ELEVENLABS_API_KEY: 'k'}}).dialogue([{voice_id: 'v', text: 'あ'}]);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].url.includes('/v1/text-to-dialogue/with-timestamps'));
  assert.deepEqual({...sent[0].body, seed: 0}, {inputs: [{voice_id: 'v', text: 'あ'}], model_id: 'eleven_v4', language_code: 'ja', seed: 0});
  assert.ok(Number.isInteger(sent[0].body.seed));
  assert.equal(made.cost, 47);
  await assert.rejects(new ElevenLabs({env: {ELEVENLABS_API_KEY: 'k'}}).dialogue([{voice_id: 'x', text: 'あ'}]), /使えない声/);
});

// 秒の区間ごとに音を置いた 16 bit の音。8000 Hz
const isPauseChar = c => /[\s、。（）]/.test(c);
const pcmOf = (seconds, spans, rate = 8000) => {
  const b = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (const [from, to] of spans) for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) b.writeInt16LE(i % 2 ? 6000 : -6000, i * 2);
  return b;
};

test('会話の切り位置: 境目より前に始まる語頭を切らず、前の行に次の語頭を入れない', () => {
  const pcm = pcmOf(3, [[0.1, 1.2], [1.3, 2.8]]);   // 2 行目の声は 1.3 秒から。voice_segments の境目は 1.5 秒
  const cuts = dialogueCuts(pcm, 8000, [1.5]);
  assert.ok(Math.abs(cuts[0].from - 0.1) < 0.011);
  assert.ok(Math.abs(cuts[0].to - 1.23) < 0.011, '前の行は無音の始まりから 30 ms 後で終わる');
  assert.ok(Math.abs(cuts[1].from - 1.3) < 0.011, '語頭を切らない');
  assert.ok(cuts[0].to <= cuts[1].from);
  assert.ok(Math.abs(cuts[1].to - 2.8) < 0.011);
  assert.deepEqual(checkDialogueCuts(pcm, 8000, cuts), []);
});

test('会話の切り位置: 無音が境目のあとへ続くときは声の始まりまで進め、無音が無ければ一番小さい所を境にする', () => {
  assert.ok(Math.abs(dialogueCuts(pcmOf(3, [[0, 1.2], [1.7, 2.8]]), 8000, [1.5])[1].from - 1.7) < 0.011);
  const pcm = pcmOf(3, [[0, 3]]);
  pcm.fill(0, 2 * 8000, 2 * 8080);    // 1.00〜1.01 秒だけ静か
  const cuts = dialogueCuts(pcm, 8000, [1.2]);
  assert.equal(cuts[1].joined, true);
  assert.ok(Math.abs(cuts[0].to - 1) < 0.011); assert.ok(cuts[0].to <= cuts[1].from);
  assert.deepEqual(checkDialogueCuts(pcm, 8000, cuts), []);
});

test('会話の切り位置: 行の最後の語の前に溜めがあっても、その語を前の行に残す', () => {
  // 1 行目 0.1〜0.9 秒、溜め 0.9〜1.4、最後の語 1.4〜1.6、間 0.1 秒、2 行目 1.7〜3.0。境目は声より 0.27 秒遅い 1.97 秒
  const pcm = pcmOf(3.2, [[0.1, 0.9], [1.4, 1.6], [1.7, 3.0]]);
  const cuts = dialogueCuts(pcm, 8000, [1.97], [1.4]);
  assert.ok(Math.abs(cuts[0].to - 1.63) < 0.011, `前の行は最後の語の後で終わる ${cuts[0].to}`);
  assert.ok(Math.abs(cuts[1].from - 1.7) < 0.011);
  assert.deepEqual(checkDialogueCuts(pcm, 8000, cuts), []);
  assert.deepEqual(warnDialogueCuts(pcm, 8000, cuts, [{start: 1.4, end: 1.6}, {start: 2.5, end: 3}]), []);
});

test('会話の切り位置: 最後の語の中の短い息継ぎを境目にせず、境目が声の終わりより早くても語の後の無音で切る', () => {
  // 1 行目 0.1〜1.0 秒、50 ms の息継ぎ、最後の語「違う」1.05〜1.5 秒(最後の文字「う」は alignment で 1.28 秒から)、無音 1.5〜1.9、2 行目 1.9〜3.0。境目は 1.4 秒と早い
  const pcm = pcmOf(3.2, [[0.1, 1.0], [1.05, 1.5], [1.9, 3.0]]);
  const cuts = dialogueCuts(pcm, 8000, [1.4], [1.28]);
  assert.ok(Math.abs(cuts[0].to - 1.53) < 0.011, `語の後で切る ${cuts[0].to}`);
  assert.ok(Math.abs(cuts[1].from - 1.9) < 0.011);
  assert.deepEqual(checkDialogueCuts(pcm, 8000, cuts), []);
  assert.deepEqual(warnDialogueCuts(pcm, 8000, cuts, [{start: 1.28, end: 1.5}, {start: 2.5, end: 3}]), []);
});

test('会話の切り位置: alignment が声より遅れていても下限は 0.3 秒手前、前の行の終わりは次の行の始まりを超えない', () => {
  const pcm = pcmOf(3.2, [[0.1, 0.9], [1.2, 1.4], [1.7, 3.0]]);   // 最後の語は 1.2〜1.4 秒。alignment は 1.4 秒と 0.2 秒遅れて言う
  const cuts = dialogueCuts(pcm, 8000, [1.97], [1.4]);
  assert.ok(Math.abs(cuts[0].to - 1.43) < 0.011, `最後の語を切らない ${cuts[0].to}`);
  assert.ok(cuts[0].to <= cuts[1].from);
});

test('会話の警告: 最後の語が切り出しの外にある、次の行の頭に前の行の最後の語が入る、終わりの 30 ms に音がある', () => {
  const pcm = pcmOf(3.2, [[0.1, 0.9], [1.4, 1.6], [1.7, 3.0]]);
  const lasts = [{start: 1.4, end: 1.6}, {start: 2.5, end: 3}];
  const bad = warnDialogueCuts(pcm, 8000, [{from: 0.1, to: 0.95, joined: false}, {from: 0.95, to: 3, joined: false}], lasts);
  assert.equal(bad.length, 2);
  assert.ok(bad.some(w => /1 行目の最後の語/.test(w)) && bad.some(w => /2 行目の頭/.test(w)));
  assert.equal(warnDialogueCuts(pcm, 8000, [{from: 0.1, to: 1.5, joined: false}, {from: 1.7, to: 3, joined: false}], lasts).length, 1, '終わりの 30 ms に音がある');
});

test('会話の検査: 切り位置の前に音があれば、その行を返す', () => {
  const pcm = pcmOf(3, [[0, 1.2], [1.3, 2.8]]);
  assert.deepEqual(checkDialogueCuts(pcm, 8000, [{from: 0, to: 1.2}, {from: 1.5, to: 2.8}]), [1]);
  assert.deepEqual(checkDialogueCuts(pcm, 8000, [{from: 0, to: 1.31}, {from: 1.3, to: 2.8}]), [1]);
});

test('会話の切り出し: 波形で切り、文字の時刻を区間へ写して縮め、同じ台本は生成しない', async () => {
  const dir = await tempDir(), lib = {dir};
  let calls = 0;
  const eleven = {dialogue: async inputs => {
    calls++;
    const chars = inputs.flatMap(x => [...x.text]), at = i => i * 0.2 + 0.5;
    return {audio: Buffer.from('x'), ext: 'mp3', cost: 47, alignment: {characters: chars, character_start_times_seconds: chars.map((_, i) => at(i)), character_end_times_seconds: chars.map((_, i) => at(i) + 0.2)},
      segments: [{start_time_seconds: 0, end_time_seconds: 1.3, character_start_index: 0, character_end_index: 3, dialogue_input_index: 0}, {start_time_seconds: 1.3, end_time_seconds: 3, character_start_index: 3, character_end_index: 6, dialogue_input_index: 1}]};
  }};
  const cut = [], pcm = pcmOf(3, [[0.5, 1.0], [1.1, 2.3]]);
  const ctx = {run: async (cmd, args) => { if (args.includes('pcm_s16le')) cut.push(args); await fs.writeFile(args.at(-1), pcm); }};
  const tools = {lib, eleven, ctx, voicevox: {reading: async () => null}};
  const lines = [{line: 'あいう', member: {voiceId: 'a'}}, {line: 'えおか', member: {voiceId: 'b'}}];
  const [one, two] = await speakDialogue(tools, lines);
  assert.equal(calls, 1);
  assert.equal(cut.length, 2);
  assert.ok(cut[1].some(x => /atrim=start=1\.1\d*:end=2\.3\d*.*atempo=1\.1/.test(x)), `切り位置 ${cut[1].join(' ')}`);
  assert.ok(Math.abs(two.seconds - 1.2 / DIALOGUE_TEMPO) < 0.02);
  assert.equal(two.chars[0].from, 0, '最初の文字は音の始まり');
  assert.ok(Math.abs(two.chars[2].to - two.seconds) < 1e-9, '最後の文字は音の終わり');
  assert.ok(Math.abs(one.chars[2].to - one.seconds) < 1e-9);
  assert.equal(one.dialogue, true);
  await speakDialogue(tools, lines);
  assert.equal(calls, 1); assert.equal(cut.length, 2);
  await speakDialogue(tools, [lines[1], lines[0]]);
  assert.equal(calls, 2, '台本が変われば作り直す');
  const stored = await storedDialogue(lib, lines);
  assert.ok(Math.abs(stored[0].seconds - one.seconds) < 1e-9);
  assert.equal(await storedDialogue(lib, [lines[0]]), null);
});

test('演じ方のタグ: 対応表は全ての演じ方を覆い、tone のある行の先頭にだけ付く。キャッシュのキーに入り、字幕と口には出ない', async () => {
  const {VOICE_TONES} = await import('../lib/short.mjs');
  assert.deepEqual(VOICE_TONES.filter(t => t && !DIALOGUE_TAGS[t]), [], '対応表に無い演じ方がある');
  const dir = await tempDir(), lib = {dir}, sent = [];
  const fake = new ElevenLabs({env: {CHARASTA_FAKE_ELEVENLABS: '1'}});
  const eleven = {dialogue: async inputs => { sent.push(inputs); return fake.dialogue(inputs); }};
  const pcm = pcmOf(40, [[0.1, 3], [3.3, 6]]);
  const ctx = {run: async (cmd, args) => { await fs.writeFile(args.at(-1), pcm); }};
  const tools = {lib, eleven, ctx, voicevox: {reading: async () => null}};
  const a = {voiceId: 'a'}, b = {voiceId: 'b'};
  const lines = [{line: 'ねえ。', member: a}, {line: '（まだ言えない。）', member: b, tone: 'whispers'}, {line: 'そう。', member: a, tone: 'terrified'}];
  const voices = await speakDialogue(tools, lines);
  assert.deepEqual(sent[0].map(x => x.text), ['ねえ。', '[whispers] まだ言えない。', '[terrified] そう。'], 'tone のある行だけタグが付き、心の声の括弧は外れる');
  assert.deepEqual(voices.map(v => v.chars.map(x => x.c).join('')), ['ねえ。', '（まだ言えない。）', 'そう。']);
  assert.ok(voices.every(v => v.chars.every(x => !/[\[\]a-z]/.test(x.c))), '字幕にタグの文字が出ない');
  assert.equal(voices[1].chars.find(x => x.c === 'ま').from, 0, '行の始まりは本文の最初の文字で、タグの時間を含まない');
  assert.ok(voices[1].chars.filter(x => !isPauseChar(x.c)).every(x => x.to > 0), '本文の文字は時刻を持つ');
  // tone を変えると別の鍵で作り直す。tone なしの行の鍵は変わらない
  await speakDialogue(tools, lines.map(l => ({...l, tone: l.tone === 'whispers' ? 'sad' : l.tone})));
  assert.equal(sent.length, 2);
  assert.equal(sent[1][1].text, '[sad] まだ言えない。');
  await speakDialogue(tools, lines);
  assert.equal(sent.length, 2, '同じ台本と tone は再生成しない');
  assert.ok(await storedDialogue(lib, lines));
});

test('会話の書き出し: 声の無いカットは inputs に入れず、tone と心の声と hush が崩れず、字幕にタグが出ない', async () => {
  const s = await server();
  try {
    const jobs = s.server.jobs, sent = [], dialogue = jobs.eleven.dialogue.bind(jobs.eleven);
    jobs.eleven.dialogue = (inputs, ...r) => { sent.push(inputs); return dialogue(inputs, ...r); };
    const synth = jobs.eleven.synth.bind(jobs.eleven);
    let singles = 0;
    jobs.eleven.synth = (...a) => { singles++; return synth(...a); };
    const B2 = {...A, name: 'ひより', charId: 'c2'};
    const body = drama({cast: [A, B2], cuts: [
      {...CUT, who: '凛', text: 'ねえ。', tone: 'whispers'},
      {...CUT, who: 'ひより', text: '', seconds: 2, hush: true},
      {...CUT, who: 'ひより', text: '（こわい。）', tone: 'terrified', hush: true},
      {...CUT, who: '凛', text: 'そう。'}]});
    const id = (await s.api('POST', '/api/shorts', body)).json.id;
    const job = await s.api('POST', '/api/jobs', {type: 'short', shortId: id, quality: 'preview'});
    await jobs.whenIdle();
    const done = await jobs.get(job.json.id);
    assert.equal(done.state, 'done', done.error);
    assert.equal(singles, 0, '1 文ずつの経路へ戻らない');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].map(x => x.text), ['[whispers] ねえ。', '[terrified] こわい。', 'そう。']);
    const t = JSON.parse(await fs.readFile(path.join(s.libraryDir, 'shorts', id, 'work', 'preview', 't.json'), 'utf8'));
    const shown = i => t.cuts[i].captions.flatMap(g => g.chars.map(x => x.c)).join('');
    assert.equal(shown(0), 'ねえ。'); assert.equal(shown(2), '（こわい。）'); assert.equal(shown(3), 'そう。');
    assert.equal(t.cuts[1].captions.length, 0, '声の無いカットに字幕は無い');
  } finally { await s.close(); }
});

// ---- 会話の経路の切り替えと、壊れた応答の扱い ----
async function dialogueTools(eleven) {
  const dir = await tempDir(), pcm = pcmOf(10, [[0.1, 3], [3.3, 6]]);
  return {dir, tools: {lib: {dir}, eleven, ctx: {run: async (cmd, args) => { await fs.writeFile(args.at(-1), pcm); }}, voicevox: {reading: async () => null}}};
}
const cacheFiles = async dir => (await fs.readdir(path.join(dir, 'voice-cache')).catch(() => []));
const goodDialogue = inputs => new ElevenLabs({env: {CHARASTA_FAKE_ELEVENLABS: '1'}}).dialogue(inputs);

test('会話の応答: alignment が無い、区間の数が行と合わない応答は、ファイルを書かずに日本語のエラーで止める', async () => {
  const lines = [{line: 'ねえ。', member: {voiceId: 'a'}}, {line: 'うん。', member: {voiceId: 'b'}}];
  const noAlign = await dialogueTools({dialogue: async inputs => ({...await goodDialogue(inputs), alignment: null})});
  await assert.rejects(speakDialogue(noAlign.tools, lines), /文字ごとの時刻\(alignment\)/);
  assert.deepEqual(await cacheFiles(noAlign.dir), [], 'alignment が無い応答はキャッシュに残さない');
  const short = await dialogueTools({dialogue: async inputs => { const made = await goodDialogue(inputs); return {...made, segments: made.segments.slice(0, 1)}; }});
  await assert.rejects(speakDialogue(short.tools, lines), /行の数 2 と合わない/);
  assert.deepEqual(await cacheFiles(short.dir), []);
  const dup = await dialogueTools({dialogue: async inputs => { const made = await goodDialogue(inputs); return {...made, segments: [made.segments[0], {...made.segments[1], dialogue_input_index: 0}]}; }});
  await assert.rejects(speakDialogue(dup.tools, lines), /行の数 2 と合わない/);
  assert.deepEqual(await cacheFiles(dup.dir), []);
  // 保管済みの記録が壊れていれば、API を呼ばずに同じエラーで止める
  let calls = 0;
  const cached = await dialogueTools({dialogue: async inputs => { calls++; return goodDialogue(inputs); }});
  await speakDialogue(cached.tools, lines);
  const json = (await cacheFiles(cached.dir)).find(f => f.endsWith('.json')), file = path.join(cached.dir, 'voice-cache', json);
  await fs.writeFile(file, JSON.stringify({...JSON.parse(await fs.readFile(file, 'utf8')), alignment: null}));
  await assert.rejects(speakDialogue(cached.tools, lines), /alignment/);
  assert.equal(calls, 1);
});

test('会話の文字数: 2000 字を超えるときは API を呼ばずに日本語のエラーで止める', async () => {
  let calls = 0;
  const t = await dialogueTools({dialogue: async inputs => { calls++; return goodDialogue(inputs); }});
  const lines = [{line: 'あ'.repeat(1000), member: {voiceId: 'a'}}, {line: 'い'.repeat(1001), member: {voiceId: 'b'}}];
  await assert.rejects(speakDialogue(t.tools, lines), /2001 字.*上限の 2000 字/);
  assert.equal(calls, 0);
  assert.deepEqual(await cacheFiles(t.dir), []);
  await speakDialogue(t.tools, [lines[0], {...lines[1], line: 'い'.repeat(1000)}]);
  assert.equal(calls, 1, '2000 字ちょうどは送る');
});

test('dialogue の欄: 新しいショートは全員 ElevenLabs の 2 人以上で true。欄の無い既存のショートは 1 文ずつ(v3)で書き出す', async () => {
  const s = await server();
  try {
    const jobs = s.server.jobs, B2 = {...A, name: 'ひより', charId: 'c2'};
    let dialogues = 0, singles = 0;
    const dialogue = jobs.eleven.dialogue.bind(jobs.eleven), synth = jobs.eleven.synth.bind(jobs.eleven);
    jobs.eleven.dialogue = (...a) => { dialogues++; return dialogue(...a); };
    jobs.eleven.synth = (...a) => { singles++; return synth(...a); };
    const cuts = [{...CUT, who: '凛', text: 'ねえ。'}, {...CUT, who: 'ひより', text: 'うん。'}];
    const made = (await s.api('POST', '/api/shorts', drama({cast: [A, B2], cuts}))).json;
    assert.equal(made.dialogue, true);
    assert.equal((await s.api('POST', '/api/shorts', drama({cast: [A, B], cuts}))).json.dialogue, undefined, 'VOICEVOX が混ざれば付かない');
    assert.equal((await s.api('POST', '/api/shorts', drama({cast: [A, B2], cuts, dialogue: false}))).json.dialogue, undefined, '明示の false は付けない');
    assert.equal((await s.api('POST', '/api/shorts', drama({cast: [A, B2], cuts, dialogue: 'yes'}))).status, 400);
    assert.equal((await s.api('PUT', `/api/shorts/${made.id}`, {...made, title: '直した'})).json.dialogue, true, '保存しても欄は残る');
    // 欄を外した既存のショート
    const file = path.join(s.lib.shortDir(made.id), 'short.json'), stored = JSON.parse(await fs.readFile(file, 'utf8'));
    delete stored.dialogue;
    await fs.writeFile(file, JSON.stringify(stored));
    const job = await s.api('POST', '/api/jobs', {type: 'short', shortId: made.id, quality: 'preview'});
    await jobs.whenIdle();
    const done = await jobs.get(job.json.id);
    assert.equal(done.state, 'done', done.error);
    assert.equal(dialogues, 0, '会話の API を呼ばない');
    assert.equal(singles, 2, '1 文ずつの声で作る');
  } finally { await s.close(); }
});

test('声を聞く: 会話の経路のショートは ElevenLabs を呼ばず、保管済みの切り出しを返す。無ければ書き出しを案内する', async () => {
  const s = await server();
  try {
    const jobs = s.server.jobs, B2 = {...A, name: 'ひより', charId: 'c2'};
    let calls = 0;
    for (const k of ['dialogue', 'synth']) { const f = jobs.eleven[k].bind(jobs.eleven); jobs.eleven[k] = (...a) => { calls++; return f(...a); }; }
    const cuts = [{...CUT, who: '凛', text: 'ねえ。'}, {...CUT, who: 'ひより', text: 'うん。'}];
    const id = (await s.api('POST', '/api/shorts', drama({cast: [A, B2], cuts}))).json.id, ask = cut => fetch(s.base + '/api/short-voice', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({text: 'ねえ。', provider: 'elevenlabs', voiceId: 'fake-voice', shortId: id, cut})});
    const before = await ask(0), note = await before.text();
    assert.notEqual(before.status, 200);
    assert.match(note, /会話の声は試しを書き出すと聞ける/);
    assert.equal(calls, 0, '声を聞くで ElevenLabs を呼ばない');
    const job = await s.api('POST', '/api/jobs', {type: 'short', shortId: id, quality: 'preview'});
    await jobs.whenIdle();
    assert.equal((await jobs.get(job.json.id)).state, 'done');
    const used = calls;
    assert.equal(used, 1, '書き出しで会話を 1 回だけ作る');
    const after = await ask(1);
    assert.equal(after.status, 200); assert.equal(after.headers.get('content-type'), 'audio/wav');
    assert.equal(calls, used, '書き出し後の声を聞くも ElevenLabs を呼ばない');
  } finally { await s.close(); }
});
