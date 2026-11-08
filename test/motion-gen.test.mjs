// モーションを作るジョブ motion-gen。CHARASTA_FAKE_MOTIONBRICKS で MotionBricks を呼ばずに動かす(python と numpy は要る)。
import test from 'node:test';
import {findPython} from '../lib/platform.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Library} from '../lib/library.mjs';
import {JobQueue} from '../lib/jobs.mjs';
import {parseVrma} from '../lib/vrma.mjs';
import {describe, motionGenLicense} from '../lib/motion-gen.mjs';
import {tempDir, startServer} from './helpers.mjs';

const FAKE = {CHARASTA_FAKE_MOTIONBRICKS: '1'};
async function setup(t, env = FAKE, tools = {}) {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const lib = new Library(dir);
  return {lib, q: new JobQueue({lib, env, tools})};
}
// 積んで確認待ちまで動かし、取り込む(motion-gen は確認待ちで止まる)
async function made(q, body, importBody = {}) {
  const job = await q.enqueue({type: 'motion-gen', ...body});
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error + '\n' + done.logTail);
  return {job: done, motion: await q.importGenMotion(job.id, importBody)};
}

test('移し替え: VRM の骨の向きが SOMA の骨の向きと同じになり、VRMA に回転と hips の位置がそのまま入る(test/soma_vrma_check.py)', () => {
  const out = execFileSync(findPython() ?? 'python', [path.join(import.meta.dirname, 'soma_vrma_check.py')], {encoding: 'utf8'});
  assert.match(out, /^OK /m);
});

test('motion-gen ジョブ: 積む -> 確認待ち -> 取り込むとモーションとして登録され、生成の条件とライセンスの記録が残る', async t => {
  const {lib, q} = await setup(t);
  const job = await q.enqueue({type: 'motion-gen', kind: 'forward', speed: 2, turn: 90, seconds: 2, motionId: 'mb-walk'});
  assert.equal(job.state, 'queued');
  assert.deepEqual({...job.input}, {kind: 'forward', speed: 2, direction: 'forward', turn: 90, seconds: 2, action: 'none', ending: 'stop', root: 'keep',
    label: '歩き・走り 2 m/s、左へ 90 度曲がる、2 秒、止まる', motionId: 'mb-walk'});
  await q.whenIdle();
  const done = await q.get(job.id);
  assert.equal(done.state, 'done', done.error + '\n' + done.logTail);
  assert.equal(done.result.motionId, 'mb-walk'); assert.equal(done.result.frames, 61);
  assert.equal(done.result.review, 'waiting'); assert.equal(done.result.license.evaluationOnly, true);
  assert.deepEqual(await lib.listMotions(), [], '確認待ちの間は保管場所に入れない');
  assert.deepEqual((await q.genMotionsWaiting()).map(j => j.id), [job.id]);
  assert.equal(parseVrma(await fs.readFile(await q.genMotionFile(job.id, 'motion.vrma'))).durationSec, 2);
  await assert.rejects(q.genMotionFile(job.id, 'info.json'), e => e.code === 'not-found');
  await q.importGenMotion(job.id, {});
  assert.equal((await q.get(job.id)).result.review, 'imported');
  await assert.rejects(q.importGenMotion(job.id, {}), e => e.code === 'exists', '確認待ちでないものは取り込めない');
  const [m] = await lib.listMotions();
  assert.equal(m.id, 'mb-walk'); assert.equal(m.label, job.input.label); assert.equal(m.file, '/lib/motions/mb-walk/motion.vrma');
  assert.equal(m.durationSec, 2); assert.ok(m.bones.includes('hips') && m.bones.includes('leftToes') && !m.bones.includes('upperChest'));
  assert.equal(m.source.pack, 'MotionBricks で生成');
  assert.equal(m.license.redistribution, false); assert.equal(m.license.evaluationOnly, true);
  assert.match(m.license.summary, /NVIDIA Open Model Agreement/); assert.match(m.license.summary, /NVIDIA Sample Data Evaluation License/);
  assert.deepEqual(m.license.terms.map(t => t.license.split('（')[0]), ['NVIDIA Open Model Agreement', 'NVIDIA Sample Data Evaluation License', 'Apache 2.0']);
  assert.equal(m.generated.job, job.id); assert.equal(m.generated.options.turn, 90); assert.equal(m.generated.frames, 61);
  // 保管場所の VRMA を読み直しても同じ
  const v = parseVrma(await fs.readFile(path.join(lib.dir, 'motions/mb-walk/motion.vrma')));
  assert.equal(v.durationSec, 2); assert.equal(v.usesShoulder, true);
  assert.match(await fs.readFile(path.join(lib.dir, 'jobs', job.id + '.log'), 'utf8'), /== 確認を待つ/);
});

test('motion-gen ジョブの確認: ラベルと ID を変えて取り込める。捨てると作業フォルダはごみ箱へ。確認待ちの ID は次のジョブに使えない', async t => {
  const {lib, q} = await setup(t);
  const a = await q.enqueue({type: 'motion-gen', seconds: 1, motionId: 'mb-a'});
  await assert.rejects(q.enqueue({type: 'motion-gen', seconds: 1, motionId: 'mb-a'}), {code: 'exists'});
  await q.whenIdle();
  await assert.rejects(q.enqueue({type: 'motion-gen', seconds: 1, motionId: 'mb-a'}), {code: 'exists'}, '確認待ちの間も同じ ID は積めない');
  const m = await q.importGenMotion(a.id, {label: '歩く', motionId: 'walk-1'});
  assert.equal(m.id, 'walk-1'); assert.equal((await lib.getMotion('walk-1')).label, '歩く');
  assert.equal((await q.get(a.id)).result.motionId, 'walk-1');
  const b = await q.enqueue({type: 'motion-gen', seconds: 1, motionId: 'mb-b'});
  await q.whenIdle();
  await q.discardGenMotion(b.id);
  assert.equal((await q.get(b.id)).result.review, 'discarded');
  assert.equal(JSON.parse(await fs.readFile(path.join(lib.dir, 'trash', `motion-gen-${b.id}`, 'trash.json'), 'utf8')).kind, 'motion-gen');
  await assert.rejects(fs.access(path.join(lib.dir, 'jobs', b.id)));
  assert.equal(await lib.motionExists('mb-b'), false);
  await assert.rejects(q.discardGenMotion(b.id), e => e.code === 'exists');
});

test('MotionBricks の許諾の記録は lib/model-licenses.json の motionbricksGen。値は 1 か所にまとめる前と同じ', () => {
  assert.deepEqual(motionGenLicense(['a.bvh']), {
    holder: 'NVIDIA（MotionBricks）、見本の動きは Bones 由来（NVIDIA Sample Data）',
    summary: 'MotionBricks のモデル（NVIDIA Open Model Agreement、商用可）で生成。生成の文脈と目標に、見本の動き'
      + '（NVIDIA Sample Data Evaluation License。NVIDIA の技術の評価・テスト用で、派生物の配布・提供は禁止）のポーズを使った',
    redistribution: false,
    evaluationOnly: true,
    terms: [
      {part: '生成したモデル', license: 'NVIDIA Open Model Agreement', url: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-agreement/'},
      {part: '生成の文脈と目標のポーズ（見本の動き）', license: 'NVIDIA Sample Data Evaluation License（v. Jan. 16, 2026）', file: 'assets/motions/LICENSE.txt', clips: ['a.bvh']},
      {part: 'MotionBricks のコード', license: 'Apache 2.0'},
    ],
  });
  assert.deepEqual(motionGenLicense([]).terms[1].clips, [], '呼ぶたびに写しを返す');
});

test('motion-gen ジョブ: 失敗(試しの動き fail、MotionBricks の場所が無い)は failed で、モーションを作らない', async t => {
  for (const [env, tools, re] of [[{CHARASTA_FAKE_MOTIONBRICKS: 'fail'}, {}, /MotionBricks が失敗した/],
    [{}, {motionbricksDir: path.join(await tempDir(), 'none')}, /MotionBricks の場所が無い/]]) {
    const {lib, q} = await setup(t, env, tools);
    const job = await q.enqueue({type: 'motion-gen', motionId: 'mb-x'});
    await q.whenIdle();
    const f = await q.get(job.id);
    assert.equal(f.state, 'failed'); assert.match(f.error, re);
    assert.equal(await lib.motionExists('mb-x'), false);
  }
});

test('motion-gen の入力の確かめ: 既定の値、範囲の外、種類に合わない動作、同じ ID', async t => {
  const {lib, q} = await setup(t);
  const j = await q.enqueue({type: 'motion-gen', kind: 'strafe', direction: 'left'});
  assert.equal(j.input.speed, 2.3); assert.equal(j.input.seconds, 6); assert.equal(j.input.direction, 'left'); assert.match(j.input.motionId, /^mb-strafe-/);
  assert.equal((await q.enqueue({type: 'motion-gen', kind: 'zombie', direction: 'left'})).input.direction, 'forward'); // 向きは strafe と crouch だけ
  const bad = async (body, code = 'bad-input') => assert.rejects(q.enqueue({type: 'motion-gen', ...body}), {code}, JSON.stringify(body));
  await bad({kind: 'fly'}); await bad({speed: 9}); await bad({kind: 'zombie', speed: 2}); await bad({speed: 'fast'});
  // 配列や真偽値は Number() で数になってしまうので、型で断る
  await bad({kind: ['strafe']}); await bad({kind: 'strafe', direction: ['left']}); await bad({action: ['jump']}); await bad({ending: ['stop']}); await bad({root: ['keep']});
  await bad({speed: ['2']}); await bad({turn: [90]}); await bad({seconds: ['3']}); await bad({seconds: true}); await bad({speed: ' '});
  await bad({label: ['a']}); await bad({label: 5});
  await bad({turn: 400}); await bad({seconds: 0.5}); await bad({seconds: 31}); await bad({direction: 'up', kind: 'strafe'});
  await bad({action: 'fly'}); await bad({kind: 'crouch', action: 'jump'}); await bad({action: 'duck', seconds: 3}); await bad({ending: 'loop'}); await bad({root: 'x'});
  await bad({label: 'あ'.repeat(101)}); await bad({motionId: '../x'}, 'bad-id');
  const same = await q.enqueue({type: 'motion-gen', motionId: 'same', seconds: 1});
  await bad({motionId: 'same'}, 'exists');   // 順番待ちにある
  await q.whenIdle();
  await bad({motionId: 'same'}, 'exists');   // 確認待ち
  await q.importGenMotion(same.id, {});
  await bad({motionId: 'same'}, 'exists');   // 取り込んだ
  assert.ok(await lib.motionExists('same'));
});

test('ラベルは条件から作る', () => {
  assert.equal(describe({kind: 'crouch', speed: 1.5, direction: 'right', turn: -45, seconds: 8, action: 'none', ending: 'move', root: 'inplace'}),
    'しゃがみ歩き 1.5 m/s、右へ、右へ 45 度曲がる、8 秒、止まらない、その場');
  assert.equal(describe({kind: 'forward', speed: 3, direction: 'forward', turn: 0, seconds: 6, action: 'jump', ending: 'stop', root: 'keep'}),
    '歩き・走り 3 m/s、低い物を跳び越す（0.5 m）、6 秒、止まる');
});

test('API: GET /api/motion-gen は選べる条件と確認待ちを返し、POST /api/jobs で作って取り込むと /api/motions に出る', async () => {
  const s = await startServer({env: FAKE});
  try {
    const opt = await (await fetch(s.base + '/api/motion-gen')).json();
    assert.equal(opt.available, true);
    assert.deepEqual(Object.keys(opt.kinds), ['forward', 'strafe', 'crouch', 'skipping', 'vogue', 'injured-torso', 'injured-leg', 'zombie', 'combat']);
    assert.deepEqual(Object.keys(opt.actions), ['none', 'jump', 'jump-high', 'duck']);
    assert.equal((await fetch(s.base + '/api/motion-gen', {method: 'POST'})).status, 405);
    const r = await fetch(s.base + '/api/jobs', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({type: 'motion-gen', seconds: 1, motionId: 'mb-api'})});
    assert.equal(r.status, 201);
    assert.equal((await fetch(s.base + '/api/jobs', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({type: 'motion-gen', speed: 99})})).status, 400);
    await s.server.jobs.whenIdle();
    const {waiting} = await (await fetch(s.base + '/api/motion-gen')).json();
    assert.equal(waiting.length, 1); assert.equal(waiting[0].result.review, 'waiting');
    const vrma = await fetch(s.base + waiting[0].result.vrmaUrl);
    assert.equal(vrma.status, 200); assert.equal(vrma.headers.get('content-type'), 'model/gltf-binary');
    assert.equal((await fetch(s.base + waiting[0].result.contactsUrl)).status, 200);
    assert.deepEqual(await (await fetch(s.base + '/api/motions')).json(), []);
    const post = (p, body) => fetch(s.base + p, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    assert.equal((await fetch(s.base + `/api/motion-gen/${waiting[0].id}/import`)).status, 405);
    assert.equal((await post('/api/motion-gen/nojob/import', {})).status, 404);
    assert.equal((await post(`/api/motion-gen/${waiting[0].id}/import`, {})).status, 201);
    assert.equal((await fetch(s.base + waiting[0].result.vrmaUrl)).status, 409, '取り込んだあとは配らない');
    const list = await (await fetch(s.base + '/api/motions')).json();
    assert.deepEqual(list.map(m => m.id), ['mb-api']); assert.equal(list[0].generated.options.seconds, 1);
    assert.equal((await fetch(s.base + list[0].file)).status, 200);
  } finally { await s.close(); }
});

test('motion-gen ジョブ: 足の接地を contacts.json としてモーションの横に置き、一覧に URL が出る。無いモーションには出ない', async t => {
  const {lib, q} = await setup(t);
  await made(q, {seconds: 1, motionId: 'mb-feet'});
  const c = JSON.parse(await fs.readFile(path.join(lib.dir, 'motions/mb-feet/contacts.json'), 'utf8'));
  assert.deepEqual(c.order, ['leftHeel', 'leftToe', 'rightHeel', 'rightToe']);
  assert.equal(c.fps, 30); assert.equal(c.frames.length, 31); assert.deepEqual(c.frames[0], [0, 1, 1, 0]);
  const m = (await lib.listMotions()).find(x => x.id === 'mb-feet');
  assert.equal(m.contacts, 'contacts.json'); assert.equal(m.contactsUrl, '/lib/motions/mb-feet/contacts.json');
  const data = await fs.readFile(path.join(lib.dir, 'motions/mb-feet/motion.vrma'));
  await lib.importMotion({id: 'plain', data, license: {}});
  const plain = (await lib.listMotions()).find(x => x.id === 'plain');
  assert.equal(plain.contacts, undefined); assert.equal(plain.contactsUrl, undefined);
  await assert.rejects(fs.access(path.join(lib.dir, 'motions/plain/contacts.json')));
});

test('MotionBricks の場所が無く、試しの動きでもなければ available は false', async () => {
  const s = await startServer({motionbricksDir: path.join(await tempDir(), 'none')});
  try { assert.equal((await (await fetch(s.base + '/api/motion-gen')).json()).available, false); } finally { await s.close(); }
});

test('取り込み済みで evaluationOnly を持たない MotionBricks 製のモーションは、一覧が読むときに evaluationOnly を補い、ファイルは書き換えない', async t => {
  const {lib, q} = await setup(t);
  await made(q, {seconds: 1, motionId: 'mb-old'});
  const file = path.join(lib.dir, 'motions/mb-old/motion.json');
  const json = JSON.parse(await fs.readFile(file, 'utf8')); delete json.license.evaluationOnly;
  await fs.writeFile(file, JSON.stringify(json));
  const before = await fs.readFile(file, 'utf8');
  assert.equal((await lib.listMotions())[0].license.evaluationOnly, true);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('motion-gen ジョブ: 外部コマンドが時間の上限を超えたら止めて failed(理由つき)にする。上限の中なら止めない', async t => {
  // 眠り続ける python の代わりに、sitecustomize.py で python の起動時に眠らせる(motionbricks_gen.py の前に実行される)
  const dir = await tempDir();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  await fs.writeFile(path.join(dir, 'sitecustomize.py'), 'import os, time\nif os.environ.get("TEST_SLEEP"): time.sleep(int(os.environ["TEST_SLEEP"]))\n');
  const env = {...FAKE, PYTHONPATH: dir, TEST_SLEEP: '30', CHARASTA_MOTION_GEN_TIMEOUT_MS: '1500'};
  const {lib, q} = await setup(t, env);
  const started = Date.now();
  const job = await q.enqueue({type: 'motion-gen', seconds: 1, motionId: 'mb-slow'});
  await q.whenIdle();
  const f = await q.get(job.id);
  assert.equal(f.state, 'failed'); assert.match(f.error, /python が 2 秒で終わらなかったので止めた/);
  assert.ok(Date.now() - started < 20000, '30 秒の眠りを待たずに止まる');
  assert.equal(await lib.motionExists('mb-slow'), false);
  // 上限の中で終わるなら普通に done(1 秒眠ったあとで作り終わる)
  const {q: q2} = await setup(t, {...FAKE, PYTHONPATH: dir, TEST_SLEEP: '1'});
  const ok = await q2.enqueue({type: 'motion-gen', seconds: 1, motionId: 'mb-ok'});
  await q2.whenIdle();
  assert.equal((await q2.get(ok.id)).state, 'done');
});
