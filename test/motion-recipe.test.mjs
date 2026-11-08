// モーションをつなぐジョブ motion-recipe。CHARASTA_FAKE_MOTIONBRICKS で compose.py に --fake を付け、MotionBricks を呼ばずに動かす(python と numpy は要る)。
// 確認待ちのジョブの結果の区間は、文章を CHARASTA_FAKE_KIMODO、動画を CHARASTA_FAKE_VRMA_PIPELINE の試しの動きで作る(動画は ffmpeg も要る)。
import test from 'node:test';
import {findPython} from '../lib/platform.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Library} from '../lib/library.mjs';
import {JobQueue} from '../lib/jobs.mjs';
import {Trash} from '../lib/trash.mjs';
import {parseVrma} from '../lib/vrma.mjs';
import {motionRecipeInput, composePlan, runMotionRecipe, DEFAULT_BRIDGE, MAX_SEGMENTS} from '../lib/motion-recipe.mjs';
import {motionTextLicense} from '../lib/motion-text.mjs';
import {tempDir, startServer, fakeGlb, SAMPLE_VRMA} from './helpers.mjs';

const FAKE = {CHARASTA_FAKE_MOTIONBRICKS: '1'};
const FREE = {holder: 'H', summary: '改変可', redistribution: true};

// 保管場所に 2 本: MotionBricks の試しの動きで作った評価用のモーション(接地あり)と、取り込んだ VRMA(二次配布 可)
async function setup(t, env = FAKE, tools = {}) {
  const dir = await tempDir();
  const lib = new Library(dir), q = new JobQueue({lib, env: {...FAKE, ...env}, tools});
  t.after(async () => { await q.close(); await fs.rm(dir, {recursive: true, force: true}); });
  const gen = await q.enqueue({type: 'motion-gen', kind: 'forward', seconds: 2, motionId: 'mb-a'});
  await q.whenIdle();
  await q.importGenMotion(gen.id, {});   // motion-gen は確認待ちで止まるので取り込む
  await lib.importMotion({id: 'b', name: 'b', label: '踊る', data: await fs.readFile(SAMPLE_VRMA), license: FREE});
  q.extraEnv = env;   // motion-gen は試しの動きで作り、つなぐジョブは呼び出しの env で動かす
  return {lib, q, dir};
}
const recipe = extra => ({type: 'motion-recipe', segments: [{source: 'motion', motion: 'mb-a'}, {source: 'motion', motion: 'b', trim: [0, 1.5], speed: 0.8}], ...extra});

test('入力の確かめ: 保管場所のモーションを 2〜8 本、trim は長さの中、speed は 0.25〜4、つなぎは 0〜3 秒で MotionBricks か補間', async t => {
  const {lib} = await setup(t);
  const ok = await motionRecipeInput(lib, recipe());
  assert.deepEqual(ok, {label: `${(await lib.getMotion('mb-a')).label || 'mb-a'} + 踊る`, bridge: DEFAULT_BRIDGE,
    segments: [{source: 'motion', motion: 'mb-a'}, {source: 'motion', motion: 'b', trim: [0, 1.5], speed: 0.8}]});
  const b2 = await motionRecipeInput(lib, recipe({label: ' 名前 ', bridge: {seconds: 0.8, method: 'interpolate'},
    segments: [{source: 'motion', motion: 'b', trim: [0, null], speed: 1}, {source: 'motion', motion: 'b', bridge: {seconds: 0}}]}));
  assert.equal(b2.label, '名前');
  assert.deepEqual(b2.segments, [{source: 'motion', motion: 'b'}, {source: 'motion', motion: 'b', bridge: {seconds: 0, method: 'interpolate'}}]);   // 区間のつなぎは全体の既定を引き継ぐ
  const one = {source: 'motion', motion: 'b'}, durB = Number((await lib.getMotion('b')).durationSec);
  await assert.rejects(motionRecipeInput(lib, {segments: [one, {...one, trim: [durB, null]}]}), e => e.code === 'bad-input');   // 終わりを省いて開始が長さぎりぎり: 0 コマの区間
  for (const [bad, code] of [[{segments: [one]}, 'bad-input'], [{segments: Array(MAX_SEGMENTS + 1).fill(one)}, 'bad-input'], [{segments: 'b'}, 'bad-input'],
    [{segments: [one, {source: 'vrma', path: 'C:/x.vrma'}]}, 'bad-input'], [{segments: [one, {source: 'motion', motion: 'no-such'}]}, 'not-found'],
    [{segments: [one, {source: 'motion', motion: '../b'}]}, 'bad-id'], [{segments: [one, {...one, trim: [0, 999]}]}, 'bad-input'], [{segments: [one, {...one, trim: [1, 1.05]}]}, 'bad-input'],
    [{segments: [one, {...one, trim: '0-1'}]}, 'bad-input'], [{segments: [one, {...one, speed: 5}]}, 'bad-input'], [{segments: [one, {...one, speed: ['2']}]}, 'bad-input'],
    [{segments: [{...one, bridge: {seconds: 1}}, one]}, 'bad-input'], [{segments: [one, {...one, bridge: {seconds: 4}}]}, 'bad-input'],
    [{segments: [one, one], bridge: {method: 'magic'}}, 'bad-input'], [{segments: [one, one], label: 3}, 'bad-input'], [{segments: [one, one], label: 'あ'.repeat(101)}, 'bad-input']]) {
    await assert.rejects(motionRecipeInput(lib, bad), e => e.code === code, JSON.stringify(bad));
  }
});

test('compose.py の計画: 区間は vrma で、保管場所は ID、ジョブの結果は写したパスと記録。名前に番号を付ける。既定と違う値だけ書く', () => {
  const rec = {id: null, sha256: 'abc', job: {id: 'j1', type: 'motion-text', candidate: 2}};
  const plan = composePlan('L', {bridge: DEFAULT_BRIDGE, segments: [{source: 'motion', motion: 'x'}, {source: 'job', job: 'j1', n: 2, trim: [0.5, null], speed: 2, bridge: {seconds: 0.6, method: 'interpolate'}}]},
    [{name: '歩く', plan: {motion: 'x'}}, {name: '振る（候補 2）', plan: {path: 'W/segments/2/motion.vrma', license: 'W/segments/2/license.json', motionRecord: rec}}]);
  assert.deepEqual(plan, {library: 'L', bridge: DEFAULT_BRIDGE, segments: [{source: 'vrma', motion: 'x', label: '1: 歩く'},
    {source: 'vrma', path: 'W/segments/2/motion.vrma', license: 'W/segments/2/license.json', motionRecord: rec, label: '2: 振る（候補 2）', trim: [0.5, null], speed: 2, bridge: {seconds: 0.6, method: 'interpolate'}}]});
});

// ---- 確認待ちのジョブの結果を区間にする(文章は Kimodo の試しの動き、動画は vrma-pipeline の試しの動き) ----
const JOB_FAKES = {...FAKE, CHARASTA_FAKE_KIMODO: '1', CHARASTA_FAKE_VRMA_PIPELINE: '1'};
async function setupJobs(t) {
  const s = await setup(t, JOB_FAKES);
  await s.lib.createCharacter({id: 'c1', name: 'キャラc1'});
  await s.lib.importVersion({charId: 'c1', id: 'v1', label: '試し', data: fakeGlb(), latest: true});
  const text = await s.q.enqueue({type: 'motion-text', text: '手を振る。', candidates: 2, label: '手を振る'});
  const video = await s.q.enqueue({type: 'video-motion', charId: 'c1', url: 'https://example.com/v.mp4', rights: '自分で撮った試しの動画', label: '踊る動画'});
  await s.q.whenIdle();
  for (const j of [text, video]) assert.equal((await s.q.get(j.id)).state, 'done', (await s.q.get(j.id)).error);
  return {...s, text: text.id, video: video.id};
}

test('ジョブの結果の区間: 一覧は文章の候補ごとと動画 1 本。積むのは確認待ちだけで、文章は n が要り、動画は n を書かない', async t => {
  const {lib, q, text, video} = await setupJobs(t);
  const sources = await q.recipeSources();
  assert.deepEqual(sources.map(s => [s.job, s.n, s.kind, s.name, s.limit.text]),
    [[text, 1, '文章', '手を振る（候補 1）', '二次配布 不可'], [text, 2, '文章', '手を振る（候補 2）', '二次配布 不可'], [video, null, '動画', '踊る動画', '個人利用のみ']]);
  assert.ok(sources.every(s => s.durationSec > 0));
  const jobs = {get: id => q.peek(id), dir: id => path.join(lib.dir, 'jobs', id)};
  const ok = await motionRecipeInput(lib, {segments: [{source: 'job', job: text, n: 2, trim: [0, 1]}, {source: 'motion', motion: 'b'}, {source: 'job', job: video}]}, jobs);
  assert.deepEqual(ok.segments, [{source: 'job', job: text, n: 2, trim: [0, 1]}, {source: 'motion', motion: 'b'}, {source: 'job', job: video}]);
  assert.equal(ok.label, '手を振る（候補 2） + 踊る + 踊る動画');
  const one = {source: 'motion', motion: 'b'}, durText = sources[0].durationSec;
  for (const [bad, code] of [[{source: 'job', job: text}, 'bad-input'], [{source: 'job', job: text, n: 3}, 'bad-input'], [{source: 'job', job: text, n: '1'}, 'bad-input'],
    [{source: 'job', job: video, n: 1}, 'bad-input'], [{source: 'job', job: 'jnope'}, 'not-found'], [{source: 'job', job: '../x'}, 'bad-id'],
    [{source: 'job', job: text, n: 1, trim: [0, durText + 1]}, 'bad-input']]) {
    await assert.rejects(motionRecipeInput(lib, {segments: [one, bad]}, jobs), e => e.code === code, JSON.stringify(bad));
  }
  const gen = (await q.list()).find(j => j.type === 'motion-gen').id;   // 取り込み済みの MotionBricks のジョブは保管場所のモーションを使う
  await assert.rejects(motionRecipeInput(lib, {segments: [one, {source: 'job', job: gen}]}, jobs), e => e.code === 'bad-input' && /保管場所のモーション mb-a を使う/.test(e.message));
  const recipeJob = (await q.enqueue({type: 'motion-recipe', segments: [one, one], bridge: {seconds: 0, method: 'interpolate'}})).id;   // 文章、動画、MotionBricks のジョブだけを使える
  await assert.rejects(motionRecipeInput(lib, {segments: [one, {source: 'job', job: recipeJob}]}, jobs), e => e.code === 'not-found');
  await q.whenIdle();
  await q.importVideoMotion(video, {motionId: 'vid'});
  await assert.rejects(motionRecipeInput(lib, {segments: [one, {source: 'job', job: video}]}, jobs), e => e.code === 'bad-input' && /保管場所のモーション vid を使う/.test(e.message));
  assert.deepEqual((await q.recipeSources()).map(s => s.job), [text, text], '取り込んだ動画は一覧から消える');
});

test('ジョブの結果の区間: 写してからつなぎ、記録にジョブと候補を残す。使っている間は捨てられず、別の候補を取り込んでも使う候補は消えない', async t => {
  const {lib, q, dir, text, video} = await setupJobs(t);
  const textBefore = await fs.readFile(path.join(dir, 'jobs', text, 'cand', '2', 'motion.vrma'));
  const job = await q.enqueue({type: 'motion-recipe', segments: [{source: 'job', job: text, n: 2}, {source: 'motion', motion: 'b', trim: [0, 1]}, {source: 'job', job: video}],
    bridge: {seconds: 0.5, method: 'interpolate'}});
  assert.ok(['queued', 'running'].includes(q.peek(job.id).state));
  await assert.rejects(q.discardTextMotion(text), e => e.code === 'busy' && e.message.includes(job.id));
  await assert.rejects(q.discardVideoMotion(video), e => e.code === 'busy');
  await q.importTextMotion(text, {n: 1, motionId: 'text-one'});   // 別の候補を取り込んでも、つなぐジョブが使う候補 2 は残す
  await fs.access(path.join(dir, 'jobs', text, 'cand', '2', 'motion.vrma'));
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error + '\n' + done.logTail);
  assert.deepEqual(await fs.readFile(path.join(dir, 'jobs', job.id, 'segments', '1', 'motion.vrma')), textBefore, '作業フォルダへ写した');
  const r = done.result;
  assert.deepEqual(r.segments.map(s => [s.source, s.name, s.limit.text]), [['job', '手を振る（候補 2）', '二次配布 不可'], ['motion', '踊る', '二次配布 可'], ['job', '踊る動画', '個人利用のみ']]);
  assert.ok(r.license.summary.startsWith('個人利用のみ'), '動画の個人利用の条件がそのまま全体の条件になる');
  assert.deepEqual(r.license.terms.map(x => x.holder), [motionTextLicense().holder, 'H', (await q.get(video)).result.license.holder]);
  assert.deepEqual(r.license.terms[0].terms, motionTextLicense().terms, '文章の区間は取り込みと同じ Kimodo の記録');

  await q.discardVideoMotion(video);   // 終わったあとは捨てられる。つないだ結果は写したもので取り込める
  const m = await q.importRecipeMotion(job.id, {});
  const rec = await lib.getMotion(m.id);
  const [a, , c] = rec.generated.segments;
  assert.deepEqual(a.motionRecord.job, {id: text, type: 'motion-text', candidate: 2});
  assert.equal(a.motionRecord.sha256, crypto.createHash('sha256').update(textBefore).digest('hex'));
  assert.deepEqual([a.motionRecord.id, a.motionRecord.contacts, a.motionRecord.source.path], [null, 'contacts.json', `jobs/${text}/cand/2/motion.vrma`]);
  assert.deepEqual(c.motionRecord.job, {id: video, type: 'video-motion', candidate: null});
  assert.equal(c.motionRecord.source.pack, 'vrma-pipeline（動画から変換）');
  assert.deepEqual(rec.generated.recipe.segments.map(s => s.source), ['job', 'motion', 'job']);
  assert.equal(rec.limit.text, '個人利用のみ');
  assert.equal((await lib.getMotion('text-one')).generated.candidate, 1, '取り込んだモーションはそのまま');
});

test('残した候補は、使うつなぐジョブがすべて終わってから消す。確認待ちのままのジョブの候補は消さない', async t => {
  const {q, dir, text} = await setupJobs(t);
  const cand = n => path.join(dir, 'jobs', text, 'cand', String(n));
  const exists = n => fs.access(cand(n)).then(() => true, () => false);
  const seg = [{source: 'job', job: text, n: 2}, {source: 'motion', motion: 'b', trim: [0, 1]}];
  // (3) 確認待ちのまま、使ったつなぐジョブが終わっても、候補は選ぶ前なので消さない
  const first = await q.enqueue({type: 'motion-recipe', segments: seg, bridge: {seconds: 0.5, method: 'interpolate'}});
  await q.whenIdle();
  assert.equal((await q.get(first.id)).state, 'done');
  assert.deepEqual([await exists(1), await exists(2)], [true, true]);
  // (2) 2 本のつなぐジョブが候補 2 を使う間に候補 1 を取り込む。1 本目が終わっても 2 本目が使うので残り、2 本目が終わると消える
  const a = await q.enqueue({type: 'motion-recipe', segments: seg, bridge: {seconds: 0.5, method: 'interpolate'}});
  const b = await q.enqueue({type: 'motion-recipe', segments: seg, bridge: {seconds: 0.5, method: 'interpolate'}});
  await q.importTextMotion(text, {n: 1, motionId: 'text-one'});
  assert.equal(await exists(2), true, '取り込みでは使う候補を残す');
  let sawOne = false;
  for (let i = 0; i < 2000 && !sawOne; i++) {
    if (q.peek(a.id).state === 'done' && q.peek(b.id).state !== 'done') sawOne = true;
    else await new Promise(r => setTimeout(r, 5));
  }
  if (sawOne) {
    // 1 本目が終わった直後(2 本目はまだ順番待ちか実行中)。候補 2 はまだ消えていない
    assert.equal(await exists(2), true, '別のつなぐジョブがまだ使う間は消さない');
  }
  await q.whenIdle();
  assert.equal((await q.get(b.id)).state, 'done');
  assert.deepEqual([await exists(1), await exists(2)], [true, false], '取り込んだ候補は残り、使い終えた候補は消える');
});

test('ジョブの結果の区間: 実行の直前に検査する。捨てたジョブや消えた候補のファイルは compose.py の前に断る', async t => {
  const {lib, q, dir, text} = await setupJobs(t);
  const jobs = {get: id => q.peek(id), dir: id => path.join(lib.dir, 'jobs', id)};
  const run = async segments => {
    const workDir = path.join(dir, 'w-' + Math.random().toString(36).slice(2));
    await fs.mkdir(workDir);
    const ctx = {job: {id: 'jx', input: {label: 'x', bridge: DEFAULT_BRIDGE, segments}}, workDir, step: async () => {}, run: async () => { throw new Error('compose.py を呼んだ'); }};
    return runMotionRecipe(ctx, {lib, tools: {}, env: FAKE, jobs});
  };
  await fs.rm(path.join(dir, 'jobs', text, 'cand', '1'), {recursive: true});
  await assert.rejects(run([{source: 'job', job: text, n: 1}, {source: 'motion', motion: 'b'}]), /区間 1 のジョブ .* の結果のファイルが無い（候補 1。/);
  await q.discardTextMotion(text);
  await assert.rejects(run([{source: 'motion', motion: 'b'}, {source: 'job', job: text, n: 2}]), /区間 2 のジョブ .* は確認待ちではない（捨てた）/);
});

test('利用条件の記録は lib/model-licenses.json の 1 か所。文章からの取り込みの記録は 1 か所にまとめる前と同じ', () => {
  const file = JSON.parse(fsSync.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'model-licenses.json'), 'utf8'));
  assert.deepEqual(motionTextLicense(), file.kimodoText);
  assert.deepEqual(motionTextLicense(), {
    holder: 'NVIDIA（Kimodo）、McGill-NLP（LLM2Vec）、Meta（Llama 3）',
    summary: 'Kimodo-SOMA-RP-v1.2 は NVIDIA Open Model License。文章の埋め込みに LLM2Vec（MIT）と Meta Llama 3 8B Instruct（Meta Llama 3 Community License）を使った。'
      + '見本の動きは使っていない。Llama 3 の利用は Acceptable Use Policy（https://llama.meta.com/llama3/use-policy/）に従う。'
      + 'Llama Materials（その派生物を含む）や、それを使った製品・サービスを配布・提供するときは、「Built with Meta Llama 3」の表示とライセンス文の写しが要る（Llama 3 Community License 1.b.i）',
    redistribution: false,
    terms: [
      {part: '生成したモデル（Kimodo-SOMA-RP-v1.2）', license: 'NVIDIA Open Model License', url: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/'},
      {part: 'Kimodo のコード', license: 'Apache 2.0'},
      {part: '文章の埋め込み（LLM2Vec: McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp と -mntp-supervised）', license: 'MIT'},
      {part: '文章の埋め込みの元のモデル（Meta Llama 3 8B Instruct）', license: 'Meta Llama 3 Community License', url: 'https://llama.meta.com/llama3/license/',
        policy: 'Acceptable Use Policy: https://llama.meta.com/llama3/use-policy/',
        condition: 'Llama Materials（その派生物を含む）や、それを使った製品・サービスを配布・提供するときは、ライセンス文の写しを添え、関連するサイト・画面・文書に「Built with Meta Llama 3」を目立つように表示する（1.b.i）'},
      {part: '見本の動き（MotionBricks の BVH）', license: '使っていない'},
    ],
  });
  motionTextLicense().terms.pop();
  assert.equal(motionTextLicense().terms.length, 5, '呼ぶたびに写しを返す');
});

test('motion-recipe ジョブ: 積む -> 確認待ち(継ぎ目の値と許諾) -> 取り込むと generated と接地が付く。元のモーションは変わらない', async t => {
  const {lib, q, dir} = await setup(t);
  const before = await fs.readFile(path.join(dir, 'motions/mb-a/motion.json'));
  const job = await q.enqueue(recipe());
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error + '\n' + done.logTail);
  const r = done.result;
  assert.equal(r.review, 'waiting');
  assert.equal(r.report.seams.length, 2);   // 区間とつなぎの境が 2 つ
  assert.ok(r.report.footSlide.all && r.report.elsewhereP99.speedMps >= 0 && r.report.hipsHeight.length === 3);
  assert.deepEqual(r.bridges.map(b => [b.method, b.reason]), [['interpolate', '--fake']]);
  assert.equal(r.license.evaluationOnly, true, '評価用の区間が入ると全体が評価用');
  assert.equal(r.segments[0].limit.text, '評価用のみ');
  assert.deepEqual((await q.recipeMotionsWaiting()).map(j => j.id), [job.id]);
  const vrma = await fs.readFile(await q.recipeMotionFile(job.id, 'motion.vrma'));
  assert.ok(Math.abs(parseVrma(vrma).durationSec - r.durationSec) < 0.05);
  await assert.rejects(q.recipeMotionFile(job.id, 'plan.json'), e => e.code === 'not-found');

  const m = await q.importRecipeMotion(job.id, {label: 'つないだ'});
  assert.equal(m.id, 'compose-' + job.id);
  const rec = await lib.getMotion(m.id);
  assert.equal(rec.label, 'つないだ');
  assert.equal(rec.generated.tool, 'motion-compose');
  assert.deepEqual(rec.generated.recipe.segments.map(s => s.motion), ['mb-a', 'b']);
  assert.equal(rec.generated.segments[0].motionRecord.contacts, 'contacts.json', '区間の接地は横の contacts.json から読んだ');
  assert.equal(rec.generated.segments[1].motionRecord.contacts, null);
  assert.equal(rec.generated.bridges.length, 1);
  assert.equal(rec.limit.text, '評価用のみ');
  assert.equal(rec.contacts, 'contacts.json');
  assert.deepEqual(await fs.readFile(path.join(dir, 'motions/mb-a/motion.json')), before);
  assert.equal((await q.get(job.id)).result.review, 'imported');
  await assert.rejects(q.importRecipeMotion(job.id, {}), e => e.code === 'exists', '確認待ちでないものは取り込めない');
});

test('motion-recipe ジョブ: 捨てると作業フォルダはごみ箱へ。失敗(試しの動き fail、MotionBricks の場所が無い)は failed', async t => {
  const {q, dir} = await setup(t);
  const job = await q.enqueue(recipe({bridge: {seconds: 0.5, method: 'interpolate'}}));
  await q.whenIdle();
  await q.discardRecipeMotion(job.id);
  assert.equal((await q.get(job.id)).result.review, 'discarded');
  assert.ok(JSON.parse(await fs.readFile(path.join(dir, 'trash', `motion-recipe-${job.id}`, 'trash.json'), 'utf8')).sizeBytes > 0);
  await assert.rejects(fs.access(path.join(dir, 'jobs', job.id)));

  q.extraEnv = {CHARASTA_FAKE_MOTIONBRICKS: 'fail'};
  const bad = await q.enqueue(recipe());
  await q.whenIdle();
  assert.match((await q.get(bad.id)).error, /試しの動き/);
  q.extraEnv = {};
  q.tools = {motionbricksDir: path.join(dir, 'no-such')};
  const none = await q.enqueue(recipe());
  await q.whenIdle();
  assert.match((await q.get(none.id)).error, /MotionBricks が見つからない/);
});

test('ごみ箱: 順番待ちのつなぐジョブが使うモーションは消せない', async t => {
  const {lib} = await setup(t);
  const trash = new Trash(lib, {active: async () => [{id: 'j1', type: 'motion-recipe', input: {segments: [{source: 'motion', motion: 'b'}]}}]});
  assert.equal((await trash.impact('motion', {id: 'b'})).refusal?.code, 'busy');
  assert.equal((await trash.impact('motion', {id: 'mb-a'})).refusal, null);
});

test('API: GET /api/motion-recipes、POST /api/jobs で積み、VRMA を配り、取り込むと /api/motions に出る', async () => {
  const s = await startServer({env: FAKE});
  try {
    const call = async (method, p, body) => { const r = await fetch(s.base + p, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)}); return {status: r.status, body: await r.text()}; };
    const o = JSON.parse((await call('GET', '/api/motion-recipes')).body);
    assert.equal(o.motionbricks, true); assert.deepEqual(o.waiting, []); assert.deepEqual(o.sources, []); assert.deepEqual(o.defaultBridge, DEFAULT_BRIDGE);
    assert.equal((await call('POST', '/api/jobs', {type: 'motion-gen', kind: 'forward', seconds: 2, motionId: 'mb-a'})).status, 201);
    assert.equal((await call('POST', '/api/jobs', {type: 'motion-gen', kind: 'skipping', seconds: 2, motionId: 'mb-b'})).status, 201);
    await s.server.jobs.whenIdle();   // 区間のモーションは積むときに保管場所にある必要がある。motion-gen は確認待ちなので取り込む
    for (const j of JSON.parse((await call('GET', '/api/motion-gen')).body).waiting) assert.equal((await call('POST', `/api/motion-gen/${j.id}/import`, {})).status, 201);
    assert.equal((await call('POST', '/api/jobs', {type: 'motion-recipe', segments: [{source: 'motion', motion: 'nope'}, {source: 'motion', motion: 'mb-a'}]})).status, 404);
    const job = JSON.parse((await call('POST', '/api/jobs', {type: 'motion-recipe', segments: [{source: 'motion', motion: 'mb-a'}, {source: 'motion', motion: 'mb-b'}]})).body);
    await s.server.jobs.whenIdle();
    const waiting = JSON.parse((await call('GET', '/api/motion-recipes')).body).waiting;
    assert.deepEqual(waiting.map(j => j.id), [job.id]);
    const file = await fetch(s.base + waiting[0].result.vrmaUrl);
    assert.equal(file.status, 200); assert.equal(file.headers.get('content-type'), 'model/gltf-binary');
    assert.equal((await fetch(s.base + waiting[0].result.contactsUrl)).status, 200);
    assert.equal((await call('GET', `/api/motion-recipes/${job.id}/import`)).status, 405);
    assert.equal((await call('POST', `/api/motion-recipes/nojob/import`, {})).status, 404);
    const imp = await call('POST', `/api/motion-recipes/${job.id}/import`, {motionId: 'compose-test'});
    assert.equal(imp.status, 201, imp.body);
    const list = JSON.parse((await call('GET', '/api/motions')).body);
    assert.ok(list.some(m => m.id === 'compose-test' && m.generated.tool === 'motion-compose' && m.contactsUrl));
    assert.equal((await fetch(s.base + waiting[0].result.vrmaUrl)).status, 409, '取り込んだあとは配らない');
  } finally { await s.close(); }
});

// ---- MotionBricks の条件の区間(段階 3)と、MotionBricks のジョブの確認待ちの結果 ----
test('MotionBricks の区間: 条件は motion-gen と同じ規則で確かめ、既定を埋める。speed は動きの速さ(m/s)で、切り出しの終わりは長さを超えてよい', async t => {
  const {lib} = await setup(t);
  const one = {source: 'motion', motion: 'b'};
  const ok = await motionRecipeInput(lib, {segments: [{source: 'motionbricks', kind: 'strafe', direction: 'left', seconds: 3, trim: [0.5, 9]}, one]});
  assert.deepEqual(ok.segments[0], {source: 'motionbricks', kind: 'strafe', speed: 2.3, direction: 'left', turn: 0, seconds: 3, action: 'none', ending: 'stop', root: 'keep', trim: [0.5, 9]});
  assert.equal(ok.label, '向きを保って動く 2.3 m/s、左へ、3 秒、止まる + 踊る');
  for (const bad of [{kind: 'fly'}, {speed: 9}, {kind: 'zombie', speed: 2}, {speed: ['2']}, {seconds: 0.5}, {seconds: true}, {turn: 400}, {kind: 'crouch', action: 'jump'},
    {action: 'duck', seconds: 3}, {ending: 'loop'}, {root: ['keep']}, {trim: [4, null], seconds: 3}]) {
    await assert.rejects(motionRecipeInput(lib, {segments: [{source: 'motionbricks', ...bad}, one]}), e => e.code === 'bad-input', JSON.stringify(bad));
  }
  await assert.rejects(motionRecipeInput(lib, {segments: [{source: 'motionbricks', kind: 'fly'}, one]}), /区間 1 の kind は/);
});

test('compose.py の計画: MotionBricks の区間は source が motionbricks で条件をそのまま渡す', () => {
  const seg = {source: 'motionbricks', kind: 'forward', speed: 2.3, direction: 'forward', turn: 0, seconds: 2, action: 'none', ending: 'stop', root: 'keep'};
  const plan = composePlan('L', {bridge: DEFAULT_BRIDGE, segments: [seg, {source: 'motion', motion: 'x', bridge: {seconds: 1, method: 'motionbricks'}}]},
    [{name: '歩く', plan: {...seg}}, {name: 'x', plan: {motion: 'x'}}]);
  assert.deepEqual(plan.segments[0], {...seg, label: '1: 歩く'});
  assert.equal(plan.segments[1].source, 'vrma');
});

test('motion-recipe ジョブ: MotionBricks の区間 + 保管場所のモーション。区間の記録に条件と評価用の利用条件が残り、全体も評価用になる', async t => {
  const {lib, q} = await setup(t);
  const job = await q.enqueue({type: 'motion-recipe', segments: [{source: 'motionbricks', kind: 'forward', speed: 2, seconds: 2}, {source: 'motion', motion: 'b', trim: [0, 1]}],
    bridge: {seconds: 0.5, method: 'interpolate'}});
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error + '\n' + done.logTail);
  const r = done.result;
  assert.deepEqual(r.segments.map(s => [s.source, s.name, s.limit.text]), [['motionbricks', '歩き・走り 2 m/s、2 秒、止まる', '評価用のみ'], ['motion', '踊る', '二次配布 可']]);
  assert.equal(r.license.evaluationOnly, true);
  assert.ok(r.license.summary.startsWith('MotionBricks のモデル'), '評価用の区間の文が先');
  assert.equal(r.license.terms[0].evaluationOnly, true);
  const m = await q.importRecipeMotion(job.id, {});
  const g = (await lib.getMotion(m.id)).generated, s0 = g.segments[0];
  assert.deepEqual([s0.source, s0.kind, s0.speed, s0.seconds, s0.motionbricks.tool, s0.motionbricks.model, s0.motionbricks.frames], ['motionbricks', 'forward', 2, 2, 'MotionBricks', '試しの動き', 61]);
  assert.equal(s0.license.evaluationOnly, true);
  assert.deepEqual(g.recipe.segments[0], {source: 'motionbricks', kind: 'forward', speed: 2, direction: 'forward', turn: 0, seconds: 2, action: 'none', ending: 'stop', root: 'keep'});
  assert.equal((await lib.getMotion(m.id)).limit.text, '評価用のみ');
  // MotionBricks が無く、試しの動きでもなければ、区間に MotionBricks の条件があるだけで compose.py の前に断る(つなぎが補間でも)
  q.extraEnv = {}; q.tools = {motionbricksDir: path.join(await tempDir(), 'none')};
  const none = await q.enqueue({type: 'motion-recipe', segments: [{source: 'motionbricks', seconds: 1}, {source: 'motion', motion: 'b'}], bridge: {seconds: 0.5, method: 'interpolate'}});
  await q.whenIdle();
  assert.match((await q.get(none.id)).error, /MotionBricks が見つからない.*MotionBricks の条件の区間を外し/);
});

test('MotionBricks のジョブの確認待ちの結果を区間にする。一覧に出て、使っている間は捨てられず、取り込んだあとも写したもので動く', async t => {
  const {lib, q} = await setup(t);
  const gen = await q.enqueue({type: 'motion-gen', kind: 'skipping', seconds: 2, motionId: 'mb-skip'});
  await q.whenIdle();
  const sources = await q.recipeSources();
  assert.deepEqual(sources.map(s => [s.job, s.n, s.kind, s.limit.text]), [[gen.id, null, 'MotionBricks', '評価用のみ']]);
  const jobs = {get: id => q.peek(id), dir: id => path.join(lib.dir, 'jobs', id)};
  await assert.rejects(motionRecipeInput(lib, {segments: [{source: 'job', job: gen.id, n: 1}, {source: 'motion', motion: 'b'}]}, jobs), /結果が 1 本なので n を書かない/);
  const job = await q.enqueue({type: 'motion-recipe', segments: [{source: 'job', job: gen.id}, {source: 'motion', motion: 'b'}], bridge: {seconds: 0.5, method: 'interpolate'}});
  await assert.rejects(q.discardGenMotion(gen.id), e => e.code === 'busy');
  await q.importGenMotion(gen.id, {});
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error + '\n' + done.logTail);
  const m = await q.importRecipeMotion(job.id, {});
  const s0 = (await lib.getMotion(m.id)).generated.segments[0];
  assert.deepEqual(s0.motionRecord.job, {id: gen.id, type: 'motion-gen', candidate: null});
  assert.equal(s0.motionRecord.source.pack, 'MotionBricks で生成');
  assert.equal(s0.motionRecord.contacts, 'contacts.json');
  assert.equal((await lib.getMotion(m.id)).limit.text, '評価用のみ');
});

test('compose.py の MotionBricks の条件の確かめは lib/motion-gen.mjs と同じ規則(既定の値と断る値)', async () => {
  const {motionGenConditions} = await import('../lib/motion-gen.mjs');
  const cases = [{}, {kind: 'strafe', direction: 'left'}, {kind: 'zombie', direction: 'left'}, {seconds: '3', speed: 2}, {kind: 'forward', action: 'jump', seconds: 4, turn: -90},
    {kind: 'fly'}, {speed: 9}, {speed: true}, {seconds: ['3']}, {kind: 'crouch', action: 'jump'}, {action: 'duck', seconds: 3}, {turn: 400}, {root: 'x'}, {speed: ' '}];
  const js = cases.map(c => { try { return motionGenConditions(c); } catch { return null; } });
  const {execFileSync} = await import('node:child_process');
  const script = ['import json, sys', `sys.path.insert(0, ${JSON.stringify(path.join(import.meta.dirname, '..', 'tools', 'compose'))})`, 'import compose', 'out = []',
    'for c in json.loads(sys.stdin.read()):', '    try:', '        out.append(compose.mb_conditions(c, "x"))', '    except SystemExit:', '        out.append(None)', 'print(json.dumps(out))'].join('\n');
  const py = JSON.parse(execFileSync(findPython() ?? 'python', ['-c', script], {input: JSON.stringify(cases), encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1'}}));
  assert.deepEqual(py, js);
  assert.equal(js.filter(x => x === null).length, 9);
});
