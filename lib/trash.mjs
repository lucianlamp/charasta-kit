// ごみ箱: 消す操作は保管場所の trash/ への移動で、すぐには失わない。docs/characters.md の「ごみ箱」。
//   trash/<ごみ箱 ID>/trash.json   何を消したかの記録(kind、id、charId、paths、label、trashedAt、sizeBytes、meta)
//   trash/<ごみ箱 ID>/files/<元のパス>   移したもの。キャラは characters/<id> と studio/<id>(表情づくり)の 2 か所
// 記録を先に書いてから移す。途中で止まっても、記録の paths のうち files/ に残っているものだけを戻せる。
// trash.json の無い項目は、この仕組みより前の trash/(動画からのモーションを捨てたもの、古いセリフ)。一覧には出すが戻せない。
import fs from 'node:fs/promises';
import path from 'node:path';
import {LibraryError, checkId, inside, readJsonOr, writeJson} from './library.mjs';
import {busyOf} from './studio.mjs';

export const TRASH_DIR = 'trash';
export const TRASH_KINDS = ['character', 'version', 'line', 'shoot', 'motion', 'short'];
const TRASH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const RETRY = 6, RETRY_MS = 150;

const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
// リンク(symlink、junction)そのものがあるかどうか。リンク先は見ない
async function lexists(file) { try { await fs.lstat(file); return true; } catch { return false; } }
async function listDirs(dir) {
  try { return (await fs.readdir(dir, {withFileTypes: true})).filter(d => d.isDirectory()).map(d => d.name).sort(); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
// リンクはたどらない(lstat)。リンク先の大きさは数えない
async function dirSize(p) {
  let st;
  try { st = await fs.lstat(p); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const name of await fs.readdir(p)) n += await dirSize(path.join(p, name));
  return n;
}
// 再生中の動画などでファイルが開かれていると、Windows ではフォルダを移せない。少し待って試し直し、だめなら理由を返す
export async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return await fs.rename(from, to); } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      if (i >= RETRY) throw new LibraryError('busy', 'ファイルが開かれていて移せない。再生中の画面を閉じてからやり直す');
      await sleep(RETRY_MS);
    }
  }
}

// 種類・キャラ・ID から元の場所(保管場所からの相対パス)を作る。trash.json の paths は信用せず、これと照らす
export function pathsOf(kind, charId, id) {
  switch (kind) {
    case 'character': return [`characters/${charId}`, `studio/${charId}`];
    case 'version': return [`characters/${charId}/versions/${id}`];
    case 'line': return [`characters/${charId}/lines/${id}`];
    case 'shoot': return [`characters/${charId}/shoots/${id}`];
    case 'motion': return [`motions/${id}`];
    case 'short': return [`shorts/${id}`];
    default: throw new LibraryError('bad-input', 'kind は ' + TRASH_KINDS.join(' / ') + ': ' + kind);
  }
}

// dir の中身の大きさを数えて trash.json を書く。video-motion の捨てる操作(lib/jobs.mjs)も使う
export async function recordTrash(dir, fields) {
  const rec = {paths: [], meta: {}, ...fields, trashedAt: now(), sizeBytes: await dirSize(dir)};
  await writeJson(path.join(dir, 'trash.json'), rec);
  return rec;
}

export class Trash {
  // jobs: 順番待ちと実行中のジョブを返す active() を持つもの(無ければジョブは見ない)
  // opts.rename: フォルダを移す関数。テストが失敗を差し込むために替える
  constructor(lib, jobs = null, {rename = renameRetry} = {}) { this.lib = lib; this.jobs = jobs; this.rename = rename; this.dir = path.join(lib.dir, TRASH_DIR); }

  // ---- 消す前の確かめ ----
  // 消す対象の ref は {charId, id}(character は charId のみ、motion は id のみ)。断る理由は refusal に入れて返す。
  // 場所と記録の ID には、確かめ済みの ref を使う(ファイルの中の id は使わない)
  async #plan(kind, ref) {
    const lib = this.lib, effects = [];
    if (!TRASH_KINDS.includes(kind)) throw new LibraryError('bad-input', 'kind は ' + TRASH_KINDS.join(' / ') + ': ' + kind);
    if (kind !== 'motion' && kind !== 'short') checkId(ref.charId, 'キャラ ID');
    if (kind !== 'character') checkId(ref.id, {motion: 'モーション ID', version: '版 ID', line: 'セリフ ID', shoot: '動画 ID', short: 'ショート ID'}[kind]);
    const charId = kind === 'motion' || kind === 'short' ? null : ref.charId, id = kind === 'character' ? ref.charId : ref.id;
    const add = (key, count, text) => { if (count) effects.push({key, count, text}); };
    const active = this.jobs ? await this.jobs.active() : [];
    const busy = pred => active.filter(j => pred(j.input ?? {})).map(j => `ジョブ ${j.id}`);
    const motions = kind === 'character' || kind === 'version' ? await lib.listMotions() : [];
    // ショートのジョブの入力は input.short にある。生き物は take.creature.charId、出演者は cast[].charId で参照する
    const shortUses = (i, cid, vid, latest) => {
      const hit = r => r && typeof r === 'object' && r.charId === cid && (vid == null || (r.verId ?? latest) === vid);
      return hit(i.short?.take?.creature) || (Array.isArray(i.short?.cast) && i.short.cast.some(hit));
    };
    let plan;
    if (kind === 'character') {
      const ch = await lib.getCharacter(charId), studios = await this.#studios(charId);
      const fitted = motions.filter(m => m.fittedTo?.charId === charId);
      add('versions', ch.versions.length, `版 ${ch.versions.length} 件`);
      add('lines', ch.lines.length, `セリフ ${ch.lines.length} 件`);
      add('shoots', ch.shoots.length, `撮った動画 ${ch.shoots.length} 件`);
      add('studios', studios.length, `表情づくり ${studios.length} 件`);
      add('fitted', fitted.length, `このキャラ用に合わせたモーション ${fitted.length} 本は残る。対象のキャラの表示が、消えたキャラの名前のままになる`);
      // 表情づくりの工程の状態は work.json にある。ジョブでない材料のコピーや CLI の実行も、ここで分かる
      const studioBusy = studios.filter(s => s.busy.length).map(s => `表情づくり ${s.id}(${s.busy.join('・')})`);
      const apps = await lib.appearances(charId);
      add('shorts', apps.length, `このキャラが出るショート ${apps.length} 件は残る。生き物や出演者の参照は消えたキャラを指す`);
      plan = {label: ch.name, busy: [...busy(i => i.charId === charId || shortUses(i, charId)), ...studioBusy], meta: {charCreatedAt: ch.createdAt ?? null}};
    } else if (kind === 'version') {
      const ch = await lib.getCharacter(charId), v = ch.versions.find(x => x.id === id);
      if (!v) throw new LibraryError('not-found', `版 ${charId}/${id} が無い`);
      const shoots = ch.shoots.filter(s => s.verId === id), movies = ch.lines.flatMap(l => l.videos).filter(x => x.verId === id);
      const studios = (await this.#studios(charId)).filter(s => s.versions.includes(id));
      const fitted = motions.filter(m => m.fittedTo?.charId === charId && m.fittedTo.verId === id);
      const rest = ch.versions.filter(x => x.id !== id), movedTo = ch.latestVersion === id && rest.length ? [...rest].sort((a, b) => (b.order ?? 0) - (a.order ?? 0))[0].id : null;
      add('shoots', shoots.length, `この版で撮った動画 ${shoots.length} 件は残る。記録は消えた版を指す`);
      add('lineVideos', movies.length, `この版で作ったセリフの動画 ${movies.length} 本は残る`);
      add('studios', studios.length, `この版を作った表情づくり ${studios.length} 件は残る。記録は消えた版を指す`);
      add('fitted', fitted.length, `この版に合わせたモーション ${fitted.length} 本は残る。対象のキャラの表示が、消えた版のままになる`);
      let shortRefs = 0;
      for (const a of await lib.appearances(charId)) {
        const sh = await lib.getShort(a.shortId).catch(() => null), hit = r => r && typeof r === 'object' && r.charId === charId && (r.verId ?? ch.latestVersion) === id;
        if (sh && (hit(sh.take?.creature) || (Array.isArray(sh.cast) && sh.cast.some(hit)))) shortRefs++;
      }
      add('shorts', shortRefs, `この版を使うショート ${shortRefs} 件は残る。記録は消えた版を指す`);
      if (movedTo) add('latest', 1, `最新の版が ${movedTo} に移る`);
      plan = {label: `${ch.name} ${id}`, charName: ch.name, busy: busy(i => (i.charId === charId && i.verId === id) || shortUses(i, charId, id, ch.latestVersion)),
        meta: {wasLatest: ch.latestVersion === id, movedTo, charCreatedAt: ch.createdAt ?? null},
        refusal: ch.versions.length <= 1 ? {code: 'last-version', message: `${ch.name} の版はこの 1 つだけなので、版だけは消せない。キャラごと消すならキャラの削除から`} : null};
    } else if (kind === 'line') {
      const ch = await lib.getCharacter(charId), l = ch.lines.find(x => x.id === id);
      if (!l) throw new LibraryError('not-found', `セリフ ${charId}/${id} が無い`);
      const shoots = ch.shoots.filter(s => s.lineId === id);
      add('movies', l.videos.length, `セリフの動画 ${l.videos.length} 本も一緒に移る`);
      add('shoots', shoots.length, `このセリフを使って撮った動画 ${shoots.length} 件は残る`);
      plan = {label: l.text || id, charName: ch.name, busy: busy(i => i.charId === charId && i.lineId === id), meta: {charCreatedAt: ch.createdAt ?? null}};
    } else if (kind === 'shoot') {
      const ch = await lib.getCharacter(charId), s = ch.shoots.find(x => x.id === id);
      if (!s) throw new LibraryError('not-found', `撮った動画 ${charId}/${id} が無い`);
      plan = {label: [s.motionLabel ?? 'モーションなし', s.lineText, s.aspect, s.verId].filter(Boolean).join('・'), charName: ch.name, busy: [], meta: {charCreatedAt: ch.createdAt ?? null}};
    } else if (kind === 'short') {
      const s = await lib.getShort(id);
      plan = {label: s.title, busy: busy(i => i.shortId === id), meta: {}};
    } else {
      const m = await lib.getMotion(id), users = [];
      for (const c of await lib.listCharacters()) users.push(...(await lib.shoots(c.id)).filter(s => s.motionId === id));
      add('shoots', users.length, `このモーションで撮った動画 ${users.length} 件は残る`);
      plan = {label: m.label || m.name || id, busy: busy(i => i.motionId === id || i.short?.cuts?.some(c => c.motionId === id) || (Array.isArray(i.segments) && i.segments.some(c => c.motion === id))), meta: {}};
    }
    const paths = [];
    for (const rel of pathsOf(kind, charId, id)) if (await lexists(inside(lib.dir, rel))) paths.push(rel);
    const refusal = plan.refusal ?? (plan.busy.length ? {code: 'busy', message: `順番待ちか実行中の処理が使っている(${plan.busy.join('、')})。終わってからにする`} : null);
    return {kind, charId, id, charName: null, effects, ...plan, refusal, paths, slug: kind === 'character' ? `character-${id}` : [kind, charId, id].filter(Boolean).join('-')};
  }

  // 表情づくりの一覧: studio/<キャラ>/<id>/work.json から版の ID と、動いている工程を読む
  async #studios(charId) {
    const base = this.lib.studioBase(charId), out = [];
    for (const id of await listDirs(base)) {
      const w = await readJsonOr(path.join(base, id, 'work.json'));
      if (w) out.push({id, versions: (w.versions ?? []).map(v => v.verId), busy: busyOf({...w, steps: w.steps ?? {}})});
    }
    return out;
  }

  // 消す前の確認に出すもの。断る理由があっても例外にせず返す(画面が理由を見せて、ボタンを押せなくする)
  async impact(kind, ref) {
    const p = await this.#plan(kind, ref), sizes = await Promise.all(p.paths.map(rel => dirSize(inside(this.lib.dir, rel))));
    return {kind, charId: p.charId, id: p.id, label: p.label, sizeBytes: sizes.reduce((a, b) => a + b, 0), effects: p.effects, refusal: p.refusal};
  }

  // ---- 移す ----
  async move(kind, ref) {
    const p = await this.#plan(kind, ref);
    if (p.refusal) throw new LibraryError(p.refusal.code, p.refusal.message);
    const stem = `${now().replace(/[:.]/g, '-')}-${p.slug}`, moved = [];
    await fs.mkdir(this.dir, {recursive: true});
    let trashId = stem, item = inside(this.dir, trashId);
    for (let n = 2; ; n++) {   // 同じ名前が既にあれば(同じ ms に同じものを消した)、前のごみ箱の項目を上書きせず別の名前にする
      try { await fs.mkdir(item); break; } catch (e) { if (e.code !== 'EEXIST') throw e; trashId = `${stem}-${n}`; item = inside(this.dir, trashId); }
    }
    await fs.mkdir(path.join(item, 'files'));
    // 記録を先に書く。移す途中で止まっても、files/ に移った分を記録から戻せる
    const sizes = await Promise.all(p.paths.map(rel => dirSize(inside(this.lib.dir, rel))));
    const rec = {kind, id: p.id, charId: p.charId, charName: p.charName, label: p.label, paths: p.paths, meta: p.meta, trashedAt: now(), sizeBytes: sizes.reduce((a, b) => a + b, 0)};
    try { await writeJson(path.join(item, 'trash.json'), rec); } catch (e) { await fs.rm(item, {recursive: true, force: true}); throw e; }   // まだ何も移していない
    try {
      for (const rel of p.paths) {
        const to = inside(item, 'files', rel);
        await fs.mkdir(path.dirname(to), {recursive: true});
        await this.rename(inside(this.lib.dir, rel), to);
        moved.push(rel);
      }
      if (p.meta.movedTo) await this.lib.updateCharacter(p.charId, {latestVersion: p.meta.movedTo});   // 最新の版を消したら、残りの order が最大の版へ移す
      return {...rec, trashId, restorable: true};
    } catch (e) {
      const left = await this.#giveBack(item, rec, moved);
      if (left.length) throw new LibraryError('busy', `移す途中で失敗し、${left.length} か所を元に戻せなかった。ごみ箱の ${trashId} に残してある(「戻す」で続きから戻せる): ${e.message}`);
      throw e;
    }
  }

  // 移した分を元の場所へ戻す。全部戻せたときだけ項目を消し、戻せなかった分は記録の paths に残す。戻せなかった paths を返す
  async #giveBack(item, rec, moved) {
    const left = [];
    for (const rel of [...moved].reverse()) {
      try { await this.rename(inside(item, 'files', rel), inside(this.lib.dir, rel)); } catch { left.push(rel); }
    }
    if (!left.length) { await fs.rm(item, {recursive: true, force: true}); return left; }
    left.reverse();
    await writeJson(path.join(item, 'trash.json'), {...rec, paths: left, sizeBytes: await dirSize(item)});
    return left;
  }

  // ---- 一覧 ----
  async list() {
    const items = [];
    for (const name of await listDirs(this.dir)) {
      if (!TRASH_ID_RE.test(name)) continue;
      const dir = inside(this.dir, name), rec = await readJsonOr(path.join(dir, 'trash.json')).catch(() => null);
      if (rec) items.push({...rec, trashId: name, restorable: !!rec.paths?.length && TRASH_KINDS.includes(rec.kind)});
      else items.push({trashId: name, kind: 'other', id: null, charId: null, charName: null, label: name, paths: [], meta: {}, restorable: false,
        trashedAt: (await fs.stat(dir)).mtime.toISOString(), sizeBytes: await dirSize(dir)});
    }
    items.sort((a, b) => (a.trashedAt < b.trashedAt ? 1 : -1));   // 新しい順
    return {items, count: items.length, totalBytes: items.reduce((n, x) => n + x.sizeBytes, 0)};
  }

  async #item(trashId) {
    if (typeof trashId !== 'string' || !TRASH_ID_RE.test(trashId)) throw new LibraryError('bad-id', 'ごみ箱の ID が不正: ' + JSON.stringify(trashId));
    const dir = inside(this.dir, trashId);
    if (!await exists(dir)) throw new LibraryError('not-found', `ごみ箱に ${trashId} が無い`);
    return {dir, rec: await readJsonOr(path.join(dir, 'trash.json')).catch(() => null)};
  }

  // ---- 戻す ----
  // files/ に残っている paths だけを戻す(途中で止まった項目の続き)。元の場所は kind・charId・id から作り直し、記録の paths がそれ以外なら断る
  async restore(trashId) {
    const {dir, rec} = await this.#item(trashId);
    if (!rec?.paths?.length || !TRASH_KINDS.includes(rec.kind)) throw new LibraryError('bad-input', 'この項目は戻せない(この仕組みより前に移したもので、元の場所の記録が無い)');
    if (rec.kind !== 'motion' && rec.kind !== 'short') checkId(rec.charId, 'キャラ ID');
    if (rec.kind !== 'character') checkId(rec.id, 'ID');
    const expected = pathsOf(rec.kind, rec.charId, rec.id);
    for (const rel of rec.paths) {
      if (typeof rel !== 'string' || !expected.includes(rel)) throw new LibraryError('bad-input', '元のパスが不正: ' + JSON.stringify(rel));
    }
    const present = [];
    for (const rel of rec.paths) {
      const from = inside(dir, 'files', rel);
      if (await lexists(from)) present.push({rel, from, to: inside(this.lib.dir, rel)});
    }
    if (!present.length) { await this.#remove(dir); return rec; }   // 中身は既に元の場所へ戻っている
    for (const {rel, to} of present) {
      if (await lexists(to)) throw new LibraryError('exists', `${rel} は既にある(上書きしない)。同じ ID のものを先に消すか、そのままにする`);
    }
    if (rec.kind !== 'character' && rec.kind !== 'motion' && rec.kind !== 'short') {
      const ch = await readJsonOr(path.join(this.lib.charDir(rec.charId), 'character.json'));
      if (!ch) throw new LibraryError('not-found', `キャラ ${rec.charId} が無い。先にキャラを戻す`);
      if (rec.meta?.charCreatedAt && ch.createdAt !== rec.meta.charCreatedAt) throw new LibraryError('exists', `キャラ ${rec.charId} は、これを消したときのキャラとは別のもの(同じ ID で作り直してある)ので戻せない`);
    }
    const moved = [];
    try {
      for (const pair of present) {
        await fs.mkdir(path.dirname(pair.to), {recursive: true});
        await this.rename(pair.from, pair.to);
        moved.push(pair);
      }
      // 最新の版だったものは、今の最新の版より order が大きければ最新に戻す(v3、v2 の順に消して同じ順に戻しても v3 になる)
      if (rec.kind === 'version' && rec.meta?.wasLatest) {
        const ch = await this.lib.getCharacter(rec.charId), me = ch.versions.find(v => v.id === rec.id), cur = ch.versions.find(v => v.id === ch.latestVersion);
        if (me && (!cur || (me.order ?? 0) > (cur.order ?? 0))) await this.lib.updateCharacter(rec.charId, {latestVersion: rec.id});
      }
    } catch (e) {
      const left = new Set();   // 戻せなかったもの(元の場所に出たまま)。ごみ箱の記録から外す
      for (const {from, to, rel} of [...moved].reverse()) {
        try { await this.rename(to, from); } catch { left.add(rel); }
      }
      if (left.size) {
        const rest = present.map(x => x.rel).filter(rel => !left.has(rel));
        if (rest.length) await writeJson(path.join(dir, 'trash.json'), {...rec, paths: rest, sizeBytes: await dirSize(dir)});
        else await this.#remove(dir);
        throw new LibraryError('busy', `戻す途中で失敗し、${left.size} か所は元の場所へ戻したまま、残りはごみ箱に残してある(もう一度「戻す」で続きを戻せる): ${e.message}`);
      }
      throw e;
    }
    await this.#remove(dir);
    return rec;
  }

  // ---- 完全に消す ----
  // fs.rm はリンク(symlink、junction)をたどらず、リンクそのものだけを消す(test/trash.test.mjs で確かめている)
  async #remove(dir) { await fs.rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: RETRY_MS}); }

  async purge(trashId) {
    const {dir, rec} = await this.#item(trashId);
    await this.#remove(dir);
    return {trashId, label: rec?.label ?? trashId};
  }

  async empty() {
    const names = (await this.list()).items.map(x => x.trashId);
    for (const name of names) await this.#remove(inside(this.dir, name));
    return {purged: names.length};
  }
}
