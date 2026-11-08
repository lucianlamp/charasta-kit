#!/usr/bin/env node
// きゃらすた: 自分専用のローカル Web アプリのサーバー。127.0.0.1 だけで待つ。依存パッケージなし。
// 使い方: node server.mjs [--port 8870]
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {loadConfig, root} from './lib/config.mjs';
import {Library, LibraryError, STYLES, inside} from './lib/library.mjs';
import {JobQueue} from './lib/jobs.mjs';
import {capabilities} from './lib/capabilities.mjs';
import {Studio, SERVED} from './lib/studio.mjs';
import {faceInfo} from './lib/face-check.mjs';
import {versionCheck} from './lib/version-check.mjs';
import {listGameExports} from './lib/game-export.mjs';
import {motionGenOptions} from './lib/motion-gen.mjs';
import {UPLOAD_DIR, UPLOAD_MAX, VIDEO_EXT, videoMotionOptions} from './lib/video-motion.mjs';
import {motionTextOptions} from './lib/motion-text.mjs';
import {motionRecipeOptions} from './lib/motion-recipe.mjs';
import {videoTerms} from './lib/terms.mjs';
import {overview} from './lib/overview.mjs';
import {Trash} from './lib/trash.mjs';
import {mvOptions, stageOverview, stageThumb} from './lib/stages.mjs';
import {adjustInfo} from './lib/adjust.mjs';
import {MAX_SHOT_BYTES, adjustShotFile, cancelAdjustRequest, createAdjustRequest, getAdjustRequest, listAdjustRequests, setAdjustShot, withShotUrl} from './lib/adjust-requests.mjs';
import {MAX_REF_BYTES, addStageRef, cancelStageRequest, createStageRequest, getStageRequest, listStageRequests, stageRefFile, withRefUrls} from './lib/stage-requests.mjs';
import {graphicCatalog, graphicDefaults, supportsGraphic} from './lib/graphic-mv.mjs';
import {draftImportCheck, draftRequest} from './lib/short-draft.mjs';
import {DANCE_CAMERAS} from './public/short-camera.mjs';
import {SHORT_CAMERAS, VOICE_TONES, newDanceShort, saveFigure, newShortBody, saveShortEdit, shortBody, splitShort, shortCompose, shortPreview, shortTimes, voiceSample} from './lib/short.mjs';
import {writePidFile, removePidFile} from './lib/pidfile.mjs';
import {checkCharacter, recipeDefaultMethod, refuseRemovedRoute, editionInfo, editionOf, shortInput, videoOptions} from './lib/edition.mjs';


const types = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.vrm': 'model/gltf-binary', '.vrma': 'model/gltf-binary', '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ttf': 'font/ttf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon'};
const MAX_BODY = 64 * 1024 * 1024;
const STATUS = {'bad-id': 400, 'bad-input': 400, 'too-large': 413, outside: 404, 'not-found': 404, exists: 409, busy: 409, 'last-version': 409};

function json(res, status, body) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(body));
}
function notFound(res, msg = 'not found') {
  res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
  res.end(msg);
}

// ファイルを返す。Range に対応する(音声のシークと大きな VRM のため)。無いファイルは 404。
async function sendFile(req, res, file) {
  let st;
  try { st = await fsp.stat(file); } catch { return notFound(res); }
  if (!st.isFile()) return notFound(res);
  const headers = {'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes'};
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0, end = st.size - 1, status = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); }
    else { start = Math.max(0, st.size - Number(m[2])); }
    if (start > end || start >= st.size) { res.writeHead(416, {'Content-Range': `bytes */${st.size}`}); return res.end(); }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, {start, end}).on('error', () => res.destroy());
  res.on('close', () => stream.destroy());   // 動画を途中で止められたとき、ファイルを開いたままにしない(開いたままだと Windows はフォルダを移せない)
  stream.pipe(res);
}

// 本文を読む。Content-Length が上限を超えていれば、読み始める前に 413 にする。
// 長さを偽る送り方や chunked で超えたときも、読むのをやめて 413 にする(接続は閉じる: catch で Connection: close を付ける)
async function readBody(req, max = MAX_BODY) {
  const tooLarge = () => new LibraryError('too-large', `本文が大きすぎる(上限 ${max >= 1048576 ? Math.floor(max / 1048576) + ' MiB' : Math.floor(max / 1024) + ' KiB'})`);
  if (Number(req.headers['content-length']) > max) throw tooLarge();
  const chunks = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max) throw tooLarge();
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  try { return JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')); }
  catch (e) { if (e instanceof LibraryError) throw e; throw new LibraryError('bad-input', '本文が JSON ではない'); }
}

const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };

// ファイル名からモーション ID を作る(VRMA_02.vrma -> vrma-02)。
export function motionIdFromFilename(filename) {
  return path.basename(filename, path.extname(filename)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'motion';
}

async function postMotion(req, res, lib) {
  const filename = safeDecode(String(req.headers['x-filename'] ?? '')).replace(/[\\/]/g, '_');
  if (!filename) return json(res, 400, {error: 'x-filename が要る'});
  let license = {};
  if (req.headers['x-license']) {
    try { license = JSON.parse(safeDecode(String(req.headers['x-license']))); }
    catch { return json(res, 400, {error: 'x-license が JSON ではない'}); }
  }
  const data = await readBody(req);
  const id = req.headers['x-id'] ? String(req.headers['x-id']) : motionIdFromFilename(filename);
  let expressions = [];
  if (req.headers['x-expressions']) {
    try { expressions = JSON.parse(safeDecode(String(req.headers['x-expressions']))); }
    catch { return json(res, 400, {error: 'x-expressions が JSON ではない'}); }
  }
  const m = await lib.importMotion({id, name: path.basename(filename, path.extname(filename)),
    label: safeDecode(String(req.headers['x-label'] ?? '')), data, sourcePath: filename, pack: null, license, expressions});
  json(res, 201, m);
}

// 手元の動画を受け取る。入力はヘッダ x-params(JSON)、本文は動画そのもの。入力を確かめてからファイルへ流す(大きいのでメモリに載せない)
async function postVideoMotion(req, res, lib, jobs) {
  const fileName = safeDecode(String(req.headers['x-filename'] ?? '')).replace(/[\\/]/g, '_'), ext = path.extname(fileName).toLowerCase();
  if (!VIDEO_EXT.includes(ext)) return json(res, 400, {error: '動画は ' + VIDEO_EXT.join(' ') + ' のファイル'});
  if (Number(req.headers['content-length']) > UPLOAD_MAX) { res.setHeader('Connection', 'close'); return json(res, 413, {error: '動画が大きすぎる(上限 2 GiB)'}); }
  let params;
  try { params = JSON.parse(safeDecode(String(req.headers['x-params'] ?? ''))); } catch { return json(res, 400, {error: 'x-params が JSON ではない'}); }
  if (!params || typeof params !== 'object' || Array.isArray(params)) return json(res, 400, {error: 'x-params は JSON の連想配列'});
  await jobs.checkVideoMotion(params);
  const upload = `v${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}${ext}`, dir = path.join(lib.dir, UPLOAD_DIR), file = path.join(dir, upload);
  await fsp.mkdir(dir, {recursive: true});
  let size = 0;
  const limit = new Transform({transform(c, _, done) { size += c.length; done(size > UPLOAD_MAX ? new LibraryError('too-large', '動画が大きすぎる(上限 2 GiB)') : null, c); }});
  try { await pipeline(req, limit, fs.createWriteStream(file, {flags: 'wx'})); }
  catch (e) { await fsp.rm(file, {force: true}); throw e; }
  try { json(res, 201, await jobs.enqueue({...params, type: 'video-motion', url: undefined, upload, fileName})); }
  catch (e) { await fsp.rm(file, {force: true}); throw e; }
}

// 消す対象の URL を {kind, charId, id, impact} にする。
//   /api/characters/<キャラ>、.../versions|lines|shoots/<ID>、/api/motions/<ID>、/api/shorts/<ID>。末尾に /impact を付けると影響の一覧。該当しなければ null
// ID の形の確かめは Trash が lib の checkId で行う(%2F で包んだ .. もここでは 1 つの段のまま渡り、そこで断られる)
export function trashTarget(pathname) {
  const m = /^\/api\/(?:characters\/([^/]+)(?:\/(versions|lines|shoots)\/([^/]+))?|motions\/([^/]+)|shorts\/([^/]+))(\/impact)?$/.exec(pathname);
  if (!m) return null;
  const [, c, sub, id, motion, short, impact] = m;
  if (short) return {kind: 'short', charId: null, id: safeDecode(short), impact: !!impact};
  if (motion) return {kind: 'motion', charId: null, id: safeDecode(motion), impact: !!impact};
  const kind = {versions: 'version', lines: 'line', shoots: 'shoot'}[sub] ?? 'character';
  return {kind, charId: safeDecode(c), id: id ? safeDecode(id) : safeDecode(c), impact: !!impact};
}

export function createServer(config) {
  const lib = new Library(config.libraryDir);
  const publicDir = path.join(root, 'public'), vendorDir = path.join(root, 'vendor');
  let server;
  // config.env: ジョブの外部コマンドに足す環境変数(CHARASTA_FAKE_GROK など。ふだんは process.env だけ)
  const studio = new Studio(lib, {charakuruApp: config.charakuruApp, blender: config.blender, env: config.env ?? {}});
  const edition = editionOf(config);   // 版の種類(docs/edition.md)。キットで外した機能の API とジョブは断る
  const jobs = new JobQueue({lib, studio, edition, env: config.env ?? {}, getPort: () => server.address()?.port ?? config.port,
    tools: {blender: config.blender, kit: config.charakuruApp, patchVrm: config.patchVrm, springTune: config.springTune, motionbricksDir: config.motionbricksDir, motionbricksBackend: config.motionbricksBackend, motionbricksOnnxRuntime: config.motionbricksOnnxRuntime, vrmaPipelineDir: config.vrmaPipelineDir, rgbmocapDir: config.rgbmocapDir,
      kimodoDir: config.kimodoDir, hfCacheDir: config.hfCacheDir, stageStudioDir: config.stageStudioDir, voicevoxDir: config.voicevoxDir, hyperframesCli: config.hyperframesCli, hyperframesBrowser: config.hyperframesBrowser, figureImageGen: config.figureImageGen, gitBash: config.gitBash}});

  const trash = new Trash(lib, jobs);

  server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    // ログに使う値は先に取る。本文を読み切らずに req が破棄されると、finish のときには req.socket が null になる
    const remote = req.socket.remoteAddress, forwarded = req.headers['x-forwarded-for'] || '-', agent = String(req.headers['user-agent'] || '').slice(0, 60);
    res.on('finish', () => console.log([new Date().toISOString(), remote, forwarded, req.method,
      req.url.slice(0, 120), res.statusCode, res.getHeader('content-length') ?? '-', `${Date.now() - t0}ms`, agent].join(' ')));
    try {
      // DNS リバインディングと他サイトからの書き込みを避ける。
      const host = String(req.headers.host ?? '');
      // config.allowedHosts: ほかに受け付けるホスト名（tailscale serve の後ろで使う tailnet の名前）
      const hostName = host.replace(/:\d+$/, '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(hostName) && !(config.allowedHosts ?? []).includes(hostName)) { res.writeHead(403); return res.end('forbidden'); }
      if (req.headers.origin && new URL(req.headers.origin).host !== host) { res.writeHead(403); return res.end('forbidden'); }

      const url = new URL(req.url, 'http://127.0.0.1');
      let p;
      try { p = decodeURIComponent(url.pathname); } catch { return notFound(res); }
      const get = req.method === 'GET' || req.method === 'HEAD';
      refuseRemovedRoute(edition, p);

      if (get && p === '/') return await sendHtml(req, res, path.join(publicDir, 'index.html'));
      if (get && p === '/viewer') return await sendHtml(req, res, path.join(publicDir, 'viewer.html'));

      if (get && p === '/api/overview') return json(res, 200, {...await overview(lib, studio, {charakuruUrl: config.charakuruUrl}), ...editionInfo(edition), capabilities: await capabilities({config, jobs})});
      if (get && p === '/api/capabilities') return json(res, 200, await capabilities({config, jobs}));
      if (p === '/api/characters') {
        if (get) return json(res, 200, await lib.listCharacters());
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          if (body?.style == null) throw new LibraryError('bad-input', 'style が要る(' + STYLES.join(' / ') + ')');   // 新しいキャラはスタイルを必ず選ぶ
          checkCharacter(edition, body);
          return json(res, 201, await lib.createCharacter(body));
        }
        res.writeHead(405, {Allow: 'GET, POST'}); return res.end();
      }
      const faceRoute = /^\/api\/characters\/([^/]+)\/versions\/([^/]+)\/face$/.exec(url.pathname);   // 版の顔: 方式、Fcl_ のキー、プリセット、確かめの撮影
      if (faceRoute && get) return json(res, 200, await faceInfo(lib, safeDecode(faceRoute[1]), safeDecode(faceRoute[2])));
      const checkRoute = /^\/api\/characters\/([^/]+)\/versions\/([^/]+)\/check$/.exec(url.pathname);   // 版の検査: スタイルごと(スタンダード=VRoid 形式、チビ=軽い版と三角形など)
      if (checkRoute && get) return json(res, 200, await versionCheck(lib, safeDecode(checkRoute[1]), safeDecode(checkRoute[2]), {edition}));
      const adjustRoute = /^\/api\/characters\/([^/]+)\/versions\/([^/]+)\/adjust$/.exec(url.pathname);   // 体型と揺れものの直し(docs/adjust.md)。直すのはジョブ adjust
      if (adjustRoute && get) return json(res, 200, await adjustInfo(lib, safeDecode(adjustRoute[1]), safeDecode(adjustRoute[2])));
      const gameRoute = /^\/api\/characters\/([^/]+)\/versions\/([^/]+)\/game-exports$/.exec(url.pathname);   // 版のゲーム用の書き出し(docs/game-export.md)。作るのはジョブ game-export
      if (gameRoute && get) return json(res, 200, await listGameExports(lib, safeDecode(gameRoute[1]), safeDecode(gameRoute[2])));
      const verRoute = /^\/api\/characters\/([^/]+)\/versions$/.exec(url.pathname);   // きゃらくるのプロジェクトから版を取り込む
      if (verRoute) {
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
        return json(res, 201, await studio.importProjectVersion(safeDecode(verRoute[1]), await readJsonBody(req)));
      }
      // 消す操作(ごみ箱へ移す)と、消す前の影響の一覧(末尾に /impact)。docs/characters.md の「ごみ箱」
      const target = trashTarget(url.pathname);
      if (target?.impact) {
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        return json(res, 200, await trash.impact(target.kind, target));
      }
      if (target && req.method === 'DELETE') {
        const item = await trash.move(target.kind, target);
        return json(res, 200, {ok: true, trashed: 'trash/' + item.trashId, item});
      }
      if (target && target.kind !== 'character' && !(target.kind === 'short' && (get || req.method === 'PUT'))) { res.writeHead(405, {Allow: 'DELETE'}); return res.end(); }
      if (p === '/api/trash') {
        if (get) return json(res, 200, await trash.list());
        if (req.method === 'DELETE') return json(res, 200, await trash.empty());
        res.writeHead(405, {Allow: 'GET, DELETE'}); return res.end();
      }
      const trashItem = /^\/api\/trash\/([^/]+)(\/restore)?$/.exec(url.pathname);
      if (trashItem) {
        const [, rawId, restore] = trashItem, id = safeDecode(rawId);
        if (restore) {
          if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
          return json(res, 200, {ok: true, item: await trash.restore(id)});
        }
        if (req.method !== 'DELETE') { res.writeHead(405, {Allow: 'DELETE'}); return res.end(); }
        return json(res, 200, {ok: true, ...await trash.purge(id)});
      }
      if (p.startsWith('/api/characters/')) {
        const id = p.slice('/api/characters/'.length);
        if (get) return json(res, 200, await lib.getCharacter(id));
        if (req.method === 'PATCH') { const body = await readJsonBody(req); checkCharacter(edition, body); await lib.updateCharacter(id, body); return json(res, 200, await lib.getCharacter(id)); }
        res.writeHead(405, {Allow: 'GET, PATCH, DELETE'}); return res.end();
      }
      if (p === '/api/short-draft/prompt') {   // Gemini へ渡す依頼文
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
        return json(res, 200, {prompt: await draftRequest(lib, config.stageStudioDir, await readJsonBody(req))});
      }
      if (p === '/api/short-draft/import') {   // Gemini の答えの取り込み。問題があれば理由と直しの依頼文を返す
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
        const body = await readJsonBody(req), found = await draftImportCheck(lib, config.stageStudioDir, body);
        if (found.errors.length) return json(res, 422, {error: `取り込めない: ${found.errors.slice(0, 3).join('、')}`, ...found});
        return json(res, 201, await jobs.enqueue({...body, type: 'short-draft', source: 'gemini'}));
      }
      if (p === '/api/jobs') {
        if (get) return json(res, 200, await jobs.list());
        if (req.method === 'POST') return json(res, 201, await jobs.enqueue(await readJsonBody(req)));
        res.writeHead(405, {Allow: 'GET, POST'}); return res.end();
      }
      if (p.startsWith('/api/jobs/')) {
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        return json(res, 200, await jobs.get(p.slice('/api/jobs/'.length)));
      }
      if (p === '/api/charakuru/projects') {
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        return json(res, 200, await studio.listProjects());
      }
      if (p.startsWith('/api/studio/')) return await studioRoute(req, res, url.pathname.slice('/api/studio/'.length).split('/').map(safeDecode), studio, jobs);
      if (p === '/api/motion-gen') {   // モーションを作るジョブで選べる条件と確認待ち
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        return json(res, 200, {...await motionGenOptions(config.motionbricksDir, jobs.env), waiting: await jobs.genMotionsWaiting()});
      }
      const mg = /^\/api\/motion-gen\/([^/]+)\/(motion\.vrma|contacts\.json|import|discard)$/.exec(url.pathname);
      if (mg) {   // 確認待ちの結果: VRMA と接地を配る、取り込む、捨てる(/api/motion-recipes/<ジョブ>/… と同じ形)
        const [, jobId, action] = mg, id = safeDecode(jobId);
        if (action === 'motion.vrma' || action === 'contacts.json') {
          if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
          return await sendFile(req, res, await jobs.genMotionFile(id, action));
        }
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
        if (action === 'import') return json(res, 201, await jobs.importGenMotion(id, await readJsonBody(req)));
        return json(res, 200, await jobs.discardGenMotion(id));
      }
      if (p === '/api/motion-texts') {   // 文章からモーションを作る: 使えるかどうかと確認待ち
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        return json(res, 200, {...motionTextOptions(jobs.kimodoAvailable(), jobs.env), kimodoDir: config.kimodoDir ?? null, waiting: await jobs.textMotionsWaiting()});
      }
      const tm = /^\/api\/motion-texts\/([^/]+)\/(?:candidates\/([^/]+)\/(motion\.vrma|contacts\.json)|(import|discard))$/.exec(url.pathname);
      if (tm) {
        const [, jobId, n, file, action] = tm, id = safeDecode(jobId);
        if (file) {
          if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
          return await sendFile(req, res, await jobs.textMotionFile(id, safeDecode(n), file));
        }
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
        if (action === 'import') return json(res, 201, await jobs.importTextMotion(id, await readJsonBody(req)));
        return json(res, 200, await jobs.discardTextMotion(id));
      }
      if (p === '/api/motion-recipes') {   // モーションをつなぐ: 選べる条件、確認待ち、区間に使える確認待ちの結果(sources)。積むのは /api/jobs の type: motion-recipe
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        return json(res, 200, {...await motionRecipeOptions(config.motionbricksDir, jobs.env, {defaultMethod: recipeDefaultMethod(edition, jobs.motionbricksReady())}), waiting: await jobs.recipeMotionsWaiting(), sources: await jobs.recipeSources()});
      }
      const mr = /^\/api\/motion-recipes\/([^/]+)\/(motion\.vrma|contacts\.json|import|discard)$/.exec(url.pathname);
      if (mr) {
        const [, jobId, action] = mr, id = safeDecode(jobId);
        if (action === 'motion.vrma' || action === 'contacts.json') {
          if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
          return await sendFile(req, res, await jobs.recipeMotionFile(id, action));
        }
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
        if (action === 'import') return json(res, 201, await jobs.importRecipeMotion(id, await readJsonBody(req)));
        return json(res, 200, await jobs.discardRecipeMotion(id));
      }
      if (p === '/api/video-motions') {   // 動画からモーションを作る: GET は使えるかどうかと確認待ち、POST は手元の動画を受け取って積む
        if (get) return json(res, 200, {...videoOptions(edition, await videoMotionOptions(config.vrmaPipelineDir, jobs.env, config.rgbmocapDir)), waiting: await jobs.videoMotionsWaiting()});
        if (req.method === 'POST') return await postVideoMotion(req, res, lib, jobs);
        res.writeHead(405, {Allow: 'GET, POST'}); return res.end();
      }
      const vm = /^\/api\/video-motions\/([^/]+)\/(compare\.mp4|import|discard)$/.exec(url.pathname);
      if (vm) {
        const [, jobId, action] = vm, id = safeDecode(jobId);
        if (action === 'compare.mp4') {
          if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
          return await sendFile(req, res, await jobs.videoMotionCompare(id));
        }
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
        if (action === 'import') return json(res, 201, await jobs.importVideoMotion(id, await readJsonBody(req)));
        return json(res, 200, await jobs.discardVideoMotion(id));
      }
      if (p === '/api/motions') {
        if (get) return json(res, 200, await lib.listMotions());
        if (req.method === 'POST') return await postMotion(req, res, lib);
        res.writeHead(405, {Allow: 'GET, POST'}); return res.end();
      }

      if (p === '/api/shorts') {   // ショート動画のカット表
        if (get) return json(res, 200, await lib.listShorts());
        if (req.method === 'POST') { const body = await newShortBody(lib, config.stageStudioDir, shortInput(edition, await readJsonBody(req))); return json(res, 201, await lib.saveShort('s' + Date.now().toString(36), body)); }
        res.writeHead(405, {Allow: 'GET, POST'}); return res.end();
      }
      if (p === '/api/dance-shorts') {   // ダンス MV のショートを新しく作る(#mv/<キャラ> の入口)。docs/shorts-dance-mv.md
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
        return json(res, 201, await newDanceShort({lib, stageDir: config.stageStudioDir}, await readJsonBody(req)));
      }
      const graphicDef = /^\/api\/shorts\/([^/]+)\/graphic-defaults$/.exec(p);
      if (graphicDef) {   // グラフィック MV の既定値(文字、色、表情、スカート)。保存はしない。?preset=pop|chara|mono
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        const preset = url.searchParams.get('preset') || 'pop';
        if (!['pop', 'chara', 'mono'].includes(preset)) return json(res, 400, {error: 'preset は pop / chara / mono'});
        return json(res, 200, await graphicDefaults({lib, short: await lib.getShort(safeDecode(graphicDef[1])), preset}));
      }
      const beatCuts = /^\/api\/shorts\/([^/]+)\/beat-cuts$/.exec(p);
      if (beatCuts) {   // 拍から割る: 曲か bpm からカット(シーン、カメラ、秒)を作って保存する
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
        return json(res, 200, await splitShort({lib, stageDir: config.stageStudioDir}, safeDecode(beatCuts[1]), await readJsonBody(req), await jobs.active()));
      }
      if (p === '/api/short-options') {   // 編集画面で選べるシーン、カメラ、話者
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        const [speakers, elevenVoices] = await Promise.all([jobs.voicevox.speakers().catch(() => []), jobs.eleven.voices().catch(() => [])]);
        const graphic = await supportsGraphic(config.stageStudioDir) ? await graphicCatalog(config.stageStudioDir) : null;   // グラフィック MV の場面(stage-studio に道具が無ければ null)
        return json(res, 200, {...await mvOptions(config.stageStudioDir), cameras: SHORT_CAMERAS, danceCameras: DANCE_CAMERAS, speakers, elevenVoices, tones: VOICE_TONES, graphic});
      }
      if (p === '/api/short-voice') {   // セリフの試し聞き
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
        const {file, type} = await voiceSample({lib, voicevox: jobs.voicevox, eleven: jobs.eleven}, await readJsonBody(req)), audio = await fsp.readFile(file);
        res.writeHead(200, {'Content-Type': type, 'Content-Length': audio.length}); return res.end(audio);
      }
      const figureUp = /^\/api\/shorts\/([^/]+)\/figures$/.exec(p);
      if (figureUp) {   // カットの図。本文はファイルそのもの、ヘッダ x-filename
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
        return json(res, 201, await saveFigure(lib, safeDecode(figureUp[1]), safeDecode(String(req.headers['x-filename'] ?? '')), await readBody(req)));
      }
      const shortTimesUrl = /^\/api\/shorts\/([^/]+)\/times\/([^/]+)$/.exec(p);
      if (shortTimesUrl) {   // 書き出しの時間表。編集画面がカットの頭へ飛ぶ
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        return json(res, 200, await shortTimes(lib, safeDecode(shortTimesUrl[1]), safeDecode(shortTimesUrl[2])));
      }
      // 編集画面のプレビュー。ショートの合成のフォルダの中の、決まった種類のファイルだけ配る
      const shortFile = /^\/api\/shorts\/([^/]+)\/compose\/(.+)$/.exec(p);
      if (shortFile) {
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        const id = safeDecode(shortFile[1]);
        if (shortFile[2] === 'index.html') { const html = await shortPreview(lib, id); res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}); return res.end(html); }
        // 図はまだ書き出していないものも見られるようにショートのフォルダから配る
        if (shortFile[2].startsWith('figures/')) {
          const fig = inside(lib.shortDir(id), 'figures', safeDecode(shortFile[2].slice(8)));
          return /\.(png|jpe?g|webp)$/.test(fig) ? await sendFile(req, res, fig) : notFound(res);
        }
        const compose = await shortCompose(lib, id);
        if (!compose) return notFound(res);
        // %2F や %5C で包んだ .. は URL の正規化を通り抜けるので、inside で確かめる
        const file = inside(compose.compose, safeDecode(shortFile[2]));
        if (!/\.(mp4|wav|ttf|jpg)$/.test(file)) return notFound(res);
        return await sendFile(req, res, file);
      }
      if (target?.kind === 'short') {
        if (get) return json(res, 200, await lib.getShort(target.id));
        await lib.getShort(target.id);
        return json(res, 200, await saveShortEdit(lib, target.id, await shortBody(lib, config.stageStudioDir, shortInput(edition, await readJsonBody(req))), await jobs.active()));
      }
      if (p === '/api/shoots') {   // 動画ギャラリー: 全キャラの撮った動画
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        return json(res, 200, await lib.allShoots());
      }
      if (p === '/api/mv') {   // MV で選べるシーン
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        return json(res, 200, await mvOptions(config.stageStudioDir));
      }
      if (p === '/api/stages') {   // ステージの画面: シーンの一覧と、それぞれを使うショートと MV(読むだけ)
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        return json(res, 200, await stageOverview(config.stageStudioDir, lib));
      }
      // ステージの頼みごと(docs/stages.md): 一覧と作る、参考の絵を足す(本文は絵そのもの、ヘッダ x-filename)、取り下げ、参考の絵を見る
      if (p === '/api/stage-requests') {
        if (get) return json(res, 200, {requests: (await listStageRequests(lib.dir)).map(withRefUrls)});
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'GET, POST'}); return res.end(); }
        return json(res, 201, withRefUrls(await createStageRequest(lib.dir, await readJsonBody(req))));
      }
      const stageReq = /^\/api\/stage-requests\/([^/]+)(\/refs(?:\/([^/]+))?)?$/.exec(p);
      if (stageReq) {
        const id = safeDecode(stageReq[1]);
        if (stageReq[3]) {
          if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
          return await sendFile(req, res, await stageRefFile(lib.dir, id, safeDecode(stageReq[3])));
        }
        if (stageReq[2]) {
          if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
          return json(res, 201, await addStageRef(lib.dir, id, {name: safeDecode(String(req.headers['x-filename'] ?? '')), data: await readBody(req, MAX_REF_BYTES)}));
        }
        if (get) return json(res, 200, withRefUrls(await getStageRequest(lib.dir, id)));
        if (req.method !== 'DELETE') { res.writeHead(405, {Allow: 'GET, DELETE'}); return res.end(); }
        return json(res, 200, await cancelStageRequest(lib.dir, id));
      }
      // 直しの頼みごと(docs/adjust.md): 一覧(?char= で絞る)と作る、今の見た目の絵を付ける(本文は絵そのもの)、取り下げ、絵を見る
      if (p === '/api/adjust-requests') {
        if (get) return json(res, 200, {requests: (await listAdjustRequests(lib.dir, {charId: url.searchParams.get('char') || null})).map(withShotUrl)});
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'GET, POST'}); return res.end(); }
        return json(res, 201, withShotUrl(await createAdjustRequest(lib, await readJsonBody(req))));
      }
      const adjustReq = /^\/api\/adjust-requests\/([^/]+)(\/shot)?$/.exec(p);
      if (adjustReq) {
        const id = safeDecode(adjustReq[1]);
        if (adjustReq[2]) {
          if (get) return await sendFile(req, res, await adjustShotFile(lib.dir, id));
          if (req.method !== 'POST') { res.writeHead(405, {Allow: 'GET, POST'}); return res.end(); }
          return json(res, 201, await setAdjustShot(lib.dir, id, await readBody(req, MAX_SHOT_BYTES)));
        }
        if (get) return json(res, 200, withShotUrl(await getAdjustRequest(lib.dir, id)));
        if (req.method !== 'DELETE') { res.writeHead(405, {Allow: 'GET, DELETE'}); return res.end(); }
        return json(res, 200, await cancelAdjustRequest(lib.dir, id));
      }
      const mvThumb = /^\/api\/mv\/stages\/([^/]+)\.jpg$/.exec(p);
      if (mvThumb) {
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        return await sendFile(req, res, stageThumb(config.stageStudioDir, mvThumb[1]));
      }

      if (p === '/api/audio') {   // 撮るときに重ねる音声ファイル。本文はファイルそのもの、ヘッダ x-filename
        if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); return res.end(); }
        return json(res, 201, await lib.importAudio({name: safeDecode(String(req.headers['x-filename'] ?? '')).replace(/[\\/]/g, '_'), data: await readBody(req)}));
      }
      if (p === '/api/terms') {   // 動画の利用条件: ?motion=<ID>&audioName=<名前>&audioSummary=<人が書いた条件>
        if (!get) { res.writeHead(405, {Allow: 'GET'}); return res.end(); }
        const q = url.searchParams, name = q.get('audioName');
        return json(res, 200, videoTerms({motion: q.get('motion') ? await lib.getMotion(q.get('motion')) : null, audio: name ? {name, summary: (q.get('audioSummary') ?? '').trim(), publishOk: q.get('audioPublic') === '1'} : null}));
      }

      // 保管場所のうち配るのはキャラとモーションだけ（jobs/、trash/、server.log などは配らない）
      if (get && /^\/lib\/(characters|motions)\//.test(p)) {
        // %2F や %5C で包んだ .. は URL の正規化を通り抜けるので、解決したあとの最初の段でも確かめる
        const file = inside(lib.dir, p.slice(5));
        if (!['characters', 'motions'].includes(path.relative(lib.dir, file).split(path.sep)[0])) return notFound(res);
        return await sendFile(req, res, file);
      }
      // 表情づくりは、撮影・採用した絵・試作・確かめの撮影だけ配る(材料の .blend と work/ は配らない)
      const sm = /^\/lib\/studio\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(p);
      if (get && sm && SERVED.includes(sm[3])) {
        // %2F や %5C で包んだ .. は URL の正規化を通り抜けるので、解決したあとの最初の段でも確かめる
        const base = studio.dir(sm[1], sm[2]), file = inside(base, sm[3], sm[4]);
        if (!SERVED.includes(path.relative(base, file).split(path.sep)[0])) return notFound(res);
        return await sendFile(req, res, file);
      }
      if (get && p.startsWith('/vendor/')) return await sendFile(req, res, inside(vendorDir, p.slice(8)));
      if (get && p.startsWith('/app/')) return await sendFile(req, res, inside(publicDir, p.slice(5)));

      notFound(res);
    } catch (e) {
      if (e instanceof LibraryError) {
        const status = STATUS[e.code] ?? 400;
        if (e.code === 'too-large') res.setHeader('Connection', 'close');   // 残りの本文は読まない
        return String(req.url).startsWith('/api/') ? json(res, status, {error: e.message, code: e.code}) : notFound(res, e.message);
      }
      console.error(e);
      if (!res.headersSent) json(res, 500, {error: String(e.message)}); else res.destroy();
    }
  });
  server.jobs = jobs; // テスト用: whenIdle() で終わりを待つ
  server.on('close', () => { jobs.close(); });
  return server;
}

// /api/studio/<キャラ>[/<表情づくり>[/<操作>[/<名前>]]](docs/expression-studio.md の API)
async function studioRoute(req, res, parts, studio, jobs) {
  const [charId, id, action, name] = parts, m = req.method, get = m === 'GET' || m === 'HEAD';
  const deny = allow => { res.writeHead(405, {Allow: allow}); res.end(); };
  const status = async () => json(res, 200, await studio.status(charId, id, j => jobs.peek(j)));
  if (parts.length === 1) {
    if (get) return json(res, 200, await studio.list(charId));
    if (m === 'POST') { const b = await readJsonBody(req); const w = await studio.create({charId, id: b.id, note: b.note ?? ''}); return json(res, 201, await studio.status(charId, w.id)); }
    return deny('GET, POST');
  }
  if (parts.length === 2) return get ? status() : deny('GET');
  // 依頼と候補: requests、requests/<依頼>/withdraw、requests/<依頼>/candidates(本文は PNG、x-note)、requests/<依頼>/candidates/<番号>/adopt|reject
  if (action === 'requests') {
    // 依頼 ID と候補の番号を * にした形で道を選ぶ(例 "POST * candidates * adopt")
    const [, , , reqId, , n] = parts, route = [m, ...parts.slice(3).map((p, i) => i === 0 || i === 2 ? '*' : p)].join(' ');
    if (route === 'POST') { await studio.createRequest(charId, id, await readJsonBody(req)); return status(); }
    if (route === 'POST * withdraw') { await studio.withdrawRequest(charId, id, reqId); return status(); }
    if (route === 'POST * candidates') {
      const c = await studio.addCandidate(charId, id, reqId, {data: await readBody(req), note: safeDecode(String(req.headers['x-note'] ?? '')),
        from: req.headers['x-from'] ? safeDecode(String(req.headers['x-from'])) : null});
      return json(res, 201, c);
    }
    if (route === 'POST * candidates * adopt') { await studio.adoptCandidate(charId, id, reqId, n); return status(); }
    if (route === 'POST * candidates * reject') { await studio.rejectCandidate(charId, id, reqId, n, await readJsonBody(req)); return status(); }
    return json(res, 404, {error: `${m} /api/studio/…/${parts.slice(2).join('/')} は無い`});
  }
  const route = `${m} ${action}${parts.length === 4 ? '/' : ''}`;
  if (parts.length === 3 && route === 'POST copy') { await studio.copyInputs(charId, id, await readJsonBody(req)); return status(); }
  if (parts.length === 3 && route === 'PUT rects') { await studio.setRects(charId, id, await readJsonBody(req)); return status(); }
  if (parts.length === 3 && route === 'PATCH options') { await studio.setOptions(charId, id, await readJsonBody(req)); return status(); }
  if (parts.length === 3 && route === 'POST promote') return json(res, 201, await studio.promote(charId, id, await readJsonBody(req)));
  if (parts.length === 4 && route === 'POST videos/') { await studio.addVideo(charId, id, {name, data: await readBody(req)}); return status(); }
  if (parts.length > 4) return notFound(res);
  return json(res, 404, {error: `${m} /api/studio/…/${action} は無い`});
}

// 画面のファイルがまだ無いときも落ちずに 404 を返す。
async function sendHtml(req, res, file) {
  try { await fsp.access(file); } catch { return notFound(res, '画面のファイルがまだ無い: ' + path.relative(root, file)); }
  return sendFile(req, res, file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const config = loadConfig();
  const port = i > 0 ? Number(process.argv[i + 1]) : config.port;
  const server = createServer(config);
  server.listen(port, '127.0.0.1', () => {
    fs.mkdirSync(config.libraryDir, {recursive: true});   // 初めて動かすときは保管場所がまだ無い(pid ファイルもここに書く)
    writePidFile(config.libraryDir);   // ポートを取れたときだけ書く(取れずに終わる 2 つ目のサーバーは書かない)
    console.log(`charasta http://127.0.0.1:${port}/  library=${config.libraryDir}  pid=${process.pid}`);
  });
  // 止めるとき、Kimodo の作業プロセス(起動した PID の木)も止め、自分の server.pid を消す
  process.on('exit', () => { server.jobs.kimodo?.killSync(); removePidFile(config.libraryDir); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { server.jobs.close().finally(() => process.exit(0)); });
}
