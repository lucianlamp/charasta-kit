// 直しの頼みごと(仕上げの「体型と揺れもの」の「Claude に依頼する」、docs/adjust.md)。保管場所の adjust-requests/<ID>/ に request.json と今の見た目の絵を置く。
//   画面(server.mjs の /api/adjust-requests)が作る・絵を足す・取り下げる。エージェント(scripts/adjust-requests.mjs)が始める・片付ける・見送る
//   状態: waiting(対応待ち) → working(作業中) → done(完了。作った新しいバージョンが付く) か declined(見送り)。取り下げは対応待ちのときだけで、フォルダごと消す
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {LibraryError, checkId, inside, readJsonOr, writeJson} from './library.mjs';
import {imageKind} from './stage-requests.mjs';

export const ADJUST_AREAS = {body: '体型', springs: '揺れもの', other: 'その他'};
export const TEXT_MAX = 1000, REPLY_MAX = 400, MAX_SHOT_BYTES = 8 * 1024 * 1024;

const baseDir = libDir => path.join(path.resolve(libDir), 'adjust-requests');
const dirOf = (libDir, id) => inside(libDir, 'adjust-requests', checkId(id, '依頼の ID'));
const file = (libDir, id) => path.join(dirOf(libDir, id), 'request.json');
const nowIso = (now = new Date()) => now.toISOString();

function text(v, what, max) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new LibraryError('bad-input', `${what}が要る`);
  if (s.length > max) throw new LibraryError('bad-input', `${what}は ${max} 字まで`);
  return s;
}

export async function getAdjustRequest(libDir, id) {
  const r = await readJsonOr(file(libDir, id));
  if (!r) throw new LibraryError('not-found', `依頼 ${id} が無い`);
  return r;
}

// 新しい順。charId を渡すとそのキャラの分だけ
export async function listAdjustRequests(libDir, {charId = null} = {}) {
  const names = await fs.readdir(baseDir(libDir), {withFileTypes: true}).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const all = await Promise.all(names.filter(d => d.isDirectory()).map(d => readJsonOr(path.join(baseDir(libDir), d.name, 'request.json')).catch(() => null)));
  return all.filter(r => r && (!charId || r.charId === charId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

// lib は Library(キャラとバージョンがあるかを見る)。ID は日時と乱数
export async function createAdjustRequest(lib, {charId, verId, area, text: body} = {}, now = new Date()) {
  checkId(charId, 'キャラ ID'); checkId(verId, 'バージョン ID');
  if (!await lib.versionExists(charId, verId)) throw new LibraryError('not-found', `バージョン ${charId}/${verId} が無い`);
  if (!Object.hasOwn(ADJUST_AREAS, area)) throw new LibraryError('bad-input', `どこを直すかは ${Object.keys(ADJUST_AREAS).join('、')}`);
  const r = {charId, verId, area, text: text(body, '直してほしいこと', TEXT_MAX)};
  await fs.mkdir(baseDir(lib.dir), {recursive: true});
  for (;;) {
    const id = nowIso(now).slice(0, 19).replace(/[-:]/g, '').replace('T', '-') + '-' + crypto.randomBytes(2).toString('hex');
    try { await fs.mkdir(dirOf(lib.dir, id)); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    const req = {id, ...r, shot: null, state: 'waiting', createdAt: nowIso(now), reply: '', repliedAt: null, newVersion: null};
    await writeJson(file(lib.dir, id), req);
    return req;
  }
}

// 今の見た目の絵を 1 枚付ける(付け直しは置き換え)。対応待ちのときだけ
export async function setAdjustShot(libDir, id, data) {
  const req = await getAdjustRequest(libDir, id);
  if (req.state !== 'waiting') throw new LibraryError('busy', '対応待ちの依頼にだけ絵を付けられる');
  if (!data?.length || data.length > MAX_SHOT_BYTES) throw new LibraryError('bad-input', `絵は ${MAX_SHOT_BYTES / 1048576} MB まで`);
  const ext = imageKind(data);
  if (!ext) throw new LibraryError('bad-input', '絵は PNG、JPEG、WebP');
  if (req.shot) await fs.rm(path.join(dirOf(libDir, id), req.shot), {force: true});
  req.shot = `shot.${ext}`;
  await fs.writeFile(path.join(dirOf(libDir, id), req.shot), data);
  await writeJson(file(libDir, id), req);
  return {file: req.shot};
}

export async function adjustShotFile(libDir, id) {
  const req = await getAdjustRequest(libDir, id);
  if (!req.shot) throw new LibraryError('not-found', '絵が無い');
  return inside(dirOf(libDir, id), req.shot);
}

export async function cancelAdjustRequest(libDir, id) {
  const req = await getAdjustRequest(libDir, id);
  if (req.state !== 'waiting') throw new LibraryError('busy', '対応待ちの依頼だけ取り下げられる');
  await fs.rm(dirOf(libDir, id), {recursive: true, force: true});
  return {id, cancelled: true};
}

async function move(libDir, id, from, change) {
  const req = await getAdjustRequest(libDir, id);
  if (!from.includes(req.state)) throw new LibraryError('busy', `依頼 ${id} は ${req.state}（${from.join(' か ')} のときだけできる）`);
  const next = {...req, ...change};
  await writeJson(file(libDir, id), next);
  return next;
}

export const startAdjustRequest = (libDir, id) => move(libDir, id, ['waiting'], {state: 'working'});

// 作ったバージョンを付けて片付ける。そのバージョンがこのキャラにあり、頼まれたときのバージョンとは別のものだけ
export async function finishAdjustRequest(lib, id, {version, reply, now = new Date()}) {
  const msg = text(reply, '返事', REPLY_MAX);
  const req = await getAdjustRequest(lib.dir, id);
  checkId(version, '新しいバージョン ID');
  if (version === req.verId) throw new LibraryError('bad-input', `バージョン ${version} は依頼されたときのバージョン。直した結果は新しいバージョンにする（バージョンは上書きしない）`);
  if (!await lib.versionExists(req.charId, version)) throw new LibraryError('bad-input', `バージョン ${req.charId}/${version} が無い。先に新しいバージョンを作る`);
  return move(lib.dir, id, ['waiting', 'working'], {state: 'done', newVersion: version, reply: msg, repliedAt: nowIso(now)});
}

export async function declineAdjustRequest(libDir, id, {reply, now = new Date()}) {
  const msg = text(reply, '返事', REPLY_MAX);
  return move(libDir, id, ['waiting', 'working'], {state: 'declined', reply: msg, repliedAt: nowIso(now)});
}

export const withShotUrl = req => ({...req, shotUrl: req.shot ? `/api/adjust-requests/${encodeURIComponent(req.id)}/shot` : null});
