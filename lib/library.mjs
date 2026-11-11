// 保管場所の読み書き。取り込んだファイルはコピーして固定し、あとから変えない(ADR 0002)。
// 同じ ID が既にあれば止まる(上書きしない)。ID は英小文字・数字・ハイフンだけ。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {parseGlb, parseVrma} from './vrma.mjs';
import {checkVrmMeta} from './vrm-meta.mjs';
import {currentTerms, limitOf} from './terms.mjs';
import {LibraryError} from './errors.mjs';

export {LibraryError};

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const AUDIO_EXT = ['.mp3', '.wav', '.m4a'];

export function checkId(id, what = 'ID') {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new LibraryError('bad-id', `${what} は英小文字・数字・ハイフンだけで書く: ${JSON.stringify(id)}`);
  }
  return id;
}

// base の中のパスだけを返す。外へ出るものは例外。
export function inside(base, ...rel) {
  const root = path.resolve(base);
  const file = path.resolve(root, ...rel);
  if (rel.some(r => String(r).includes('\0')) || !file.startsWith(root + path.sep)) throw new LibraryError('outside', 'パスの外へ出る指定: ' + rel.join('/'));
  return file;
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const now = () => new Date().toISOString();
const urlOf = (...parts) => '/lib/' + parts.map(encodeURIComponent).join('/');

export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function readJsonOr(file, fallback = null) {
  try { return await readJson(file); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function writeJson(file, obj) {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function subdirs(dir) {
  try { return (await fs.readdir(dir, {withFileTypes: true})).filter(d => d.isDirectory()).map(d => d.name).sort(); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

// "grok:eve" -> {provider:'grok', id:'eve'}
const VOICE_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function parseVoice(s) {
  if (s == null || s === '') return null;
  let v;
  if (typeof s === 'object') v = {provider: s.provider, id: s.id};
  else {
    const i = String(s).indexOf(':');
    if (i <= 0 || i === s.length - 1) throw new LibraryError('bad-input', 'voice は provider:id の形で書く: ' + s);
    v = {provider: s.slice(0, i), id: s.slice(i + 1)};
  }
  if (typeof v.provider !== 'string' || typeof v.id !== 'string' || !VOICE_PART_RE.test(v.provider) || !VOICE_PART_RE.test(v.id)) {
    throw new LibraryError('bad-input', 'voice の provider と id は英数字・ . _ - だけで書く: ' + JSON.stringify(s));
  }
  return v;
}

export const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];
export const FRAMINGS = ['face', 'upper'];
// 3D の作り方(キャラごとに記録する。tripo: 本家の手順、kimi: Kimi と Blender で進める手順)
export const METHODS = ['tripo', 'kimi'];
function checkMethod(m) {
  if (m != null && !METHODS.includes(m)) throw new LibraryError('bad-input', '作り方は ' + METHODS.join(' / ') + ': ' + JSON.stringify(m));
  return m ?? null;
}

// キャラのスタイル。standard: スタンダード(表情はシェイプキー)、chibi: チビ(表情は画像)、creature: 生き物(Blender の骨と動き。docs/creature.md)
export const STYLES = ['standard', 'chibi', 'creature'];
function checkStyle(v) {
  if (!STYLES.includes(v)) throw new LibraryError('bad-input', 'style は ' + STYLES.join(' / ') + ': ' + JSON.stringify(v));
  return v;
}
// 保存済みの character.json に style が無い(前からのキャラ)ときは null
const styleOf = ch => (STYLES.includes(ch.style) ? ch.style : null);
export const isCreature = ch => ch?.style === 'creature';
// VRM のバージョンを前提にする操作(撮影、顔の確かめ、表情づくり、バージョンの取り込みなど)に生き物のキャラを渡したときの断り。what は操作の名前
export function rejectCreature(ch, what) {
  if (isCreature(ch)) throw new LibraryError('bad-input', `生き物のキャラ ${ch.id} は VRM のバージョンが無いので「${what}」はできない(docs/creature.md)`);
  return ch;
}
const BLEND_MAGIC = [Buffer.from('BLENDER'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from([0x1f, 0x8b])];   // 無圧縮、zstd、gzip

// 生き物のバージョンの動きの要約(creature.json から)。画面は clipNames を出す
export function creatureSummary(spec) {
  const clips = spec.clips && typeof spec.clips === 'object' ? spec.clips : {};
  return {rest: spec.rest ?? null, fly: spec.fly ?? null, clips, clipNames: Object.keys(clips), scale: spec.scale ?? null, drop: spec.drop ?? 0, fps: spec.fps ?? null, yaw: spec.yaw ?? null};
}

const MAX_TAGS = 8, MAX_TAG_LENGTH = 20;

// タグの配列を検査して返す。前後の空白は除き、重複は先に出たほうを残す。
function checkTags(tags) {
  if (!Array.isArray(tags)) throw new LibraryError('bad-input', 'tags は文字列の配列');
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') throw new LibraryError('bad-input', 'タグは文字列: ' + JSON.stringify(t));
    const tag = t.trim(), n = [...tag].length;
    if (n < 1 || n > MAX_TAG_LENGTH) throw new LibraryError('bad-input', `タグは 1〜${MAX_TAG_LENGTH} 文字: ${JSON.stringify(t)}`);
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS) throw new LibraryError('bad-input', `タグは最大 ${MAX_TAGS} 個`);
  return out;
}

// 保存済みの character.json は信用しすぎず、文字列だけ拾う。
const tagsOf = ch => (Array.isArray(ch.tags) ? ch.tags.filter(t => typeof t === 'string') : []);

export class Library {
  constructor(dir) { this.dir = path.resolve(dir); this.shortUpdates = new Map(); }

  charDir(id) { return inside(this.dir, 'characters', checkId(id, 'キャラ ID')); }
  studioBase(charId) { return inside(this.dir, 'studio', checkId(charId, 'キャラ ID')); }   // 表情づくり(lib/studio.mjs)の置き場所
  motionDir(id) { return inside(this.dir, 'motions', checkId(id, 'モーション ID')); }

  // ID の名前でフォルダを作る。既にあれば止まる。失敗したら作ったフォルダを消す。
  async #createDir(dir, label) {
    await fs.mkdir(path.dirname(dir), {recursive: true});
    try { await fs.mkdir(dir); } catch (e) {
      if (e.code === 'EEXIST') throw new LibraryError('exists', `${label} は既にある（上書きしない）`);
      throw e;
    }
  }
  async #withNewDir(dir, label, fn) {
    await this.#createDir(dir, label);
    try { return await fn(); } catch (e) { await fs.rm(dir, {recursive: true, force: true}); throw e; }
  }

  async createCharacter({id, name, note = '', voice = null, method = null, style}) {
    const dir = this.charDir(id);
    if (!name) throw new LibraryError('bad-input', 'name が要る');
    checkMethod(method);
    if (style !== undefined) checkStyle(style);   // 省略は許す(前からの作り方)。API と CLI の入口で必須にする
    return this.#withNewDir(dir, `キャラ ${id}`, async () => {
      const ch = {id, name, note, voice: parseVoice(voice), latestVersion: null, ...(method && {method}), ...(style && {style}), createdAt: now()};
      await writeJson(path.join(dir, 'character.json'), ch);
      return ch;
    });
  }

  async getCharacterJson(id) {
    const ch = await readJsonOr(path.join(this.charDir(id), 'character.json'));
    if (!ch) throw new LibraryError('not-found', `キャラ ${id} が無い`);
    return ch;
  }

  // src は VRM ファイルの中身(Buffer)。source は出どころの記録。
  async importVersion({charId, id, label = '', note = '', data, sourcePath = '', charakuruProject = null, latest = false}) {
    const ch = rejectCreature(await this.getCharacterJson(charId), 'VRM のバージョンの取り込み');
    checkId(id, 'バージョン ID');
    if (!Buffer.isBuffer(data)) throw new LibraryError('bad-input', 'data が Buffer ではない');
    try { parseGlb(data); } catch (e) { throw new LibraryError('bad-input', 'VRM を読めない: ' + e.message); }
    const dir = inside(this.dir, 'characters', charId, 'versions', id);
    return this.#withNewDir(dir, `バージョン ${charId}/${id}`, async () => {
      const vs = await this.#versions(charId); // 作った直後で version.json がまだ無いので、自分は含まない。消したバージョンがあっても並びが重ならないよう最大の次にする
      const order = vs.length ? Math.max(...vs.map(v => v.order ?? 0)) + 1 : 1;
      await fs.writeFile(path.join(dir, 'model.vrm'), data, {flag: 'wx'});
      const ver = {id, charId, label, order, note, source: {path: sourcePath, charakuruProject},
        sha256: sha256(data), sizeBytes: data.length, importedAt: now()};
      await writeJson(path.join(dir, 'version.json'), ver);
      if (latest || !ch.latestVersion) await writeJson(path.join(this.charDir(charId), 'character.json'), {...ch, latestVersion: id});
      return ver;
    });
  }

  // 生き物のバージョン: model.blend(コピーして固定)、creature.json(検査済みの spec)、version.json(kind: 'creature')。thumb.png は呼び出し側があとで撮る。
  // 生き物のキャラにしか取り込めない。Action の名前の確かめは lib/creature.mjs が先にする
  async importCreatureVersion({charId, id, label = '', note = '', blendFile, spec, sourcePath = '', latest = false}) {
    const ch = await this.getCharacterJson(charId);
    if (!isCreature(ch)) throw new LibraryError('bad-input', `キャラ ${charId} は生き物ではない。生き物のバージョンは style が creature のキャラにだけ取り込める`);
    checkId(id, 'バージョン ID');
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new LibraryError('bad-input', 'spec が連想配列ではない');
    const data = await fs.readFile(blendFile);
    if (!BLEND_MAGIC.some(m => data.subarray(0, m.length).equals(m))) throw new LibraryError('bad-input', 'Blender のファイルではない: ' + blendFile);
    const dir = inside(this.dir, 'characters', charId, 'versions', id);
    return this.#withNewDir(dir, `バージョン ${charId}/${id}`, async () => {
      const vs = await this.#versions(charId);
      const order = vs.length ? Math.max(...vs.map(v => v.order ?? 0)) + 1 : 1;
      await fs.writeFile(path.join(dir, 'model.blend'), data, {flag: 'wx'});
      await writeJson(path.join(dir, 'creature.json'), spec);
      const ver = {id, charId, kind: 'creature', label, order, note, source: {path: sourcePath, charakuruProject: null},
        sha256: sha256(data), sizeBytes: data.length, importedAt: now()};
      await writeJson(path.join(dir, 'version.json'), ver);
      if (latest || !ch.latestVersion) await writeJson(path.join(this.charDir(charId), 'character.json'), {...ch, latestVersion: id});
      return ver;
    });
  }

  // バージョンのフォルダの絶対パス(ファイルを置く、読むため)
  versionDir(charId, verId) { return inside(this.dir, 'characters', checkId(charId, 'キャラ ID'), 'versions', checkId(verId, 'バージョン ID')); }

  // reading が無いか空なら text を入れる。files: {保存名: 元のパス} をセリフのフォルダへコピーする(例 source.mp4)。
  async importLine({charId, id, text, reading = '', emotion = null, voice = null, data, ext, sourcePath = '', source = {}, files = {}}) {
    const ch = await this.getCharacterJson(charId);
    checkId(id, 'セリフ ID');
    if (!text) throw new LibraryError('bad-input', 'text が要る');
    if (emotion && !EMOTIONS.includes(emotion)) throw new LibraryError('bad-input', '感情は ' + EMOTIONS.join(' / ') + ': ' + emotion);
    ext = String(ext).toLowerCase();
    if (!AUDIO_EXT.includes(ext)) throw new LibraryError('bad-input', '音声は mp3 / wav / m4a: ' + ext);
    const dir = inside(this.dir, 'characters', charId, 'lines', id);
    return this.#withNewDir(dir, `セリフ ${charId}/${id}`, async () => {
      const audio = 'audio' + ext;
      await fs.writeFile(path.join(dir, audio), data, {flag: 'wx'});
      for (const [name, src] of Object.entries(files)) {
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || name === audio || name === 'line.json') throw new LibraryError('bad-input', 'ファイル名が不正: ' + name);
        await fs.copyFile(src, path.join(dir, name), fsConstants.COPYFILE_EXCL);
      }
      const line = {id, text, reading: String(reading ?? '').trim() || text, emotion: emotion || null,
        voice: parseVoice(voice) ?? ch.voice ?? null, audio, source: {path: sourcePath, ...source}, createdAt: now()};
      await writeJson(path.join(dir, 'line.json'), line);
      return line;
    });
  }

  // 変えてよいのは voice / note / latestVersion / method / tags / style / vrmMeta だけ。ほかのキーがあれば何も変えずに拒否する。
  async updateCharacter(id, patch) {
    const ch = await this.getCharacterJson(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new LibraryError('bad-input', '本文が JSON の連想配列ではない');
    const keys = Object.keys(patch);
    const bad = keys.filter(k => !['voice', 'note', 'latestVersion', 'method', 'tags', 'style', 'vrmMeta'].includes(k));
    if (bad.length) throw new LibraryError('bad-input', '変えられない項目: ' + bad.join(', ') + '（変えてよいのは voice / note / latestVersion / method / tags / style / vrmMeta）');
    if (!keys.length) throw new LibraryError('bad-input', '変える項目が無い');
    const next = {...ch};
    if ('voice' in patch) next.voice = parseVoice(patch.voice);
    if ('note' in patch) {
      if (typeof patch.note !== 'string') throw new LibraryError('bad-input', 'note は文字列');
      next.note = patch.note;
    }
    if ('method' in patch) next.method = checkMethod(patch.method);
    if ('tags' in patch) next.tags = checkTags(patch.tags);
    if ('vrmMeta' in patch) {   // ゲーム用の書き出しが VRM の meta に入れる作者と利用条件(lib/vrm-meta.mjs)。null か空で消す
      let meta;
      try { meta = checkVrmMeta(patch.vrmMeta); } catch (e) { throw new LibraryError('bad-input', e.message); }
      if (meta) next.vrmMeta = meta; else delete next.vrmMeta;
    }
    if ('style' in patch) {
      next.style = checkStyle(patch.style);
      // 生き物と VRM はバージョンの中身が違うので、バージョンがあるキャラは行き来させない
      if (isCreature(ch) !== isCreature(next) && (await this.#versions(id)).length) throw new LibraryError('bad-input', 'バージョンがあるキャラは、生き物とそれ以外のスタイルを行き来できない');
    }
    if ('latestVersion' in patch) {
      const v = checkId(patch.latestVersion, 'バージョン ID');
      if (!await this.versionExists(id, v)) throw new LibraryError('not-found', `バージョン ${id}/${v} が無い`);
      next.latestVersion = v;
    }
    await writeJson(path.join(this.charDir(id), 'character.json'), next);
    return next;
  }

  async getLine(charId, lineId) {
    const dir = inside(this.dir, 'characters', checkId(charId, 'キャラ ID'), 'lines', checkId(lineId, 'セリフ ID'));
    const l = await readJsonOr(path.join(dir, 'line.json'));
    if (!l) throw new LibraryError('not-found', `セリフ ${charId}/${lineId} が無い`);
    return {...l, reading: l.reading || l.text, dir, audioFile: path.join(dir, l.audio)};
  }

  async lineExists(charId, lineId) {
    return exists(inside(this.dir, 'characters', checkId(charId, 'キャラ ID'), 'lines', checkId(lineId, 'セリフ ID')));
  }

  async versionExists(charId, verId) {
    return exists(path.join(this.charDir(charId), 'versions', checkId(verId, 'バージョン ID'), 'version.json'));
  }

  // 書き出した動画: lines/<id>/videos/<verId>-<framing>.mp4
  videoFile(charId, lineId, verId, framing) {
    if (!FRAMINGS.includes(framing)) throw new LibraryError('bad-input', 'framing は ' + FRAMINGS.join(' / '));
    return inside(this.dir, 'characters', checkId(charId, 'キャラ ID'), 'lines', checkId(lineId, 'セリフ ID'), 'videos', `${checkId(verId, 'バージョン ID')}-${framing}.mp4`);
  }
  videoUrl(charId, lineId, verId, framing) { return urlOf('characters', charId, 'lines', lineId, 'videos', `${verId}-${framing}.mp4`); }

  // generated: 生成したモーションの記録(MotionBricks の条件など。lib/motion-gen.mjs)。取り込んだモーションは null
  // contacts: 足の接地の横の情報(contacts.json の中身。docs/foot-ik.md)。無いモーションはビューアが足の高さから判定する
  // fittedTo: どのキャラの体に合わせて作ったか {charId, charName, verId}(動画から作ったモーション。lib/video-motion.mjs)
  async importMotion({id, name, label = '', data, sourcePath = '', pack = null, license, expressions = [], generated = null, contacts = null, fittedTo = null}) {
    checkId(id, 'モーション ID');
    const meta = (() => { try { return parseVrma(data); } catch (e) { throw new LibraryError('bad-input', 'VRMA を読めない: ' + e.message); } })();
    const lic = {holder: '', summary: '', redistribution: false, ...(license ?? {})};
    lic.redistribution = lic.redistribution === true;
    const dir = this.motionDir(id);
    return this.#withNewDir(dir, `モーション ${id}`, async () => {
      await fs.writeFile(path.join(dir, 'motion.vrma'), data, {flag: 'wx'});
      if (contacts) await fs.writeFile(path.join(dir, 'contacts.json'), JSON.stringify(contacts), {flag: 'wx'});
      const m = {id, name: name || id, label, source: {path: sourcePath, pack}, license: lic, ...meta,
        expressions: expressions ?? [], ...(generated && {generated}), ...(fittedTo && {fittedTo}), ...(contacts && {contacts: 'contacts.json'}), sha256: sha256(data), importedAt: now()};
      await writeJson(path.join(dir, 'motion.json'), m);
      return m;
    });
  }

  async motionExists(id) { return exists(path.join(this.motionDir(id), 'motion.json')); }

  async getMotion(id) {
    const m = await readJsonOr(path.join(this.motionDir(id), 'motion.json'));
    if (!m) throw new LibraryError('not-found', `モーション ${id} が無い`);
    return this.#motionRecord(m);
  }

  // 取り込み済みの記録は書き換えない(ADR 0002)ので、evaluationOnly を持たない古い生成物は、見本の動きの許諾を持つことから読むときに補う
  #motionRecord(m) {
    if (m.license && m.license.evaluationOnly === undefined && m.license.terms?.some(t => /Sample Data Evaluation License/.test(t.license))) m = {...m, license: {...m.license, evaluationOnly: true}};
    return {...m, limit: limitOf(m)};
  }

  // 撮るときに渡す音声ファイル: audio/<id>/。id は中身のハッシュなので、同じファイルは 1 つにまとまる。動画を作るジョブしか読まない(配らない)
  audioDir(id) { return inside(this.dir, 'audio', checkId(id, '音声 ID')); }

  async importAudio({name, data}) {
    const ext = path.extname(String(name)).toLowerCase();
    if (!AUDIO_EXT.includes(ext)) throw new LibraryError('bad-input', '音声は ' + AUDIO_EXT.join(' / ') + ': ' + name);
    if (!data?.length) throw new LibraryError('bad-input', '音声ファイルが空');
    const hash = sha256(data), id = 'a' + hash.slice(0, 16), dir = this.audioDir(id);
    if (await exists(path.join(dir, 'audio.json'))) return this.getAudio(id);
    await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(path.join(dir, 'audio' + ext), data);
    await writeJson(path.join(dir, 'audio.json'), {id, name: path.basename(String(name)), ext, sha256: hash, sizeBytes: data.length, importedAt: now()});
    return this.getAudio(id);
  }

  async getAudio(id) {
    const dir = this.audioDir(id), a = await readJsonOr(path.join(dir, 'audio.json'));
    if (!a) throw new LibraryError('not-found', `音声 ${id} が無い`);
    return {...a, file: path.join(dir, 'audio' + a.ext)};
  }

  // 撮った動画: characters/<キャラ>/shoots/<ジョブ ID>/ に video.mp4、poster.jpg、shoot.json(撮った条件と利用条件の札)
  shootDir(charId, id) { return inside(this.dir, 'characters', checkId(charId, 'キャラ ID'), 'shoots', checkId(id, '動画 ID')); }
  #shootUrls(charId, id) { return {url: urlOf('characters', charId, 'shoots', id, 'video.mp4'), posterUrl: urlOf('characters', charId, 'shoots', id, 'poster.jpg')}; }

  // files: {video, poster} は作業フォルダのファイル。保管場所の中で移す
  async saveShoot(record, {video, poster}) {
    const dir = this.shootDir(record.charId, record.id);
    await fs.mkdir(dir, {recursive: true});
    await fs.rename(video, path.join(dir, 'video.mp4'));
    await fs.rename(poster, path.join(dir, 'poster.jpg'));
    await writeJson(path.join(dir, 'shoot.json'), record);
    return {...record, ...this.#shootUrls(record.charId, record.id)};
  }

  async shoots(charId) {
    const base = path.join(this.charDir(charId), 'shoots'), out = [];
    for (const id of await subdirs(base)) {
      const s = await readJsonOr(path.join(base, id, 'shoot.json'));
      if (s) out.push({...s, ...(s.terms && {terms: currentTerms(s.terms)}), ...this.#shootUrls(charId, id)});   // 札の文は今の判定の文で出す(保管場所のファイルは書き換えない)
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));   // 新しい順
  }

  // ショート動画のカット表: shorts/<id>/short.json。声と描いたコマも同じフォルダに置く(lib/short.mjs)
  shortDir(id) { return inside(this.dir, 'shorts', checkId(id, 'ショート ID')); }

  // 各項目の thumb: そのショートを書き出した動画(撮った動画の short.id が一致する一番新しいもの)のポスターの URL。書き出していなければ null
  async listShorts() {
    const base = path.join(this.dir, 'shorts'), out = [], thumbs = new Map();
    for (const sh of await this.allShoots()) if (sh.short?.id && !thumbs.has(sh.short.id)) thumbs.set(sh.short.id, sh.posterUrl);   // allShoots は新しい順
    for (const id of await subdirs(base)) {
      const s = await readJsonOr(path.join(base, id, 'short.json'));
      if (s) out.push({...s, thumb: thumbs.get(s.id ?? id) ?? null});
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async getShort(id) {
    const s = await readJsonOr(path.join(this.shortDir(id), 'short.json'));
    if (!s) throw new LibraryError('not-found', `ショート ${id} が無い`);
    return s;
  }

  async saveShort(id, body) {
    const dir = this.shortDir(id), old = await readJsonOr(path.join(dir, 'short.json')), t = now();
    await fs.mkdir(dir, {recursive: true});
    const rec = {...body, id, createdAt: old?.createdAt ?? t, updatedAt: t};
    await writeJson(path.join(dir, 'short.json'), rec);
    return rec;
  }

  // 読んで直して書く。同じショートへの更新は 1 件ずつ順に進める(編集画面の保存とジョブが重なっても互いの変更を消さない)。fn が null を返すと書かない
  updateShort(id, fn) {
    const next = (this.shortUpdates.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => { const body = await fn(await this.getShort(id)); return body ? this.saveShort(id, body) : null; });
    this.shortUpdates.set(id, next);
    return next.finally(() => { if (this.shortUpdates.get(id) === next) this.shortUpdates.delete(id); });
  }

  // 全キャラの撮った動画(新しい順)。動画ギャラリーの一覧
  async allShoots() {
    const out = [];
    for (const c of await this.listCharacters()) out.push(...(await this.shoots(c.id)).map(s => ({...s, charName: c.name})));
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async listCharacters() {
    const out = [];
    for (const id of await subdirs(path.join(this.dir, 'characters'))) {
      const ch = await readJsonOr(path.join(this.dir, 'characters', id, 'character.json'));
      if (!ch) continue;
      const versions = await this.#versions(id);
      const lines = await this.#lines(id);
      const latestVer = versions.find(v => v.id === ch.latestVersion) ?? versions[versions.length - 1] ?? null;
      out.push({id: ch.id, name: ch.name, note: ch.note, style: styleOf(ch),
        latest: latestVer ? {id: latestVer.id, label: latestVer.label, thumb: latestVer.thumb} : null,
        versionCount: versions.length, lineCount: lines.length});
    }
    return out;
  }

  async #versions(charId) {
    const base = path.join(this.charDir(charId), 'versions');
    const out = [];
    for (const vid of await subdirs(base)) {
      const v = await readJsonOr(path.join(base, vid, 'version.json'));
      if (!v) continue;
      const hasThumb = await exists(path.join(base, vid, 'thumb.png')), thumb = hasThumb ? urlOf('characters', charId, 'versions', vid, 'thumb.png') : null;
      if (v.kind === 'creature') {
        // 生き物のバージョンは VRM が無い。model と modelLite は null、動きの一覧は creature に出す
        const spec = await readJsonOr(path.join(base, vid, 'creature.json'), null);
        out.push({...v, kind: 'creature', thumb, model: null, modelLite: null, blend: urlOf('characters', charId, 'versions', vid, 'model.blend'), creature: spec && creatureSummary(spec)});
        continue;
      }
      const hasLite = await exists(path.join(base, vid, 'model-lite.vrm'));
      out.push({...v, kind: 'vrm', thumb,
        model: urlOf('characters', charId, 'versions', vid, 'model.vrm'),
        // スマホ用の軽い VRM（tools/make_lite.py が作る派生物。元の model.vrm は変えない）
        modelLite: hasLite ? urlOf('characters', charId, 'versions', vid, 'model-lite.vrm') : null});
    }
    return out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  async #lines(charId) {
    const base = path.join(this.charDir(charId), 'lines');
    const out = [];
    for (const lid of await subdirs(base)) {
      const l = await readJsonOr(path.join(base, lid, 'line.json'));
      if (!l) continue;
      const videos = [];
      try {
        for (const f of (await fs.readdir(path.join(base, lid, 'videos'))).sort()) {
          const m = /^(.+)-(face|upper)\.mp4$/.exec(f);
          if (m) videos.push({verId: m[1], framing: m[2], url: this.videoUrl(charId, lid, m[1], m[2])});
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      out.push({...l, reading: l.reading || l.text, videos, audioUrl: urlOf('characters', charId, 'lines', lid, l.audio)});
    }
    return out;
  }

  // brief: 撮った動画(shoots)と出演したショート(appearances)を読まない。どちらもファイルが多く、ライブラリの集計(lib/overview.mjs)は使わない
  async getCharacter(id, {brief = false} = {}) {
    const ch = await this.getCharacterJson(id);
    const [versions, lines] = await Promise.all([this.#versions(id), this.#lines(id)]);
    const full = brief ? {} : {shoots: await this.shoots(id), appearances: await this.appearances(id)};
    return {...ch, tags: tagsOf(ch), style: styleOf(ch), versions, lines, ...full};
  }

  // このキャラが出るショート(cast[].charId か charId か take.creature.charId)。updatedAt の新しい順。読めない short.json は飛ばす
  async appearances(charId) {
    const base = path.join(this.dir, 'shorts'), found = [];
    for (const id of await subdirs(base)) {
      let s;
      try { s = await readJsonOr(path.join(base, id, 'short.json')); } catch { continue; }
      if (!s || typeof s !== 'object') continue;
      if (s.charId !== charId && !(Array.isArray(s.cast) && s.cast.some(m => m?.charId === charId)) && s.take?.creature?.charId !== charId) continue;
      found.push({shortId: id, title: s.title, style: s.style, updatedAt: s.updatedAt});
    }
    return found.sort((x, y) => String(y.updatedAt ?? '').localeCompare(String(x.updatedAt ?? '')));
  }

  async listMotions() {
    const out = [];
    for (const id of await subdirs(path.join(this.dir, 'motions'))) {
      const m = await readJsonOr(path.join(this.dir, 'motions', id, 'motion.json'));
      if (!m) continue;
      out.push({...this.#motionRecord(m), file: urlOf('motions', id, 'motion.vrma'), ...(m.contacts && {contactsUrl: urlOf('motions', id, m.contacts)})});
    }
    return out;
  }
}
