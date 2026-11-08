// 版の種類(edition)ごとの決まり(docs/edition.md)。full は作者の版(既定)で何も変えない。kit は配るキットで、画面から隠した機能をサーバーも断る。
// 版の種類は lib/config.mjs の loadConfig が決める(キットの root の edition.json、config.json の edition、環境変数 CHARASTA_EDITION)
import {LibraryError} from './library.mjs';
import {EDITIONS, editionLabels} from '../public/edition.mjs';

export {EDITIONS};
export const editionOf = config => (config.edition === 'kit' ? 'kit' : 'full');

// キットで積めないジョブと、その機能の名前
const KIT_REMOVED_JOBS = {'motion-text': '文章からモーションを作る(Kimodo)', 'game-export': 'ゲーム用の書き出し',
  'short-draft': 'ショートの下書き', 'short-figures': 'ショートの図の自動生成'};
// キットで断る API(どのメソッドも)。上のジョブの結果と選べる条件を返すもの
const KIT_REMOVED_ROUTES = [/^\/api\/motion-texts(\/|$)/, /^\/api\/short-draft\//, /^\/api\/characters\/[^/]+\/versions\/[^/]+\/game-exports$/];
// キットのショートの型: 対話型(型 drama の演出)とダンス MV
const KIT_SHORT_STYLES = ['drama', 'dance'];
const NOTE = '配布版には無い機能';

const refuse = what => { throw new LibraryError('bad-input', `「${what}」は${NOTE}`); };

export function refuseRemovedRoute(edition, pathname) {
  if (edition === 'kit' && KIT_REMOVED_ROUTES.some(re => re.test(pathname))) refuse(pathname);
}

export function checkJob(edition, body) {
  if (edition === 'kit' && Object.hasOwn(KIT_REMOVED_JOBS, body?.type)) refuse(KIT_REMOVED_JOBS[body.type]);
}

// キャラの作り方とスタイル(作るときと直すとき)。キットは きゃらくる(Tripo Studio)だけで、生き物(style: creature)は無い
export function checkCharacter(edition, body) {
  if (edition !== 'kit') return;
  if (body?.method != null && body.method !== 'tripo') refuse(`作り方 ${body.method}`);
  if (body?.style === 'creature') refuse('生き物');
}

// 生き物だけが使うカメラ(public/short-camera.mjs で kinds が creature だけのもの)
const CREATURE_CAMERAS = ['crow_close', 'crow_takeoff'];

// ショートの本文(作るときと保存するとき)。キットは型を書かなければ対話型、雑学・派手・ニュースは断る。
// 生き物(take.creature、カットの生き物の動き、生き物のカメラ)も断る
export function shortInput(edition, body) {
  if (edition !== 'kit' || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const style = body.style ?? 'drama';
  if (!KIT_SHORT_STYLES.includes(style)) refuse(`ショートの型 ${style}`);
  if (body.take?.creature != null) refuse('生き物(take.creature)');
  for (const c of Array.isArray(body.cuts) ? body.cuts : []) {
    if (c?.creature != null) refuse('カットの生き物の動き');
    if (CREATURE_CAMERAS.includes(c?.camera)) refuse(`生き物のカメラ ${c.camera}`);
  }
  return {...body, style};
}

// モーションをつなぐ(motion-recipe)のキットの決まり: 区間は保管場所のモーション、動画の結果、MotionBricks の条件だけ。文章(Kimodo)の区間は断る。
// 文章の区間は、画面が積む source: text か、文章のジョブ(motion-text)の結果を使う source: job。jobs は jobs.mjs が渡す {get(id)}。
// MotionBricks が使えない(motionbricksDir が無い)ときは、MotionBricks の条件の区間と、MotionBricks のつなぎを積む前に断る(補間だけなら動く)
export function checkRecipe(edition, body, jobs, motionbricks) {
  if (edition !== 'kit' || !Array.isArray(body?.segments)) return;
  const wantsBridge = b => b?.method === 'motionbricks' && (b.seconds == null || Number(b.seconds) > 0);
  let mb = wantsBridge(body.bridge);
  for (const s of body.segments) {
    if (s?.source === 'text' || (s?.source === 'job' && typeof s.job === 'string' && jobs.get(s.job)?.type === 'motion-text')) refuse('文章(Kimodo)の区間');
    if (s?.source === 'motionbricks' || wantsBridge(s?.bridge)) mb = true;
  }
  if (mb && !motionbricks) throw new LibraryError('bad-input', 'MotionBricks が見つからない(設定の motionbricksDir)。MotionBricks の条件の区間を外し、つなぎを補間にすれば動かせる');
}

// キットで MotionBricks が使えないときの、つなぎの既定の作り方(書かなければ補間)
export const recipeDefaultMethod = (edition, motionbricks) => (edition === 'kit' && !motionbricks ? 'interpolate' : undefined);

// 使える機能の一覧に、版の種類で決まる項目を足す。キットで外した機能は、道具があっても使えないとして理由を出す
// gameExport、shortDraft、shortFigures、talkStyles(雑学・ドラマ・派手・ニュースの型と見本)、creature(生き物のキャラ)は版の種類だけで決まる。作者の版ではいつも使える。
// motionRecipe はキットでも使える(版の種類では決まらない。MotionBricks が無ければ補間だけで動く)
const EDITION_KEYS = ['gameExport', 'shortDraft', 'shortFigures', 'talkStyles', 'creature'];
export function editionCapabilities(edition, caps) {
  const on = {available: true, setting: 'edition'}, off = {available: false, setting: 'edition', note: NOTE};
  if (edition !== 'kit') return {...caps, edition, motionRecipe: on, ...Object.fromEntries(EDITION_KEYS.map(k => [k, on]))};
  return {...caps, edition, motionRecipe: on, ...Object.fromEntries(['kimodo', 'rgbmocap', 'figureImageGen', ...EDITION_KEYS].map(k => [k, off]))};
}

// /api/overview に載せる版の種類と画面の名前
export const editionInfo = edition => ({edition, labels: editionLabels(edition)});

// 動画からモーションを作るときに選べる変換。キットは MediaPipe(vrma-pipeline)だけで、RGB MoCap の ExMR は出さない
export function videoOptions(edition, o) {
  if (edition !== 'kit') return o;
  const engines = {...o.engines};
  delete engines.exmr;
  return {...o, engines, rgbmocapDir: null, defaultEngine: 'mediapipe'};
}
