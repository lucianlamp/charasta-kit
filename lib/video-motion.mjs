// 動画からモーションを作るジョブ video-motion(docs/video-to-vrma.md)。動きの推定は 2 通り(入力の engine):
//   exmr(既定): RGB MoCap(設定の rgbmocapDir)の ExMR で BVH を作り、tools/compose で VRM の骨へ移す(tools/rgbmocap/exmr_vrma.py)
//   mediapipe: vrma-pipeline(設定の vrmaPipelineDir)の batch_convert.py(MediaPipe Pose と Hand Landmarker)
// どちらも元の動画と並べた比較の動画まで作って止まる。本番には入れない。確認の画面で「取り込む」を押して初めてモーションになる。
//   動画を取る(URL は yt-dlp) -> 切り出す(ffmpeg) -> VRMA を作る -> 比較の動画(Blender で描いて左右に並べる) -> 利用条件の記録
// 試しの動き(環境変数。サーバーの config.env でも渡せる):
//   CHARASTA_FAKE_VRMA_PIPELINE=1  vrma-pipeline と Blender と yt-dlp を呼ばず、作りものの動きで通す(ffmpeg と python と numpy は要る)。fail は変換の失敗、hang は変換が終わらない
//   CHARASTA_VIDEO_MOTION_TIMEOUT_MS  切り出しのあとの時間の上限(ミリ秒)。省くとコマ数から決める(テストが短くする)
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {root} from './config.mjs';
import {rgbmocapPython, venvPython, isWin, isMac} from './platform.mjs';
import {h264Args, runH264} from './encoder.mjs';
import {LibraryError, checkId, inside, readJsonOr, writeJson} from './library.mjs';

export const UPLOAD_DIR = 'uploads';
export const UPLOAD_MAX = 2 * 1024 * 1024 * 1024;
export const VIDEO_EXT = ['.mp4', '.m4v', '.mov', '.webm', '.mkv'];
const MAX_CLIP_SEC = 120, MAX_RIGHTS = 500, MAX_LABEL = 100, MAX_URL = 2000, SPEED = [0.1, 4], GRIP = [0, 100];
const FETCH_MS = 15 * 60 * 1000, CUT_MS = 5 * 60 * 1000;
const ENGINES = {
  exmr: {pack: 'RGB MoCap ExMR（動画から変換）', tool: 'rgbmocap', model: 'RGB MoCap ExMR（SMPL-X）+ tools/compose',
    // ExMR と体のモデルの条件(RGB MoCap の THIRD_PARTY_NOTICES.md)。使ってよいかは人が確かめる。ここでは記録するだけ
    terms: [{part: '動きの推定（RGB MoCap の ExMR）', license: 'ExMR の LICENSE（GVHMR 由来。教育・研究・非営利の利用に限る条件）。RGB MoCap 本体は MIT'},
      {part: '体と手のモデル（SMPL-X、MANO）', license: 'SMPL-X / MANO のモデルライセンス（登録して取得。非商用の条件と再配布の制限）'},
      {part: '特徴の抽出（Sapiens2、SAM 3D Body、HaMeR）', license: 'Sapiens2 License、SAM License、HaMeR（MIT、重みは提供元の条件）'}]},
  mediapipe: {pack: 'vrma-pipeline（動画から変換）', tool: 'vrma-pipeline', model: 'MediaPipe Pose + Hand Landmarker', terms: []},
};
export const VIDEO_ENGINES = Object.keys(ENGINES);
// 床は暗くする(0.35 では白い服が床に溶けて手が読めなかった)。ノイズ除去ありで 1 コマ約 0.75 秒(RTX 4070)
const RENDER = ['--views', 'front', '--frames-view', 'front', '--frames-res', '720', '--samples', '32', '--denoise', '--materials', 'original', '--floor-shade', '0.08',
  '--device', 'gpu', '--skip-poses', '--frames-engine', 'CYCLES'];

// 時間の上限(ミリ秒)。実測は 1 コマ約 1 秒(変換 0.2、描画 0.75 など)。その 3 倍ほどに、Blender と Python の起動の分を足す
// ExMR はモデルの読み込みに数分かかる(ILLIT 658 コマで推定 14 分、8 秒 229 コマの初回で 22 分)ので、固定の分を大きくとる
// 手のめり込みの直し(handBodyFix)は 658 コマで約 22 分(1 コマ約 2 秒)なので、1 コマ 4 秒を足す
export const videoMotionTimeoutMs = (frames, engine = 'mediapipe', handBodyFix = false) => (engine === 'exmr' ? 1800000 + frames * 5000 : 120000 + frames * 3000) + (handBodyFix ? frames * 4000 : 0);

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

function number(value, name, [lo, hi], fallback) {
  const blank = value === undefined || value === null || value === '';
  const v = blank ? fallback : typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  if (v === null) return null;
  if (!Number.isFinite(v) || v < lo || v > hi) throw new LibraryError('bad-input', `${name} は ${lo}〜${hi} の数`);
  return v;
}

function text(value, name, max) {
  if (value != null && typeof value !== 'string') throw new LibraryError('bad-input', `${name} は文字列`);
  const s = (value ?? '').trim();
  if ([...s].length > max) throw new LibraryError('bad-input', `${name} は ${max} 文字まで`);
  return s;
}

function checkUrl(value) {
  const s = text(value, 'url', MAX_URL);
  let u = null;
  try { u = new URL(s); } catch { /* 下で断る */ }
  if (!u || !['http:', 'https:'].includes(u.protocol)) throw new LibraryError('bad-input', 'url は http か https の URL');
  return s;
}

// 入力の確かめ(動画の中身より前にわかること)。input には charId と verId が入っている。
// engine を書かないときは exmr。ただし RGB MoCap が無い(exmrAvailable が偽)か、mediapipe だけの条件(depthOpt: false、grip)を書いた前からの呼び出しは mediapipe
// body.url か body.upload(サーバーが uploads/ に置いたファイル名)のどちらか。保存の前に確かめるときは source: false で動画を問わない
export function videoMotionInput(lib, input, body, {source = true, exmrAvailable = true} = {}) {
  const legacy = body.depthOpt === false || (body.grip != null && body.grip !== '' && Number(body.grip) !== 0);
  const out = {...input,
    rights: text(body.rights, '権利のメモ', MAX_RIGHTS),
    engine: body.engine ?? (legacy || !exmrAvailable ? 'mediapipe' : 'exmr'),
    unmirror: body.unmirror === true,
    handBodyFix: body.handBodyFix === true,
    speed: number(body.speed, 'speed', SPEED, 1),
    depthOpt: body.depthOpt !== false,
    grip: number(body.grip, 'grip', GRIP, 0),
    trimStart: number(body.trimStart, 'trimStart', [0, 36000], 0),
    trimEnd: number(body.trimEnd, 'trimEnd', [0, 36000], null),
    crop: text(body.crop, 'crop', 32),
    label: text(body.label, 'label', MAX_LABEL)};
  if (!VIDEO_ENGINES.includes(out.engine)) throw new LibraryError('bad-input', 'engine は ' + VIDEO_ENGINES.join(' か '));
  if (out.engine === 'exmr' && !exmrAvailable) throw new LibraryError('bad-input', 'RGB MoCap が無いので exmr は使えない(設定の rgbmocapDir)');
  if (out.engine === 'exmr' && (body.depthOpt === false || out.grip)) throw new LibraryError('bad-input', '奥行き最適化と両手の間隔は mediapipe の変換だけで使う');
  if (!out.rights) throw new LibraryError('bad-input', '権利のメモを書く（どこの動画で、どう使ってよいか）');
  if (body.unmirror != null && typeof body.unmirror !== 'boolean') throw new LibraryError('bad-input', 'unmirror は true か false');
  if (body.handBodyFix != null && typeof body.handBodyFix !== 'boolean') throw new LibraryError('bad-input', 'handBodyFix は true か false');
  if (out.handBodyFix && out.engine !== 'exmr') throw new LibraryError('bad-input', '手のめり込みの直しは exmr の変換だけで使う');
  if (body.depthOpt != null && typeof body.depthOpt !== 'boolean') throw new LibraryError('bad-input', 'depthOpt は true か false');
  if (out.grip && !out.depthOpt) throw new LibraryError('bad-input', '両手の間隔は全身の奥行き最適化を切ると使えない');
  if (out.trimEnd !== null && out.trimEnd <= out.trimStart) throw new LibraryError('bad-input', 'trimEnd は trimStart より後ろにする');
  if (out.crop && !/^\d+:\d+:\d+:\d+$/.test(out.crop)) throw new LibraryError('bad-input', 'crop は 幅:高さ:左:上 の数');
  if (!source) return out;
  if (!!body.url === !!body.upload) throw new LibraryError('bad-input', '動画は url か手元のファイルのどちらか 1 つ');
  if (body.url) {
    out.url = checkUrl(body.url);
    out.label ||= new URL(out.url).hostname;
  } else {
    if (typeof body.upload !== 'string' || !/^[a-z0-9-]+\.[a-z0-9]+$/.test(body.upload) || !VIDEO_EXT.includes(path.extname(body.upload))) throw new LibraryError('bad-input', 'upload はサーバーが置いたファイルの名前');
    out.upload = body.upload;
    out.fileName = text(body.fileName, 'fileName', 200);
    out.label ||= path.basename(out.fileName, path.extname(out.fileName)) || 'video';
  }
  return out;
}

// 画面が読むもの(GET /api/video-motions)
export async function videoMotionOptions(pipelineDir, env, rgbmocapDir = null) {
  const fake = !!env.CHARASTA_FAKE_VRMA_PIPELINE, pipeline = fake || await exists(venvPython(pipelineDir ?? ''));
  const engines = {exmr: pipeline && (fake || await exists(rgbmocapPython(rgbmocapDir ?? ''))), mediapipe: pipeline};
  return {available: pipeline, pipelineDir: pipelineDir ?? null, rgbmocapDir: rgbmocapDir ?? null, engines, defaultEngine: engines.exmr ? 'exmr' : 'mediapipe', maxClipSec: MAX_CLIP_SEC, speed: SPEED};
}

// 手を入れない元の動画のうち、切り出しの ffmpeg の引数。fps は ffprobe の r_frame_rate(例 60/1)
export function cutArgs({input, out, fps, speed, trimStart, trimEnd, crop, unmirror, encoder = 'libx264'}) {
  const [num, den] = fps.split('/').map(Number), s = Math.round(speed * 1000);
  const vf = [...(crop ? [`crop=${crop}`] : []), ...(unmirror ? ['hflip'] : []), `setpts=${s / 1000}*PTS`];
  return ['-y', '-v', 'error', ...(trimStart ? ['-ss', String(trimStart)] : []), ...(trimEnd !== null ? ['-to', String(trimEnd)] : []), '-i', input,
    '-vf', vf.join(','), '-r', `${num * 1000}/${(den || 1) * s}`, '-an', ...h264Args(encoder, 18), '-pix_fmt', 'yuv420p', out];
}

// yt-dlp で URL の動画を orig/source_<id>.<ext> に落とす(+ .info.json)。vrma-pipeline の fetch_video.ps1 -DownloadOnly と同じ手順:
// 映像だけ(音は要らない)、H.264 で 1920 以下を優先、プレイリストは取らない。クライアントは default、web_embedded、mweb の順に試す(Cookie やプロキシは使わない)。
// 全部失敗したら、動画のファイル(か cookies.txt)を手元から渡してもらう。yt-dlp は PATH の yt-dlp か環境変数 CHARASTA_YTDLP。
export const YTDLP_FORMAT = 'bv*[vcodec^=avc1][height<=1920][width<=1920]/bv*[height<=1920]/b';
export function ytdlpArgs({url, orig, client, ejs}) {
  return [...(ejs ? ['--remote-components', 'ejs:github'] : []), '--no-playlist', ...(client === 'default' ? [] : ['--extractor-args', `youtube:player_client=${client}`]),
    '-f', YTDLP_FORMAT, '-o', path.join(orig, 'source_%(id)s.%(ext)s'), '--write-info-json', url];
}
async function downloadVideo(ctx, url, orig) {
  await fs.mkdir(orig, {recursive: true});
  // YouTube の署名の解き方(EJS)を yt-dlp が取りに行く指定。古い yt-dlp にはこの指定が無いので、--help に出るときだけ付ける
  const help = await ctx.run('yt-dlp', ['--help'], {capture: true, timeoutMs: 60000}).catch(e => { if (e.stopped) throw e; return ''; });
  const ejs = /--remote-components/.test(help);
  let last = null;
  for (const client of ['default', 'web_embedded', 'mweb']) {
    try { await ctx.run('yt-dlp', ytdlpArgs({url, orig, client, ejs}), {timeoutMs: FETCH_MS}); return; } catch (e) {
      if (e.stopped) throw e;
      last = e; ctx.log(`!! yt-dlp の client=${client} で取れなかった。次を試す\n`);
    }
  }
  throw new Error('どの方法でも動画を取れなかった。動画のファイルを手元から渡す(' + (last?.message ?? '') + ')');
}

// URL の動画を input/orig/ に落とす。戻り値は {file, title}
async function fetchVideo(ctx, {pipelineDir, fake, dir}) {
  const orig = path.join(dir, 'orig');
  if (fake) {
    await fs.mkdir(orig, {recursive: true});
    await ctx.run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '2', '-pix_fmt', 'yuv420p', path.join(orig, 'source_fake.mp4')], {timeoutMs: FETCH_MS});
    await writeJson(path.join(orig, 'source_fake.info.json'), {title: '試しの動画', uploader: '試し'});
  } else {
    await downloadVideo(ctx, ctx.job.input.url, orig);
  }
  const names = await fs.readdir(orig), video = names.find(n => /^source_.*\.(mp4|webm|mkv)$/i.test(n));
  if (!video) throw new Error('取った動画が見つからない');
  const info = names.find(n => n.endsWith('.info.json'));
  const j = info ? await readJsonOr(path.join(orig, info)) : null;
  return {file: path.join(orig, video), title: j ? [j.title, j.uploader ?? j.channel].filter(Boolean).join(' | ') : ''};
}

// batch_convert.py の引数。depthOpt の既定は on、grip は両手で持つ物の手首の間隔(cm)で 0 なら付けない
export function convertArgs({inDir, outDir, model, depthOpt = true, grip = 0}) {
  return ['-X', 'utf8', 'batch_convert.py', '--input', inDir, '--output', outDir, '--vrm', model, '--depth-opt', depthOpt ? 'on' : 'off', ...(grip ? ['--grip', String(grip)] : [])];
}

async function convert(ctx, {pipelineDir, rgbmocapDir, blender, fake, model, inDir, outDir, depthOpt, grip, engine, handBodyFix = false, limit}) {
  const item = path.join(outDir, 'clip'), vrma = path.join(item, 'clip.vrma');
  if (fake === 'fail') throw new Error('試しの動き: vrma-pipeline が失敗した');
  if (fake === 'hang') await ctx.run('node', ['-e', 'setTimeout(() => {}, 60000)'], limit);
  if (fake) {
    await fs.mkdir(item, {recursive: true});
    const info = path.join(item, 'info.json');
    await ctx.run('python', [path.join(root, 'tools', 'motionbricks_gen.py'), '--out', vrma, '--info', info, '--contacts', path.join(item, 'contacts.json'), '--kind', 'forward', '--speed', '2.3', '--direction', 'forward',
      '--turn', '0', '--seconds', '1', '--action', 'none', '--ending', 'stop', '--root', 'keep', '--fake'], limit);
    await writeJson(path.join(item, 'quality_report.json'), {overall: 'PASS'});
    return {vrma, item};
  }
  if (engine === 'exmr') {
    await ctx.run('python', [path.join(root, 'tools', 'rgbmocap', 'exmr_vrma.py'), '--video', path.join(inDir, 'clip.mp4'), '--model', model, '--out-dir', item,
      '--work', path.join(ctx.workDir, 'exmr'), '--rgbmocap', rgbmocapDir, ...(blender ? ['--blender', blender] : []), ...(handBodyFix ? ['--hand-body-fix'] : [])], {env: {PYTHONUTF8: '1', VRMA_PIPELINE_DIR: pipelineDir}, ...limit});
    return {vrma, item};
  }
  try {
    await ctx.run('vrma-python', convertArgs({inDir, outDir, model, depthOpt, grip}), {cwd: pipelineDir, env: {VRMA_BLENDER: blender}, ...limit});
  } catch (e) {
    const rec = (await readJsonOr(path.join(outDir, 'manifest.json')))?.items?.['clip.mp4'];
    throw rec?.error ? new Error(`VRMA を作れなかった(${rec.stage_failed}): ${rec.error}`) : e;
  }
  return {vrma, item};
}

// 比較の動画の字幕に使う書体。環境変数 CHARASTA_FONT、Windows は arial、macOS は Arial、無ければ同梱の Noto Sans JP
function labelFont(env) {
  for (const f of [env.CHARASTA_FONT, env.VRMA_FONT, ...(isWin ? ['C:/Windows/Fonts/arial.ttf'] : isMac ? ['/System/Library/Fonts/Supplemental/Arial.ttf'] : [])]) if (f && fsSync.existsSync(f)) return f;
  return path.join(root, 'public', 'fonts', 'NotoSansJP-VF.ttf');
}
// 元の動画と描いた動画を左右に並べる filter(vrma-pipeline の side_by_side.ps1 と同じ)。fps は ffprobe の厳密な分数。描いたコマの番号 = 元のコマの番号 + 1 を字幕に出す
export function sideBySideFilter({fps, label, font}) {
  const ff = `fontfile='${font.replaceAll('\\', '/').replaceAll(':', '\\:')}':`, lab = `${ff}fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6:x=6:y=6`;
  return `[0:v]fps=${fps},scale=-2:480,setsar=1,setpts=N/(${fps})/TB,drawtext=${lab}:text='src f%{eif\\:n+1\\:d}'[v0];`
    + `[1:v]fps=${fps},scale=480:480:flags=lanczos,setsar=1,setpts=N/(${fps})/TB,drawtext=${lab}:text='${label} body f%{eif\\:n+1\\:d}'[v1];[v0][v1]hstack=inputs=2,format=yuv420p`;
}
async function sideBySide(ctx, {src, render, out, label, limit, env}) {
  const fps = (await ctx.run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', src], {capture: true, timeoutMs: CUT_MS})).trim().split(/\r?\n/)[0].replace(/,$/, '');
  if (!fps) throw new Error('ffprobe が読めない: ' + src);
  const fc = sideBySideFilter({fps, label, font: labelFont(env)});
  await runH264(ctx, encoder => ['-loglevel', 'error', '-y', '-i', src, '-i', render, '-filter_complex', fc, '-r', fps, ...h264Args(encoder, 20), out], {out, ...limit}, env);
}

// 比較の動画: VRMA をそのキャラに当てて Blender で全コマ描き、切り出した動画と左右に並べる。描いたコマは残さない
async function compareVideo(ctx, {pipelineDir, blender, fake, model, vrma, clip, out, frames, limit, env}) {
  if (fake) {
    await ctx.run('ffmpeg', ['-y', '-v', 'error', '-i', clip, '-vf', 'scale=320:240', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], limit);
    return;
  }
  const dir = path.join(ctx.workDir, 'render');
  try {
    await ctx.run('blender', ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', path.join(pipelineDir, 'src/vrma_pipeline/blender/render_check.py'), '--',
      '--vrm', model, '--vrma', vrma, '--out-dir', dir, '--max-renders', String(frames + 20), ...RENDER], limit);
    await sideBySide(ctx, {src: clip, render: path.join(dir, 'motion.mp4'), out, label: 'vrm', limit, env});   // CHARASTA_ENCODER=cpu は runH264 が読む
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
}

// 利用条件の記録を作る。公開できるかは動画ごとに人が決めることなので、メモの文にかかわらず個人利用として記録する(charasta_license.py)
async function licenseRecord(ctx, {pipelineDir, fake, model, clip, item, sidecar, limit}) {
  const out = path.join(ctx.workDir, 'license.json');
  if (fake) await writeJson(out, {holder: `${sidecar.attribution}（権利は各権利者）`, summary: '個人利用のみ。公開・再配布・商用利用は不可（動画の公開も不可）', redistribution: false, terms: [{part: '元動画', license: sidecar.license}]});
  else await ctx.run('vrma-python', ['-X', 'utf8', path.join(pipelineDir, 'tools', 'charasta_license.py'), clip, '--out', out, '--vrm', model, '--item-dir', item], {env: {VRMA_PROJECT: pipelineDir}, ...limit});
  return {...await readJsonOr(out), rightsNote: ctx.job.input.rights};
}

// ジョブ 1 件を動かす。ctx は jobs.mjs の {job, workDir, log, step, run}。取り込みはしない
export async function runVideoMotion(ctx, {lib, pipelineDir, rgbmocapDir, blender, env}) {
  const {job, workDir} = ctx, i = job.input, fake = env.CHARASTA_FAKE_VRMA_PIPELINE, engine = i.engine ?? 'mediapipe', E = ENGINES[engine];
  const model = inside(lib.dir, 'characters', i.charId, 'versions', i.verId, 'model.vrm');
  const inDir = path.join(workDir, 'in'), outDir = path.join(workDir, 'out'), clip = path.join(inDir, 'clip.mp4');
  await fs.mkdir(inDir, {recursive: true});
  const source0 = i.upload ? path.join(workDir, 'source' + path.extname(i.upload)) : null;
  if (i.upload) await fs.rename(inside(lib.dir, UPLOAD_DIR, i.upload), source0);   // 受け取った動画は最初に作業フォルダへ移す(失敗しても uploads/ に残さない)
  if (!fake && !await exists(venvPython(pipelineDir ?? ''))) throw new Error('vrma-pipeline の場所が無い(設定の vrmaPipelineDir): ' + pipelineDir);
  if (!fake && engine === 'exmr' && !await exists(rgbmocapPython(rgbmocapDir ?? ''))) throw new Error('RGB MoCap の場所が無い(設定の rgbmocapDir): ' + rgbmocapDir);

  await ctx.step(i.url ? (fake ? '動画を取る(試しの動き)' : 'URL から動画を取る') : '動画を受け取る');
  let source = source0, title = '';
  if (i.url) ({file: source, title} = await fetchVideo(ctx, {pipelineDir, fake, dir: path.join(workDir, 'fetch')}));

  await ctx.step('切り出す');
  const probe = (stream, file) => ctx.run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', stream, '-of', 'csv=p=0', file], {capture: true, timeoutMs: CUT_MS}).then(s => s.trim().split(/\r?\n/)[0].replace(/,$/, ''));
  const fps = await probe('stream=r_frame_rate', source).catch(() => { throw new Error('動画を読めない: ' + (i.fileName || i.url)); });
  await runH264(ctx, encoder => cutArgs({input: source, out: clip, fps, speed: i.speed, trimStart: i.trimStart, trimEnd: i.trimEnd, crop: i.crop, unmirror: i.unmirror, encoder}), {out: clip, timeoutMs: CUT_MS}, env);
  const frames = Number(await ctx.run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', clip], {capture: true, timeoutMs: CUT_MS}).then(s => s.trim().replace(/,$/, '')));
  const clipFps = await probe('stream=r_frame_rate', clip), [fn, fd] = clipFps.split('/').map(Number), seconds = frames / (fn / (fd || 1));
  if (!(frames >= 2)) throw new Error('切り出した動画にコマが無い(開始と終了の秒を見直す)');
  if (seconds > MAX_CLIP_SEC) throw new Error(`切り出した動画が ${seconds.toFixed(1)} 秒ある。${MAX_CLIP_SEC} 秒以内に切り出す`);
  const timeoutMs = Number(env.CHARASTA_VIDEO_MOTION_TIMEOUT_MS) || videoMotionTimeoutMs(frames, engine, i.handBodyFix === true), deadline = Date.now() + timeoutMs;
  const limit = {get timeoutMs() { return Math.max(1, deadline - Date.now()); }};
  job.timeoutMs = timeoutMs;
  ctx.log(`${seconds.toFixed(2)} 秒、${frames} コマ、${clipFps} fps、上限 ${Math.round(timeoutMs / 1000)} 秒\n`);

  // パイプラインと charasta_license.py が読む権利のメモ(<動画>.license.json)。人の許諾が確かめられていないので commercial は false
  const options = {engine, unmirror: i.unmirror, speed: i.speed, trimStart: i.trimStart, trimEnd: i.trimEnd, crop: i.crop || null,
    ...(engine === 'mediapipe' && {depthOpt: i.depthOpt !== false, grip: i.grip || 0}), ...(i.handBodyFix && {handBodyFix: true})};
  const sidecar = {license: i.rights, commercial: false, share_alike: false, attribution: title || i.rights, ...(i.url && {source_url: i.url}),
    notes: `権利のメモ: ${i.rights}。前処理: ${JSON.stringify(options)}`};
  await writeJson(clip + '.license.json', sidecar);

  await ctx.step(fake ? 'VRMA を作る(試しの動き)' : `VRMA を作る(${E.model} と Blender)`);
  const common = {pipelineDir, blender, fake, model, limit};
  const {vrma, item} = await convert(ctx, {...common, rgbmocapDir, inDir, outDir, depthOpt: i.depthOpt, grip: i.grip, engine, handBodyFix: i.handBodyFix === true});

  await ctx.step(fake ? '比較の動画を作る(試しの動き)' : '比較の動画を作る(Blender の GPU で描く)');
  await compareVideo(ctx, {...common, env, vrma, clip, frames, out: path.join(workDir, 'compare.mp4')});

  await ctx.step('利用条件を記録する');
  const license = await licenseRecord(ctx, {...common, clip, item, sidecar});
  // charasta_license.py は vrma-pipeline の変換とその判定の行を書く。ExMR のときはそれを除き、ExMR の条件を足す
  if (E.terms.length) license.terms = [...(license.terms ?? []).filter(x => !/vrma-pipeline|パイプラインの判定/.test(x.part)), ...E.terms];
  const quality = (await readJsonOr(path.join(item, 'quality_report.json')))?.overall ?? null;
  const ch = await lib.getCharacterJson(i.charId);
  return {review: 'waiting', label: i.label, charId: i.charId, charName: ch.name, verId: i.verId, frames, fps: clipFps, durationSec: Number(seconds.toFixed(3)), quality, license, options,
    compareUrl: `/api/video-motions/${job.id}/compare.mp4`};
}

// 結果のファイル(clip.vrma か contacts.json)。取り込みと、つなぐジョブ(lib/motion-recipe.mjs)が読む
export const clipFile = (workDir, name) => path.join(workDir, 'out', 'clip', name);

// 確認の画面の「取り込む」。job は jobs.mjs が確かめた、確認待ちのジョブ
export async function importVideoMotion(lib, workDir, job, body) {
  const r = job.result, label = text(body.label, 'label', MAX_LABEL) || r.label;
  const id = body.motionId ? checkId(body.motionId, 'モーション ID') : 'video-' + job.id;
  if (await lib.motionExists(id)) throw new LibraryError('exists', `モーション ${id} は既にある(上書きしない)`);
  const contacts = await readJsonOr(clipFile(workDir, 'contacts.json'));
  const E = ENGINES[r.options?.engine ?? 'mediapipe'];
  return lib.importMotion({id, name: label, label, data: await fs.readFile(clipFile(workDir, 'clip.vrma')), sourcePath: job.input.url ?? job.input.fileName ?? '', pack: E.pack, license: r.license,
    fittedTo: {charId: r.charId, charName: r.charName, verId: r.verId}, contacts,
    generated: {tool: E.tool, model: E.model, job: job.id, frames: r.frames, fps: r.fps, quality: r.quality, options: r.options}});
}
