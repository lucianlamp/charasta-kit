// stage-studio のシーン: 一覧、見本の画像、描画コードのハッシュ、ステージの画面の一覧。MV(lib/mv.mjs)とショート(lib/short.mjs、lib/short-draft.mjs、lib/dance.mjs)とステージの画面(public/stages.mjs)が使う。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {LibraryError, checkId, inside, readJsonOr} from './library.mjs';

// dir が未設定(null)なら、stage-studio が無いのでシーンは空
export const stageCatalog = async dir => (dir ? await readJsonOr(path.join(dir, 'stages', 'catalog.json')) : null) ?? [];

// 画面が選べるシーン。stage-studio が無ければ available が false
export async function mvOptions(dir) {
  const stages = await stageCatalog(dir);
  return {available: stages.length > 0, stages: stages.map(s => ({...s, thumb: `/api/mv/stages/${s.id}.jpg`}))};
}

export function stageThumb(dir, id) {
  if (!dir) throw new LibraryError('not-found', 'stage-studio が設定されていない(config.json の stageStudioDir)');
  return inside(dir, 'assets', 'thumbs', checkId(id, 'シーン ID') + '.jpg');
}

// ショートが使うシーン: カットの stage とダンス MV の music.stages(グラフィック MV のカットは stage が空)
const shortStages = s => new Set([...(Array.isArray(s?.cuts) ? s.cuts.map(c => c?.stage) : []), ...(Array.isArray(s?.music?.stages) ? s.music.stages : [])].filter(x => typeof x === 'string' && x));

// ステージの画面(#stages、GET /api/stages): シーンごとに名前、ID、サムネイル(無ければ null)、そのシーンを使うショートと MV(撮った動画の kind が mv のもの)。
// 読むだけ。新しいシーンは頼みごと(lib/stage-requests.mjs)でエージェントが stage-studio に足す。configured は stageStudioDir の設定があるか
export async function stageOverview(dir, lib) {
  const catalog = await stageCatalog(dir);
  const [shorts, shoots] = await Promise.all([lib.listShorts(), lib.allShoots()]);
  const used = shorts.map(s => [s, shortStages(s)]), mvs = shoots.filter(s => s.kind === 'mv' && Array.isArray(s.mv?.stages));
  const stages = await Promise.all(catalog.filter(s => typeof s?.id === 'string').map(async s => {
    const thumb = await (async () => { await fs.access(stageThumb(dir, s.id)); return `/api/mv/stages/${encodeURIComponent(s.id)}.jpg`; })().catch(() => null);
    return {id: s.id, label: s.label ?? s.id, thumb,
      shorts: used.filter(([, set]) => set.has(s.id)).map(([x]) => ({id: x.id, title: x.title ?? '', style: x.style ?? null, take: !!x.take, updatedAt: x.updatedAt ?? null})),
      mvs: mvs.filter(x => x.mv.stages.includes(s.id)).map(x => ({id: x.id, charId: x.charId, charName: x.charName, verId: x.verId, quality: x.quality ?? null, createdAt: x.createdAt ?? null}))};
  }));
  return {configured: !!dir, stages};
}

// シーンと描画のコードの中身のハッシュ。コードを直したあとの積み直しが、直す前のコマの続きを描かないようにする
export async function stageCode(stageDir, stage) {
  const hashes = await Promise.all([path.join('stages', stage + '.py'), 'lib/studio.py', 'lib/shots.py', 'tools/render.py'].map(f => fs.readFile(path.join(stageDir, f)).then(b => crypto.createHash('sha1').update(b).digest('hex'), () => '')));
  return hashes.join();
}
