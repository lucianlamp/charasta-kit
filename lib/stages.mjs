// stage-studio のシーン: 一覧、見本の画像、描画コードのハッシュ。MV(lib/mv.mjs)とショート(lib/short.mjs、lib/short-draft.mjs、lib/dance.mjs)が使う。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {checkId, inside, readJsonOr} from './library.mjs';

export const stageCatalog = async dir => (await readJsonOr(path.join(dir, 'stages', 'catalog.json'))) ?? [];

// 画面が選べるシーン。stage-studio が無ければ available が false
export async function mvOptions(dir) {
  const stages = await stageCatalog(dir);
  return {available: stages.length > 0, stages: stages.map(s => ({...s, thumb: `/api/mv/stages/${s.id}.jpg`}))};
}

export function stageThumb(dir, id) {
  return inside(dir, 'assets', 'thumbs', checkId(id, 'シーン ID') + '.jpg');
}

// シーンと描画のコードの中身のハッシュ。コードを直したあとの積み直しが、直す前のコマの続きを描かないようにする
export async function stageCode(stageDir, stage) {
  const hashes = await Promise.all([path.join('stages', stage + '.py'), 'lib/studio.py', 'lib/shots.py', 'tools/render.py'].map(f => fs.readFile(path.join(stageDir, f)).then(b => crypto.createHash('sha1').update(b).digest('hex'), () => '')));
  return hashes.join();
}
