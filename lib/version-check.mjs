// 版の検査(GET /api/characters/<キャラ>/versions/<版>/check)。キャラのスタイルで検査を分ける(docs/character-style.md)。
//   standard: VRoid 形式の検査(lib/vroid-format.mjs の checkVroid。手本は studio/vroid/reference.json、scripts/vroid-check.mjs と同じ読み方)
//   chibi: チビの検査(lib/chibi-check.mjs)
//   creature とスタイル未設定: 検査なし(理由つき)
// 結果は版のフォルダの check.json に置く。model.vrm と model-lite.vrm の大きさと更新時刻、手本の更新時刻、検査の版が同じなら読み直さない。
import fs from 'node:fs/promises';
import path from 'node:path';
import {root} from './config.mjs';
import {LibraryError, STYLES, checkId, inside, readJsonOr, writeJson} from './library.mjs';
import {checkVroid, profileOf, summary} from './vroid-format.mjs';
import {chibiCheck, measureGlb, summaryOf} from './chibi-check.mjs';

export const CHECK_VERSION = 1;   // 検査の項目を変えたら上げる(キャッシュを捨てる)
export const REFERENCE_FILE = path.join(root, 'studio', 'vroid', 'reference.json');
export const CHECK_FILE = 'check.json';

const stamp = async file => fs.stat(file).then(s => ({size: s.size, mtimeMs: Math.round(s.mtimeMs)}), () => null);
const REASON = {
  creature: '生き物は VRM の版が無いので、VRM の検査は対象外(docs/creature.md)',
  unset: 'スタイルが未設定。プロフィールでスタンダードかチビを決めると検査できる',
};

async function compute(style, dir, referenceFile) {
  const model = path.join(dir, 'model.vrm'), liteFile = path.join(dir, 'model-lite.vrm');
  const hasLite = !!await stamp(liteFile);
  if (style === 'standard') {
    const ref = await readJsonOr(referenceFile);
    if (!ref) return {unavailable: `手本が保管場所に無い: ${path.relative(root, referenceFile).replaceAll('\\', '/')}(scripts/vroid-check.mjs reference で作る)`, items: []};
    const items = checkVroid(profileOf((await measureGlb(model)).js), ref);
    return {items, summary: {...summary(items), unknown: 0}};
  }
  const items = chibiCheck(await measureGlb(model), hasLite ? await measureGlb(liteFile) : null);
  return {items, summary: summaryOf(items)};
}

export async function versionCheck(lib, charId, verId, {referenceFile = REFERENCE_FILE} = {}) {
  const ch = await lib.getCharacterJson(charId);
  if (!await lib.versionExists(charId, verId)) throw new LibraryError('not-found', `版 ${charId}/${verId} が無い`);
  const style = STYLES.includes(ch.style) ? ch.style : null;
  const base = {charId, verId, style};
  if (style === null || style === 'creature') return {...base, applicable: false, reason: REASON[style ?? 'unset'], items: []};
  const dir = inside(lib.dir, 'characters', checkId(charId, 'キャラ ID'), 'versions', checkId(verId, '版 ID'));
  const key = {v: CHECK_VERSION, style, model: await stamp(path.join(dir, 'model.vrm')), lite: await stamp(path.join(dir, 'model-lite.vrm')),
    ref: style === 'standard' ? await stamp(referenceFile) : null};
  if (!key.model) throw new LibraryError('not-found', `版 ${charId}/${verId} に model.vrm が無い`);
  const file = path.join(dir, CHECK_FILE), saved = await readJsonOr(file).catch(() => null);   // 壊れた check.json は無いものとして測り直す
  if (saved && JSON.stringify(saved.key) === JSON.stringify(key)) return {...base, applicable: true, ...saved.result, cached: true, checkedAt: saved.checkedAt};
  const result = await compute(style, dir, referenceFile), checkedAt = new Date().toISOString();
  await writeJson(file, {key, checkedAt, result}).catch(() => {});   // 同時に 2 本の GET が書くと片方の rename が失敗する。キャッシュは次に書ければよいので、測った結果は返す
  return {...base, applicable: true, ...result, cached: false, checkedAt};
}
