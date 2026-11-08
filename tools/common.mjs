// tools/ の共通部分: 設定の読み込み、Playwright の読み込み、引数、ビューアの URL。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {loadConfig} from '../lib/config.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 設定はサーバーと同じ読み込み(lib/config.mjs)を使う。CHARASTA_CONFIG で別の設定を指せる
export {loadConfig};

// Playwright は、このリポジトリの node_modules(npm install で入る)から読む。入っていなければ環境変数 PLAYWRIGHT の場所を読む
export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch (e) {
    if (process.env.PLAYWRIGHT) return require(process.env.PLAYWRIGHT);
    throw Error('playwright が見つからない。リポジトリで npm install を実行する(別の場所のを使うなら環境変数 PLAYWRIGHT にそのパス): ' + e.message);
  }
}

// --name value / --flag の形。位置引数は _ に入る。
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {_: []};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i]; else out[k] = true;
    } else out._.push(argv[i]);
  }
  return out;
}

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export function needId(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw Error(`--${name} は英小文字・数字・ハイフンの ID で指定する`);
  return value;
}

// http://127.0.0.1:<port>/viewer?char=&ver=   ver を省くと最新の版。--port で設定のポートを上書きする(サーバーが別のポートで動いているとき)
// --studio ID --proto N: 表情づくりの試作(ver=proto-N)
// follow=0: ビューアのカメラの追従を切る(撮影の道具はカメラを自分で置くので、hips について動かさない)
// 足の IK は既定でビューアと同じくオン(撮影は画面で見える動きを写す)。--footik 0 で切る。止めて手で置いた姿勢には、ビューアは IK をかけない
export function viewerUrl(args, config = loadConfig()) {
  const q = new URLSearchParams({char: needId(args.char, 'char'), follow: '0'});
  rejectCreature(args.char, config);
  if (args.studio) { q.set('studio', needId(args.studio, 'studio')); if (!/^\d+$/.test(String(args.proto))) throw Error('--proto は試作の番号'); q.set('ver', 'proto-' + Number(args.proto)); }
  else if (args.ver) q.set('ver', needId(args.ver, 'ver'));
  if (String(args.footik) === '0') q.set('footik', '0');
  return `http://127.0.0.1:${args.port ? Number(args.port) : config.port}/viewer?${q}`;
}

// 生き物のキャラ(style が creature)は VRM の版が無いので、ビューアで撮る道具は使えない(サムネイルは scripts/import-creature.mjs が Blender で撮る)
export function rejectCreature(char, config = loadConfig()) {
  let style = null;
  try { style = JSON.parse(fs.readFileSync(path.join(config.libraryDir, 'characters', char, 'character.json'), 'utf8')).style; } catch { /* キャラが無ければビューアの側で断られる */ }
  if (style === 'creature') throw Error(`${char} は生き物のキャラで、VRM の版が無い。ビューアで撮る道具は使えない(docs/creature.md)`);
}

// ビューアの画面が読み込まれるまで待つ（window.viewer.vrm が入る）
export async function openViewer(page, url) {
  const res = await page.goto(url);
  if (!res || !res.ok()) throw Error(`${url} を開けない（${res ? res.status() : '応答なし'}）。サーバーは動いているか: node server.mjs`);
  await page.waitForFunction(() => window.viewer && window.viewer.vrm, null, {timeout: 120000});
}

// 画面の操作パネルを隠してキャンバスだけにする
export const HIDE_PANEL_CSS = 'aside,header,nav,#panel,#side{display:none!important} #app{grid-template-columns:1fr!important;grid-template-rows:1fr!important}';
