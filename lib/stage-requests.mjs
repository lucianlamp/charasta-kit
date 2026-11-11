// ステージの頼みごと(ステージの画面の「新しいステージを頼む」、docs/stages.md)。保管場所の stage-requests/<ID>/ に request.json と参考の絵を置く。
//   画面(server.mjs の /api/stage-requests)が作る・参考の絵を足す・取り下げる。エージェント(scripts/stage-requests.mjs)が始める・片付ける・見送る
//   状態: waiting(対応待ち) → working(作業中) → done(完了) か declined(見送り)。取り下げは対応待ちのときだけで、フォルダごと消す
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {LibraryError, checkId, inside, readJsonOr, writeJson} from './library.mjs';
import {stageCatalog, stageThumb} from './stages.mjs';

export const STAGE_REQUEST_STATES = ['waiting', 'working', 'done', 'declined'];
export const LABEL_MAX = 40, DESCRIPTION_MAX = 1000, REPLY_MAX = 400, MAX_REFS = 4, MAX_REF_BYTES = 8 * 1024 * 1024;
// 参考の絵は中身の先頭で種類を見る(拡張子は信じない)
const IMAGE_KINDS = [['png', b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['jpg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['webp', b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP']];
// 絵の種類(png、jpg、webp)。どれでもなければ undefined。直しの頼みごと(lib/adjust-requests.mjs)も使う
export const imageKind = data => IMAGE_KINDS.find(([, test]) => test(data))?.[0];

const baseDir = libDir => path.join(path.resolve(libDir), 'stage-requests');
const dirOf = (libDir, id) => inside(libDir, 'stage-requests', checkId(id, '依頼の ID'));
const file = (libDir, id) => path.join(dirOf(libDir, id), 'request.json');
const nowIso = (now = new Date()) => now.toISOString();

function text(v, what, max) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new LibraryError('bad-input', `${what}が要る`);
  if (s.length > max) throw new LibraryError('bad-input', `${what}は ${max} 字まで`);
  return s;
}

export async function getStageRequest(libDir, id) {
  const r = await readJsonOr(file(libDir, id));
  if (!r) throw new LibraryError('not-found', `依頼 ${id} が無い`);
  return r;
}

// 新しい順
export async function listStageRequests(libDir) {
  const names = await fs.readdir(baseDir(libDir), {withFileTypes: true}).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const all = await Promise.all(names.filter(d => d.isDirectory()).map(d => readJsonOr(path.join(baseDir(libDir), d.name, 'request.json')).catch(() => null)));
  return all.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

// ID は日時と乱数(英小文字・数字・ハイフン)。同じ ID のフォルダがあれば作り直す
export async function createStageRequest(libDir, {label, description} = {}, now = new Date()) {
  const r = {label: text(label, '名前', LABEL_MAX), description: text(description, 'どんな場所か', DESCRIPTION_MAX)};
  await fs.mkdir(baseDir(libDir), {recursive: true});
  for (;;) {
    const id = nowIso(now).slice(0, 19).replace(/[-:]/g, '').replace('T', '-') + '-' + crypto.randomBytes(2).toString('hex');
    try { await fs.mkdir(dirOf(libDir, id)); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    const req = {id, ...r, refs: [], state: 'waiting', createdAt: nowIso(now), reply: '', repliedAt: null, stageId: null};
    await writeJson(file(libDir, id), req);
    return req;
  }
}

// 参考の絵を 1 枚足す。対応待ちのときだけ。name は元のファイルの名前(画面に出すだけ)
export async function addStageRef(libDir, id, {name = '', data}) {
  const req = await getStageRequest(libDir, id);
  if (req.state !== 'waiting') throw new LibraryError('busy', '対応待ちの依頼にだけ絵を追加できる');
  if (req.refs.length >= MAX_REFS) throw new LibraryError('bad-input', `参考の絵は ${MAX_REFS} 枚まで`);
  if (!data?.length || data.length > MAX_REF_BYTES) throw new LibraryError('bad-input', `参考の絵は 1 枚 ${MAX_REF_BYTES / 1048576} MB まで`);
  const ext = imageKind(data);
  if (!ext) throw new LibraryError('bad-input', '参考の絵は PNG、JPEG、WebP');
  const ref = {file: `ref-${req.refs.length + 1}.${ext}`, name: String(name).slice(0, 120)};
  await fs.writeFile(path.join(dirOf(libDir, id), ref.file), data);
  req.refs.push(ref);
  await writeJson(file(libDir, id), req);
  return ref;
}

// 参考の絵のファイル。request.json に書いたものだけ
export async function stageRefFile(libDir, id, name) {
  const req = await getStageRequest(libDir, id);
  if (!req.refs.some(r => r.file === name)) throw new LibraryError('not-found', `参考の絵 ${name} が無い`);
  return inside(dirOf(libDir, id), name);
}

// 取り下げ。対応待ちのときだけ。フォルダごと消す
export async function cancelStageRequest(libDir, id) {
  const req = await getStageRequest(libDir, id);
  if (req.state !== 'waiting') throw new LibraryError('busy', '対応待ちの依頼だけ取り下げられる');
  await fs.rm(dirOf(libDir, id), {recursive: true, force: true});
  return {id, cancelled: true};
}

async function move(libDir, id, from, change) {
  const req = await getStageRequest(libDir, id);
  if (!from.includes(req.state)) throw new LibraryError('busy', `依頼 ${id} は ${req.state}（${from.join(' か ')} のときだけできる）`);
  const next = {...req, ...change};
  await writeJson(file(libDir, id), next);
  return next;
}

// エージェントが作業を始める
export const startStageRequest = (libDir, id) => move(libDir, id, ['waiting'], {state: 'working'});

// 作ったシーンを付けて片付ける。stage-studio のシーンの一覧にあり、サムネイルがあるシーンだけ
export async function finishStageRequest(libDir, id, {stageDir, stageId, reply, now = new Date()}) {
  const msg = text(reply, '返事', REPLY_MAX);
  if (!stageDir) throw new LibraryError('bad-input', 'stage-studio の場所が設定されていない（config.json の stageStudioDir）');
  checkId(stageId, 'ステージ ID');
  if (!(await stageCatalog(stageDir)).some(s => s?.id === stageId)) throw new LibraryError('bad-input', `ステージ ${stageId} が stage-studio の stages/catalog.json に無い`);
  if (!await fs.access(stageThumb(stageDir, stageId)).then(() => true, () => false)) throw new LibraryError('bad-input', `ステージ ${stageId} のサムネイル(assets/thumbs/${stageId}.jpg)が無い`);
  return move(libDir, id, ['waiting', 'working'], {state: 'done', stageId, reply: msg, repliedAt: nowIso(now)});
}

// 作らないと決めたとき。理由を返事に書く
export async function declineStageRequest(libDir, id, {reply, now = new Date()}) {
  const msg = text(reply, '返事', REPLY_MAX);
  return move(libDir, id, ['waiting', 'working'], {state: 'declined', reply: msg, repliedAt: nowIso(now)});
}

// 画面と CLI に渡す形: 参考の絵に URL を付ける
export const withRefUrls = req => ({...req, refs: req.refs.map(r => ({...r, url: `/api/stage-requests/${encodeURIComponent(req.id)}/refs/${encodeURIComponent(r.file)}`}))});
