// ショート動画: カット表の API、声と口、字幕、演出、合成、書き出しのジョブ。Blender、VOICEVOX、HyperFrames は呼ばない(CHARASTA_FAKE_CAPTURE、CHARASTA_FAKE_VOICEVOX)。ffmpeg は要る。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {lipFrames, voicePhrases, voiceSeconds} from '../lib/voicevox.mjs';
import {buildTimeline, captionsOf, charTimes, withExpressions} from '../lib/short-timeline.mjs';
import {baseKey, checkHyperframes, checkReport, compositionHtml, hyperframesEnv, mixArgs, renderProject, transitionPlan} from '../lib/short-compose.mjs';
import {transitionFrame} from '../lib/short-transitions.mjs';
import {direct, expressionMarks, numberIn, parseMarks, plainText} from '../public/short-direct.mjs';
import {tempDir, fakeGlb, FAKE_ENV, SAMPLE_VRMA, startServer} from './helpers.mjs';

const ENV = {...FAKE_ENV, CHARASTA_FAKE_VOICEVOX: '1'};
const QUERY = {speedScale: 2, prePhonemeLength: 0.2, postPhonemeLength: 0.2, accent_phrases: [{moras: [{vowel: 'a', vowel_length: 0.4, consonant_length: null}, {vowel: 'N', vowel_length: 0.2, consonant_length: 0.2}], pause_mora: {vowel: 'pau', vowel_length: 0.4}}]};

async function stageDir() {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'stages'));
  await fs.writeFile(path.join(dir, 'stages', 'catalog.json'), JSON.stringify([{id: 'concert', label: 'コンサート'}, {id: 'classroom', label: '教室'}]));
  await fs.writeFile(path.join(dir, 'stages', 'concert.py'), '# 1');
  return dir;
}

async function server() {
  const s = await startServer({stageStudioDir: await stageDir(), env: ENV});
  const lib = s.server.jobs.lib;
  await lib.createCharacter({id: 'c1', name: 'いち'});
  await lib.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({a: 1})});
  await lib.importMotion({id: 'talk', data: await fs.readFile(SAMPLE_VRMA), label: '話す', license: {holder: 'h', summary: '改変可', redistribution: false}});
  const api = async (method, url, body) => {
    const r = await fetch(s.base + url, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)});
    return {status: r.status, json: await r.json().catch(() => null)};
  };
  return {...s, lib, api};
}
const CUT = {stage: 'concert', motionId: 'talk', expression: 'neutral', camera: 'talk_bust', text: 'タコの心臓は三つ', telop: '心臓は3つ'};
const short = (o = {}) => ({title: 'タコ', charId: 'c1', speaker: 8, speakerName: '春日部つむぎ', cuts: [CUT, {...CUT, stage: 'classroom', text: '', seconds: 1}], ...o});

test('声の長さ: 前後の間と子音も足し、話す速さで縮み、間は倍率で縮む', () => {
  assert.ok(Math.abs(voiceSeconds(QUERY) - 0.8) < 1e-9);   // (前 0.2 + あ 0.4 + 子音 0.2 + ン 0.2 + 間 0.4 + 後 0.2) / 速さ 2
  assert.ok(Math.abs(voiceSeconds({...QUERY, pauseLengthScale: 0.5}) - 0.7) < 1e-9);
});

test('口の形: 母音の区間で開いて、閉じる音で閉じる', () => {
  const q = {speedScale: 1, prePhonemeLength: 0.1, postPhonemeLength: 0.1, accent_phrases: [{moras: [{vowel: 'a', vowel_length: 0.3, consonant_length: null}, {vowel: 'N', vowel_length: 0.3, consonant_length: null}], pause_mora: null}]};
  const f = lipFrames(q, 30, 30);
  assert.equal(f.length, 30); assert.deepEqual(f[0], {});
  assert.ok(f[9].aa > 0.7);          // 0.3 秒: あ の途中
  assert.ok((f[18].aa ?? 0) < 0.05);  // 0.6 秒: ン
});

test('文の印: `[語]` の括弧を除いた文と強調の位置を返し、余った括弧も声に渡さない', () => {
  assert.deepEqual(parseMarks('タコの[心臓]は[三つ]'), {plain: 'タコの心臓は三つ', marks: [{from: 3, to: 5}, {from: 6, to: 8}]});
  assert.deepEqual(parseMarks('[閉じない'), {plain: '閉じない', marks: []});
  assert.deepEqual(parseMarks('[語|surprised'), {plain: '語|surprised', marks: []});
  assert.deepEqual(parseMarks('余り]と[]'), {plain: '余りと', marks: []});
  assert.equal(plainText(undefined), '');
  assert.deepEqual(parseMarks('えっ[3つ|surprised]も[語|ない表情]'), {plain: 'えっ3つも語', marks: [{from: 2, to: 4, expression: 'surprised'}, {from: 5, to: 6}]});
});

const mora = (text, from, to) => ({text, from, to});
const PHRASES = [{from: 0.1, to: 0.9, pause: true, moras: [mora('シ', 0.1, 0.2), mora('ン', 0.2, 0.3), mora('ゾ', 0.3, 0.4), mora('オ', 0.4, 0.5), mora('ワ', 0.5, 0.9)]},
  {from: 1.2, to: 1.8, pause: false, moras: [mora('ミッ', 1.2, 1.4), mora('ツ', 1.4, 1.8)]}];

test('声の句の時刻: 間も数えて話す速さで縮み、文字は間の前後で声に対応する', () => {
  const [p] = voicePhrases(QUERY);
  assert.ok(Math.abs(p.from - 0.1) < 1e-9); assert.ok(Math.abs(p.to - 0.5) < 1e-9); assert.equal(p.pause, true);
  const chars = charTimes('心臓は、三つ', PHRASES);
  assert.deepEqual(chars.map(c => c.c).join(''), '心臓は、三つ');
  assert.equal(chars[2].from, 0.5);               // 助詞の「は」は声の「ワ」に一致する
  assert.equal(chars[3].from, chars[3].to);       // 読点は時間を取らない
  assert.equal(chars[4].from, 1.2);               // 間のあとの漢字は間のあとの声から始まる
  const groups = captionsOf('心臓は、[三つ]'.replace(/[[\]]/g, ''), [{from: 4, to: 6}], PHRASES);
  assert.deepEqual(groups.map(g => g.text), ['心臓は、', '三つ']);
  assert.equal(groups[1].from, 0.95);             // 語りの 0.25 秒前に出す
  assert.ok(groups[0].to <= groups[1].from);       // 重ならない
  const tight = [{from: 0, to: 0.5, pause: true, moras: [mora('シ', 0, 0.5)]}, {from: 0.55, to: 1, pause: false, moras: [mora('ミ', 0.55, 1)]}];
  const close = captionsOf('し、み', [], tight);
  assert.equal(close[1].from, 0.5); assert.equal(close[0].to, 0.5);   // 間が短いときは前の語りが終わるまで次を出さない
  assert.deepEqual(groups[0].lines, [4]);
  const many = [{from: 0, to: 0.5, pause: false, moras: [mora('モオ', 0, 0.2), mora('ヒトツガ', 0.2, 0.5)]}, {from: 0.5, to: 1, pause: false, moras: [mora('ゼンシンニ', 0.5, 1)]}, {from: 1, to: 1.4, pause: false, moras: [mora('チオ', 1, 1.2), mora('オクッテ', 1.2, 1.4)]}];
  assert.deepEqual(captionsOf('もう一つが全身に血を送って', [], many)[0].lines, [8, 5]);   // 改行はアクセント句の境
  assert.equal(groups[1].chars[0].em, true); assert.equal(groups[0].chars[0].em, false);
});

const cuts = (...texts) => texts.map(text => ({text, telop: '', expression: 'neutral'}));

test('字幕: 空の句があっても落ちない', () => {
  const phrases = [[0, 0.4, 'ア', true], [0.42, 0.48, 'イ', true], [0.5, 1.4, 'ウ', true], [1.5, 2, 'エ', false]].map(([from, to, text, pause]) => ({from, to, pause, moras: [mora(text, from, to)]}));
  assert.equal(captionsOf('1.5倍、絵', [], phrases).map(g => g.text).join(''), '1.5倍、絵');
});

test('自動演出: 文から決まり、同じ入力には同じ答えを返す。カットの上書きが勝つ', () => {
  const list = [{...cuts('心臓は三つあるって知ってた？')[0], telop: '心臓は3つ'}, ...cuts('血は青いんだ', 'なんと！', 'なぜだろう？', '[青い]血'), {...cuts('フォローしてね')[0]}];
  const a = direct(list, 'trivia');
  assert.deepEqual(a, direct(list, 'trivia'));
  assert.deepEqual(a.cuts.map(c => c.kind), ['hook', 'plain', 'exclaim', 'question', 'plain', 'follow']);
  assert.equal(a.cuts[0].transition, 'none'); assert.equal(a.cuts[0].telopType, 'hook'); assert.equal(a.cuts[0].number, '3');
  assert.ok(a.cuts[0].effects.includes('question'));
  assert.equal(a.cuts[2].transition, 'flash'); assert.equal(a.cuts[3].transition, 'zoom');
  assert.ok(a.cuts[4].effects.includes('punch')); assert.ok(a.cuts[4].sfx.some(q => q.at === 'marks'));
  assert.equal(a.cuts[5].telopText, 'フォローしてね'); assert.ok(a.cuts[5].effects.includes('sparkle'));
  const ending = direct(cuts('はじめ', 'じゃあ、いくつだった？'), 'trivia').cuts;
  assert.equal(ending[0].telopText, '衝撃の雑学'); assert.equal(ending[1].kind, 'end'); assert.equal(ending[1].telopText, ''); assert.equal(ending[1].pull, true);   // 空のフックは見出し、定型の誘導は足さない
  for (const c of a.cuts) assert.ok(c.effects.length <= 2);
  for (const [i, c] of a.cuts.entries()) if (i > 1) assert.notEqual(c.transition, a.cuts[i - 1].transition);

  const drama = direct(list, 'drama');
  assert.equal(drama.letterbox, true); assert.equal(drama.caption, 'quiet');
  assert.ok(drama.cuts.slice(1).every(c => c.transition === 'none' && !c.effects.length && c.telopType === 'cinema'));
  assert.equal(direct(list, 'news').cuts[1].telopType, 'band');

  const custom = direct([list[0], {...list[1], transition: 'glitch', effect: 'shake', telopType: 'band'}, {...list[2], effect: 'none'}], 'trivia');
  assert.equal(custom.cuts[1].transition, 'glitch'); assert.deepEqual(custom.cuts[1].effects, ['shake']); assert.equal(custom.cuts[1].telopType, 'band');
  assert.deepEqual(custom.cuts[2].effects, []);
  const punch = direct([list[0], {...list[1], text: '血は[青い]んだ'}, list[5]], 'trivia').cuts[1];
  assert.ok(punch.effects.includes('slam')); assert.equal(punch.slamAt, 0.3); assert.equal(punch.slamWord, '青い'); assert.ok(punch.sfx.some(q => q.at === 'slam'));   // オチの 1 語は全画面
  assert.equal(direct(cuts('（どうして）'), 'trivia').cuts[0].thought, true);                                                   // 心の声
  assert.deepEqual(expressionMarks('[語|happy]のあと、なんと'), [{at: 0, expression: 'happy'}, {at: 5, expression: 'surprised'}]);
  assert.deepEqual(expressionMarks('なんと', 'drama'), []);
  assert.equal(direct([{...cuts('語')[0], telop: '数字なし', telopType: 'number'}, ...cuts('語')], 'trivia').cuts[0].telopType, 'pop');   // 数字の無いテロップは数字の型にしない
  const wide = direct([...cuts('語'), {...cuts('語')[0], telop: '１，０００倍'}], 'trivia').cuts[1];
  assert.equal(wide.telopText, '1,000倍'); assert.equal(wide.number, '1,000');                                                     // 全角は半角へ直す
  const before = direct(list, 'trivia').cuts, after = direct(list.map(c => ({...c, telop: c.telop + '!'})), 'trivia').cuts;
  assert.deepEqual(after.map(c => c.transitionSeed), before.map(c => c.transitionSeed)); assert.deepEqual(after.map(c => c.transition), before.map(c => c.transition));   // テロップは転換を変えない
  assert.equal(numberIn('１０００倍'), '1000'); assert.equal(numberIn('3.'), '3'); assert.equal(numberIn('三つある'), '三'); assert.equal(numberIn('一緒に'), null);
});

test('timeline: 字幕と強調語と効果音を動画の時刻で持つ', () => {
  const query = {speedScale: 1, prePhonemeLength: 0, postPhonemeLength: 0, accent_phrases: [{moras: [{text: 'ア', vowel: 'a', vowel_length: 0.5, consonant_length: null}, {text: 'オ', vowel: 'o', vowel_length: 0.5, consonant_length: null}], pause_mora: null}]};
  const raw = [{...CUT, text: '', telop: '', stage: 'a'}, {...CUT, text: 'あ[お]', telop: '青', stage: 'b'}];
  const short = {title: 'た', style: 'trivia', cuts: raw}, timed = [{...raw[0], id: 'x', start: 0, end: 2, count: 60}, {...raw[1], id: 'y', start: 2, end: 3.5, count: 45}];
  const t = buildTimeline({short, timed, speech: [null, {phrases: voicePhrases(query), seconds: 1}], width: 432, height: 768, fps: 30});
  assert.equal(t.seconds, 3.5); assert.equal(t.cuts[1].frames, 'y/frames/%05d.png'); assert.equal(t.cuts[1].text, 'あお');
  assert.deepEqual(t.cuts[1].marks, [{text: 'お', t: 2.5}]);
  assert.equal(t.cuts[1].captions[0].chars[1].from, 2.5); assert.equal(t.cuts[1].voice.phrases[0].moras[1].from, 2.5);
  assert.deepEqual(t.cuts[0].captions, []); assert.equal(t.cuts[0].voice, null);
  assert.ok(t.sfx.some(q => q.name === 'ding' && q.t === 2.5));
  assert.deepEqual(t.sfx.map(q => q.t), [...t.sfx.map(q => q.t)].sort((a, b) => a - b));
  assert.deepEqual(t.cuts[1].punches, [2.5]);
  assert.equal(t.cuts[1].figureAt, 2.5);
  const named = buildTimeline({short: {...short, series: '雑学', cuts: [{...raw[0], who: 'ひより'}]}, timed: [{...raw[0], who: 'ひより', id: 'x', start: 0, end: 2, count: 60}], speech: [null], width: 432, height: 768, fps: 30});
  assert.equal(named.series, '雑学'); assert.equal(named.cuts[0].who, 'ひより'); assert.match(named.cuts[0].whoColor, /^#/);
});

test('語の表情: 語の時刻からコマごとの口の形に載り、しばらくで戻る', () => {
  const q = {speedScale: 1, prePhonemeLength: 0, postPhonemeLength: 0, accent_phrases: [{moras: [{text: 'ア', vowel: 'a', vowel_length: 1, consonant_length: null}, {text: 'オ', vowel: 'o', vowel_length: 1, consonant_length: null}], pause_mora: null}]};
  const frames = withExpressions(Array.from({length: 120}, () => ({aa: 0.5})), 'あ[お|happy]', {phrases: voicePhrases(q)}, 'trivia', 30);
  assert.equal(frames[29].emotion, undefined); assert.equal(frames[30].emotion, 'happy'); assert.equal(frames[30].aa, 0.5); assert.equal(frames[90].emotion, undefined);
  const plain = [{}]; assert.equal(withExpressions(plain, 'あお', {phrases: voicePhrases(q)}, 'trivia', 30), plain);
});

test('転換: 種が同じなら同じコマで、端では前後のコマに近い', () => {
  const w = 16, h = 8, from = new Uint8Array(w * h * 3).fill(20), to = new Uint8Array(w * h * 3).fill(220);
  for (const kind of ['whip', 'zoom', 'flash', 'slide', 'glitch', 'dissolve']) {
    const a = transitionFrame(kind, from, to, new Uint8Array(from.length), {width: w, height: h, p: 0.5, seed: 3, frame: 1}), b = transitionFrame(kind, from, to, new Uint8Array(from.length), {width: w, height: h, p: 0.5, seed: 3, frame: 1});
    assert.deepEqual(a, b, kind);
    const end = transitionFrame(kind, from, to, new Uint8Array(from.length), {width: w, height: h, p: 0.999, seed: 3});
    assert.ok(end.reduce((s, v) => s + v, 0) / end.length > 190, kind);
  }
});

test('合成: 転換の位置、入力のハッシュ、音の引数、index.html', () => {
  const cut = (id, n, transition, frames) => ({id, count: n, captions: [], direction: {transition, transitionFrames: frames, seed: 7, transitionSeed: 7}});
  const t = {title: 'た<', style: 'trivia', seconds: 3, fps: 30, cuts: [cut('a', 30, 'none', 0), cut('b', 60, 'whip', 6)]};
  assert.deepEqual(transitionPlan(t), [{index: 1, kind: 'whip', seed: 7, count: 6, start: 28, head: 3}]);   // 境の前後 3 コマずつ
  assert.equal(baseKey(t), baseKey({...t, title: '別'}));                                                     // 文字を変えても base は作り直さない
  assert.equal(baseKey(t), baseKey({...t, cuts: t.cuts.map(c => ({...c, telop: '別', direction: {...c.direction, seed: 8}}))}));   // テロップの種が変わっても同じ
  assert.notEqual(baseKey(t), baseKey({...t, cuts: [t.cuts[0], cut('b', 60, 'flash', 4)]}));
  const args = mixArgs({seconds: 3, voices: [{file: 'v.wav', start: 1}], sfx: [{file: 's.wav', t: 0.5, gain: 1, seconds: 0.4}], bgm: {file: 'b.mp3', gainDb: -5}, out: 'm.wav'}), graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /sidechaincompress/); assert.match(graph, /adelay=1000\|1000/); assert.match(graph, /alimiter=limit=0\.66/); assert.match(graph, /apad=whole_dur=3/);
  const silent = mixArgs({seconds: 2, voices: [], sfx: [], bgm: null, out: 'm.wav'});
  assert.ok(silent.includes('anullsrc=r=48000:cl=stereo'));
  const html = compositionHtml({...t, title: 'た', caption: 'karaoke', letterbox: false}, {runtime: 'x()'});
  assert.match(html, /data-composition-id="main"/); assert.match(html, /data-no-timeline/); assert.match(html, /src="base\.mp4"/); assert.match(html, /id="mix"/);
  assert.doesNotMatch(html, /cdn\.|https?:\/\/(?!www\.w3\.org)/);   // 外の URL を読まない
  assert.match(compositionHtml({...t, title: 'a</script>'.replace('<', ''), cuts: [{...t.cuts[0], text: '</script>'}]}), /\\u003c\/script>/);
});

// 描画のスクリプトを DOM の代わりの最小の入れ物で動かす
function runFx(src, cuts) {
  const nodes = [], make = name => { const n = {name, attrs: {}, children: [], style: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); }}; nodes.push(n); return n; };
  const known = {fx: make('svg'), cam: make('div')}, listeners = {};
  const document = {getElementById: id => known[id], createElementNS: (_, name) => make(name)};
  const window = {SHORT: {style: 'trivia', caption: 'karaoke', letterbox: false, series: '', seconds: 3, cuts}, addEventListener: (k, f) => { listeners[k] = f; }};
  new Function('window', 'document', src)(window, document);
  return {seek: time => listeners['hf-seek']({detail: {time}}), texts: () => nodes.filter(n => n.name === 'text').map(n => n.textContent)};
}
const fxCut = (telop, telopType, number) => ({index: 0, start: 0, end: 3, camera: 'talk_bust', telop, who: '', figure: '', captions: [], punches: [], direction: {kind: 'plain', seed: 5, kenburns: 0.05, effects: [], telopType, number, slamAt: null}});

test('文字の描画: 数字の型', async () => {
  const src = await fs.readFile(path.join('public', 'short-fx.js'), 'utf8');
  assert.doesNotThrow(() => runFx(src, [fxCut('数字なし', 'number', null)]).seek(1));   // 数字が無ければ弾むテロップへ戻す
  const f = runFx(src, [fxCut('1,000倍', 'number', '1,000')]);
  f.seek(2);
  assert.equal(f.texts().filter(t => /[0-9,]/.test(t)).filter((_, i) => i % 3 === 2).join(''), '1,000');   // カンマの位置を保つ
  const half = runFx(src, [fxCut('1.5倍', 'number', '1.5')]);
  half.seek(2);
  assert.equal(half.texts().filter(t => /[0-9.]/.test(t)).filter((_, i) => i % 3 === 2).join(''), '1.5');
});

test('合成の検査: 終了コードが 0 でなくても lint と runtime の誤りだけで止める', async () => {
  assert.match(checkReport(JSON.stringify({lint: {errorCount: 0}, runtime: {errorCount: 0}, layout: {errorCount: 80}, contrast: {warningCount: 3}})), /layout 80 件/);
  assert.throws(() => checkReport(JSON.stringify({lint: {errorCount: 1, findings: [{severity: 'error', code: 'x'}]}})), /誤りが出た.*"code":"x"/);
  assert.throws(() => checkReport(JSON.stringify({lint: {errorCount: 0}, runtime: {errorCount: 2, findings: []}})), /誤りが出た/);
  assert.throws(() => checkReport('壊れた'), /読めない/);

  const dir = await tempDir(), log = [];
  const ctx = stdout => ({log: s => log.push(s), run: async (_, args, o) => {
    if (args[1] === 'check') throw Object.assign(new Error('失敗'), {stdout});
    assert.equal(o.env.OPENROUTER_API_KEY, ''); assert.equal(o.env.HYPERFRAMES_BROWSER_PATH, 'chrome.exe'); assert.equal(o.env.TEMP, path.join(dir, 'tmp'));
    assert.ok((await fs.stat(o.env.TEMP)).isDirectory());
    o.onOutput('[Browser:PAGEERROR] 壊れた\n');
  }});
  const opts = {cli: 'cli.js', browser: 'chrome.exe', dir, quality: 'preview', out: 'o.mp4'}, ok = JSON.stringify({lint: {errorCount: 0}, runtime: {errorCount: 0}});
  await assert.rejects(renderProject(ctx(ok), opts), /描画で例外/);                                  // 描画の例外はジョブの失敗
  await assert.rejects(fs.stat(path.join(dir, 'tmp')));                                              // 失敗しても一時フォルダを消す
  await assert.rejects(renderProject(ctx(JSON.stringify({lint: {errorCount: 1}})), opts), /誤りが出た/);
  assert.equal(hyperframesEnv(dir, 'c').TMP, path.join(dir, 'tmp'));
  await assert.rejects(checkHyperframes({cli: path.join(dir, 'none.js'), browser: 'x'}), /CLI が無い/);
});

test('文字の描画: 種付きの乱数だけを使い、時計を読まない', async () => {
  const src = await fs.readFile(path.join('public', 'short-fx.js'), 'utf8');
  assert.doesNotMatch(src, /Math\.random|Date\.now|performance\.now|requestAnimationFrame|setTimeout/);
});

test('効果音: 5 種類の wav が揃っている', async () => {
  for (const name of ['whoosh', 'pop', 'ding', 'impact', 'sparkle']) {
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,channels:format=duration', '-of', 'json', path.join('assets', 'sfx', name + '.wav')]));
    assert.equal(info.streams[0].sample_rate, '48000'); assert.equal(info.streams[0].channels, 2); assert.ok(info.format.duration > 0.1 && info.format.duration < 2);
  }
});

test('API: カット表を作って読み、直して、ごみ箱へ移す。入力の誤りは断る', async () => {
  const s = await server();
  try {
    assert.equal((await s.api('POST', '/api/shorts', short({cuts: [{...CUT, stage: 'none'}]}))).status, 400);
    assert.equal((await s.api('POST', '/api/shorts', short({cuts: [{...CUT, motionId: 'none'}]}))).status, 404);
    assert.equal((await s.api('POST', '/api/shorts', short({charId: 'none'}))).status, 404);
    const made = await s.api('POST', '/api/shorts', short());
    assert.equal(made.status, 201); assert.equal(made.json.verId, 'v1');
    const id = made.json.id;
    assert.equal((await s.api('PUT', '/api/shorts/' + id, short({title: '直した'}))).json.title, '直した');
    assert.equal((await s.api('GET', '/api/shorts')).json.length, 1);
    assert.equal((await s.api('GET', '/api/short-options')).json.speakers.length, 1);
    assert.equal((await s.api('GET', `/api/shorts/${id}/impact`)).json.refusal, null);
    const gone = await s.api('DELETE', '/api/shorts/' + id);
    assert.equal(gone.status, 200);
    assert.equal((await s.api('GET', '/api/shorts/' + id)).status, 404);
    assert.equal((await s.api('POST', `/api/trash/${gone.json.item.trashId}/restore`)).status, 200);   // 戻せる
    assert.equal((await s.api('GET', '/api/shorts/' + id)).json.title, '直した');
    assert.equal((await s.api('POST', '/api/short-voice', {text: 'あ', speed: 99})).status, 400);
    assert.equal((await s.api('POST', '/api/shorts', short({cuts: [null]}))).status, 400);
    assert.equal((await s.api('POST', '/api/shorts', short({style: 'none'}))).status, 400);
    assert.equal((await s.api('POST', '/api/shorts', short({cuts: [{...CUT, transition: 'none-such'}]}))).status, 400);
    const styled = await s.api('POST', '/api/shorts', short({style: 'drama', cuts: [{...CUT, transition: 'glitch'}]}));
    assert.equal(styled.json.style, 'drama'); assert.equal(styled.json.cuts[0].transition, 'glitch'); assert.equal(styled.json.cuts[0].effect, '');
  } finally { await s.close(); }
});

test('API: カットの確認と直しの頼みごと、ショート全体の頼みごとを保存して読み戻す', async () => {
  const s = await server();
  try {
    const id = (await s.api('POST', '/api/shorts', short())).json.id, at = '2026-11-04T01:02:03.000Z';
    const saved = await s.api('PUT', '/api/shorts/' + id, short({ask: '全体にテンポを上げて', askedAt: at, cuts: [{...CUT, ok: true, ask: ' もう少し寄って ', askedAt: at}, {...CUT, ok: false, ask: '', askedAt: at}]}));
    assert.equal(saved.status, 200);
    const back = (await s.api('GET', '/api/shorts/' + id)).json;
    assert.equal(back.ask, '全体にテンポを上げて'); assert.equal(back.askedAt, at);
    assert.equal(back.cuts[0].ok, true); assert.equal(back.cuts[0].ask, 'もう少し寄って'); assert.equal(back.cuts[0].askedAt, at);
    assert.equal(back.cuts[1].ok, undefined); assert.equal(back.cuts[1].ask, undefined); assert.equal(back.cuts[1].askedAt, undefined);   // 空の頼みごとは時刻も残さない
    const plain = (await s.api('PUT', '/api/shorts/' + id, short({cuts: [{...CUT, ask: '頼む前の下書き'}]}))).json;
    assert.equal(plain.cuts[0].ask, '頼む前の下書き'); assert.equal(plain.cuts[0].askedAt, undefined); assert.equal(plain.ask, undefined);
    assert.equal((await s.api('PUT', '/api/shorts/' + id, short({cuts: [{...CUT, ask: 'あ'.repeat(201)}]}))).status, 400);
    assert.equal((await s.api('PUT', '/api/shorts/' + id, short({cuts: [{...CUT, ask: 'あ', askedAt: 'きのう'}]}))).status, 400);
    // Claude の返事は頼みごとを外したあとも残る
    const replied = (await s.api('PUT', '/api/shorts/' + id, short({reply: '声を速めた', repliedAt: at, cuts: [{...CUT, reply: ' 寄りにした ', repliedAt: at}]}))).json;
    assert.equal(replied.reply, '声を速めた'); assert.equal(replied.cuts[0].reply, '寄りにした'); assert.equal(replied.cuts[0].repliedAt, at); assert.equal(replied.cuts[0].ask, undefined);
    assert.equal((await s.api('PUT', '/api/shorts/' + id, short({cuts: [{...CUT, reply: 'あ', repliedAt: 'きのう'}]}))).status, 400);
    assert.equal((await s.api('PUT', '/api/shorts/' + id, short({ask: 'あ', askedAt: 12}))).status, 400);
  } finally { await s.close(); }
});

test('API: 書き出しの時間表からカットの時刻と効果音を返す。無い画質は 404、知らない画質は 400', async () => {
  const s = await server();
  try {
    const id = (await s.api('POST', '/api/shorts', short())).json.id;
    assert.equal((await s.api('GET', `/api/shorts/${id}/times/preview`)).status, 404);
    assert.equal((await s.api('GET', `/api/shorts/${id}/times/huge`)).status, 400);
    const work = path.join(s.libraryDir, 'shorts', id, 'work', 'preview');
    await fs.mkdir(work, {recursive: true});
    await fs.writeFile(path.join(work, 't.json'), JSON.stringify({seconds: 3.5, hush: [[2, 3.5]], sfx: [{t: 0.2, name: 'pop', gain: 2}],
      cuts: [{start: 0, end: 2, text: 'あ', voice: {start: 0.1, seconds: 1.5, phrases: []}, captions: []}, {start: 2, end: 3.5, text: '', voice: null}]}));
    const r = await s.api('GET', `/api/shorts/${id}/times/preview`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {quality: 'preview', seconds: 3.5, hush: [[2, 3.5]], sfx: [{t: 0.2, name: 'pop'}], cuts: [{start: 0, end: 2, voice: {start: 0.1, seconds: 1.5}}, {start: 2, end: 3.5, voice: null}]});
  } finally { await s.close(); }
});

test('書き出し: 声の長さでカットを決め、音声の付いた動画にする。直したカットだけ描き直す', async () => {
  const s = await server();
  try {
    const id = (await s.api('POST', '/api/shorts', short())).json.id, jobs = s.server.jobs;
    const j = await s.api('POST', '/api/jobs', {type: 'short', shortId: id, quality: 'preview'});
    assert.equal(j.status, 201);
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short', shortId: id})).status, 409);
    await jobs.whenIdle();
    const done = await jobs.get(j.json.id);
    assert.equal(done.state, 'done', done.error);
    const [v] = (await s.api('GET', '/api/shoots')).json;
    assert.equal(v.kind, 'short'); assert.equal(v.short.credit, 'VOICEVOX:春日部つむぎ'); assert.deepEqual(v.short.stageLabels, ['コンサート', '教室']);
    const file = path.join(s.libraryDir, 'characters', 'c1', 'shoots', v.id, 'video.mp4');
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,height:format=duration', '-of', 'json', file]));
    assert.deepEqual(info.streams.map(x => x.codec_type).sort(), ['audio', 'video']); assert.equal(info.streams.find(x => x.height).height, 1920);
    assert.ok(info.format.duration > 2);

    const work = path.join(s.libraryDir, 'shorts', id, 'work', 'preview'), plan = async () => JSON.parse(await fs.readFile(path.join(work, 'plan.json'), 'utf8')).cuts.map(c => c.id);
    const first = await plan();
    const song = path.join(s.libraryDir, 'song.wav');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', song]);
    const audio = await s.lib.importAudio({name: 'song.wav', data: await fs.readFile(song)});
    await s.api('PUT', '/api/shorts/' + id, short({audioId: audio.id, audioPublic: true, cuts: [CUT, {...CUT, stage: 'classroom', text: '', seconds: 2}]}));
    await s.api('POST', '/api/jobs', {type: 'short', shortId: id});
    await jobs.whenIdle();
    const next = await plan();
    assert.equal(next[0], first[0]); assert.notEqual(next[1], first[1]);
    const left = await fs.readdir(work);
    assert.ok(!left.includes(first[1])); assert.ok(left.includes(next[0]));   // 使わなくなったカットの作業は消える
    const t = JSON.parse(await fs.readFile(path.join(work, 't.json'), 'utf8'));
    assert.deepEqual(t.cuts.map(c => c.id), next); assert.equal(t.style, 'trivia');

    // 図: 置いたファイルを読み、書き出すと合成のフォルダへコピーされる。ファイル名は確かめる
    const up = await fetch(`${s.base}/api/shorts/${id}/figures`, {method: 'POST', headers: {'x-filename': 'a.png'}, body: Buffer.from('png')}), {file: fig} = await up.json();
    assert.equal(up.status, 201); assert.match(fig, /^fig-[0-9a-f]+\.png$/);
    assert.equal((await fetch(`${s.base}/api/shorts/${id}/figures`, {method: 'POST', headers: {'x-filename': 'a.exe'}, body: Buffer.from('x')})).status, 400);
    assert.equal((await s.api('PUT', '/api/shorts/' + id, short({audioId: audio.id, cuts: [{...CUT, figure: '../x.png'}]}))).status, 400);
    assert.equal((await fetch(`${s.base}/api/shorts/${id}/compose/figures/${fig}`)).status, 200);
    await s.api('PUT', '/api/shorts/' + id, short({defaultBgm: true, cuts: [{...CUT, figure: fig}, {...CUT, stage: 'classroom', text: '', seconds: 2}]}));
    await s.api('POST', '/api/jobs', {type: 'short', shortId: id});
    await jobs.whenIdle();
    assert.equal((await fs.stat(path.join(work, 'compose', 'figures', fig))).size, 3);
    const figured = JSON.parse(await fs.readFile(path.join(work, 't.json'), 'utf8'));
    assert.equal(figured.cuts[0].figure, 'figures/' + fig); assert.ok(figured.sfx.some(q => q.name === 'pop' && q.gain === 2)); assert.equal(figured.bgm, 'trivia');

    // `[語]` を足しても声とカットは変わらず、字幕と声に括弧は出ない
    const voiced = (await fs.readdir(path.join(s.libraryDir, 'shorts', id, 'voice'))).sort();
    await s.api('PUT', '/api/shorts/' + id, short({audioId: audio.id, audioPublic: true, cuts: [{...CUT, text: 'タコの[心臓]は三つ'}, {...CUT, stage: 'classroom', text: '', seconds: 2}]}));
    await s.api('POST', '/api/jobs', {type: 'short', shortId: id});
    await jobs.whenIdle();
    assert.deepEqual(await plan(), next);
    assert.deepEqual((await fs.readdir(path.join(s.libraryDir, 'shorts', id, 'voice'))).sort(), voiced);
    assert.doesNotMatch(await fs.readFile(path.join(work, 'compose', 'index.html'), 'utf8'), /\[心臓\]/);
    const marked = JSON.parse(await fs.readFile(path.join(work, 't.json'), 'utf8'));
    assert.equal(marked.cuts[0].marks[0].text, '心臓'); assert.equal(marked.cuts[0].text, 'タコの心臓は三つ');

    // テロップだけの直しでは base を作り直さない
    const baseFile = path.join(work, 'compose', 'base.mp4'), baseTime = (await fs.stat(baseFile)).mtimeMs;
    await s.api('PUT', '/api/shorts/' + id, short({audioId: audio.id, audioPublic: true, cuts: [{...CUT, text: 'タコの[心臓]は三つ', telop: 'テロップだけ直す'}, {...CUT, stage: 'classroom', text: '', seconds: 2}]}));
    await s.api('POST', '/api/jobs', {type: 'short', shortId: id});
    await jobs.whenIdle();
    assert.equal((await fs.stat(baseFile)).mtimeMs, baseTime);

    // プレビュー: 文字だけの直しは書き出さずに見られ、配るのは合成のフォルダの中の決まった種類だけ
    const base = `${s.base}/api/shorts/${id}/compose`;
    await s.api('PUT', '/api/shorts/' + id, short({audioId: audio.id, audioPublic: true, style: 'drama', cuts: [{...CUT, text: 'タコの[心臓]は三つ', telop: '直した'}, {...CUT, stage: 'classroom', text: '', seconds: 2}]}));
    const page = await fetch(`${base}/index.html`);
    assert.equal(page.status, 200); assert.match(await page.text(), /直した/);
    assert.equal((await fetch(`${base}/base.mp4`)).status, 200);
    assert.ok((await fetch(`${base}/..%2F..%2F..%2Fshort.json`)).status >= 400);
    assert.ok((await fetch(`${base}/..%2F..%2F..%2F..%2Ffake.mp4`)).status >= 400);
    assert.equal((await fetch(`${base}/base.key`)).status, 404);
    await s.api('PUT', '/api/shorts/' + id, short({audioId: audio.id, audioPublic: true, cuts: [{...CUT, text: '別のセリフ'}, {...CUT, stage: 'classroom', text: '', seconds: 2}]}));
    assert.equal((await fetch(`${base}/index.html`)).status, 409);
    const withSong = (await s.api('GET', '/api/shoots')).json.find(x => x.audio);
    assert.equal(withSong.audio.name, 'song.wav');
    const head = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path.join(s.libraryDir, 'characters', 'c1', 'shoots', withSong.id, 'video.mp4')]));
    assert.ok(Math.abs(head.format.duration - withSong.seconds) < 0.1);   // 長い BGM で動画が伸びない
  } finally { await s.close(); }
});
