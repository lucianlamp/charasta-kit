// 体型と揺れものの直し(docs/adjust.md)。バージョンの model.vrm から新しいバージョンを作る。元のバージョンは変えない(ADR 0002)。
//   GET /api/characters/<キャラ>/versions/<バージョン>/adjust の中身(adjustInfo): 体型を直せるか、揺れものの組と今の値
//   ジョブ adjust(runAdjust): 1. 体型を書き換える(tools/vrm/body_shape.py)  2. 揺れものの値を書く(VRMC_springBone の JSON だけ)
//     3. 新しいバージョンとして取り込む(version.json と、使った値の adjust.json)  4. スマホ用の軽い VRM  5. サムネイル
import fs from 'node:fs/promises';
import path from 'node:path';
import {root} from './config.mjs';
import {LibraryError, checkId, rejectCreature, writeJson} from './library.mjs';
import {parseGlb, buildGlb, readGlbJson} from './glb.mjs';
import {BODY_NEUTRAL, bodyArgs, bodyChanged, bodySummary, checkBody, checkSprings, springGroups, springsChanged, springSummary, applySprings} from '../public/adjust-plan.mjs';

export const ADJUST_JOB = 'adjust';
// body_shape.py が要る骨(tools/vrm/body_shape.py の NEEDED と同じ)
const NEEDED = ['hips', 'spine', 'neck', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
const LABEL_MAX = 60, NOTE_MAX = 1000;

const bad = m => { throw new LibraryError('bad-input', m); };

// 体型を書き換えられない理由。書き換えられるなら null
export function bodyProblem(json) {
  const vrm = json?.extensions?.VRMC_vrm;
  if (!vrm) return json?.extensions?.VRM ? 'VRM 0.x のバージョン。体型を直すには VRM 1.0 のバージョンが要る' : 'VRM の情報が無い';
  const bones = vrm.humanoid?.humanBones ?? {}, miss = NEEDED.filter(b => bones[b]?.node == null);
  if (miss.length) return '骨が足りない: ' + miss.join('、');
  if (!json.skins?.length) return 'skin が無い';
  return null;
}

async function versionJson(lib, charId, verId) {
  rejectCreature(await lib.getCharacterJson(charId), '体型と揺れものの直し');
  const file = path.join(lib.versionDir(charId, verId), 'model.vrm');
  if (!await fs.access(file).then(() => true, () => false)) throw new LibraryError('not-found', `バージョン ${charId}/${verId} の model.vrm が無い`);
  return {file, json: await readGlbJson(file)};
}

// 画面が読む: {charId, verId, body: {available, reason, neutral}, springs: {available, reason, groups}}。groups の joints は下見に使う(節点の番号と今の値)
export async function adjustInfo(lib, charId, verId) {
  const {json} = await versionJson(lib, charId, verId);
  const reason = bodyProblem(json), groups = springGroups(json);
  return {charId, verId, body: {available: !reason, reason, neutral: BODY_NEUTRAL},
    springs: {available: groups.length > 0, reason: groups.length ? null : json?.extensions?.VRMC_springBone ? '揺れものが無い' : 'VRM 1.0 の揺れもの(VRMC_springBone)が無い', groups}};
}

// ジョブの入力。active(newVerId) は同じ新しいバージョン ID の adjust ジョブが待っているか動いているか
export async function adjustInput(lib, body, active = () => false) {
  const charId = checkId(body.charId, 'キャラ ID'), verId = checkId(body.verId, 'バージョン ID');
  const {json} = await versionJson(lib, charId, verId);
  const newVerId = checkId(String(body.newVerId ?? '').trim(), '新しいバージョン ID');
  if (await lib.versionExists(charId, newVerId) || active(charId, newVerId)) throw new LibraryError('exists', `バージョン ${charId}/${newVerId} は既にある（バージョンは上書きしない）`);
  let shape, springs;
  try { shape = checkBody(body.body ?? {}); springs = checkSprings(body.springs ?? {}); } catch (e) { bad(e.message); }
  const groups = springGroups(json), changed = springsChanged(groups, springs);
  if (bodyChanged(shape)) { const why = bodyProblem(json); if (why) bad('体型を直せない: ' + why); }
  if (!bodyChanged(shape) && !changed.length) bad('変える値が無い（体型も揺れものも元のまま）');
  if (body.latest !== undefined && typeof body.latest !== 'boolean') bad('latest は true / false');
  const auto = [bodySummary(shape), springSummary(groups, springs)].filter(Boolean).join('。');
  const label = String(body.label ?? '').trim() || (bodyChanged(shape) && changed.length ? '体型と揺れものを直した' : bodyChanged(shape) ? '体型を直した' : '揺れものを直した');
  const note = String(body.note ?? '').trim() || `${verId} から。${auto}`;
  if (label.length > LABEL_MAX) bad(`見出しは ${LABEL_MAX} 字まで`);
  if (note.length > NOTE_MAX) bad(`変えたことは ${NOTE_MAX} 字まで`);
  return {charId, verId, newVerId, label, note, latest: body.latest ?? false, body: shape, springs: Object.fromEntries(changed.map(g => [g.key, springs[g.key]]))};
}

export async function runAdjust(ctx, {lib, getPort, env}) {
  const {charId, verId, newVerId, label, note, latest, body, springs} = ctx.job.input;
  const src = path.join(lib.versionDir(charId, verId), 'model.vrm');
  let file = src, bodyReport = null, springJoints = 0;
  const warnings = [];
  if (bodyChanged(body)) {
    await ctx.step('体型を書き換える');
    const out = path.join(ctx.workDir, 'body.vrm');
    const stdout = await ctx.run('python', [path.join(root, 'tools', 'vrm', 'body_shape.py'), src, out, ...bodyArgs(body)], {capture: true});
    ctx.log(stdout);
    bodyReport = JSON.parse(stdout.trim().split('\n').at(-1));
    file = out;
  }
  let data = await fs.readFile(file);
  if (Object.keys(springs).length) {
    await ctx.step('揺れものの値を書く');
    const {json, bin} = parseGlb(data);
    springJoints = applySprings(json, springs);
    data = buildGlb(json, bin);
  }
  await ctx.step('新しいバージョンにする');
  const version = await lib.importVersion({charId, id: newVerId, label, note, data, sourcePath: src, latest});
  const vdir = lib.versionDir(charId, newVerId);
  await writeJson(path.join(vdir, 'adjust.json'), {from: verId, body, springs, bodyReport, springJoints, jobId: ctx.job.id ?? null, createdAt: new Date().toISOString()});
  await ctx.step('スマホ用の軽い VRM を作る');
  try { await ctx.run('python', [path.join(root, 'tools', 'make_lite.py'), path.join(vdir, 'model.vrm'), path.join(vdir, 'model-lite.vrm')]); }
  catch (e) { warnings.push('スマホ用の軽い VRM を作れなかった: ' + e.message.split('\n')[0]); }
  if (!env.CHARASTA_FAKE_CAPTURE) {
    await ctx.step('サムネイルを撮る');
    try { await ctx.run('node', [path.join(root, 'tools', 'thumb.mjs'), '--char', charId, '--ver', newVerId, '--port', String(getPort())], {timeoutMs: 120000}); }
    catch (e) { warnings.push('サムネイルを撮れなかった: ' + e.message.split('\n')[0]); }
  }
  return {charId, verId: newVerId, from: verId, version, springJoints, body: bodyReport ? {values: body, report: bodyReport} : null, warnings};
}
