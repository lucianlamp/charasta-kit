// 体型と揺れものの直し(public/adjust-plan.mjs、lib/adjust.mjs、ジョブ adjust、tools/vrm/body_shape.py)と、直しの頼みごと
// (lib/adjust-requests.mjs、/api/adjust-requests、scripts/adjust-requests.mjs)。docs/adjust.md
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {startServer, tempDir, FAKE_ENV} from './helpers.mjs';
import {Library} from '../lib/library.mjs';
import {parseGlb} from '../lib/glb.mjs';
import {findPython} from '../lib/platform.mjs';
import {BODY_NEUTRAL, bodyArgs, bodySummary, checkBody, checkSprings, springGroups, springJointValues, springSummary, applySprings} from '../public/adjust-plan.mjs';
import {createAdjustRequest, setAdjustShot, listAdjustRequests, cancelAdjustRequest, getAdjustRequest} from '../lib/adjust-requests.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = findPython() ?? 'python';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// test/fixtures/make_humanoid.py の人型の VRM
async function humanoid() {
  const file = path.join(await tempDir('charasta-humanoid-'), 'h.vrm');
  execFileSync(python, [path.join(root, 'test', 'fixtures', 'make_humanoid.py'), file], {env: {...process.env, PYTHONUTF8: '1'}});
  return fs.readFile(file);
}

async function call(base, method, p, body) {
  const r = await fetch(base + p, {method, headers: {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: r.status, body: await r.json().catch(() => null)};
}
async function waitDone(base, id) {
  for (let i = 0; i < 600; i++) {
    const j = (await call(base, 'GET', '/api/jobs/' + id)).body;
    if (j.state === 'done' || j.state === 'failed') return j;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error('ジョブが終わらない');
}

test('体型の道具: 頂点、骨、逆バインド行列、コライダー、揺れ骨、モーフ(test/body_shape_check.py)', () => {
  const out = execFileSync(python, [path.join(import.meta.dirname, 'body_shape_check.py')], {encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1'}});
  assert.match(out, /OK body_shape/);
});

test('揺れものの組: 名前から人の言葉の組に分け、無ければその他。上着のすそはスカートにしない', () => {
  const nodes = ['J_Sec_Hair1_01', 'Hair_0_0', 'J_Sec_L_CoatSkirtBack_01', 'J_Sec_L_SkirtFront1', 'J_Sec_L_Bust1', 'J_Sec_L_TipSleeve', 'FlapF_0', 'Ribbon_0', 'J_Sec_Tail1', 'Bone.001', 'J_Sec_L_Ear1', 'J_Sec_Earring_L']
    .map(name => ({name}));
  const j = (node, stiffness = 1, dragForce = 0.4, gravityPower = 0) => ({node, stiffness, dragForce, gravityPower});
  const json = {nodes, extensions: {VRMC_springBone: {springs: [
    {name: 'Hair-hair_0', joints: [j(0, 0.8), j(0, 0.6)]}, {name: 'hair_0', joints: [j(1)]}, {name: 'TopsUpperArm-4', joints: [j(2)]}, {name: 'Skirt-d5cc', joints: [j(3)]},
    {name: 'Bust-fa8', joints: [j(4)]}, {name: 'Sleeve-71a', joints: [j(5)]}, {name: 'flap_front', joints: [j(6)]}, {name: '', joints: [j(7)]}, {name: 'Tail', joints: [j(8)]},
    {name: '', joints: [j(9)]}, {name: '', joints: [j(10)]}, {name: '', joints: [j(11)]}]}}};
  const g = springGroups(json);
  assert.deepEqual(g.map(x => [x.key, x.label, x.springs]), [['coat', '上着のすそ', [2]], ['bust', '胸', [4]], ['hair', '髪', [0, 1]], ['skirt', 'スカート', [3]], ['sleeve', '袖', [5]],
    ['ribbon', 'リボン', [7]], ['tail', 'しっぽ', [8]], ['ear', '耳', [10]], ['cloth', '布', [6]], ['accessory', '飾り', [11]], ['other', 'その他', [9]]]);
  const hair = g.find(x => x.key === 'hair');
  assert.deepEqual(hair.values, {stiffness: 0.8, dragForce: 0.4, gravityPower: 0}, '組の値は joint の中央値');
  // 比で掛けて組の中の差を保つ。元が 0 の値はそのまま入れる。範囲で切る
  const v = springJointValues({...hair, joints: [{node: 5, stiffness: 0.8, dragForce: 0.4, gravityPower: 0}, {node: 6, stiffness: 0.6, dragForce: 0.4, gravityPower: 0}]}, {stiffness: 1.6, gravityPower: 0.3, dragForce: 2});
  assert.deepEqual(v, {5: {stiffness: 1.6, dragForce: 1, gravityPower: 0.3}, 6: {stiffness: 1.2, dragForce: 1, gravityPower: 0.3}});
  assert.deepEqual(springGroups({}), [], '揺れものが無い VRM');
});

test('値の確かめと、道具の引数、変えたことの文', () => {
  assert.deepEqual(checkBody({}), BODY_NEUTRAL);
  const b = checkBody({head: 0.94, neck: 0.75, shoulder: -1.2, arm: 0.8});
  assert.deepEqual(bodyArgs(b), ['--head', '0.94', '--neck', '0.0075', '--shoulder', '-0.012', '--arm', '0.8']);
  assert.equal(bodySummary(b), '頭の大きさ 0.94 倍、首の長さ +0.8 cm、肩幅(片側) -1.2 cm、腕の太さ 0.80 倍');
  for (const bad of [{head: 2}, {neck: '1'}, {legs: 1}, [], {arm: NaN}]) assert.throws(() => checkBody(bad), Error, JSON.stringify(bad));
  for (const bad of [{hairs: {stiffness: 1}}, {hair: {stiff: 1}}, {hair: {dragForce: 2}}, {hair: 1}, []]) assert.throws(() => checkSprings(bad), Error, JSON.stringify(bad));
  const groups = [{key: 'hair', label: '髪', values: {stiffness: 0.8, dragForce: 0.4, gravityPower: 0}}];
  assert.equal(springSummary(groups, {hair: {stiffness: 1.2, dragForce: 0.4}}), '髪 揺れにくさ 0.80→1.20');
  const json = {nodes: [{name: 'Hair'}], extensions: {VRMC_springBone: {springs: [{name: 'hair', joints: [{node: 0, stiffness: 0.8, dragForce: 0.4, gravityPower: 0, hitRadius: 0.02}]}]}}};
  assert.equal(applySprings(json, {hair: {stiffness: 0.8}}), 0, '元と同じ値は書かない');
  assert.equal(applySprings(json, {hair: {stiffness: 1.2}}), 1);
  assert.deepEqual(json.extensions.VRMC_springBone.springs[0].joints[0], {node: 0, stiffness: 1.2, dragForce: 0.4, gravityPower: 0, hitRadius: 0.02}, 'ほかの値は変えない');
});

async function withChar(extra, fn) {
  const s = await startServer({env: FAKE_ENV, ...extra});
  try {
    const lib = new Library(s.libraryDir);
    await lib.createCharacter({id: 'c1', name: 'C1', style: 'standard'});
    await lib.importVersion({charId: 'c1', id: 'v1', data: await humanoid(), latest: true});
    await fn(s, lib);
  } finally { await s.close(); }
}

for (const edition of [undefined, 'kit']) {
  test(`ジョブ adjust(${edition ?? 'full'}): 体型と揺れものを変えた新しい版を作り、元の版は変えない`, async () => {
    await withChar(edition ? {edition} : {}, async (s, lib) => {
      const info = (await call(s.base, 'GET', '/api/characters/c1/versions/v1/adjust')).body;
      assert.equal(info.body.available, true);
      assert.deepEqual(info.springs.groups.map(g => [g.key, g.count]), [['hair', 2], ['skirt', 1], ['ribbon', 1]]);
      const v1 = path.join(lib.dir, 'characters/c1/versions/v1/model.vrm'), before = sha(await fs.readFile(v1));

      // 入力の誤り
      for (const [body, status] of [[{}, 400], [{body: {head: 3}}, 400], [{springs: {hair: {stiffness: -1}}}, 400], [{verId: 'v9', body: {arm: 0.9}}, 404], [{newVerId: 'v1', body: {arm: 0.9}}, 409]])
        assert.equal((await call(s.base, 'POST', '/api/jobs', {type: 'adjust', charId: 'c1', verId: 'v1', newVerId: 'v2', ...body})).status, status, JSON.stringify(body));

      const r = await call(s.base, 'POST', '/api/jobs', {type: 'adjust', charId: 'c1', verId: 'v1', newVerId: 'v2', body: {neck: 1, arm: 0.9}, springs: {hair: {stiffness: 1.4}, skirt: {dragForce: 0.05}}, latest: true});
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(r.body.input.springs, {hair: {stiffness: 1.4}}, '元と同じ値の組は入れない');
      assert.equal(r.body.input.label, '体型と揺れものを直した');
      assert.match(r.body.input.note, /^v1 から。首の長さ \+1\.0 cm、腕の太さ 0\.90 倍。髪 揺れにくさ 0\.70→1\.40$/);
      assert.equal((await call(s.base, 'POST', '/api/jobs', {type: 'adjust', charId: 'c1', verId: 'v1', newVerId: 'v2', body: {arm: 0.8}})).status, 409, '同じ新しい版 ID のジョブが待っている');
      const job = await waitDone(s.base, r.body.id);
      assert.equal(job.state, 'done', job.error);
      assert.equal(sha(await fs.readFile(v1)), before, '元の版は変えない');

      const ch = (await call(s.base, 'GET', '/api/characters/c1')).body;
      assert.equal(ch.latestVersion, 'v2');
      const v2 = ch.versions.find(v => v.id === 'v2');
      assert.equal(v2.label, '体型と揺れものを直した');
      const rec = JSON.parse(await fs.readFile(path.join(lib.dir, 'characters/c1/versions/v2/adjust.json'), 'utf8'));
      assert.equal(rec.from, 'v1'); assert.equal(rec.springJoints, 4); assert.equal(rec.body.neck, 1); assert.equal(rec.bodyReport.neck.inverseBind > 0, true);
      const {json} = parseGlb(await fs.readFile(path.join(lib.dir, 'characters/c1/versions/v2/model.vrm')));
      const hair = json.extensions.VRMC_springBone.springs[0].joints.map(j => j.stiffness);
      assert.deepEqual(hair.map(x => Math.round(x * 1000) / 1000), [1.6, 1.2], '中央値 0.7 を 1.4 にした比(2 倍)で、根元と先の差を保つ');
      assert.equal(json.extensions.VRMC_springBone.springs[2].joints[0].dragForce, 0.05, 'スカートは変えない');
      assert.ok(Math.abs(json.nodes[4].translation[1] - 0.07) < 1e-6, '頭の骨が 1 cm 上がる(首から 6 cm -> 7 cm)');

      // 揺れものだけなら Python を使わず JSON だけを書き換える(BIN は同じ)
      const r2 = await call(s.base, 'POST', '/api/jobs', {type: 'adjust', charId: 'c1', verId: 'v2', newVerId: 'v3', springs: {ribbon: {gravityPower: 0}}});
      assert.equal(r2.body.input.label, '揺れものを直した');
      assert.equal((await waitDone(s.base, r2.body.id)).state, 'done');
      const a = parseGlb(await fs.readFile(path.join(lib.dir, 'characters/c1/versions/v2/model.vrm'))), b = parseGlb(await fs.readFile(path.join(lib.dir, 'characters/c1/versions/v3/model.vrm')));
      assert.equal(sha(b.bin), sha(a.bin));
      assert.equal(b.json.extensions.VRMC_springBone.springs[3].joints[0].gravityPower, 0);
      assert.equal((await call(s.base, 'GET', '/api/characters/c1')).body.latestVersion, 'v2', 'latest を付けなければ最新の版は変えない');
    });
  });
}

test('体型を直せない版: VRM 0.x は理由を返し、ジョブは断る。揺れものが無ければ組は空', async () => {
  const s = await startServer({env: FAKE_ENV});
  try {
    const lib = new Library(s.libraryDir);
    await lib.createCharacter({id: 'c0', name: 'C0', style: 'standard'});
    const {buildGlb} = await import('../lib/glb.mjs');
    await lib.importVersion({charId: 'c0', id: 'v1', data: buildGlb({asset: {version: '2.0'}, extensions: {VRM: {}}}, null)});
    const info = (await call(s.base, 'GET', '/api/characters/c0/versions/v1/adjust')).body;
    assert.equal(info.body.available, false); assert.match(info.body.reason, /VRM 0\.x/);
    assert.equal(info.springs.available, false); assert.deepEqual(info.springs.groups, []);
    const r = await call(s.base, 'POST', '/api/jobs', {type: 'adjust', charId: 'c0', verId: 'v1', newVerId: 'v2', body: {arm: 0.9}});
    assert.equal(r.status, 400); assert.match(r.body.error, /VRM 0\.x/);
    assert.equal((await call(s.base, 'GET', '/api/characters/c0/versions/v9/adjust')).status, 404);
  } finally { await s.close(); }
});

test('直しの頼みごと: 作る、絵を付ける、一覧、取り下げ(lib と API)', async () => {
  await withChar({}, async (s, lib) => {
    for (const bad of [{}, {charId: 'c1', verId: 'v1', area: 'face', text: 'x'}, {charId: 'c1', verId: 'v1', area: 'body', text: ' '}, {charId: 'c1', verId: 'v1', area: 'body', text: 'x'.repeat(1001)}])
      await assert.rejects(createAdjustRequest(lib, bad), {code: /bad-input|bad-id/}, JSON.stringify(bad).slice(0, 60));
    await assert.rejects(createAdjustRequest(lib, {charId: 'c1', verId: 'v9', area: 'body', text: 'x'}), {code: 'not-found'});
    const r = await call(s.base, 'POST', '/api/adjust-requests', {charId: 'c1', verId: 'v1', area: 'springs', text: ' 髪がはねすぎる '});
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.text, r.body.state, r.body.shot, r.body.shotUrl, r.body.newVersion], ['髪がはねすぎる', 'waiting', null, null, null]);
    const up = await fetch(`${s.base}/api/adjust-requests/${r.body.id}/shot`, {method: 'POST', body: PNG});
    assert.equal(up.status, 201);
    assert.equal((await fetch(`${s.base}/api/adjust-requests/${r.body.id}/shot`, {method: 'POST', body: Buffer.from('text')})).status, 400);
    const got = (await call(s.base, 'GET', `/api/adjust-requests/${r.body.id}`)).body;
    assert.equal(got.shot, 'shot.png');
    assert.deepEqual(Buffer.from(await (await fetch(s.base + got.shotUrl)).arrayBuffer()), PNG);
    await lib.createCharacter({id: 'c2', name: 'C2', style: 'standard'});
    await lib.importVersion({charId: 'c2', id: 'v1', data: await fs.readFile(path.join(lib.dir, 'characters/c1/versions/v1/model.vrm'))});
    const other = await createAdjustRequest(lib, {charId: 'c2', verId: 'v1', area: 'other', text: '手を大きく'});
    assert.deepEqual((await call(s.base, 'GET', '/api/adjust-requests?char=c1')).body.requests.map(x => x.id), [r.body.id]);
    assert.equal((await listAdjustRequests(lib.dir)).length, 2);
    assert.equal((await call(s.base, 'DELETE', `/api/adjust-requests/${other.id}`)).status, 200);
    await assert.rejects(getAdjustRequest(lib.dir, other.id), {code: 'not-found'});
    await assert.rejects(setAdjustShot(lib.dir, '../x', PNG), {code: 'bad-id'});
    await assert.rejects(cancelAdjustRequest(lib.dir, 'nope'), {code: 'not-found'});
  });
});

// CLI: 保管場所(CHARASTA_LIBRARY)のファイルを直に読み書きする。サーバーは要らない
const cli = (dir, ...args) => exec(process.execPath, [path.join(root, 'scripts', 'adjust-requests.mjs'), ...args], {env: {...process.env, CHARASTA_LIBRARY: dir}});

test('CLI: list、show、start、done(新しい版を確かめる)、decline', async () => {
  const dir = await tempDir(), lib = new Library(dir);
  await lib.createCharacter({id: 'c1', name: 'C1', style: 'standard'});
  await lib.importVersion({charId: 'c1', id: 'v1', data: await humanoid()});
  const a = await createAdjustRequest(lib, {charId: 'c1', verId: 'v1', area: 'body', text: '肩幅を狭く'}, new Date('2026-11-09T01:00:00Z'));
  const b = await createAdjustRequest(lib, {charId: 'c1', verId: 'v1', area: 'other', text: '指を長く'}, new Date('2026-11-09T02:00:00Z'));
  await setAdjustShot(dir, a.id, PNG);
  const list = JSON.parse((await cli(dir, 'list', '--json')).stdout);
  assert.deepEqual(list.map(r => r.id), [a.id, b.id], '古い順');
  assert.equal(list[0].shotPath, path.join(dir, 'adjust-requests', a.id, 'shot.png'));
  assert.equal(list[0].modelPath, path.join(dir, 'characters', 'c1', 'versions', 'v1', 'model.vrm'));
  assert.match((await cli(dir, 'show', a.id)).stdout, /対応待ち.*c1\/v1.*体型[\s\S]*肩幅を狭く/);
  assert.equal(JSON.parse((await cli(dir, 'start', a.id, '--json')).stdout).state, 'working');
  await assert.rejects(cli(dir, 'done', a.id, '--version', 'v2', '--reply', '狭くした'), e => e.code === 1 && /v2 が無い/.test(e.stderr));
  await assert.rejects(cli(dir, 'done', a.id, '--version', 'v1', '--reply', '狭くした'), e => e.code === 1 && /頼まれたときの版/.test(e.stderr));
  await assert.rejects(cli(dir, 'done', a.id, '--version', 'v2'), e => e.code === 2);
  await lib.importVersion({charId: 'c1', id: 'v2', data: await fs.readFile(path.join(dir, 'characters/c1/versions/v1/model.vrm'))});
  const done = JSON.parse((await cli(dir, 'done', a.id, '--version', 'v2', '--reply', '肩幅を片側 1.2 cm 狭くした', '--json')).stdout);
  assert.deepEqual([done.state, done.newVersion, done.reply], ['done', 'v2', '肩幅を片側 1.2 cm 狭くした']);
  assert.ok(done.repliedAt);
  await assert.rejects(cli(dir, 'decline', a.id, '--reply', 'x'), e => e.code === 1, '終わったものは動かせない');
  assert.equal(JSON.parse((await cli(dir, 'decline', b.id, '--reply', '指の長さは体型の道具に無い', '--json')).stdout).state, 'declined');
  assert.match((await cli(dir, 'list')).stdout, /頼みごとは無い/);
  assert.equal(JSON.parse((await cli(dir, 'list', '--all', '--char', 'c1', '--json')).stdout).length, 2);
  await assert.rejects(cli(dir, 'nope'), e => e.code === 2);
});
