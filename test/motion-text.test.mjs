// 文章からモーションを作るジョブ motion-text。CHARASTA_FAKE_KIMODO で claude と Kimodo を呼ばずに動かす(作業プロセスは本物の kimodo_worker.py --fake。ふだんの python と numpy は要る)。
import test from 'node:test';
import {venvPython} from '../lib/platform.mjs';
import {findPython} from '../lib/platform.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {Library} from '../lib/library.mjs';
import {JobQueue} from '../lib/jobs.mjs';
import {parseVrma} from '../lib/vrma.mjs';
import {limitOf, videoTerms} from '../lib/terms.mjs';
import {motionTextInput, parseSegments, claudeArgs, claudeInput, readClaudeOutput, motionTextLicense, parseGpuFree, runMotionText, ramNeed, MAX_SEG_SEC, MAX_TOTAL_SEC, RAM_GB, MIN_FREE_VRAM_MIB, VRAM_MIB, vramNeed, LOAD_MINUTES} from '../lib/motion-text.mjs';
import {execFileSync} from 'node:child_process';
import {alive} from '../lib/proc.mjs';
import {tempDir, startServer} from './helpers.mjs';

const FAKE = {CHARASTA_FAKE_KIMODO: '1'};
async function setup(t, env = FAKE, tools = {}) {
  const dir = await tempDir();
  const lib = new Library(dir), q = new JobQueue({lib, env, tools});
  t.after(async () => { await q.close(); await fs.rm(dir, {recursive: true, force: true}); });
  return {lib, q, dir};
}
const SENTENCES = '手を振る。そのあと歩き出す。';
const body = extra => ({type: 'motion-text', text: SENTENCES, ...extra});
async function finish(q, job) { await q.whenIdle(); return q.get(job.id); }

test('入力の確かめ: 文章が要る。長さは 1〜22 秒、候補は 1〜3 本、移動は keep か inplace。ラベルは文章の頭から作る', () => {
  const ok = motionTextInput({text: '  手を振る  '});
  assert.deepEqual(ok, {text: '手を振る', seconds: null, candidates: 2, root: 'keep', label: '手を振る'});
  assert.equal(motionTextInput({text: 'x', seconds: '15', candidates: 3, root: 'inplace', label: ' 名前 '}).seconds, 15);
  assert.equal(motionTextInput({text: 'x', seconds: 7.3}).seconds, 7.5);
  assert.equal(motionTextInput({text: 'あ'.repeat(60)}).label, 'あ'.repeat(40));
  for (const bad of [{}, {text: ''}, {text: '  '}, {text: 3}, {text: 'あ'.repeat(1001)}, {text: 'x', seconds: 0.5}, {text: 'x', seconds: MAX_TOTAL_SEC + 1}, {text: 'x', seconds: 'abc'}, {text: 'x', seconds: ['5']},
    {text: 'x', candidates: 0}, {text: 'x', candidates: 4}, {text: 'x', candidates: 1.5}, {text: 'x', root: 'fly'}, {text: 'x', label: 3}, {text: 'x', label: 'あ'.repeat(101)}]) {
    assert.throws(() => motionTextInput(bad), e => e.code === 'bad-input', JSON.stringify(bad));
  }
});

test('英語の説明文の確かめ: 区間は 10 秒まで、合計は 22 秒まで。指定の合計には比例配分で合わせる。コードの囲みや前置きは捨てる', () => {
  const reply = segs => '結果です\n```json\n' + JSON.stringify({segments: segs}) + '\n```';
  assert.deepEqual(parseSegments(reply([{prompt: 'A person  walks.', seconds: 6}]), null), [{prompt: 'A person walks.', seconds: 6}]);
  assert.deepEqual(parseSegments(reply([{prompt: 'A', seconds: 8}, {prompt: 'B', seconds: 6}, {prompt: 'C', seconds: 8}]), null).map(s => s.seconds), [8, 6, 8]);
  assert.deepEqual(parseSegments(reply([{prompt: 'A', seconds: 4}, {prompt: 'B', seconds: 4}]), 15).map(s => s.seconds), [7.5, 7.5]);
  assert.equal(parseSegments(reply([{prompt: 'A', seconds: 3}, {prompt: 'B', seconds: 3}, {prompt: 'C', seconds: 3}]), 10).reduce((t, s) => t + s.seconds, 0), 10);
  const fails = [[reply([{prompt: 'A', seconds: MAX_SEG_SEC + 1}]), null, /10 秒まで/], [reply([{prompt: 'A', seconds: 12}]), 12, /10 秒まで/],
    [reply([{prompt: 'A', seconds: 9}, {prompt: 'B', seconds: 9}, {prompt: 'C', seconds: 9}]), null, /22 秒まで/], [reply([]), null, /区間が無い/], ['これは JSON ではない', null, /読めない/],
    [reply([{prompt: '', seconds: 4}]), null, /正しくない/], [reply([{prompt: 'A', seconds: 'x'}]), null, /正しくない/], [reply(Array(7).fill({prompt: 'A', seconds: 2})), null, /6 個まで/]];
  for (const [raw, sec, re] of fails) assert.throws(() => parseSegments(raw, sec), re, String(raw).slice(0, 60));
});

test('claude -p の呼び方: 文章は引数に載せず標準入力で渡す。ツールと設定は読ませない', () => {
  const text = '剣を振る"; rm -rf / #$(whoami)';
  const args = claudeArgs('sonnet');
  assert.ok(args.every(a => !a.includes('rm -rf')), '文章を引数に含めない');
  // 実機の確かめ(2026-10-31): 歩数・速さ・「止まる」を 1 文に入れた歩く文は進まず、平易な文は進む。移動の区間は 5 秒以上にする
  const system = args[args.indexOf('--system-prompt') + 1];
  assert.match(system, /one main action/); assert.match(system, /three steps/); assert.match(system, /at least 5 seconds/);
  assert.deepEqual(args.slice(0, 5), ['-p', '--model', 'sonnet', '--tools', '']);
  for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(args.includes(flag), flag);
  assert.ok(claudeInput(text, null).includes(text)); assert.match(claudeInput(text, 12), /12 秒/);
  assert.equal(readClaudeOutput(JSON.stringify({result: '{"segments":[]}'})), '{"segments":[]}');
  assert.throws(() => readClaudeOutput(JSON.stringify({is_error: true, result: 'Not logged in'})), /claude が失敗した: Not logged in/);
  assert.throws(() => readClaudeOutput('Not JSON'), /読めない/);
});

test('motion-text ジョブ: 文章 -> 英語の説明文 -> 候補 2 本で確認待ち。取り込むまでモーションにならず、取り込むと選んだ 1 本だけが残る', async t => {
  const {lib, q, dir} = await setup(t);
  const job = await q.enqueue(body({label: '手を振る', root: 'inplace'}));
  assert.equal(job.state, 'queued'); assert.deepEqual({...job.input}, {text: SENTENCES, seconds: null, candidates: 2, root: 'inplace', label: '手を振る'});
  const done = await finish(q, job);
  assert.equal(done.state, 'done', done.error + '\n' + done.logTail);
  const r = done.result;
  assert.equal(r.review, 'waiting'); assert.equal(r.fake, true); assert.equal(r.model, 'Kimodo-SOMA-RP-v1.2');
  assert.deepEqual(r.segments, [{prompt: 'A person 手を振る', seconds: 4}, {prompt: 'A person そのあと歩き出す', seconds: 4}]);
  assert.equal(r.english, 'A person 手を振る A person そのあと歩き出す'); assert.equal(r.durationSec, 8);
  assert.deepEqual(r.candidates.map(c => c.n), [1, 2]); assert.equal(r.candidates[1].seed, r.candidates[0].seed + 1);
  assert.equal(r.candidates[0].vrmaUrl, `/api/motion-texts/${job.id}/candidates/1/motion.vrma`);
  assert.deepEqual(await lib.listMotions(), []);   // まだモーションではない
  for (const n of [1, 2]) for (const f of ['motion.vrma', 'contacts.json', 'info.json']) assert.ok(fsSync.existsSync(path.join(dir, 'jobs', job.id, 'cand', String(n), f)), `${n}/${f}`);
  assert.deepEqual((await q.textMotionsWaiting()).map(j => j.id), [job.id]);
  for (const [bad, re] of [[{n: 3}, /候補 3 は無い/], [{}, /整数/], [{n: 1, motionId: 'Bad ID'}, /ID/]]) await assert.rejects(q.importTextMotion(job.id, bad), re);

  const m = await q.importTextMotion(job.id, {n: 2, label: '手を振って歩く'});
  assert.equal(m.id, 'text-' + job.id); assert.equal(m.label, '手を振って歩く'); assert.equal(m.source.pack, 'Kimodo で生成（文章から）');
  const g = m.generated;
  assert.equal(g.tool, 'Kimodo'); assert.equal(g.model, 'Kimodo-SOMA-RP-v1.2'); assert.equal(g.text, SENTENCES); assert.equal(g.english, r.english);
  assert.deepEqual(g.segments, r.segments); assert.equal(g.seed, r.candidates[1].seed); assert.equal(g.candidate, 2); assert.equal(g.durationSec, 8); assert.equal(g.job, job.id);
  assert.equal(g.sampleMotions, false); assert.equal(g.root, 'inplace');
  assert.equal(m.contacts, 'contacts.json');
  const saved = (await lib.listMotions())[0];
  assert.equal(saved.durationSec, 8); assert.ok(saved.bones.includes('hips') && !saved.bones.includes('upperChest'));
  assert.equal(parseVrma(await fs.readFile(path.join(lib.dir, 'motions', m.id, 'motion.vrma'))).durationSec, 8);
  // 選ばなかった候補のファイルは消え、確認待ちから外れる
  assert.ok(!fsSync.existsSync(path.join(dir, 'jobs', job.id, 'cand', '1'))); assert.ok(fsSync.existsSync(path.join(dir, 'jobs', job.id, 'cand', '2')));
  assert.deepEqual(await q.textMotionsWaiting(), []);
  assert.equal((await q.get(job.id)).result.review, 'imported'); assert.equal((await q.get(job.id)).result.motionId, m.id);
  await assert.rejects(q.importTextMotion(job.id, {n: 2}), /確認待ちではない/);
});

test('ライセンスの記録: Kimodo / LLM2Vec / Llama 3 の条件を事実だけ書き、見本の動きは使っていないと残す。評価用のみにはしない', async t => {
  const {lib, q} = await setup(t);
  const job = await q.enqueue(body());
  await finish(q, job);
  await q.importTextMotion(job.id, {n: 1});
  const m = (await lib.listMotions())[0], l = m.license;
  assert.equal(l.evaluationOnly, undefined); assert.equal(l.redistribution, false);
  assert.deepEqual(l.terms.map(t => t.license), ['NVIDIA Open Model License', 'Apache 2.0', 'MIT', 'Meta Llama 3 Community License', '使っていない']);
  assert.match(l.summary, /Kimodo-SOMA-RP-v1\.2 は NVIDIA Open Model License/); assert.match(l.summary, /LLM2Vec（MIT）/); assert.match(l.summary, /Meta Llama 3 Community License/);
  assert.match(l.summary, /見本の動きは使っていない/); assert.match(l.summary, /https:\/\/llama\.meta\.com\/llama3\/use-policy\//);
  assert.match(l.terms[3].policy, /llama3\/use-policy/);
  assert.doesNotMatch(JSON.stringify(l), /商用/);   // 商用で使えるかの判断は書かない
  assert.deepEqual(l, motionTextLicense());
  assert.equal(limitOf(m).warn, false);   // 評価用のみの札にならない
  assert.equal(videoTerms({motion: m}).level, 'ok');
});

test('長さを指定すると区間ごとの秒に分け、1 区間が 10 秒を超えるときは Kimodo を起こす前に失敗する', async t => {
  const {q} = await setup(t);
  const a = await finish(q, await q.enqueue(body({seconds: 15})));
  assert.equal(a.state, 'done', a.error); assert.deepEqual(a.result.segments.map(s => s.seconds), [7.5, 7.5]); assert.equal(a.result.durationSec, 15);
  const b = await q.enqueue(body({text: '長い一続きの動き', seconds: 15}));
  const f = await finish(q, b);
  assert.equal(f.state, 'failed'); assert.match(f.error, /英語の説明文を確かめられなかった: 区間 1 が 15 秒ある。1 区間は 10 秒まで/);
  assert.match(f.logTail, /== 英語の説明文に直す/); assert.doesNotMatch(f.logTail, /== 文章のモデルを読み込んでいる/);
});

test('失敗の経路: claude が使えない、Kimodo の失敗、読み込みの失敗、hips が 2 m を超える動きは理由つきで failed になりモーションは作らない', async t => {
  for (const [mode, re, hold] of [['claude-fail', /claude が使えない/, false], ['fail', /Kimodo が失敗した/, true], ['load-fail', /モデルを読み込めない/, true],
    ['high', /2 本とも、hips が 2 m を超えて壊れていた.*3\.5 m まで上がる/, true]]) {
    const {lib, q, dir} = await setup(t, {CHARASTA_FAKE_KIMODO: mode});
    const job = await q.enqueue(body());
    const f = await finish(q, job);
    assert.equal(f.state, 'failed', mode); assert.match(f.error, re, mode);
    assert.deepEqual(await lib.listMotions(), []); assert.deepEqual(await q.textMotionsWaiting(), []);
    assert.equal(!!q.kimodo?.running, hold, mode);   // 変換で失敗したときは作業プロセスを起こしていない
    if (mode === 'high') assert.deepEqual(fsSync.readdirSync(path.join(dir, 'jobs', job.id, 'cand')), []);   // 壊れた候補のファイルは残さない
  }
});

test('RAM の空きが足りなければ、モデルを読み込む前に理由つきで失敗する。読み込み済みでも stream は符号化の分を測る', async t => {
  let free = 0.5;
  const {q} = await setup(t, FAKE, {freeMemGB: () => free});
  const f = await finish(q, await q.enqueue(body()));
  assert.equal(f.state, 'failed'); assert.ok(f.error.includes(`RAM の空きが 0.5 GB しかない（文章のモデルの読み込みに ${RAM_GB.stream.load} GB 要る）`), f.error);
  assert.equal(q.kimodo.running, false);
  free = RAM_GB.stream.load;
  const ok = await finish(q, await q.enqueue(body()));
  assert.equal(ok.state, 'done', ok.error);
  free = 0.5;   // 読み込み済みでも、文章の符号化の別プロセスの分は要る
  const low = await finish(q, await q.enqueue(body()));
  assert.equal(low.state, 'failed'); assert.ok(low.error.includes(`RAM の空きが 0.5 GB しかない（文章の符号化に ${RAM_GB.stream.encode} GB 要る）`), low.error);
  assert.equal(q.kimodo.running, true);   // 作業プロセスは残す
  free = RAM_GB.stream.encode;
  const again = await finish(q, await q.enqueue(body()));
  assert.equal(again.state, 'done', again.error); assert.match(again.logTail, /文章のモデルは読み込み済み/);
});

test('今までの経路(CHARASTA_KIMODO_ENCODER=cpu)は、読み込み前に 16 GB を測り、読み込み済みなら測らない', async t => {
  let free = 4;
  const {q} = await setup(t, {...FAKE, CHARASTA_KIMODO_ENCODER: 'cpu'}, {freeMemGB: () => free});
  const f = await finish(q, await q.enqueue(body()));
  assert.equal(f.state, 'failed'); assert.match(f.error, /RAM の空きが 4\.0 GB しかない（文章のモデルの読み込みに 16 GB 要る）/);
  free = 20;
  assert.equal((await finish(q, await q.enqueue(body()))).state, 'done');
  free = 1;
  const again = await finish(q, await q.enqueue(body()));
  assert.equal(again.state, 'done', again.error);
  assert.equal(q.kimodo.encoder, 'cpu');
});

test('エンコーダの設定: 既定は stream で、埋め込みは保管場所の kimodo-cache/embeddings に覚える。知らない値は claude に送る前に断る', async t => {
  const {q, dir} = await setup(t, FAKE);
  const w = q.kimodoWorker();
  assert.equal(w.encoder, 'stream'); assert.equal(w.embedDir, path.join(dir, 'kimodo-cache', 'embeddings'));
  assert.equal(ramNeed({}, false), RAM_GB.stream.load); assert.equal(ramNeed({}, true), RAM_GB.stream.encode);
  assert.equal(ramNeed({CHARASTA_KIMODO_MIN_FREE_GB: '9'}, false), 9); assert.equal(ramNeed({CHARASTA_KIMODO_ENCODER: 'cpu'}, true), 0);
  assert.equal(ramNeed({CHARASTA_KIMODO_ENCODER: 'stream-cpu'}, false), RAM_GB.stream.load);
  assert.ok(RAM_GB.stream.load < RAM_GB.cpu.load);
  const bad = await setup(t, {...FAKE, CHARASTA_KIMODO_ENCODER: 'gpu'});
  const f = await finish(bad.q, await bad.q.enqueue(body()));
  assert.equal(f.state, 'failed'); assert.ok(f.error.includes('CHARASTA_KIMODO_ENCODER は stream / stream-cpu / cpu（gpu になっている）'), f.error);
  assert.doesNotMatch(f.logTail ?? '', /英語の説明文に直す/);
});

test('文章のエンコーダのキャッシュ(tools/kimodo_text_encoder.py): 文章ごとに 1 回だけ別プロセスで符号化し、ディスクから読む(test/kimodo_text_encoder_check.py)', () => {
  const out = execFileSync(findPython() ?? 'python', [path.join(import.meta.dirname, 'kimodo_text_encoder_check.py')], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  assert.match(out, /^ok/m);
});

test('GPU の要る空きはモードで違い、cpu は main と同じ 2500。読み込み済みなら符号化の分を足さない', () => {
  assert.equal(vramNeed({}, false), 4000); assert.equal(vramNeed({CHARASTA_KIMODO_ENCODER: 'stream'}, false), 4000);
  assert.equal(vramNeed({CHARASTA_KIMODO_ENCODER: 'stream-cpu'}, false), 2500);
  assert.equal(vramNeed({CHARASTA_KIMODO_ENCODER: 'cpu'}, false), 2500); assert.equal(MIN_FREE_VRAM_MIB, 2500);
  assert.equal(vramNeed({}, true), 2500); assert.equal(vramNeed({CHARASTA_KIMODO_ENCODER: 'cpu'}, true), 2500);
});

test('読み込み済みの作業プロセスは、GPU の空きが 2500 MiB あれば待たない。未読み込みの stream は 4000 MiB 要る', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  await fs.mkdir(path.dirname(venvPython(dir)), {recursive: true});
  await fs.writeFile(venvPython(dir), '');
  const run = async () => JSON.stringify({result: JSON.stringify({segments: [{prompt: 'A person waves.', seconds: 3}]})});
  const go = async (loaded, env) => {
    const msgs = [];
    const ctx = {job: {id: 'j1', input: motionTextInput({text: '手を振る', seconds: 3})}, workDir: dir, signal: new AbortController().signal, log() {}, step: async m => { msgs.push(m); }, run};
    const worker = {kimodoDir: dir, loaded, hold: () => () => {}, ensureLoaded: async () => { throw new Error('ここで止める'); }};
    await assert.rejects(runMotionText(ctx, {worker, env, tools: {freeMemGB: () => 99, gpuFreeMiB: async () => 3000}}), /ここで止める|GPU の空きが 3000 MiB/);
    return msgs.some(m => /GPU が空くのを待っている/.test(m));
  };
  assert.equal(await go(true, {}), false);
  assert.equal(await go(false, {CHARASTA_KIMODO_ENCODER: 'stream-cpu'}), false);
  assert.equal(await go(false, {CHARASTA_KIMODO_ENCODER: 'cpu'}), false);
  assert.equal(await go(false, {CHARASTA_GPU_WAIT_MS: '30', CHARASTA_GPU_POLL_MS: '10'}), true);
});

test('GPU の空きが足りなければ空くまで待ち、待ち切れなければ理由つきで失敗する', async t => {
  let calls = 0;
  const {q} = await setup(t, {...FAKE, CHARASTA_GPU_POLL_MS: '20'}, {gpuFreeMiB: async () => (++calls < 4 ? 500 : 8000)});
  const ok = await finish(q, await q.enqueue(body()));
  assert.equal(ok.state, 'done', ok.error); assert.ok(ok.logTail.includes(`== GPU が空くのを待っている（空き 500 MiB、${VRAM_MIB.stream} MiB 要る）`), ok.logTail); assert.match(ok.logTail, /GPU が空いた/);
  const w = await setup(t, {...FAKE, CHARASTA_GPU_POLL_MS: '10', CHARASTA_GPU_WAIT_MS: '60'}, {gpuFreeMiB: async () => 100});
  const f = await finish(w.q, await w.q.enqueue(body()));
  assert.equal(f.state, 'failed'); assert.match(f.error, /GPU の空きが 100 MiB しかない/);
  assert.equal(!!w.q.kimodo?.running, false);
});

test('作業プロセス: PID を記録し、次のジョブで使い回し、使わなければ終了し、キューを閉じると止まる', async t => {
  const {q, dir} = await setup(t, {...FAKE, CHARASTA_KIMODO_IDLE_MS: '700'});
  const a = await finish(q, await q.enqueue(body()));
  assert.equal(a.state, 'done', a.error);
  const w = q.kimodo, rec = JSON.parse(fsSync.readFileSync(path.join(dir, 'jobs', 'kimodo-worker.json'), 'utf8'));
  assert.equal(rec.pid, w.pid); assert.ok(alive(rec.pid)); assert.equal(w.loaded, true);
  const b = await finish(q, await q.enqueue(body())), pid = w.pid;
  assert.equal(b.state, 'done'); assert.equal(pid, rec.pid); assert.match(b.logTail, /文章のモデルは読み込み済み/);
  for (let i = 0; i < 60 && w.running; i++) await new Promise(r => setTimeout(r, 100));   // 使わないまま idleMs が過ぎる
  assert.equal(w.running, false); assert.ok(!alive(pid)); assert.ok(!fsSync.existsSync(path.join(dir, 'jobs', 'kimodo-worker.json')));
  const c = await finish(q, await q.enqueue(body()));   // 終わったあとの次のジョブは、起動し直して読み込む
  assert.equal(c.state, 'done'); assert.notEqual(w.pid, pid); assert.match(c.logTail, new RegExp(`== 文章のモデルを読み込んでいる（約 ${LOAD_MINUTES} 分）`));
  const pid2 = w.pid;
  await q.close();
  assert.equal(w.running, false); assert.ok(!alive(pid2));
});

test('前のサーバーが残した PID の記録は、生きていれば知らせるだけで止めず、死んでいれば消す', async t => {
  const {q, dir} = await setup(t);
  const w = q.kimodoWorker(), file = path.join(dir, 'jobs', 'kimodo-worker.json');
  fsSync.mkdirSync(path.dirname(file), {recursive: true});
  fsSync.writeFileSync(file, JSON.stringify({pid: process.pid}));
  assert.equal(w.staleRecord().pid, process.pid); assert.ok(fsSync.existsSync(file));
  fsSync.writeFileSync(file, JSON.stringify({pid: 2 ** 31 - 7}));
  assert.equal(w.staleRecord(), null); assert.ok(!fsSync.existsSync(file));
});

test('API: 文章を積むと候補が確認待ちに出て、候補の VRMA を配り、取り込むと /api/motions に出る。捨てるとごみ箱へ移る', async () => {
  const s = await startServer({env: FAKE});
  try {
    const opt = await (await fetch(s.base + '/api/motion-texts')).json();
    assert.equal(opt.available, true); assert.equal(opt.maxSegmentSec, 10); assert.equal(opt.maxTotalSec, 22); assert.deepEqual(opt.candidates, {min: 1, max: 3, default: 2}); assert.deepEqual(opt.waiting, []);
    const post = (p, b) => fetch(s.base + p, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(b)});
    assert.equal((await post('/api/jobs', {type: 'motion-text', text: ''})).status, 400);
    assert.equal((await post('/api/jobs', {type: 'motion-text', text: 'x', seconds: 30})).status, 400);
    const job = await (await post('/api/jobs', body({candidates: 3}))).json(), job2 = await (await post('/api/jobs', body({candidates: 1}))).json();
    await s.server.jobs.whenIdle();
    const waiting = (await (await fetch(s.base + '/api/motion-texts')).json()).waiting;
    assert.deepEqual(waiting.map(j => j.id).sort(), [job.id, job2.id].sort());
    assert.equal(waiting.find(j => j.id === job.id).result.candidates.length, 3);
    const v = await fetch(s.base + `/api/motion-texts/${job.id}/candidates/3/motion.vrma`);
    assert.equal(v.status, 200); assert.equal(parseVrma(Buffer.from(await v.arrayBuffer())).durationSec, 8);
    const c = await fetch(s.base + `/api/motion-texts/${job.id}/candidates/3/contacts.json`);
    assert.equal(c.status, 200); assert.equal((await c.json()).order.length, 4);
    for (const p of [`/api/motion-texts/${job.id}/candidates/4/motion.vrma`, `/api/motion-texts/${job.id}/candidates/1/info.json`, `/api/motion-texts/nojob/candidates/1/motion.vrma`]) assert.equal((await fetch(s.base + p)).status, 404, p);
    assert.equal((await fetch(s.base + `/api/motion-texts/${job.id}/import`)).status, 405);
    const im = await post(`/api/motion-texts/${job.id}/import`, {n: 3, label: '手を振る', motionId: 'wave-walk'});
    assert.equal(im.status, 201);
    const list = await (await fetch(s.base + '/api/motions')).json();
    assert.deepEqual(list.map(m => m.id), ['wave-walk']); assert.equal(list[0].label, '手を振る'); assert.equal(list[0].generated.candidate, 3);
    assert.equal((await fetch(s.base + list[0].file)).status, 200); assert.equal((await fetch(s.base + list[0].contactsUrl)).status, 200);
    assert.equal((await fetch(s.base + `/api/motion-texts/${job.id}/candidates/3/motion.vrma`)).status, 409);   // 取り込み済みは確認待ちではない
    const dis = await post(`/api/motion-texts/${job2.id}/discard`, {});
    assert.equal(dis.status, 200); assert.equal((await dis.json()).result.review, 'discarded');
    assert.deepEqual((await (await fetch(s.base + '/api/motion-texts')).json()).waiting, []);
    const trash = await (await fetch(s.base + '/api/trash')).json();
    assert.deepEqual(trash.items.map(i => [i.kind, i.restorable]), [['text-motion', false]]);
    assert.ok(fsSync.existsSync(path.join(s.libraryDir, 'trash', `text-motion-${job2.id}`, 'cand', '1', 'motion.vrma')));
  } finally { await s.close(); }
});

test('Kimodo が無い設定では available が false で、積んだジョブは文章を claude に送る前に理由つきで失敗する', async t => {
  const none = path.join(await tempDir(), 'none');
  const s = await startServer({kimodoDir: none, env: {CHARASTA_CLAUDE: path.join(none, 'claude-must-not-run')}});
  try {
    const opt = await (await fetch(s.base + '/api/motion-texts')).json();
    assert.equal(opt.available, false); assert.match(opt.kimodoDir, /none$/);
    const r = await fetch(s.base + '/api/jobs', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body())});
    const job = await r.json();
    await s.server.jobs.whenIdle();
    const f = await (await fetch(`${s.base}/api/jobs/${job.id}`)).json();
    assert.equal(f.state, 'failed'); assert.match(f.error, /Kimodo の \.venv が見つからない（設定の kimodoDir: .*none）/);
    assert.doesNotMatch(f.logTail, /\$ claude/);
  } finally { await s.close(); }
});

// ---- レビューの指摘の分 ----
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { for (let i = 0; i < ms / 50; i++) { if (await fn()) return true; await sleep(50); } return false; }

test('区間の秒が 0 や NaN になるものは断る(丸めて全部 0、合計が 0)', () => {
  const two = secs => JSON.stringify({segments: secs.map(s => ({prompt: 'A person moves.', seconds: s}))});
  assert.throws(() => parseSegments(two([0.2, 0.2]), 5), /全部 0 になった/);
  assert.throws(() => parseSegments(two([0.2, 0.2]), null), /区間 1 が 0 秒しかない/);
  assert.throws(() => parseSegments('{"segments":[{"prompt":"A","seconds":"NaN"}]}', null), /正しくない/);
  assert.throws(() => parseSegments('{"segments":[{"prompt":"A","seconds":1e999}]}', null), /正しくない/);
  assert.throws(() => parseSegments(two([0.2, 4]), 5), /区間 1 が 0 秒しかない/);   // 比例配分で 0 になる区間も断る
});

test('nvidia-smi の出力の読み方: 0 MiB は 0 のまま、読めなければ null', () => {
  assert.equal(parseGpuFree('9632\n'), 9632); assert.equal(parseGpuFree(' 0 \r\n12\r\n'), 0);
  for (const bad of ['', '\n', 'N/A', 'Failed to initialize NVML', undefined]) assert.equal(parseGpuFree(bad), null, String(bad));
});

test('GPU の空きが 0 MiB のときも待つ(測れないものとして扱わない)', async t => {
  const {q} = await setup(t, {...FAKE, CHARASTA_GPU_POLL_MS: '10', CHARASTA_GPU_WAIT_MS: '60'}, {gpuFreeMiB: async () => 0});
  const f = await finish(q, await q.enqueue(body()));
  assert.equal(f.state, 'failed'); assert.match(f.error, /GPU の空きが 0 MiB しかない/);
});

test('ライセンスの記録に Llama 3 の配布・提供の条件（Built with Meta Llama 3 とライセンス文の写し）を事実として残す', () => {
  const l = motionTextLicense(), t = l.terms.find(x => x.license === 'Meta Llama 3 Community License');
  assert.match(l.summary, /「Built with Meta Llama 3」の表示とライセンス文の写し/); assert.match(l.summary, /1\.b\.i/);
  assert.match(t.condition, /Built with Meta Llama 3/); assert.match(t.condition, /ライセンス文の写し/);
  assert.doesNotMatch(JSON.stringify(l), /商用/);
});

test('英語への変換の本物の経路: claude を引数の配列と標準入力で呼ぶ。cwd、タイムアウト、設定を読ませない指定、システムプロンプトを確かめる(偽の ctx.run)', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  await fs.mkdir(path.dirname(venvPython(dir)), {recursive: true});
  await fs.writeFile(venvPython(dir), '');
  const text = '剣を振る"; rm -rf / #$(whoami)', calls = [];
  const mk = run => ({job: {id: 'j1', input: motionTextInput({text, seconds: 12})}, workDir: dir, signal: new AbortController().signal, log() {}, step: async () => {}, run});
  const worker = {kimodoDir: dir, loaded: false, hold: () => () => {}, ensureLoaded: async () => { throw new Error('ここで止める'); }};
  const run = async (cmd, args, opts) => {
    calls.push({cmd, args, opts});
    return JSON.stringify({result: JSON.stringify({segments: [{prompt: 'A person swings a sword.', seconds: 6}, {prompt: 'A person steps back.', seconds: 6}]})});
  };
  await assert.rejects(runMotionText(mk(run), {worker, env: {CHARASTA_CLAUDE_MODEL: 'haiku'}, tools: {freeMemGB: () => 99, gpuFreeMiB: async () => 9999}}), /ここで止める/);
  assert.equal(calls.length, 1);
  const {cmd, args, opts} = calls[0];
  assert.equal(cmd, 'claude'); assert.equal(args[0], '-p'); assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(args[args.indexOf('--setting-sources') + 1], ''); assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.match(args[args.indexOf('--system-prompt') + 1], /^You convert a description of a human body motion/);
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.ok(args.every(a => !a.includes('rm -rf')), '文章は引数に載せない');
  assert.ok(opts.input.includes(text) && opts.input.includes('12 秒')); assert.equal(opts.capture, true); assert.equal(opts.cwd, dir); assert.equal(opts.timeoutMs, 180000);
  // claude が失敗したときは、理由を付けて失敗する(標準出力の末尾も例外の文に入る)
  const failing = async () => { throw new Error('claude が失敗した(終了コード 1): 標準エラー / 標準出力の末尾: {"is_error":true,"result":"Not logged in"}'); };
  await assert.rejects(runMotionText(mk(failing), {worker, env: {}, tools: {}}), /英語の説明文に直せなかった（claude が使えない？）.*Not logged in/);
  // 返事が JSON でなければ確かめられずに失敗する。Kimodo は起こさない
  await assert.rejects(runMotionText(mk(async () => JSON.stringify({result: 'できません'})), {worker, env: {}, tools: {}}), /英語の説明文を確かめられなかった: 英語への変換の返事を読めない/);
});

test('外部コマンドが 0 以外で終わったとき、捕らえた標準出力の末尾も理由に入る', async t => {
  const {q} = await setup(t);
  await assert.rejects(q.run('node', ['-e', 'process.stdout.write(JSON.stringify({is_error:true,result:"Not logged in"})); process.exit(1)'], () => {}, {capture: true}),
    /node が失敗した\(終了コード 1\).*標準出力の末尾: .*Not logged in/);
  await assert.rejects(q.run('node', ['-e', 'console.error("err line"); process.exit(2)'], () => {}), /終了コード 2\): err line$/);
});

test('作業プロセスの標準出力に混ざったノイズ(print、fd 1 への書き込み、null の行)は応答と分け、ログへ回す', async t => {
  const {q, dir} = await setup(t, {CHARASTA_FAKE_KIMODO: 'noisy'});
  const f = await finish(q, await q.enqueue(body()));
  assert.equal(f.state, 'done', f.error + f.logTail);
  assert.match(f.logTail, /print のノイズ/); assert.match(f.logTail, /C の層のノイズ/);
  assert.match(fsSync.readFileSync(path.join(dir, 'jobs', 'kimodo-worker.log'), 'utf8'), /null/);   // 受け側は null の行で落ちず、ログに残す
});

test('生成の途中で作業プロセスが死ぬと理由つきで失敗し、状態を片づける。次のジョブは起動し直す', async t => {
  const {q, dir} = await setup(t, {CHARASTA_FAKE_KIMODO: 'die'});
  const f = await finish(q, await q.enqueue(body()));
  assert.equal(f.state, 'failed'); assert.match(f.error, /作業プロセスが終わった\(終了コード 3\)/);
  const w = q.kimodo;
  assert.ok(await until(() => !w.running)); assert.equal(w.loaded, false); assert.ok(!fsSync.existsSync(path.join(dir, 'jobs', 'kimodo-worker.json')));
  w.fake = '1';   // 直った状態で、次のジョブ
  const ok = await finish(q, await q.enqueue(body()));
  assert.equal(ok.state, 'done', ok.error); assert.match(ok.logTail, /== 文章のモデルを読み込んでいる/);
});

test('作業プロセスが答えなければ、タイムアウトで止めて理由つきで失敗する', async t => {
  const {q} = await setup(t, {CHARASTA_FAKE_KIMODO: 'hang', CHARASTA_KIMODO_TIMEOUT_MS: '500', CHARASTA_KIMODO_QUIT_WAIT_MS: '200'});
  const t0 = Date.now(), f = await finish(q, await q.enqueue(body()));
  assert.equal(f.state, 'failed'); assert.match(f.error, /作業プロセスが 1 秒で答えなかったので止めた/); assert.ok(Date.now() - t0 < 30000);   // 上限 0.5 秒 + 終了待ち。重い機械でも 30 秒は超えない
  const pid = q.kimodo.pid;
  assert.ok(await until(() => !q.kimodo.running)); assert.equal(q.kimodo.loaded, false); if (pid) assert.ok(!alive(pid));
});

test('終わらせている最中の作業プロセスと、次のジョブが重なっても、終わるのを待って起動し直す(読み込みもやり直す)', async t => {
  const {q} = await setup(t);
  assert.equal((await finish(q, await q.enqueue(body()))).state, 'done');
  const w = q.kimodo, p1 = w.pid, closing = w.close();
  assert.equal(w.loaded, false);   // close の入口で読み込み済みの印を外す
  const b = await finish(q, await q.enqueue(body()));
  await closing;
  assert.equal(b.state, 'done', b.error); assert.match(b.logTail, /== 文章のモデルを読み込んでいる/); assert.notEqual(w.pid, p1); assert.ok(!alive(p1)); assert.ok(alive(w.pid));
});

test('終わらせている最中の作業プロセスがあるときは、それが終わってから RAM を測る(古いプロセスの分を数えない)', async t => {
  const seen = [];
  const {q} = await setup(t, FAKE, {freeMemGB: () => { seen.push(q.kimodo.running); return 99; }});
  assert.equal((await finish(q, await q.enqueue(body()))).state, 'done');
  const closing = q.kimodo.close();
  const job = await q.enqueue(body());
  await closing;
  assert.equal((await finish(q, job)).state, 'done');
  assert.deepEqual(seen, [false, false]);
});

test('ジョブの間は、使わないことによる終了のタイマーが止まる(GPU を待つ間に、読み込み済みの作業プロセスが終わらない)', async t => {
  let slow = false, calls = 0;
  const {q} = await setup(t, {...FAKE, CHARASTA_KIMODO_IDLE_MS: '250', CHARASTA_GPU_POLL_MS: '40'}, {gpuFreeMiB: async () => (slow && ++calls < 20 ? 100 : 9000)});
  assert.equal((await finish(q, await q.enqueue(body()))).state, 'done');
  const w = q.kimodo, p1 = w.pid;
  slow = true;   // 2 本目は GPU を約 0.8 秒待つ(250 ms を超える)
  const b = await finish(q, await q.enqueue(body()));
  assert.ok(calls >= 20, `GPU を ${calls} 回測った`);
  assert.equal(b.state, 'done', b.error); assert.match(b.logTail, /文章のモデルは読み込み済み/); assert.equal(w.pid, p1);
  assert.ok(await until(() => !w.running, 4000)); assert.ok(!alive(p1));   // ジョブが終われば、使わないまま 250 ms で終わる
});

test('GPU 待ちの間にサーバーを止めると、待ちを切り上げて中断し、作業プロセスは起動しない。止めたあとは積めず、起動もしない', async t => {
  const {q} = await setup(t, {...FAKE, CHARASTA_GPU_POLL_MS: '30000', CHARASTA_GPU_WAIT_MS: '600000'}, {gpuFreeMiB: async () => 100});
  const job = await q.enqueue(body());
  assert.ok(await until(async () => /GPU が空くのを待っている/.test((await q.get(job.id)).step)));
  const t0 = Date.now();
  await q.close();
  assert.ok(Date.now() - t0 < 4000, '待ちを切り上げる');
  const f = await q.get(job.id);
  assert.equal(f.state, 'failed'); assert.match(f.error, /サーバーを止めるので、ジョブを中断した/);
  assert.equal(q.kimodo.running, false); assert.equal(q.kimodo.shut, true);
  await assert.rejects(q.kimodo.request('load'), /起動しない/);
  await assert.rejects(q.enqueue(body()), /止まりかけている/);
});

test('サーバーを止めると、読み込み前のジョブは作業プロセスを起動せずに中断する(RAM を測ったあとでも)', async t => {
  let release;
  const gate = new Promise(r => { release = r; });
  const {q} = await setup(t, FAKE, {freeMemGB: () => { return 99; }, gpuFreeMiB: async () => { await gate; return 9000; }});
  const job = await q.enqueue(body());
  assert.ok(await until(async () => /英語の説明文に直す/.test((await q.get(job.id)).step) || (await q.get(job.id)).state === 'running'));
  const closing = q.close();
  release();
  await closing;
  const f = await q.get(job.id);
  assert.equal(f.state, 'failed'); assert.match(f.error, /中断/); assert.equal(q.kimodo.running, false);
});

test('新しい JobQueue(サーバーの再起動)でも、確認待ちの候補を読めて、取り込める', async t => {
  const {lib, q, dir} = await setup(t);
  const job = await q.enqueue(body());
  assert.equal((await finish(q, job)).state, 'done');
  const q2 = new JobQueue({lib, env: FAKE});
  t.after(() => q2.close());
  assert.deepEqual((await q2.textMotionsWaiting()).map(j => j.id), [job.id]);
  assert.equal(await q2.textMotionFile(job.id, '2', 'motion.vrma'), path.join(dir, 'jobs', job.id, 'cand', '2', 'motion.vrma'));
  assert.ok(fsSync.existsSync(await q2.textMotionFile(job.id, '2', 'contacts.json')));
  const m = await q2.importTextMotion(job.id, {n: 1, motionId: 'after-restart'});
  assert.equal(m.id, 'after-restart'); assert.equal(m.generated.candidate, 1);
  assert.deepEqual((await q2.textMotionsWaiting()), []);
});

test('途中経過の保存と段階の保存が重なっても、ジョブの記録は壊れない(同じジョブの保存は順に書く)', async t => {
  const {q} = await setup(t);
  for (let k = 0; k < 4; k++) {
    const f = await finish(q, await q.enqueue(body({candidates: 3})));
    assert.equal(f.state, 'done', f.error); assert.equal(f.result.candidates.length, 3);
  }
});

test('動きの数え方(tools/vrma_stats.py): 歩く動きは hips の道のりと太ももの振れが出て、立って手を振るだけの動きは出ない(test/vrma_stats_check.py)', () => {
  const out = execFileSync(findPython() ?? 'python', [path.join(import.meta.dirname, 'vrma_stats_check.py')], {encoding: 'utf8'});
  assert.match(out, /^OK /m);
});

test('入力の確かめ: speed と segments。道を決めた歩きは長く作れ、区間を直接渡すと claude を通らない', () => {
  const segments = Array.from({length: 7}, () => ({prompt: 'A person walks forward.', seconds: 4}));
  const input = motionTextInput({text: '歩く', speed: 1.2, segments});
  assert.equal(input.speed, 1.2);
  assert.equal(input.segments.length, 7);
  assert.throws(() => motionTextInput({text: '歩く', segments}), /7 個|28 秒/, '道が無ければ今の上限のまま');
  assert.throws(() => motionTextInput({text: '歩く', speed: 3}), /speed/);
  assert.equal(motionTextInput({text: '歩く'}).speed, undefined);
});

test('入力の確かめ: 道を決めた歩きの区間は 0.1 秒単位で、区間の speed で止まれる', () => {
  const segments = [{prompt: 'A person walks forward.', seconds: 2.77}, {prompt: 'A person stops and looks up.', seconds: 1.94, speed: 0}];
  assert.deepEqual(motionTextInput({text: '歩く', speed: 1.2, segments}).segments, [{prompt: 'A person walks forward.', seconds: 2.8}, {prompt: 'A person stops and looks up.', seconds: 1.9, speed: 0}]);
  assert.throws(() => motionTextInput({text: '歩く', segments}), /speed/, '道が無ければ区間の speed は受けない');
  assert.throws(() => motionTextInput({text: '歩く', speed: 1.2, segments: [{prompt: 'A person runs.', seconds: 2, speed: 3}]}), /speed/);
  assert.deepEqual(motionTextInput({text: '歩く', segments: [{prompt: 'A person waves.', seconds: 2.7}]}).segments, [{prompt: 'A person waves.', seconds: 2.5}], '道が無ければ 0.5 秒単位のまま');
});
