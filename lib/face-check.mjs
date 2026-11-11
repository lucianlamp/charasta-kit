// バージョンの顔の確認(docs/expression-studio.md の「シェイプキー方式のバージョンの確認」)。作るのは with-kimi スキルで、きゃらすたは見るだけ。
// faceInfo: VRM の JSON チャンクから、どの方式の顔かと Fcl_ のキーとプリセットを読む。
// face-check ジョブ: バージョンに対して確かめの撮影をし、バージョンのフォルダの checks/<種類>/ に置く(grid、keys、motion)。
// 試しの動き: CHARASTA_FAKE_CAPTURE=1 はブラウザで撮らない。hang は終わらない撮影。nohair は髪を測れなかった形。
// CHARASTA_SHOOT_TIMEOUT_MS で時間の上限を決め打ちにする。
import fs from 'node:fs/promises';
import path from 'node:path';
import {root} from './config.mjs';
import {LibraryError, checkId, inside, readJsonOr, rejectCreature, writeJson} from './library.mjs';
import {renameRetry} from './trash.mjs';
import {readGlbJson} from './glb.mjs';

export const FACE_CHECK_JOB = 'face-check';
export const FACE_CHECK_SETS = {grid: '格子と表情', keys: 'キー別', motion: 'モーション'};
const TIMEOUT_MS = {grid: 10 * 60e3, keys: 10 * 60e3, motion: 20 * 60e3};
const PRESETS = ['neutral', 'blink', 'blinkLeft', 'blinkRight', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh'];
// VRM 0 の blendShapeGroups の presetName -> VRM 1 のプリセットの名前
const V0_PRESET = {neutral: 'neutral', blink: 'blink', blink_l: 'blinkLeft', blink_r: 'blinkRight', joy: 'happy', angry: 'angry', sorrow: 'sad', fun: 'relaxed', surprised: 'surprised', a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh'};
const COMBOS = ['Fcl_MTH_A+Fcl_HA_Fung1', 'Fcl_MTH_A+Fcl_HA_Fung2', 'Fcl_MTH_A+Fcl_HA_Fung3', 'Fcl_MTH_A+Fcl_HA_Hide', 'Fcl_MTH_A+Fcl_HA_Short'];
const MOTION_SEQ = ['none', 'aa', 'ih', 'ou', 'blink', 'happy', 'oh', 'surprised', 'sad', 'angry', 'ee', 'relaxed'];
const MOTION_VIEWS = [['y0', 0, 0], ['y45', 45, -15]];
const now = () => new Date().toISOString();
const exists = f => fs.access(f).then(() => true, () => false);

// VRoid の β 版などは、キーの名前に材質の前置きが付く(Face.M_F00_000_00_Fcl_ALL_Angry)。isFcl は前置きがあっても認め、fclName は前置きを除く。
// three.js のキーの辞書は元の名前のままなので、keys と key には元の名前を持つ
export const isFcl = k => /(^|_)Fcl_/.test(k);
export const fclName = k => (isFcl(k) ? k.slice(k.indexOf('Fcl_')) : k);

// 撮るキーの一覧。ファイル名はキーの名前によらず番号で決める(VRM の中の文字をパスに使わない)
export function keyPlan(names) {
  const full = new Map(names.map(n => [fclName(n), n]));
  const combos = COMBOS.filter(c => c.split('+').every(k => full.has(k))).map(c => c.split('+').map(k => full.get(k)).join('+'));
  return [...names, ...combos].map((key, i) => ({
    name: key.split('+').map(fclName).join('+'), file: `k${String(i).padStart(3, '0')}.png`, kind: 'key', key, group: key.includes('+') ? 'MIX' : /^Fcl_([A-Z]+)_/.exec(fclName(key))?.[1] ?? 'OTHER'}));
}
// モーションのコマ: 表情を 2 コマずつ、正面と斜めで交互に
export function motionPlan(seconds = 24, every = 16) {
  return Array.from({length: Math.floor(seconds * 60 / every)}, (_, f) => {
    const expr = MOTION_SEQ[Math.floor(f / 2) % MOTION_SEQ.length], [view, yaw, pitch] = MOTION_VIEWS[f % 2];
    return {name: `${f} ${expr} ${view}`, file: `f_${String(f).padStart(4, '0')}.jpg`, kind: 'motion', expr, view, yaw, pitch};
  });
}

function presetsV1(js, meshes, vrm) {
  const preset = vrm?.expressions?.preset ?? {}, names = m => m?.extras?.targetNames ?? [];
  return PRESETS.map(name => {
    const e = preset[name];
    return {name, keys: (e?.morphTargetBinds ?? []).map(b => names(meshes[js.nodes[b.node]?.mesh])[b.index]).filter(Boolean),
      bound: !!(e?.morphTargetBinds?.length || e?.materialColorBinds?.length || e?.textureTransformBinds?.length)};
  });
}
function presetsV0(meshes, v0) {
  const groups = v0.blendShapeMaster?.blendShapeGroups ?? [], names = m => m?.extras?.targetNames ?? [];
  return PRESETS.map(name => {
    const g = groups.find(x => V0_PRESET[x.presetName] === name);
    return {name, keys: (g?.binds ?? []).map(b => names(meshes[b.mesh])[b.index]).filter(Boolean), bound: !!(g?.binds?.length || g?.materialValues?.length)};
  });
}

// js: VRM の JSON。method: shapekey(Fcl_ のキーがある)、atlas(顔画像の方式)、other(それ以外)。vrm: 1 か 0(無ければ null)
export function faceOf(js) {
  const meshes = js.meshes ?? [], names = meshes.flatMap(m => m.extras?.targetNames ?? []);
  const keys = [...new Set(names.filter(isFcl))];
  const atlas = (js.images ?? []).some(i => /^FaceAtlas/.test(i.name ?? '')) || (js.nodes ?? []).some(n => n.name === 'Face_layers');
  const vrm = js.extensions?.VRMC_vrm, v0 = js.extensions?.VRM;
  const bones = vrm ? Object.keys(vrm.humanoid?.humanBones ?? {}) : (v0?.humanoid?.humanBones ?? []).map(b => b.bone);
  const skin = (js.materials ?? []).some(m => (m.name ?? '').includes('Face_00_SKIN')) ? 'Face_00_SKIN' : 'head';
  return {method: keys.length ? 'shapekey' : atlas ? 'atlas' : 'other', vrm: vrm ? 1 : v0 ? 0 : null, keys,
    presets: !vrm && v0 ? presetsV0(meshes, v0) : presetsV1(js, meshes, vrm),
    lookAt: vrm?.lookAt?.type ?? (v0?.firstPerson?.lookAtTypeName?.toLowerCase() ?? null), eyeBones: bones.includes('leftEye') && bones.includes('rightEye'), skinMaterial: skin};
}

const verDir = (lib, charId, verId) => inside(lib.dir, 'characters', checkId(charId, 'キャラ ID'), 'versions', checkId(verId, 'バージョン ID'));
const url = (charId, verId, ...rest) => '/lib/characters/' + [charId, 'versions', verId, ...rest].map(encodeURIComponent).join('/');

async function listChecks(dir, charId, verId) {
  const out = {};
  for (const set of Object.keys(FACE_CHECK_SETS)) {
    const meta = await readJsonOr(path.join(dir, 'checks', set, 'check.json'));
    if (!meta) continue;
    const index = (await readJsonOr(path.join(dir, 'checks', set, 'index.json'))) ?? [];
    out[set] = {...meta, images: index.map(i => ({...i, url: url(charId, verId, 'checks', set, i.file)}))};
  }
  return out;
}

export async function faceInfo(lib, charId, verId) {
  rejectCreature(await lib.getCharacterJson(charId), '顔の確認');
  if (!await lib.versionExists(charId, verId)) throw new LibraryError('not-found', `バージョン ${charId}/${verId} が無い`);
  const dir = verDir(lib, charId, verId);
  return {...faceOf(await readGlbJson(path.join(dir, 'model.vrm'))), charId, verId, checks: await listChecks(dir, charId, verId)};
}

// 積むときの確かめ。pending(input): 同じバージョンの同じ種類が順番待ちか実行中か
export async function faceCheckInput(lib, body, pending) {
  const charId = checkId(body.charId, 'キャラ ID'), verId = checkId(body.verId, 'バージョン ID');
  rejectCreature(await lib.getCharacterJson(charId), '顔の確認');
  if (!await lib.versionExists(charId, verId)) throw new LibraryError('not-found', `バージョン ${charId}/${verId} が無い`);
  if (typeof body.set !== 'string' || !Object.hasOwn(FACE_CHECK_SETS, body.set)) throw new LibraryError('bad-input', 'set は ' + Object.keys(FACE_CHECK_SETS).join(' / '));
  const input = {charId, verId, set: body.set};
  if (body.set === 'motion') {
    if (typeof body.motionId !== 'string' || !body.motionId) throw new LibraryError('bad-input', 'motionId が要る');
    await lib.getMotion(body.motionId);
    // ビューアは VRM 0 を rotateVRM0 で回すので、VRMA を当てると前後が逆になる
    if (faceOf(await readGlbJson(path.join(verDir(lib, charId, verId), 'model.vrm'))).vrm === 0) throw new LibraryError('bad-input', 'VRM 0 のバージョンはモーションで撮れない。VRM 1 へ変換してバージョンにしてから撮る');
    input.motionId = body.motionId;   // ごみ箱は input.motionId で、使っているジョブを見る
  }
  if (body.set === 'keys' && faceOf(await readGlbJson(path.join(verDir(lib, charId, verId), 'model.vrm'))).method !== 'shapekey')
    throw new LibraryError('bad-input', 'このバージョンに Fcl_ のキーが無い');
  if (pending(input)) throw new LibraryError('exists', `${charId}/${verId} の「${FACE_CHECK_SETS[body.set]}」のジョブが既に順番待ちにある`);
  return input;
}

// 試しの動き: 撮影の道具が書くのと同じ形の index.json と絵
async function fakeShots(ctx, tmp, set, face, left) {
  const plan = set === 'keys' ? keyPlan(face.keys) : set === 'motion' ? motionPlan(1, 16) : [{name: 'grid_p0_y0', file: 'grid_p0_y0.png', kind: 'grid', expr: 'neutral', gaze: 'center', yaw: 0, pitch: 0}];
  await ctx.run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x886655:s=64x64', '-frames:v', '1', path.join(tmp, plan[0].file)], {timeoutMs: left()});
  for (const p of plan.slice(1)) await fs.copyFile(path.join(tmp, plan[0].file), path.join(tmp, p.file));
  await writeJson(path.join(tmp, 'index.json'), plan);
}

// tmp の撮影を out へ置く。前の撮影は out.old へ避け、置けたら消す。置けなければ戻す(新旧どちらも失わない)。rename はテストが差し替える
export async function swapIn(tmp, out, old, rename = renameRetry) {
  await fs.rm(old, {recursive: true, force: true});
  const had = await exists(out);
  if (had) await rename(out, old);
  try { await rename(tmp, out); }
  catch (e) { if (had) await rename(old, out).catch(() => {}); throw e; }
  await fs.rm(old, {recursive: true, force: true}).catch(() => {});   // 残っても次の撮影が消す
}

export async function runFaceCheck(ctx, {lib, getPort, env}) {
  const {job} = ctx, {charId, verId, set, motionId} = job.input, dir = verDir(lib, charId, verId);
  const out = path.join(dir, 'checks', set), tmp = out + '.tmp', old = out + '.old', port = String(getPort());
  job.timeoutMs = env.CHARASTA_SHOOT_TIMEOUT_MS ? Number(env.CHARASTA_SHOOT_TIMEOUT_MS) : TIMEOUT_MS[set];
  const deadline = Date.now() + job.timeoutMs, left = () => Math.max(1, deadline - Date.now());
  if (!await exists(out) && await exists(old)) await renameRetry(old, out);   // 前の置き換えが途中で止まった残り
  await fs.rm(tmp, {recursive: true, force: true});
  await fs.mkdir(tmp, {recursive: true});
  const common = ['--char', charId, '--ver', verId, '--out', tmp, '--port', port], fake = env.CHARASTA_FAKE_CAPTURE;
  const face = faceOf(await readGlbJson(path.join(dir, 'model.vrm')));
  const tool = (name, ...args) => ctx.run('node', [path.join(root, 'tools', name), ...common, ...args], {timeoutMs: left()});
  try {
    await ctx.step(`${verId} の${FACE_CHECK_SETS[set]}を撮る`);
    if (fake === 'hang') await ctx.run('node', ['-e', 'setTimeout(() => {}, 60000)'], {timeoutMs: left()});
    else if (fake) {
      await fakeShots(ctx, tmp, set, face, left);
      if (set === 'motion') await writeJson(path.join(tmp, 'hair.json'), fake === 'nohair' ? {measured: false, reason: '髪のメッシュが見つからない'} : {measured: true, frames: 1, framesWithHair: 0, worstVerts: 0, worstFrame: -1, maxDepthMm: 0});
    } else if (set === 'grid') await tool('studio_checks.mjs', '--set', 'full');
    else if (set === 'keys') await tool('face_keys.mjs');
    else {
      await tool('face_motion.mjs', '--motion', motionId);
      await ctx.step('髪が顔の面より内側へ入る頂点を数える');
      await tool('face_hair.mjs', '--motion', motionId, '--skin', face.skinMaterial, '--json', path.join(tmp, 'hair.json'));
    }
    const count = ((await readJsonOr(path.join(tmp, 'index.json'))) ?? []).length;
    if (!count) throw new Error('撮影の一覧が空');
    const hair = await readJsonOr(path.join(tmp, 'hair.json'));
    await writeJson(path.join(tmp, 'check.json'), {set, motionId: motionId ?? null, count, hair: hair?.measured ? hair : null, jobId: job.id, at: now()});
    await swapIn(tmp, out, old);
    return {charId, verId, set, count};
  } catch (e) { await fs.rm(tmp, {recursive: true, force: true}).catch(() => {}); throw e; }
}
