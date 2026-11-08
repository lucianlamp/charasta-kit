// ショートの下書き: ジョブ short-draft、事実の確認、連載。実際の claude と Web は呼ばない(CHARASTA_FAKE_DRAFT。CHARASTA_CLAUDE は無いファイルを指す)。ffmpeg は要る。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {checkDraft, draftArgs, draftBody, draftPrompt, draftSystem, factPrompt, longClauses, oddCommas, parseDraft, readDraftStream, readFactCheck, telopEcho, vetClaims} from '../lib/short-draft.mjs';
import {LIMITS} from '../lib/short.mjs';
import {motionPose} from '../lib/vrma.mjs';
import {pendingClaims, scriptKey} from '../public/short-direct.mjs';
import {tempDir, fakeGlb, FAKE_ENV, SAMPLE_VRMA, startServer} from './helpers.mjs';

const ENV = {...FAKE_ENV, CHARASTA_FAKE_VOICEVOX: '1', CHARASTA_FAKE_ELEVENLABS: '1', CHARASTA_FAKE_DRAFT: '1', CHARASTA_CLAUDE: 'Z:/no-such/claude.exe'};
const A = {name: '凛', charId: 'c1', verId: 'v1', provider: 'voicevox', speaker: 8, speakerName: 'つむぎ', speed: 1.25}, B = {...A, name: 'ひより', charId: 'c2'};
const OPTIONS = {stages: [{id: 'classroom', label: '教室'}, {id: 'concert', label: 'コンサート'}], motions: [{id: 'talk-stand', label: '話す 立ち', seconds: 8, speak: true}, {id: 'act-offer', label: '手紙を差し出す', seconds: 4, speak: true}, {id: 'act-lean', label: '身を乗り出す', seconds: 3, speak: false}]};

async function server(env = ENV) {
  const stage = await tempDir();
  await fs.mkdir(path.join(stage, 'stages'));
  await fs.writeFile(path.join(stage, 'stages', 'catalog.json'), JSON.stringify([{id: 'classroom', label: '教室'}, {id: 'concert', label: 'コンサート'}]));
  await fs.writeFile(path.join(stage, 'stages', 'classroom.py'), '# 1');
  const s = await startServer({stageStudioDir: stage, env}), lib = s.server.jobs.lib;
  for (const id of ['c1', 'c2']) { await lib.createCharacter({id, name: id}); await lib.importVersion({charId: id, id: 'v1', data: fakeGlb({id})}); }
  for (const id of ['talk-stand', 'act-still', 'vrma-01']) await lib.importMotion({id, data: await fs.readFile(SAMPLE_VRMA), label: id, license: {holder: 'h', summary: '改変可', redistribution: false}});
  const api = async (method, url, body) => {
    const r = await fetch(s.base + url, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)});
    return {status: r.status, json: await r.json().catch(() => null)};
  };
  return {...s, lib, api, jobs: s.server.jobs};
}
const finish = async (s, body) => {
  const r = await s.api('POST', '/api/jobs', {type: 'short-draft', ...body});
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await s.jobs.whenIdle();
  return (await s.api('GET', '/api/jobs/' + r.json.id)).json;
};
const close = s => s.close();
const SAMPLE_VRMA_BYTES = await fs.readFile(SAMPLE_VRMA);

test('claude の引数: 文は載せず、許すのは WebSearch と WebFetch だけ。ドラマはツールなし', () => {
  const web = draftArgs('sonnet', 'SYS', true), plain = draftArgs('sonnet', 'SYS', false);
  assert.deepEqual(web.slice(web.indexOf('--tools'), web.indexOf('--tools') + 2), ['--tools', 'WebSearch,WebFetch']);
  assert.deepEqual(web.slice(web.indexOf('--allowedTools'), web.indexOf('--allowedTools') + 2), ['--allowedTools', 'WebSearch,WebFetch']);
  assert.ok(!/Bash|Write|Edit|PowerShell|Read/.test(web.join(' ')));
  assert.deepEqual(plain.slice(plain.indexOf('--tools'), plain.indexOf('--tools') + 2), ['--tools', '']);
  assert.ok(!plain.includes('--allowedTools'));
  for (const a of [web, plain]) for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(a.includes(flag));
});

test('プロンプト: 今のライブラリの一覧と基準が入り、テーマは標準入力の文だけに入る', () => {
  const input = {style: 'trivia', theme: 'ペンギンの秘密', note: '', seconds: 20, cast: [A]}, prompt = draftPrompt(input, OPTIONS), system = draftSystem('trivia', 1);
  for (const w of ['ペンギンの秘密', 'talk-stand', 'classroom', 'talk_bust', 'heartbeat', 'surprised', 'whispers']) assert.ok(prompt.includes(w), w);
  assert.ok(!system.includes('ペンギンの秘密'));
  assert.ok(!prompt.includes('close_who'), '1 人の一覧に話す人のカメラを出さない');
  assert.ok(!/follow:|crying|terrified/.test(prompt), '定型の誘導と読みが崩れやすいタグは出さない');
  assert.ok(!prompt.split('表情(expression)')[1].split('印の表情')[0].includes('happy'), '目を閉じる表情はカットの表情に出さない');
  for (const w of ['問い', '[語]', 'figureNote', 'フォローして', 'WebSearch']) assert.ok(system.includes(w), w);
  const drama = draftSystem('drama', 2);
  for (const w of ['反転', '引き', '3〜7 秒', 'hush', '語尾', 'serial']) assert.ok(drama.includes(w), w);
  assert.ok(!drama.includes('WebSearch'));
  const next = draftPrompt({...input, style: 'drama', cast: [A, B], previous: {title: '第一話', episode: 2, serial: {name: '連載', next: '差出人を探す'}, cuts: [{who: '凛', text: '[これ]は？', telop: ''}]}}, OPTIONS);
  assert.ok(next.includes('第 2 話') && next.includes('差出人を探す') && next.includes('凛: これは？') && next.includes('全部知っている'), '手紙の文も渡す');
  assert.ok(drama.includes('"serial"') && draftSystem('drama', 1).includes('"serial"'), '1 人のドラマにも連載の形を渡す');
});

test('出典: 検索の結果に出た URL と開けた URL だけを認める。AI が書いた URL は落とす', () => {
  const line = o => JSON.stringify(o), out = [
    line({type: 'assistant', message: {content: [{type: 'tool_use', id: 's1', name: 'WebSearch', input: {query: 'x'}}, {type: 'tool_use', id: 'f1', name: 'WebFetch', input: {url: 'https://b.example/page#top'}}, {type: 'tool_use', id: 'f2', name: 'WebFetch', input: {url: 'https://c.example/404'}}]}}),
    line({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 's1', content: 'Links: [{"title":"A","url":"https://a.example/x"}]'}, {type: 'tool_result', tool_use_id: 'f1', content: 'see https://d.example/inside'}, {type: 'tool_result', tool_use_id: 'f2', is_error: true, content: 'failed'}]}}),
    line({type: 'result', subtype: 'success', result: '{"title":"t"}'})].join('\n');
  const {seen, reply, searches, fetches} = readDraftStream(out);
  assert.equal(reply, '{"title":"t"}');
  assert.deepEqual([searches, fetches], [1, 2]);
  assert.deepEqual([...seen].sort(), ['https://a.example/x', 'https://b.example/page']);
  const claims = vetClaims([{text: 'a', sources: [{url: 'https://a.example/x/', title: 'A'}, {url: 'https://made.up/x', title: 'B'}, {url: 'https://c.example/404'}]}, {text: 'b'}], seen);
  assert.deepEqual(claims[0].sources.map(x => x.url), ['https://a.example/x/']);
  assert.deepEqual(claims[1].sources, []);
  assert.deepEqual(pendingClaims({claims}).map(c => c.text), ['b']);
  assert.throws(() => readDraftStream('not json'), /読めない/);
  assert.throws(() => readDraftStream(line({type: 'result', is_error: true, result: 'Not logged in'})), /Not logged in/);
});

test('下書きの確かめ: 一覧に無いものは errors、字数と長さは warnings。出演者は入力から取り、答えの cast は使わない', () => {
  assert.deepEqual(parseDraft('前置き {"a":1} 後ろ'), {a: 1});
  assert.throws(() => parseDraft('なし'), /JSON ではない/);
  assert.deepEqual(longClauses('[3つ|surprised]の心臓、一二三四五六七八九十一。'), ['一二三四五六七八九十一']);
  const input = {style: 'trivia', seconds: 20, cast: [A]}, cut = {stage: 'classroom', camera: 'talk_bust', motionId: 'talk-stand', expression: 'neutral', text: 'これ、知ってた？'};
  const body = draftBody({title: 't', cast: [{name: '偽物'}], claims: [{text: '主張'}], cuts: [cut, {...cut, stage: 'mars', camera: 'close_who', motionId: 'vrma-01', text: '[語|shocked]フォローしてね、一二三四五六七八九十一', tone: 'crying'}]}, input, new Set());
  assert.deepEqual(body.cast, [A]);
  const {errors, warnings} = checkDraft(body, input, OPTIONS);
  for (const re of [/シーン "mars"/, /カメラ "close_who"/, /動き "vrma-01"/, /印の表情 shocked/]) assert.ok(errors.some(e => re.test(e)), String(re));
  for (const re of [/定型/, /11 字/, /全体が/, /図の提案/]) assert.ok(warnings.some(e => re.test(e)), String(re));
  assert.equal(body.cuts[1].tone, '', 'VOICEVOX の声には演じ方を残さない');
  const voiced = draftBody({title: 't', cuts: [{...cut, tone: 'crying'}]}, {...input, cast: [{...A, provider: 'elevenlabs'}]}, new Set());
  assert.ok(checkDraft(voiced, input, OPTIONS).errors.some(e => /演じ方 crying/.test(e)));
  const drama = {style: 'drama', seconds: 25, cast: [A, B]}, two = draftBody({title: 't', cuts: [{stage: 'classroom', camera: 'prop_close', who: '誰か', text: '手紙。', actors: [{motionId: 'act-offer', expression: 'cold'}, {absent: true}]}]}, drama, new Set());
  assert.equal(two.cuts[0].actors[0].turn, 30, '差し出す動きは相手の方へ足す');
  const eleven = [{...A, provider: 'elevenlabs'}, {...B, provider: 'elevenlabs'}], line = {title: 't', serial: {synopsis: 's', next: 'n'}, cuts: [{stage: 'classroom', camera: 'bust_who', who: A.name, text: 'まだ。'}]};
  assert.equal(draftBody(line, {...drama, cast: eleven}, new Set()).dialogue, true, '新しい話は会話の経路');
  const next = previous => draftBody(line, {...drama, cast: eleven, previous: {id: 'sprev', title: '前', episode: 2, serial: {name: '前', episode: 1}, cuts: [], dialogue: previous}}, new Set());
  assert.equal(next(false).dialogue, undefined, '1 文ずつの前の話の続きは 1 文ずつのまま');
  assert.equal(next(true).dialogue, true, '会話の経路の前の話の続きは会話の経路');
  assert.equal(two.cuts[0].motionId, 'act-offer');
  const shoulder = draftBody({title: 't', cuts: [{camera: 'over_shoulder', actors: [{motionId: 'act-offer', prop: 'letter'}, {motionId: 'talk-stand'}]}, {camera: 'bust_who', actors: [{motionId: 'act-offer', prop: 'letter'}, {absent: true}]}]}, drama, new Set());
  assert.deepEqual(shoulder.cuts.map(c => c.actors[0].prop), [undefined, 'letter'], '肩越しは手紙を外す');
  const found = checkDraft(two, drama, OPTIONS);
  assert.ok(found.errors.some(e => /話す人 "誰か"/.test(e)) && found.errors.some(e => /手紙を持つ人/.test(e)) && found.errors.some(e => /serial/.test(e)));
});

test('雑学の下書き: 新しいショートになり、見ていない URL の主張は要確認で本番を止める。試しは止めない。確認すると通る', async () => {
  const s = await server();
  try {
    const old = (await s.api('POST', '/api/shorts', {title: '既存', charId: 'c1', cuts: []})).json;
    const job = await finish(s, {theme: 'ペンギン', style: 'trivia', seconds: 20, cast: [A]});
    assert.equal(job.state, 'done', job.error);
    assert.deepEqual([job.result.claims, job.result.needsCheck, job.result.runs], [2, 1, 1], JSON.stringify(job.result.warnings));
    const short = (await s.api('GET', '/api/shorts/' + job.result.shortId)).json;
    assert.notEqual(short.id, old.id);
    assert.equal(short.cast[0].speaker, 8);
    assert.equal(short.cuts[1].figureNote, '丸い図');
    assert.equal(short.claims[0].sources[0].url, 'https://example.org/seen');
    assert.deepEqual(short.claims[1].sources, []);
    assert.equal((await s.api('GET', '/api/shorts/' + old.id)).json.updatedAt, old.updatedAt, '既存のショートを変えない');
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short', shortId: short.id, quality: 'final'})).status, 409);
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short', shortId: short.id, quality: 'preview'})).status, 201);
    await s.jobs.whenIdle();
    short.claims[1].confirmed = true;
    const put = await s.api('PUT', '/api/shorts/' + short.id, short);
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(put.json.claims[1].confirmed, true);
    assert.equal(put.json.draft.theme, 'ペンギン');
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short', shortId: short.id, quality: 'final'})).status, 201);
    await s.jobs.whenIdle();
    assert.equal((await s.api('PUT', '/api/shorts/' + short.id, {...short, claims: [{text: 'x', sources: [{url: 'javascript:alert(1)'}]}]})).status, 400);
  } finally { await close(s); }
});

test('直させる経路: 不正な JSON は 1 回だけ直させる。直してもだめなら失敗。warnings は残して保存する。claude の失敗は理由つき', async () => {
  for (const [mode, state, runs] of [['bad-json', 'done', 2], ['bad', 'failed', 2], ['warn', 'done', 2], ['claude-fail', 'failed', 1]]) {
    const s = await server({...ENV, CHARASTA_FAKE_DRAFT: mode});
    try {
      const job = await finish(s, {theme: 'ペンギン', style: 'trivia', cast: [A]});
      assert.equal(job.state, state, `${mode}: ${job.error}`);
      if (mode === 'bad') assert.match(job.error, /JSON ではない/);
      if (mode === 'claude-fail') assert.match(job.error, /claude が使えない/);
      else if (mode === 'warn') { assert.equal(job.result.runs, runs); assert.ok(job.result.warnings.some(w => /字ある/.test(w))); assert.ok((await s.api('GET', '/api/shorts/' + job.result.shortId)).json.draft.warnings.length); }
      assert.equal((await s.api('GET', '/api/shorts')).json.length, state === 'done' ? 1 : 0);
    } finally { await close(s); }
  }
});

test('確かめたあとに台本を直すと本番を止める。強調の印の直しでは止めない。確認すると通る。主張を消せる', async () => {
  assert.equal(scriptKey([{text: '[語]です', telop: 'a'}]), scriptKey([{text: '語です', telop: 'a'}]));
  assert.notEqual(scriptKey([{text: '語です', telop: 'a'}]), scriptKey([{text: '語です', telop: 'b'}]));
  const s = await server();
  try {
    const job = await finish(s, {theme: 'ペンギン', style: 'trivia', seconds: 20, cast: [A]}), id = job.result.shortId;
    const short = (await s.api('GET', '/api/shorts/' + id)).json;
    short.claims[1].confirmed = true;
    await s.api('PUT', '/api/shorts/' + id, short);
    const edited = {...short, cuts: short.cuts.map((c, i) => (i ? c : {...c, telop: '別の数字 200'}))};
    await s.api('PUT', '/api/shorts/' + id, edited);
    const blocked = await s.api('POST', '/api/jobs', {type: 'short', shortId: id, quality: 'final'});
    assert.equal(blocked.status, 409);
    assert.match(blocked.json.error, /台本が変わった/);
    assert.equal(pendingClaims(edited).length, 2);
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short', shortId: id, quality: 'preview'})).status, 201);
    await s.jobs.whenIdle();
    const none = await s.api('PUT', '/api/shorts/' + id, {...edited, claims: []});
    assert.deepEqual(none.json.claims, []);
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short', shortId: id, quality: 'final'})).status, 409, '主張を消しても台本の確認は要る');
    await s.api('PUT', '/api/shorts/' + id, {...edited, claims: edited.claims.slice(0, 1), scriptKey: scriptKey(edited.cuts)});
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short', shortId: id, quality: 'final'})).status, 201);
    await s.jobs.whenIdle();
  } finally { await close(s); }
});

test('検索なしの直しで足した主張は出典なしになる。直しの claude が失敗しても 1 回目を保存する。text が文字列でなければ直させる', async () => {
  const added = await server({...ENV, CHARASTA_FAKE_DRAFT: 'add-claim'});
  try {
    const job = await finish(added, {theme: 'ペンギン', style: 'trivia', seconds: 20, cast: [A]});
    assert.equal(job.state, 'done', job.error);
    const short = (await added.api('GET', '/api/shorts/' + job.result.shortId)).json;
    assert.deepEqual(short.claims.map(c => c.sources.length), [1, 0, 0]);
    assert.equal(short.claims[2].text, '直しで足した主張');
  } finally { await close(added); }
  const fails = await server({...ENV, CHARASTA_FAKE_DRAFT: 'fix-fail'});
  try {
    const job = await finish(fails, {theme: 'ペンギン', style: 'trivia', seconds: 20, cast: [A]});
    assert.equal(job.state, 'done', job.error);
    assert.ok(job.result.warnings.length);
    assert.match(await fs.readFile(path.join(fails.libraryDir, 'jobs', job.id + '.log'), 'utf8'), /1 回目を使う: 試しの動き: 直しの claude が失敗した/);
  } finally { await close(fails); }
  const bad = await server({...ENV, CHARASTA_FAKE_DRAFT: 'bad-text'});
  try {
    const job = await finish(bad, {theme: 'ペンギン', style: 'trivia', seconds: 20, cast: [A]});
    assert.equal(job.state, 'failed');
    assert.equal(job.step, '基準から外れた所を直させる', '読めない答えも直させてから失敗にする');
  } finally { await close(bad); }
});

test('話すカットの動き: 顔が下を向く動きは話す人に使えず、一覧も分かれる。笑顔は目を開けた表情に直す。問いかけの [語|happy] は外す', () => {
  assert.ok(Number.isFinite(motionPose(SAMPLE_VRMA_BYTES).headDown));
  const prompt = draftPrompt({style: 'drama', theme: 'x', note: '', seconds: 25, cast: [A, B]}, OPTIONS);
  assert.ok(prompt.indexOf('act-lean') > prompt.indexOf('聞く人だけの動き'));
  assert.ok(!draftPrompt({style: 'trivia', theme: 'x', note: '', seconds: 20, cast: [A]}, OPTIONS).includes('act-lean'));
  assert.ok(!/act-nod|act-still|act-lean/.test(draftSystem('drama', 2) + draftSystem('trivia', 1)), '動きの名前を固定で書かない');
  const input = {style: 'trivia', seconds: 20, cast: [A]}, cut = {stage: 'classroom', camera: 'talk_bust', motionId: 'act-lean', expression: 'happy', text: '何[メートル|happy]で引き返す？'};
  const body = draftBody({title: 't', claims: [{text: 'x'}], cuts: [cut, {...cut, stage: 'concert', motionId: 'talk-stand', text: 'それは[高い|happy]。'}]}, input, new Set());
  assert.deepEqual(body.cuts.map(c => c.expression), ['neutral', 'neutral']);
  assert.equal(body.cuts[0].text, '何[メートル]で引き返す？');
  assert.equal(body.cuts[1].text, 'それは[高い|happy]。', '短い区間の笑顔は残す');
  const found = checkDraft(body, input, OPTIONS);
  assert.ok(found.errors.some(e => /カット 1: 動き act-lean は話す人/.test(e)));
  assert.ok(found.warnings.includes('シーンが 1 つではない'));
  const drama = {style: 'drama', seconds: 25, cast: [A, B]}, two = draftBody({title: 't', serial: {synopsis: 'a', next: 'b'}, cuts: [{stage: 'classroom', camera: 'close_who', who: '凛', text: 'それ。', actors: [{motionId: 'talk-stand'}, {motionId: 'act-lean'}]}]}, drama, new Set());
  assert.ok(!checkDraft(two, drama, OPTIONS).errors.some(e => /話す人と撮られる人/.test(e)), '聞く人には使える');
});

test('長さの上限はカット番号つきの errors になり、プロンプトにも書く。シリーズ帯は名前を切ってから話数を足す', () => {
  assert.ok(draftSystem('drama', 2).includes(`synopsis ${LIMITS.synopsis}`));
  const input = {style: 'drama', seconds: 25, cast: [A, B]}, long = 'あ'.repeat(LIMITS.text + 1);
  const body = draftBody({title: 't', serial: {synopsis: 'あ'.repeat(LIMITS.synopsis + 1), next: 'b', threads: Array(LIMITS.threads + 1).fill('x'), characters: [{name: 'あ'.repeat(13), note: 'x'}]}, cuts: [{stage: 'classroom', camera: 'close_who', who: '凛', text: 'それ。', actors: [{motionId: 'talk-stand'}, {absent: true}]}, {stage: 'classroom', camera: 'bust_who', who: '凛', text: long, telop: 'い'.repeat(LIMITS.telop + 1), figureNote: 'う'.repeat(LIMITS.figureNote + 1), actors: [{motionId: 'talk-stand'}, {absent: true}]}]}, input, new Set());
  const {errors} = checkDraft(body, input, OPTIONS);
  for (const re of [/カット 2 の text/, /カット 2 の telop/, /synopsis/, /threads/, /登場人物 1 の name/]) assert.ok(errors.some(e => re.test(e)), String(re));
  const solo = {style: 'trivia', seconds: 20, cast: [A]};
  assert.ok(checkDraft(draftBody({title: 't', claims: [{text: 'x'}], cuts: [{stage: 'classroom', camera: 'talk_bust', motionId: 'talk-stand', text: 'それ？', figureNote: 'う'.repeat(LIMITS.figureNote + 1)}]}, solo, new Set()), solo, OPTIONS).errors.some(e => /カット 1 の figureNote/.test(e)));
  const name = 'あ'.repeat(30), next = draftBody({title: '題', serial: {synopsis: 'a', next: 'b'}, cuts: []}, {...input, previous: {id: 'p', episode: 12, title: name, serial: {name}, defaultBgm: true, ambience: ''}}, new Set());
  assert.equal(next.series, `${'あ'.repeat(15)} 第12話`);
  const titled = draftBody({title: '手紙 第2話 最後の一行', cuts: [{figureNote: '演出の指示'}]}, {...input, previous: {id: 'p', episode: 2, title: '手紙', serial: {name: '手紙'}, defaultBgm: true, ambience: ''}}, new Set());
  assert.equal(titled.title, '手紙 第2話 最後の一行', '答えの題に連載の名前があっても重ねない');
  assert.equal(titled.cuts[0].figureNote, '', 'ドラマに図の説明を残さない');
  assert.equal([...next.series].length, 20);
});

test('入力の確かめ: テーマ、型、長さ、出演者、ドラマの名前', async () => {
  const s = await server();
  try {
    for (const body of [{cast: [A]}, {theme: 'x', cast: []}, {theme: 'x', style: 'nope', cast: [A]}, {theme: 'x', seconds: 5, cast: [A]}, {theme: 'x', style: 'drama', cast: [A, {...B, name: ''}]}, {theme: 'x', cast: [A, {...B, name: A.name}]}, {theme: 'x', cast: [A, B, {...A, name: 'c'}, {...A, name: 'd'}]}, {theme: 'x', cast: [{...A, charId: 'nobody'}]}, {fromShortId: 'nothing'}]) assert.notEqual((await s.api('POST', '/api/jobs', {type: 'short-draft', ...body})).status, 201, JSON.stringify(body));
    // 前の話の出演者、版、BGM が消えていたら、話数が上限なら、積む時点で断る
    const gone = (await s.api('POST', '/api/shorts', {title: '話', style: 'drama', cast: [A, B], cuts: []})).json;
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short-draft', fromShortId: gone.id})).status, 201);
    await s.jobs.whenIdle();
    await s.lib.saveShort(gone.id, {...gone, cast: [{...A, verId: 'v9'}, B]});
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short-draft', fromShortId: gone.id})).status, 404);
    await s.lib.saveShort(gone.id, {...gone, audioId: 'nothing'});
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short-draft', fromShortId: gone.id})).status, 404);
    await s.lib.saveShort(gone.id, {...gone, serial: {episode: 999}});
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short-draft', fromShortId: gone.id})).status, 400);
    const trivia = (await s.api('POST', '/api/shorts', {title: '雑学', charId: 'c1', cuts: []})).json;
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short-draft', fromShortId: trivia.id})).status, 400);
  } finally { await close(s); }
});

test('連載: ドラマの下書きは連載を持ち、次の話は出演者、声、シーンを引き継ぐ新しいショートになる。前の話は変えない', async () => {
  const s = await server();
  try {
    const job = await finish(s, {theme: '手紙', style: 'drama', seconds: 25, cast: [A, {...B, provider: 'elevenlabs', voiceId: 'fake-voice', voiceName: '試しの声'}]});
    assert.equal(job.state, 'done', job.error);
    const first = (await s.api('GET', '/api/shorts/' + job.result.shortId)).json;
    assert.deepEqual([first.serial.name, first.serial.episode, first.serial.previousId, first.claims], ['試しの連載', 1, '', undefined]);
    assert.equal(first.cuts[0].actors.length, 2);
    first.serial.next = '人が直した方向';
    first.cuts[0].stage = 'concert';
    await s.api('PUT', '/api/shorts/' + first.id, first);
    const stamp = (await s.api('GET', '/api/shorts/' + first.id)).json.updatedAt;
    const nextJob = await finish(s, {fromShortId: first.id, note: '差出人を出す', cast: [A]});
    assert.equal(nextJob.state, 'done', nextJob.error);
    const prompt = await fs.readFile(path.join(s.libraryDir, 'jobs', nextJob.id, 'prompt.txt'), 'utf8');
    assert.ok(prompt.includes('人が直した方向') && prompt.includes('差出人を出す') && prompt.includes('これ、誰の字……'));
    const second = (await s.api('GET', '/api/shorts/' + nextJob.result.shortId)).json;
    assert.notEqual(second.id, first.id);
    assert.deepEqual([second.serial.episode, second.serial.previousId, second.serial.name], [2, first.id, '試しの連載']);
    assert.deepEqual(second.cast, first.cast, '出演者と声は前の話から取り、入力の cast は使わない');
    assert.ok(second.cuts.every(c => first.cuts.some(x => x.stage === c.stage)), 'シーンは前の話のものだけ');
    assert.equal(second.ambience, first.ambience);
    assert.equal(second.cuts[0].telop, '', '上の帯と重ねない');
    assert.match(second.title, /試しの連載 第2話/);
    assert.equal(second.series, '試しの連載 第2話');
    assert.equal((await s.api('GET', '/api/shorts/' + first.id)).json.updatedAt, stamp, '前の話を変えない');

    // 連載の無い古いドラマからも作れる
    const old = (await s.api('POST', '/api/shorts', {title: '古い話', style: 'drama', cast: [A, B], cuts: [{stage: 'classroom', motionId: 'talk-stand', who: '凛', text: 'それ。'}]})).json;
    const oldNext = await finish(s, {fromShortId: old.id});
    assert.equal(oldNext.state, 'done', oldNext.error);
    const made = (await s.api('GET', '/api/shorts/' + oldNext.result.shortId)).json;
    assert.deepEqual([made.serial.name, made.serial.episode, made.serial.previousId], ['古い話', 2, old.id]);

    // 1 人の古いドラマからも作れる
    const solo = (await s.api('POST', '/api/shorts', {title: '1 人の話', style: 'drama', charId: 'c1', cuts: [{stage: 'classroom', motionId: 'talk-stand', text: 'それ。'}]})).json;
    const soloNext = await finish(s, {fromShortId: solo.id});
    assert.equal(soloNext.state, 'done', soloNext.error);
    assert.equal((await s.api('GET', '/api/shorts/' + soloNext.result.shortId)).json.serial.episode, 2);

    // 音声ファイルの BGM も引き継ぐ
    const audio = await s.lib.importAudio({name: 'bgm.mp3', data: Buffer.from('x')});
    const withBgm = (await s.api('POST', '/api/shorts', {title: 'BGM の話', style: 'drama', charId: 'c1', audioId: audio.id, audioSummary: '自作', audioPublic: true, cuts: [{stage: 'classroom', motionId: 'talk-stand', text: 'それ。'}]})).json;
    const bgmNext = await finish(s, {fromShortId: withBgm.id});
    const bgm = (await s.api('GET', '/api/shorts/' + bgmNext.result.shortId)).json;
    assert.deepEqual([bgm.audioId, bgm.audioSummary, bgm.audioPublic], [audio.id, '自作', true]);
  } finally { await close(s); }
});

// ---- Gemini の答えの取り込み ----
const FILL = '一回目の話、二回目の話、三回目の話、四回目の話、五回目の話、';
const CUT = {stage: 'classroom', camera: 'talk_bust', motionId: 'talk-stand', expression: 'neutral', telop: ''};
const answer = (o = {}) => ({title: 'ペンギンの話', ambience: '', cuts: [{...CUT, text: 'これ、知ってた？' + FILL}, {...CUT, text: 'なんと[100回|surprised]も鳴く、' + FILL, figureNote: '丸い図'}, {...CUT, text: 'しかも理由がある。' + FILL}, {...CUT, text: 'じゃあ、' + FILL + '理由は？'}],
  claims: [{text: '100 回鳴く', confidence: 'high', query: '試し', sources: [{url: 'https://example.org/seen', title: '見た出典'}]}, {text: 'Gemini の URL の主張', confidence: 'high', query: '試し', sources: [{url: 'https://example.org/gemini-only', title: '見ていない URL'}]}], ...o});
const TRIVIA_REQ = {theme: 'ペンギン', style: 'trivia', seconds: 20, cast: [A]};

test('依頼文: claude と同じ基準と今の一覧が入り、Gemini 用の調べ方になる', async () => {
  const s = await server();
  try {
    const {status, json} = await s.api('POST', '/api/short-draft/prompt', TRIVIA_REQ);
    assert.equal(status, 200);
    for (const w of ['ペンギン', 'talk-stand', 'classroom', 'talk_bust', 'surprised', '掘り下げます', '"cuts"', 'Google 検索']) assert.ok(json.prompt.includes(w), w);
    assert.ok(!json.prompt.includes('WebSearch'));
    assert.equal((await s.api('POST', '/api/short-draft/prompt', {...TRIVIA_REQ, theme: ''})).status, 400);
    assert.equal((await s.api('GET', '/api/short-draft/prompt')).status, 405);
  } finally { await close(s); }
});

test('貼り付けの形: コードの囲み、前後の説明文、括弧を含む説明文でも読める', () => {
  const j = JSON.stringify(answer());
  for (const text of [j, '```json\n' + j + '\n```', 'はい、作りました。\n```\n' + j + '\n```\n以上です。{補足} も書きました', '例 {"a":1} のあとの本体: ' + j, '\ufeff' + j]) assert.equal(parseDraft(text).title, 'ペンギンの話', text.slice(0, 20));
  assert.throws(() => parseDraft('{"title": "途中で切れた'), /JSON ではない/);
  assert.throws(() => parseDraft('JSON がありません'), /JSON ではない/);
});

test('取り込み: 雑学は別に確かめ、検索で見た URL だけが残る。出典の無い主張は要確認で本番を止める。作り手を記録する。答えの確認済みは使わない', async () => {
  const s = await server();
  try {
    const before = (await s.api('GET', '/api/shorts')).json.length, confirmed = answer();
    confirmed.claims[1].confirmed = true;
    const r = await s.api('POST', '/api/short-draft/import', {...TRIVIA_REQ, answer: 'はい。\n```json\n' + JSON.stringify(confirmed) + '\n```\nどうぞ。'});
    assert.equal(r.status, 201, JSON.stringify(r.json));
    await s.jobs.whenIdle();
    const job = (await s.api('GET', '/api/jobs/' + r.json.id)).json;
    assert.equal(job.state, 'done', job.error);
    assert.deepEqual([job.result.draftBy, job.result.needsCheck, job.result.runs], ['gemini', 1, 1]);
    const short = (await s.api('GET', '/api/shorts/' + job.result.shortId)).json;
    assert.equal(short.draftBy, 'gemini');
    assert.equal(short.draft.model, 'gemini');
    assert.deepEqual(short.claims.map(c => [c.sources.length, c.confirmed]), [[1, false], [0, false]]);
    assert.equal((await s.api('GET', '/api/shorts')).json.length, before + 1);
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short', shortId: short.id, quality: 'final'})).status, 409);
    assert.equal((await s.api('PUT', '/api/shorts/' + short.id, short)).json.draftBy, 'gemini');
  } finally { await close(s); }
});

test('確かめの claude が失敗しても取り込み、主張は全部要確認になる', async () => {
  const s = await server({...ENV, CHARASTA_FAKE_DRAFT: 'check-fail'});
  try {
    const r = await s.api('POST', '/api/short-draft/import', {...TRIVIA_REQ, answer: JSON.stringify(answer())});
    await s.jobs.whenIdle();
    const job = (await s.api('GET', '/api/jobs/' + r.json.id)).json;
    assert.equal(job.state, 'done', job.error);
    assert.equal(job.result.needsCheck, 2);
    assert.ok(job.result.warnings.some(w => /確かめられなかった/.test(w)));
    const short = (await s.api('GET', '/api/shorts/' + job.result.shortId)).json;
    assert.equal(short.draft.checkedBy, '');
    assert.deepEqual(short.claims.map(c => c.confidence), ['low', 'low']);
  } finally { await close(s); }
});

test('取り込めない答え: 理由と直しの依頼文を返し、ショートもジョブも作らない', async () => {
  const s = await server();
  try {
    const cases = [['JSON ではありません', /JSON ではない/], ['{"title": "途中', /JSON ではない/],
      [JSON.stringify(answer({cuts: [{...CUT, motionId: 'vrma-01', text: 'x？'}]})), /動き "vrma-01" は一覧に無い/],
      [JSON.stringify(answer({cuts: [{...CUT, stage: 'mars', text: 'x？'}]})), /シーン "mars"/],
      [JSON.stringify(answer({cuts: [{...CUT, text: 'あ'.repeat(LIMITS.text + 1)}]})), /カット 1 の text/],
      [JSON.stringify(answer({title: 'あ'.repeat(LIMITS.title + 1), cuts: [{...CUT, text: 'x？'}]})), null],
      [JSON.stringify(answer({cuts: [{...CUT, text: '<script>alert(1)</script>？'}]})), /カット 1 の text に HTML/],
      [JSON.stringify(answer({cuts: [{...CUT, text: 'x？', telop: '<b>太字</b>'}]})), /カット 1 の telop に HTML/],
      [JSON.stringify(answer({claims: [{text: '<img src=x onerror=y>'}]})), /主張 1 に HTML/],
      [JSON.stringify(answer({claims: []})), /claims が空/], [JSON.stringify(answer({cuts: [{...CUT, text: 123}]})), /./]];
    for (const [text, re] of cases) {
      const r = await s.api('POST', '/api/short-draft/import', {...TRIVIA_REQ, answer: text});
      if (!re) { assert.equal(r.status, 201, '題は上限で切る'); await s.jobs.whenIdle(); continue; }
      assert.equal(r.status, 422, text.slice(0, 60));
      assert.ok(r.json.errors.some(e => re.test(e)), JSON.stringify(r.json.errors));
      assert.ok(r.json.fixPrompt.includes(r.json.errors[0]) && /全体を書き直して/.test(r.json.fixPrompt));
    }
    assert.equal((await s.api('POST', '/api/short-draft/import', {...TRIVIA_REQ, answer: ''})).status, 400);
    assert.equal((await s.api('POST', '/api/short-draft/import', {...TRIVIA_REQ, answer: 'あ'.repeat(60001)})).status, 400);
  } finally { await close(s); }
});

test('ジョブへ直接積んだ不正な答えは理由つきで失敗する。作り手の値を確かめる', async () => {
  const s = await server();
  try {
    const job = await finish(s, {...TRIVIA_REQ, source: 'gemini', answer: 'だめな答え'});
    assert.equal(job.state, 'failed');
    assert.match(job.error, /Gemini の答えを取り込めなかった/);
    assert.equal((await s.api('POST', '/api/jobs', {type: 'short-draft', ...TRIVIA_REQ, source: 'other'})).status, 400);
    const empty = await finish(s, {...TRIVIA_REQ, source: 'gemini'});
    assert.match(empty.error, /答えが無い/);
  } finally { await close(s); }
});

test('Gemini のドラマは serial を取り込み、確かめの claude を呼ばない。次の話も同じ流れで引き継ぐ', async () => {
  const s = await server();
  try {
    const cut = (who, text) => ({stage: 'classroom', camera: 'close_who', who, text, telop: '', seconds: 5, actors: [{motionId: 'talk-stand', expression: 'worried'}, {motionId: 'talk-stand', expression: 'tense'}]});
    const reply = name => JSON.stringify({title: '手紙', ambience: 'wind', cuts: [cut('凛', 'これ、誰の字……'), cut('ひより', 'まだ言えない。'), cut('凛', 'それって、'), cut('ひより', '姉の字じゃ')], serial: {name, characters: [{name: '凛', note: '高校生'}], synopsis: 'あらすじ', threads: ['差出人'], next: '差出人を探す'}});
    const first = await s.api('POST', '/api/short-draft/import', {theme: '手紙', style: 'drama', seconds: 25, cast: [A, B], answer: reply('手紙の連載')});
    assert.equal(first.status, 201, JSON.stringify(first.json));
    await s.jobs.whenIdle();
    const job = (await s.api('GET', '/api/jobs/' + first.json.id)).json;
    assert.deepEqual([job.state, job.result.runs, job.result.draftBy], ['done', 0, 'gemini'], job.error);
    const one = (await s.api('GET', '/api/shorts/' + job.result.shortId)).json;
    assert.equal(one.serial.name, '手紙の連載');
    const prompt = (await s.api('POST', '/api/short-draft/prompt', {fromShortId: one.id})).json.prompt;
    assert.ok(prompt.includes('第 2 話') && prompt.includes('差出人を探す') && prompt.includes('これ、誰の字'));
    const second = await s.api('POST', '/api/short-draft/import', {fromShortId: one.id, answer: reply('別の名前')});
    assert.equal(second.status, 201, JSON.stringify(second.json));
    await s.jobs.whenIdle();
    const made = (await s.api('GET', '/api/shorts/' + (await s.api('GET', '/api/jobs/' + second.json.id)).json.result.shortId)).json;
    assert.deepEqual([made.serial.name, made.serial.episode, made.serial.previousId, made.draftBy], ['手紙の連載', 2, one.id, 'gemini']);
    assert.deepEqual(made.cast, one.cast);
  } finally { await close(s); }
});

test('確かめ役の答え: 支えられない主張と検索で見ていない URL は出典にしない。台本はデータとして渡す', () => {
  const seen = new Set(['https://a.example/x']), mine = [{text: 'a', query: 'qa'}, {text: 'b'}, {text: 'c'}, {text: '省かれた', query: 'qd'}];
  const reply = JSON.stringify({claims: [{id: 0, text: '言い換え', confidence: 'high', query: 'q', supported: true, sources: [{url: 'https://a.example/x', title: 'A'}, {url: 'https://made.up/y', title: 'B'}]}, {id: 1, text: 'b', confidence: 'high', supported: false, sources: [{url: 'https://a.example/x'}]}, {id: 2, text: 'c', confidence: 'high', sources: [{url: 'https://a.example/x'}]}, {id: null, text: '足した主張', confidence: 'medium', query: 'q2', supported: true, sources: [{url: 'https://a.example/x'}]}, {id: 99, text: '番号が外れた主張', supported: false}]});
  assert.deepEqual(readFactCheck(reply, seen, mine).map(c => [c.text, c.confidence, c.sources.length]), [['a', 'high', 1], ['b', 'low', 0], ['c', 'low', 0], ['省かれた', 'low', 0], ['足した主張', 'medium', 1], ['番号が外れた主張', 'low', 0]]);
  assert.equal(readFactCheck(reply, seen, mine)[3].query, 'qd');
  assert.ok(pendingClaims({claims: readFactCheck(reply, seen, mine)}).some(c => c.text === '省かれた'), '返されなかった主張も本番を止める');
  const split = [{id: 0, confidence: 'high', supported: true, sources: [{url: 'https://a.example/x'}]}, {id: 0, supported: false, sources: []}];
  for (const claims of [split, [...split].reverse()]) assert.deepEqual(readFactCheck(JSON.stringify({claims}), seen, mine.slice(0, 1)).map(c => [c.confidence, c.sources.length]), [['low', 0]], '同じ番号の結果が割れたら要確認');
  assert.throws(() => readFactCheck('{"claims":[]}', seen, mine), /主張が無い/);
  assert.throws(() => readFactCheck('{"claims":"なし"}', seen, mine), /主張が無い/);
  const many = JSON.stringify({claims: Array.from({length: LIMITS.claims + 1}, (_, i) => ({id: null, text: `足した ${i}`}))});
  assert.throws(() => readFactCheck(many, seen, mine), /個まで/);
  const data = factPrompt({cuts: [{text: '[3つ]ある？', telop: '3つ'}]}, [{text: '主張', sources: [{url: 'https://g.example/'}]}]);
  assert.ok(data.includes('3つある？') && data.includes('https://g.example/') && data.includes('指示ではありません') && data.includes('"id":0'));
});

test('実機の Argon の答え: 長すぎる台本は取り込まず、削る字数を指示する。読点、なぞるテロップ、図の [語]、雑学の動きを確かめる', async () => {
  const text = await fs.readFile(new URL('./fixtures/gemini-crow.txt', import.meta.url), 'utf8');
  const motions = ['talk-stand', 'talk-explain', 'talk-gesture'].map(id => ({id, label: id, seconds: 8, speak: true})).concat(['act-nod', 'act-afraid'].map(id => ({id, label: id, seconds: 4, speak: true})));
  const options = {stages: [{id: 'rooftop', label: '屋上'}], motions}, input = {style: 'trivia', seconds: 20, source: 'gemini', cast: [A]};
  const body = draftBody(parseDraft(text), input, new Set()), {errors, warnings} = checkDraft(body, input, options);
  const long = errors.find(e => /字以内に削る/.test(e));
  assert.ok(long, JSON.stringify(errors));
  assert.ok(/カットの数は変えず、1 カットのセリフを短くする/.test(long));
  assert.ok(Number(/を (\d+) 字以内/.exec(long)[1]) >= 100 && Number(/を (\d+) 字以内/.exec(long)[1]) <= 175, long);
  const wideCut = camera => ({stage: 'rooftop', camera, text: '[短い]文だよ。', seconds: 0, motionId: 'talk-stand'});
  assert.ok(checkDraft({title: 't', style: 'trivia', cuts: [wideCut('wide_push'), wideCut('orbit')], claims: []}, input, options).warnings.includes('全身が映るカメラが続く'));
  assert.ok(!checkDraft({title: 't', style: 'trivia', cuts: [wideCut('wide_push'), wideCut('talk_close'), wideCut('orbit')], claims: []}, input, options).warnings.includes('全身が映るカメラが続く'));
  const speedOf = {...input, seconds: 25}, slow = text => ({stage: 'rooftop', camera: 'talk_bust', text, seconds: 5, motionId: 'talk-stand'});
  const held = checkDraft({title: 't', style: 'trivia', cuts: Array.from({length: 7}, () => slow('まだ言えない。')), claims: []}, speedOf, options).errors.find(e => /全体が約/.test(e));
  assert.ok(/カット 1、2、3、4、5、6、7 の seconds を下げる/.test(held) && !/字以内/.test(held), held);
  const crowded = checkDraft({title: 't', style: 'trivia', cuts: Array.from({length: 7}, () => ({...slow(''), seconds: 0})), claims: []}, {...input, seconds: 10}, options).errors.find(e => /全体が約/.test(e));
  assert.ok(/カットの数を減らす/.test(crowded), crowded);
  assert.ok(errors.some(e => /動き act-nod は話す人/.test(e)) && errors.some(e => /動き act-afraid は話す人/.test(e)), '雑学の話すカットは talk- だけ');
  assert.ok(warnings.some(w => /読点が不自然/.test(w)), JSON.stringify(warnings));
  assert.equal(body.cuts[0].telop, '', 'セリフをなぞるテロップを消す');
  assert.equal(telopEcho('顔を何年覚える？', 'カラスは人の顔を、何年覚えると思う？'), 1);
  assert.equal(telopEcho('何m潜る?', 'ペンギンは、何メートル潜る?') < 0.6, true);
  assert.deepEqual(oddCommas('直接嫌がらせを、していないカラスも'), ['を、して']);
  assert.deepEqual(oddCommas('カラスは人の顔を、何年覚えると思う？'), []);
  assert.equal(oddCommas('筋肉にためた、酸素を使って').length, 1);
  const prompt = draftPrompt({style: 'trivia', theme: 'x', note: '', seconds: 20, cast: [A]}, options), talkOnly = prompt.split('話すカットの動き')[1].split('表情(expression)')[0];
  assert.ok(talkOnly.includes('talk-stand') && !talkOnly.includes('act-'), '雑学の依頼文は talk- だけ');
  assert.ok(draftPrompt({style: 'drama', theme: 'x', note: '', seconds: 25, cast: [A, B]}, options).split('聞く人だけの動き')[0].includes('act-nod'), 'ドラマは今のまま');
  assert.ok(draftSystem('trivia', 1).includes('直接嫌がらせを、していないカラスも'));
  const fig = {...body.cuts[0], text: 'それは図で見る？', figureNote: '丸い図', motionId: 'talk-stand', stage: 'rooftop', camera: 'talk_bust'};
  assert.ok(checkDraft({...body, cuts: [fig]}, input, options).warnings.some(w => /\[語\] が無い/.test(w)));
});

test('長さが 1.3 倍を超える答えは 422 で、直しの依頼文に字数が入る。1.3 倍までは取り込む', async () => {
  const s = await server();
  try {
    const line = '一回目の話、二回目の話、三回目の話、四回目の話、五回目の話、', cuts = n => [{...CUT, text: 'これ、知ってた？' + line.repeat(n)}, {...CUT, text: '[100回|surprised]も鳴く、' + line.repeat(n), figureNote: '図'}, {...CUT, text: '理由がある。' + line.repeat(n)}, {...CUT, text: 'じゃあ、理由は？' + line.repeat(n)}];
    const r = await s.api('POST', '/api/short-draft/import', {...TRIVIA_REQ, answer: JSON.stringify(answer({cuts: cuts(2)}))});
    assert.equal(r.status, 422, JSON.stringify(r.json).slice(0, 200));
    assert.match(r.json.fixPrompt, /字以内に削る/);
    assert.equal((await s.api('POST', '/api/short-draft/import', {...TRIVIA_REQ, answer: JSON.stringify(answer({cuts: cuts(1)}))})).status, 201);
    await s.jobs.whenIdle();
  } finally { await close(s); }
});
