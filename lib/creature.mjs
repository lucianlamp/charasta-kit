// 生き物(人以外のキャラ。docs/creature.md): バージョンの取り込み(Action の名前の確かめ、サムネイル)と、ショートの take.creature の参照の解決。
// Blender は背景で動かす小さな Python(tools/creature_actions.py、tools/creature_thumb.py)だけを呼ぶ。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {LibraryError, checkId, isCreature, readJson} from './library.mjs';
import {root} from './config.mjs';

const run = promisify(execFile);
const BLENDER_TIMEOUT_MS = 10 * 60 * 1000;

// creature.json に入れてよい値(生き物そのもの)。撮る場面ごとの値は take.creature 側に置く
export const SPEC_KEYS = ['rest', 'clips', 'fly', 'scale', 'drop', 'fps', 'yaw'];
export const SHOT_KEYS = ['perch', 'path', 'flight', 'events', 'blend'];
// take.creature の参照の形で、場面ごとに上書きしてよい値
export const REF_KEYS = ['charId', 'verId', 'perch', 'yaw', 'path', 'flight', 'scale', 'drop'];
export const CLIP_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

const bad = message => new LibraryError('bad-input', message);
const num = (v, what, lo, hi) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw bad(`${what} は ${lo} から ${hi} の数: ${JSON.stringify(v)}`);
  return v;
};

// [Action の名前, 始めのコマ, 終わりのコマ]
function clipOf(v, what) {
  if (!Array.isArray(v) || v.length !== 3 || typeof v[0] !== 'string' || !v[0] || v[0].length > 128) throw bad(`${what} は [Action の名前, 始めのコマ, 終わりのコマ]: ${JSON.stringify(v)}`);
  const a = v[1], b = v[2];
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a || b > 100000) throw bad(`${what} のコマは 0 以上の整数で、終わりは始め以上: ${JSON.stringify(v)}`);
  return [v[0], a, b];
}

// creature.json の中身を確かめて、保存する形にする。rest、scale、yaw、fps が要る(stage-studio の lib/creature.py が必ず読む値)
export function checkCreatureSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw bad('creature.json が連想配列ではない');
  const shot = SHOT_KEYS.filter(k => k in spec);
  if (shot.length) throw bad(`creature.json に撮る場面ごとの値は入れない: ${shot.join(', ')}（ショートの take.creature に書く）`);
  const unknown = Object.keys(spec).filter(k => !SPEC_KEYS.includes(k));
  if (unknown.length) throw bad(`creature.json に知らない項目: ${unknown.join(', ')}（使えるのは ${SPEC_KEYS.join(' / ')}）`);
  for (const k of ['rest', 'scale', 'yaw', 'fps']) if (!(k in spec)) throw bad(`creature.json に ${k} が要る`);
  const out = {rest: clipOf(spec.rest, 'rest')};
  if (spec.clips !== undefined) {
    if (!spec.clips || typeof spec.clips !== 'object' || Array.isArray(spec.clips)) throw bad('clips は {動きの名前: [Action の名前, 始めのコマ, 終わりのコマ]}');
    out.clips = {};
    for (const [k, v] of Object.entries(spec.clips)) {
      if (!CLIP_NAME_RE.test(k)) throw bad(`clips の名前は英数字・_ - の 1〜32 文字: ${JSON.stringify(k)}`);
      out.clips[k] = clipOf(v, `clips.${k}`);
    }
  }
  if (spec.fly !== undefined) out.fly = clipOf(spec.fly, 'fly');
  out.scale = num(spec.scale, 'scale', 0.001, 1000);
  if (spec.drop !== undefined) out.drop = num(spec.drop, 'drop', -10, 10);
  out.fps = num(spec.fps, 'fps', 1, 240);
  out.yaw = num(spec.yaw, 'yaw', -360, 360);
  return out;
}

// spec が使う [Action, 始め, 終わり] の一覧 [{where, clip}]
export function clipsOf(spec) {
  return [{where: 'rest', clip: spec.rest}, ...(spec.fly ? [{where: 'fly', clip: spec.fly}] : []), ...Object.entries(spec.clips ?? {}).map(([k, clip]) => ({where: `clips.${k}`, clip}))];
}

// blend の Action の一覧(tools/creature_actions.py の出力)と spec を照らす。無い名前は errors、コマが Action の範囲の外なら warnings
export function checkSpecAgainstActions(spec, listing) {
  const errors = [], warnings = [];
  for (const {where, clip} of clipsOf(spec)) {
    const a = listing.actions?.[clip[0]];
    if (!a) { errors.push(`${where} の Action「${clip[0]}」が blend に無い（あるのは ${Object.keys(listing.actions ?? {}).join(', ') || 'なし'}）`); continue; }
    const [lo, hi] = a.frames;
    if (clip[1] < Math.floor(lo) || clip[2] > Math.ceil(hi)) warnings.push(`${where} のコマ ${clip[1]}〜${clip[2]} が Action「${clip[0]}」の範囲 ${lo}〜${hi} の外`);
  }
  return {errors, warnings};
}

export function blenderPath(config = {}, env = process.env) { return env.CHARASTA_BLENDER || config.blender; }

const script = name => path.join(root, 'tools', name);

// blend の Action とコマの範囲。Armature か Action が無ければ Blender が終了コード 1 で終わり、例外にする
export async function listBlendActions(blend, {blender, timeoutMs = BLENDER_TIMEOUT_MS} = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'creature-'));
  try {
    const out = path.join(tmp, 'actions.json');
    try { await run(blender, ['-b', '--factory-startup', blend, '--python-exit-code', '1', '--python', script('creature_actions.py'), '--', out], {timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20}); }
    catch (e) { throw bad(`Blender で ${path.basename(blend)} を調べられなかった: ${String(e.stderr || e.message).trim().split('\n').slice(-3).join(' / ')}`); }
    return JSON.parse(await fs.readFile(out, 'utf8'));
  } finally { await fs.rm(tmp, {recursive: true, force: true}); }
}

// rest の姿勢のサムネイル(512x512、背景は透明)を out に書く。短いパスの一時フォルダに描いてから移す
export async function renderCreatureThumb(blend, spec, out, {blender, size = 512, timeoutMs = BLENDER_TIMEOUT_MS} = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'creature-'));
  try {
    const specFile = path.join(tmp, 'creature.json'), png = path.join(tmp, 'thumb.png');
    await fs.writeFile(specFile, JSON.stringify(spec));
    try { await run(blender, ['-b', '--factory-startup', blend, '--python-exit-code', '1', '--python', script('creature_thumb.py'), '--', specFile, png, String(size)], {timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20}); }
    catch (e) { throw bad(`サムネイルを描けなかった: ${String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-3).join(' / ')}`); }
    await fs.copyFile(png, out);
  } finally { await fs.rm(tmp, {recursive: true, force: true}); }
}

// 生き物のバージョンを取り込む。順序: spec の形 -> Blender で Action の名前 -> コピー -> サムネイル。
// 名前が無ければ何も作らずに止める。サムネイルの失敗はバージョンを消さず、thumbError に理由を入れて返す。
// list と thumb は差し替えられる(試験用)
export async function importCreature(lib, {charId, id, label = '', note = '', src, spec, latest = false}, {blender, list = listBlendActions, thumb = renderCreatureThumb} = {}) {
  const ch = await lib.getCharacterJson(charId);
  if (!isCreature(ch)) throw bad(`キャラ ${charId} は生き物ではない。生き物のバージョンは style が creature のキャラにだけ取り込める`);
  const checked = checkCreatureSpec(spec), blend = path.resolve(src);
  if (!await fs.stat(blend).then(s => s.isFile(), () => false)) throw bad('blend が無い: ' + blend);
  const listed = await list(blend, {blender}), {errors, warnings} = checkSpecAgainstActions(checked, listed);
  const external = Array.isArray(listed.externalImages) ? listed.externalImages : [];
  if (external.length) warnings.push(`パックされていない外部の画像が ${external.length} 枚ある(${external.join(', ')})。取り込んだ model.blend は相対パスの画像を見つけられず、貼られない。先に Blender で「全てをパック」してから取り込む`);
  if (errors.length) throw bad('Action の確認に失敗した:\n' + errors.map(e => '  ' + e).join('\n'));
  const version = await lib.importCreatureVersion({charId, id, label, note, blendFile: blend, spec: checked, sourcePath: blend, latest});
  let thumbError = null;
  const vdir = lib.versionDir(charId, id);   // 保存した複製から描く。元の blend だけにある相対パスの画像で描き違えないため
  try { await thumb(path.join(vdir, 'model.blend'), checked, path.join(vdir, 'thumb.png'), {blender}); } catch (e) { thumbError = e.message; }
  return {version, warnings, thumbError};
}

// ---- ショートの take.creature ----

// 新しい書き方(charId がある)か、前からの書き方(blend のパスと全部の値)か
export const isCreatureRef = c => !!c && typeof c === 'object' && !Array.isArray(c) && 'charId' in c;

// 保存の前の確かめ。前からの書き方はそのまま通す。新しい書き方は charId が生き物で、バージョンが生き物のバージョンかを確かめて、載せてよい項目だけ残す
export async function creatureRefBody(lib, c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad('take.creature が連想配列ではない');
  if (!isCreatureRef(c)) return c;
  if ('blend' in c) throw bad('take.creature は charId か blend のどちらか一方で書く');
  const unknown = Object.keys(c).filter(k => !REF_KEYS.includes(k));
  if (unknown.length) throw bad(`take.creature に知らない項目: ${unknown.join(', ')}（使えるのは ${REF_KEYS.join(' / ')}）`);
  const charId = checkId(c.charId, 'キャラ ID'), ch = await lib.getCharacterJson(charId);
  if (!isCreature(ch)) throw bad(`キャラ ${charId} は生き物ではない（take.creature に使えるのは style が creature のキャラ）`);
  const verId = checkId(c.verId ?? ch.latestVersion, 'バージョン ID');
  await findCreatureVersion(lib, charId, verId);
  const out = {charId, ...(c.verId ? {verId} : {}), perch: c.perch, path: c.path};
  if (!Number.isInteger(c.perch) || c.perch < 0 || c.perch > 99) throw bad('take.creature.perch は止まり木の番号（0 以上の整数）');
  if (!Array.isArray(c.path) || c.path.length !== 3 || !c.path.every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) throw bad('take.creature.path は [x, y, z] を 3 つ（枝から先のベジェの残りの 3 点）');
  if (c.flight !== undefined) out.flight = num(c.flight, 'take.creature.flight', 0.5, 60);
  if (c.yaw !== undefined) out.yaw = num(c.yaw, 'take.creature.yaw', -360, 360);
  if (c.scale !== undefined) out.scale = num(c.scale, 'take.creature.scale', 0.001, 1000);
  if (c.drop !== undefined) out.drop = num(c.drop, 'take.creature.drop', -10, 10);
  return out;
}

async function findCreatureVersion(lib, charId, verId) {
  if (!await lib.versionExists(charId, verId)) throw new LibraryError('not-found', `バージョン ${charId}/${verId} が無い`);
  const dir = lib.versionDir(charId, verId), v = await readJson(path.join(dir, 'version.json'));
  if (v.kind !== 'creature') throw bad(`バージョン ${charId}/${verId} は生き物のバージョンではない`);
  return {dir, v};
}

// 撮るときの解決。参照を stage-studio の lib/creature.py の spec({blend, perch, ...})にする。場面ごとの値が creature.json より優先。
// 前からの書き方はそのまま返す。sha256 はバージョンの blend の中身(コマの ID に混ぜる)
export async function resolveCreature(lib, c) {
  if (!isCreatureRef(c)) return {spec: c, sha256: null};
  const body = await creatureRefBody(lib, c), ch = await lib.getCharacterJson(body.charId);
  const {dir, v} = await findCreatureVersion(lib, body.charId, body.verId ?? ch.latestVersion);
  const base = await readJson(path.join(dir, 'creature.json')), {charId, verId, ...shot} = body;
  return {spec: {...base, ...shot, blend: path.join(dir, 'model.blend')}, sha256: v.sha256};
}

// カットの creature の動き(tilt、down、stare、takeoff)が、生き物の spec にあるか。takeoff は caw と fly を使う(lib/creature.py)
export function checkCues(spec, cues) {
  const lack = new Set();
  for (const name of cues) {
    if (name === 'takeoff') { if (!spec.clips?.caw) lack.add('clips.caw'); if (!spec.fly) lack.add('fly'); }
    else if (!spec.clips?.[name]) lack.add(`clips.${name}`);
  }
  if (lack.size) throw bad(`生き物の動きが足りない: ${[...lack].join(', ')}（カットの creature が使う）`);
}
