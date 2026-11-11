// ショートの合成: 描いたコマ -> 転換を焼き込んだ base.mp4 と音の mix.wav -> HyperFrames の index.html -> 動画。docs/shorts.md の「合成」。
//   作業は work/<quality>/compose/。base と mix は入力のハッシュが同じなら作り直さないので、文字や演出だけの直しは HyperFrames の書き出しだけで済む
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {root} from './config.mjs';
import {h264Args, runH264} from './encoder.mjs';
import {transitionFrame} from './short-transitions.mjs';

const FPS_GOP = 15;   // プレビューのシークのためにキーフレームを増やす
export const OUT_WIDTH = 1080, OUT_HEIGHT = 1920;
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const SFX_DIR = path.join(root, 'assets', 'sfx');
// 音の素材。file は assets/sfx/ から。pixabay/ の出どころは assets/sfx/CREDITS.md。seconds で切り、db で素材の強さをそろえる
export const SFX = {
  whoosh: {file: 'pixabay/whoosh-short.mp3'}, pop: {file: 'pixabay/pop.mp3'}, impact: {file: 'pixabay/impact-bass-1.mp3', seconds: 0.9, db: -9}, glitch: {file: 'pixabay/glitch-1.mp3', seconds: 0.45, db: -4},
  ding: {file: 'ding.wav'}, sparkle: {file: 'sparkle.wav'}, soft: {file: 'whoosh.wav'},
  // ドラマの環境音と効果音。ElevenLabs の sound-generation で作った(tools/make_drama_sfx.mjs)
  //   db は素材のピークを約 -8 dBFS にそろえる値(SFX_DB を足した結果)。語りに負けない大きさ
  footsteps: {file: 'drama/footsteps.mp3', db: 25}, paper: {file: 'drama/paper.mp3', db: 25}, wind: {file: 'drama/wind.mp3', db: 26}, chime: {file: 'drama/chime.mp3', db: 1}, heartbeat: {file: 'drama/heartbeat.mp3', db: 7}, door: {file: 'drama/door.mp3', db: 21}, crows: {file: 'drama/crows.mp3', db: 26},
  snap: {file: 'drama/snap.mp3', db: 28}, hit: {file: 'drama/hit.mp3', db: 5}, ring: {file: 'drama/ring.mp3', db: 18},
  // 歩く足音(1 歩分の砂利の音。素材のピークは約 -1 dBFS)。語りの下に敷く音なので、ほかと違って -8 ではなくピークを約 -15 dBFS(1 歩の瞬間のラウドネスで語りの約 17 LU 下。-18 では Gemini がスマホで小さいと判定した)にする。0.45 秒で切る(あとは無音)
  gravel: {file: 'drama/gravel.mp3', seconds: 0.45, db: -1},
  // 立ち止まる 1 歩の砂利を擦る音(素材のピークは約 -3 dBFS)。足音より 6 dB 強い約 -9 dBFS にして、止まった瞬間を聞かせる。0.5 秒で切る
  scuff: {file: 'drama/scuff.mp3', seconds: 0.5, db: 7},
  // カラスの 1 声(0.05〜0.5 秒に 1 回鳴く。素材のピークは約 0 dBFS)。ピークを約 -10 dBFS にして、最初のセリフの裏で鳴らす
  caw: {file: 'drama/caw.mp3', seconds: 0.6, db: 3},
};
// 配布版では pixabay/ と drama/ を含めない。pixabay/ の音は fallback の自作の wav に差し替え、drama/ の音は無ければ鳴らさない(ログに残す)
const SFX_FALLBACK = {
  whoosh: {file: 'whoosh.wav'}, pop: {file: 'pop.wav'}, impact: {file: 'impact.wav', db: -3}, glitch: {file: 'glitch.wav', seconds: 0.45},
};
// 効果音の素材を決める。本来の素材があればそれ、無ければ自作の代わり、それも無ければ null。dir は assets/sfx/ の場所(テスト用に差し替えられる)
export function resolveSfx(name, {dir = SFX_DIR, log = null} = {}) {
  const own = SFX[name];
  if (!own) return null;
  if (existsSync(path.join(dir, own.file))) return {...own, file: path.join(dir, own.file)};
  const alt = SFX_FALLBACK[name];
  if (alt && existsSync(path.join(dir, alt.file))) { log?.(`効果音 ${name}: ${own.file} が無いので ${alt.file} で代える\n`); return {...alt, file: path.join(dir, alt.file)}; }
  log?.(`効果音 ${name}: ${own.file} が無いので鳴らさない\n`);
  return null;
}
// フォントは public/fonts/ に同梱(SIL OFL 1.1。ライセンスの文は同じ場所の OFL-*.txt)
const FONT_DIR = path.join(root, 'public', 'fonts');
const FONTS = [['ShortSans', path.join(FONT_DIR, 'NotoSansJP-VF.ttf'), 'NotoSansJP-VF.ttf', '100 900'], ['ShortSerif', path.join(FONT_DIR, 'NotoSerifJP-VF.ttf'), 'NotoSerifJP-VF.ttf', '200 900'], ['ShortRound', path.join(FONT_DIR, 'ZenMaruGothic-Black.ttf'), 'ZenMaruGothic-Black.ttf', '900']];
// 音量(dB)。語りの積分ラウドネスを VOICE_LUFS に、BGM を BGM_LUFS に、効果音は素材のピークから下げ、全体はリミッターで抑える
const VOICE_LUFS = -15, BGM_LUFS = -23, DRAMA_BGM_LUFS = -26, AMBIENCE_LUFS = -33, SFX_DB = -13, PEAK = 0.66;   // 0.66 は約 -3.6 dBFS。AAC にすると少し上がるので -3 dBFS より下げておく
const FADE_SEC = 0.3;

// ---- 転換を焼き込んだ動画 ----
const framePath = (work, cut, n) => path.join(work, cut.id, 'frames', `${String(n).padStart(5, '0')}.png`);
export const baseKey = t => sha1(JSON.stringify(t.cuts.map(c => [c.id, c.direction.transition, c.direction.transitionFrames, c.direction.transitionSeed])));

async function readRaw(ctx, frames, width, height, file) {
  const out = [];
  for (const [i, f] of frames.entries()) {
    const raw = `${file}.${i}.rgb`;
    await ctx.run('ffmpeg', ['-y', '-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, raw]);
    out.push(new Uint8Array(await fs.readFile(raw)));
    await fs.rm(raw);
  }
  return out;
}

// カットの境に作るコマの位置。前のカットの最後の半分と次のカットの最初の半分を置き換える。n は動画全体のコマ番号(1 から)
export function transitionPlan(t) {
  const out = [];
  let first = 1;
  for (const [i, cut] of t.cuts.entries()) {
    const d = cut.direction, n = i ? Math.min(d.transitionFrames, t.cuts[i - 1].count, cut.count) : 0;
    if (n >= 2) {
      const head = Math.floor(n / 2);
      out.push({index: i, kind: d.transition, seed: d.transitionSeed % 1000, count: n, start: first - head, head});
    }
    first += cut.count;
  }
  return out;
}

export async function buildBase(ctx, t, {work, dir, width, height, env, timeoutMs}) {
  const key = baseKey(t), out = path.join(dir, 'base.mp4'), stamp = path.join(dir, 'base.key');
  if (await fs.readFile(stamp, 'utf8').catch(() => null) === key && await fs.stat(out).catch(() => null)) return false;
  const seq = path.join(dir, 'seq'), trans = path.join(dir, 'trans');
  await fs.rm(seq, {recursive: true, force: true}); await fs.rm(trans, {recursive: true, force: true});
  await fs.mkdir(seq, {recursive: true}); await fs.mkdir(trans, {recursive: true});
  const made = new Map(), plan = transitionPlan(t);
  for (const tr of plan) {
    const before = t.cuts[tr.index - 1], after = t.cuts[tr.index], lastBefore = before.count;
    // 置き換える区間の、前のカットのコマと次のカットのコマ。足りない所は端のコマを使う
    const fromFiles = Array.from({length: tr.count}, (_, k) => framePath(work, before, Math.min(lastBefore, lastBefore - tr.head + 1 + k)));
    const toFiles = Array.from({length: tr.count}, (_, k) => framePath(work, after, Math.max(1, k - tr.head + 1)));
    const froms = await readRaw(ctx, fromFiles, width, height, path.join(trans, 'from')), tos = await readRaw(ctx, toFiles, width, height, path.join(trans, 'to'));
    for (let k = 0; k < tr.count; k++) {
      const frame = new Uint8Array(froms[k].length);
      transitionFrame(tr.kind, froms[k], tos[k], frame, {width, height, p: (k + 1) / (tr.count + 1), seed: tr.seed, frame: k});
      const raw = path.join(trans, `${tr.index}_${k}.rgb`), png = path.join(trans, `${tr.index}_${k}.png`);
      await fs.writeFile(raw, frame);
      await ctx.run('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', raw, png]);
      await fs.rm(raw);
      made.set(tr.start + k, png);
    }
  }
  let n = 0;
  for (const cut of t.cuts) for (let f = 1; f <= cut.count; f++) {
    n++;
    await fs.link(made.get(n) ?? framePath(work, cut, f), path.join(seq, `${String(n).padStart(5, '0')}.png`));
  }
  const vf = `scale=${OUT_WIDTH}:${OUT_HEIGHT}:flags=lanczos,scale=out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int+bicubic,format=yuv420p`;
  await runH264(ctx, encoder => ['-y', '-v', 'error', '-framerate', String(t.fps), '-start_number', '1', '-i', path.join(seq, '%05d.png'), '-vf', vf, ...h264Args(encoder, 16), '-g', String(FPS_GOP), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-an', out], {out, timeoutMs}, env);
  await fs.rm(seq, {recursive: true, force: true}); await fs.rm(trans, {recursive: true, force: true});
  await fs.writeFile(stamp, key);
  return true;
}

// ---- 音 ----
// 型の既定の BGM(tools/make_bgm.py が合成した音)
export const defaultBgm = name => ({file: path.join(root, 'assets', 'bgm', `${name}.m4a`), loop: true});
export const ambienceFile = (name, opts) => { const r = resolveSfx(name, opts); return r && {file: r.file, loop: true}; };

// 語り、BGM(語りの間だけ下げる)、環境音、効果音を混ぜる ffmpeg の引数。語りの voices[].db は話す人ごとの補正
export function mixArgs({seconds, voices, sfx, bgm, ambience, hush = [], out}) {
  const inputs = [], parts = [], delayed = (label, i, at, extra = '') => { const ms = Math.round(at * 1000); parts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo${extra},adelay=${ms}|${ms}[${label}]`); return `[${label}]`; };
  const add = file => { inputs.push('-i', file); return inputs.filter(x => x === '-i').length - 1; };
  const voiceLabels = voices.map((v, i) => delayed(`v${i}`, add(v.file), v.start, v.db ? `,volume=${v.db.toFixed(2)}dB` : ''));
  const sfxLabels = sfx.map((s, i) => delayed(`s${i}`, add(s.file), s.t, `${s.seconds ? `,atrim=0:${s.seconds},afade=t=out:st=${Math.max(0, s.seconds - 0.08)}:d=0.08` : ''},volume=${(SFX_DB + (s.db ?? 0) + 20 * Math.log10(s.gain)).toFixed(2)}dB`));
  const mix = (labels, name) => { parts.push(labels.length > 1 ? `${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[${name}]` : `${labels[0]}anull[${name}]`); return `[${name}]`; };
  const final = [];
  const voice = voiceLabels.length ? mix(voiceLabels, 'voice') : null;
  const hushFilter = hush.length ? `,volume='if(${hush.map(([a, b]) => `between(t\\,${a}\\,${b})`).join('+')}\\,0\\,1)':eval=frame` : '';   // BGM と環境音を止めて、音の落差を作る
  if (ambience) {
    inputs.push('-stream_loop', '-1', '-i', ambience.file);
    parts.push(`[${inputs.filter(x => x === '-i').length - 1}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${seconds},afade=t=in:d=1,afade=t=out:st=${Math.max(0, seconds - 1).toFixed(3)}:d=1,volume=${ambience.gainDb.toFixed(2)}dB${hushFilter}[amb]`);
    final.push('[amb]');
  }
  if (bgm) {
    if (bgm.loop) inputs.push('-stream_loop', '-1');
    const i = inputs.filter(x => x === '-i').length; inputs.push(...(bgm.start ? ['-ss', String(bgm.start)] : []), '-i', bgm.file);   // start: 曲の途中から使う(ダンス MV の audioStart)
    parts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${seconds},afade=t=out:st=${Math.max(0, seconds - FADE_SEC).toFixed(3)}:d=${FADE_SEC},volume=${bgm.gainDb.toFixed(2)}dB${hushFilter}[bgm0]`);
    if (voice && bgm.duck !== false) {   // duck: false は語りの下に潜らせない(ダンス MV)
      parts.push(`${voice}asplit=2[voiceMix][voiceTail]`, `[voiceTail]apad=whole_dur=${seconds}[voiceKey]`);   // 語りが先に終わっても BGM を最後まで鳴らす
      parts.push('[bgm0][voiceKey]sidechaincompress=threshold=0.06:ratio=3:attack=30:release=300:makeup=1[bgm]');
      final.push('[voiceMix]', '[bgm]');
    } else final.push(...(voice ? [voice] : []), '[bgm0]');
  } else if (voice) final.push(voice);
  if (sfxLabels.length) final.push(mix(sfxLabels, 'sfx'));
  if (!final.length) { inputs.push('-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=48000:cl=stereo'); final.push(`[${inputs.filter(x => x === '-i').length - 1}:a]`); }
  parts.push(`${final.join('')}amix=inputs=${final.length}:duration=longest:normalize=0,alimiter=limit=${PEAK}:level=false:attack=4:release=60,apad=whole_dur=${seconds},atrim=0:${seconds}[a]`);
  return ['-y', '-v', 'error', ...inputs, '-filter_complex', parts.join(';'), '-map', '[a]', '-ar', '48000', '-c:a', 'pcm_s16le', out];
}

// 積分ラウドネス(LUFS)を測る。無音や測れないときは null
async function measureLufs(ctx, file, scratch, {start = 0, seconds = 0} = {}) {
  await ctx.run('ffmpeg', ['-y', '-v', 'error', ...(start ? ['-ss', String(start)] : []), ...(seconds ? ['-t', String(seconds)] : []), '-i', file, '-af', `ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.I:file='${scratch.replaceAll('\\', '/').replace(':', '\\:')}'`, '-f', 'null', '-']);
  const found = [...(await fs.readFile(scratch, 'utf8')).matchAll(/lavfi\.r128\.I=(-?[\d.]+)/g)].at(-1);
  await fs.rm(scratch, {force: true});
  const v = found ? Number(found[1]) : null;
  return v === null || v < -60 ? null : v;
}

export async function buildMix(ctx, t, {dir, voices, bgm, ambience}) {
  const seconds = t.seconds, missing = new Set();
  const sfx = t.sfx.flatMap(q => { const r = resolveSfx(q.name, {log: m => { if (!missing.has(q.name)) { missing.add(q.name); ctx.log?.(m); } }}); return r ? [{...q, ...r}] : []; });
  const key = sha1(JSON.stringify([seconds, voices, sfx, bgm?.file, ambience?.file, t.hush, VOICE_LUFS, BGM_LUFS, DRAMA_BGM_LUFS, AMBIENCE_LUFS, SFX_DB, ...(bgm?.lufs ? [bgm.start ?? 0, bgm.lufs] : [])])), out = path.join(dir, 'mix.wav'), stamp = path.join(dir, 'mix.key');
  if (await fs.readFile(stamp, 'utf8').catch(() => null) === key && await fs.stat(out).catch(() => null)) return false;
  await fs.rm(stamp, {force: true});   // 作りかけの mix.wav を次の書き出しが完成品と見ないように
  const scratch = path.join(dir, 'r128.txt');
  const leveled = async (track, lufs) => { const v = track ? await measureLufs(ctx, track.file, scratch, track.start || track.lufs ? {start: track.start ?? 0, seconds} : {}) : null; return track && {...track, gainDb: v === null ? -20 : lufs - v}; };
  const song = await leveled(bgm, bgm?.lufs ?? (t.style === 'drama' ? DRAMA_BGM_LUFS : BGM_LUFS)), room = await leveled(ambience, AMBIENCE_LUFS);
  // 声の違いで音量がばらつかないよう、話す人ごとにそろえる
  const gains = new Map();
  for (const who of new Set(voices.map(v => v.who))) {
    await ctx.run('ffmpeg', mixArgs({seconds, voices: voices.filter(v => v.who === who), sfx: [], bgm: null, out}));
    const lufs = await measureLufs(ctx, out, scratch);
    gains.set(who, lufs === null ? 0 : VOICE_LUFS - lufs);
  }
  await ctx.run('ffmpeg', mixArgs({seconds, voices: voices.map(v => ({...v, db: gains.get(v.who)})), sfx, bgm: song, ambience: room, hush: t.hush, out}));
  await fs.writeFile(stamp, key);
  return true;
}

// ---- HyperFrames のプロジェクト ----
export function compositionHtml(t, {runtime = '', vendorRuntime = ''} = {}) {
  const data = JSON.stringify(t).replaceAll('<', '\\u003c');
  const faces = FONTS.map(([family, , file, weight]) => `@font-face{font-family:'${family}';src:url('fonts/${file}');font-weight:${weight};font-display:block}`).join('\n');
  const grade = t.grade === false ? '' : t.style === 'drama' ? 'filter:contrast(1.06) saturate(1.02);' : 'filter:contrast(1.04) saturate(1.1);';
  const vignette = t.grade === false ? 'none' : t.style === 'drama' ? 'radial-gradient(ellipse at 50% 42%,rgba(0,0,0,0) 46%,rgba(4,10,18,.42) 100%)' : 'radial-gradient(ellipse at 50% 46%,rgba(0,0,0,0) 62%,rgba(10,6,20,.34) 100%)';
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=${OUT_WIDTH}, height=${OUT_HEIGHT}"><title>${t.title.replace(/[<&]/g, '')}</title>
<style>
${faces}
html,body{margin:0;background:#000}
#root{position:relative;width:${OUT_WIDTH}px;height:${OUT_HEIGHT}px;overflow:hidden;background:#000}
#cam{position:absolute;inset:0;will-change:transform}
#base{position:absolute;inset:0;width:${OUT_WIDTH}px;height:${OUT_HEIGHT}px;object-fit:cover;${grade}}
#vignette{position:absolute;inset:0;background:${vignette}}
#fx{position:absolute;inset:0;width:${OUT_WIDTH}px;height:${OUT_HEIGHT}px;overflow:hidden}
</style>${vendorRuntime ? `\n<script src="${vendorRuntime}"></script>` : ''}</head><body>
<div id="root" data-composition-id="main" data-start="0" data-width="${OUT_WIDTH}" data-height="${OUT_HEIGHT}" data-duration="${t.seconds}" data-no-timeline>
<div id="cam"><video id="base" src="base.mp4" muted playsinline data-start="0" data-duration="${t.seconds}" data-track-index="0"></video></div>
<div id="vignette"></div>
<svg id="fx" viewBox="0 0 ${OUT_WIDTH} ${OUT_HEIGHT}" xmlns="http://www.w3.org/2000/svg"></svg>
<audio id="mix" src="mix.wav" data-start="0" data-duration="${t.seconds}" data-track-index="1" data-volume="1"></audio>
</div>
<script>window.SHORT=${data};
${runtime}
</script>
</body></html>
`;
}

export const fxScript = () => fs.readFile(path.join(root, 'public', 'short-fx.js'), 'utf8');

// プロジェクトのフォルダへ index.html と字の素材を置く
export async function writeProject(t, dir) {
  await fs.mkdir(path.join(dir, 'fonts'), {recursive: true});
  for (const [, from, file] of FONTS) { const to = path.join(dir, 'fonts', file); if (!await fs.stat(to).catch(() => null)) await fs.copyFile(from, to); }
  await fs.writeFile(path.join(dir, 'index.html'), compositionHtml(t, {runtime: await fxScript()}));
}

// 差し込みの絵と図を合成のフォルダへ置き、timeline に相対パスを書く
export async function prepareInserts(ctx, t, {work, dir, figures}) {
  for (const cut of t.cuts) {
    if (cut.figure) { await fs.mkdir(path.join(dir, 'figures'), {recursive: true}); await fs.copyFile(path.join(figures, path.basename(cut.figure)), path.join(dir, cut.figure)); }
    if (!cut.insertFrom) continue;
    const name = `insert-${cut.insertFrom}.jpg`, file = path.join(dir, name);
    if (!await fs.stat(file).catch(() => null)) await ctx.run('ffmpeg', ['-y', '-v', 'error', '-i', framePath(work, {id: cut.insertFrom}, 10), '-q:v', '3', file]);
    cut.insert = name;
  }
}

// HyperFrames の CLI の環境。テレメトリーと更新の確認を切り、API キーを渡さない(snapshot は GEMINI_API_KEY があるとコマを外へ送る)。
//   Chrome は設定の実体を渡し、自動でダウンロードさせない。一時ファイルは合成のフォルダの下に置き、ジョブの最後に消す
export const hyperframesEnv = (dir, browser) => {
  const temp = path.join(dir, 'tmp');
  return {HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENROUTER_API_KEY: '', HYPERFRAMES_BROWSER_PATH: browser, TEMP: temp, TMP: temp};
};

// 書き出しの前に道具を確かめる。Cycles を動かしてから失敗しないように、ジョブの先頭で呼ぶ
export async function checkHyperframes({cli, browser}) {
  if (!await fs.stat(cli).catch(() => null)) throw new Error(`HyperFrames の CLI が無い: ${cli}。config の hyperframesCli を確認する`);
  if (!await fs.stat(browser).catch(() => null)) throw new Error(`HyperFrames の Chrome が無い: ${browser}。config の hyperframesBrowser を確認する`);
}

// check は問題があると終了コード 1 で終わるが、報告は標準出力に出る。lint と runtime の誤りで止める。
//   layout は重ねた縁取りの層も文字の重なりと数え、contrast は縁のある文字を見ないので、ログに残すだけ
export function checkReport(text) {
  let report;
  try { report = JSON.parse(text); } catch { throw new Error('合成の検査の結果が読めない'); }
  const bad = [...(report.lint?.findings ?? []), ...(report.runtime?.findings ?? [])].find(f => f.severity === 'error');
  if (report.lint?.errorCount || report.runtime?.errorCount) throw new Error(`合成の検査で誤りが出た: ${JSON.stringify(bad ?? {}).slice(0, 300)}`);
  return `合成の検査: lint 警告 ${report.lint?.warningCount ?? 0}、layout ${report.layout?.errorCount ?? 0} 件、contrast ${report.contrast?.warningCount ?? 0} 件（どちらも記録だけ）\n`;
}

export async function renderProject(ctx, {cli, browser, dir, quality, out, timeoutMs}) {
  const env = hyperframesEnv(dir, browser);
  await fs.mkdir(env.TEMP, {recursive: true});
  try {
    const text = await ctx.run('node', [cli, 'check', '--json'], {capture: true, cwd: dir, env, timeoutMs}).catch(e => { if (e.stopped || e.stdout === undefined) throw e; return e.stdout; });
    ctx.log(checkReport(text));
    // 描画のスクリプトの例外は出力に出るだけで render は成功するので、ここで拾う
    let output = '';
    await ctx.run('node', [cli, 'render', '--quality', quality === 'final' ? 'high' : 'standard', '--gpu', '--output', out], {cwd: dir, env, timeoutMs, onOutput: s => { output = (output + s).slice(-20000); }});
    const failed = /\[Browser:PAGEERROR\][^\n]*/.exec(output);
    if (failed) throw new Error(`文字と演出の描画で例外が出た: ${failed[0].slice(0, 300)}`);
  } finally {
    await fs.rm(env.TEMP, {recursive: true, force: true});
  }
}

// ブラウザを使わない試しの経路(CHARASTA_FAKE_CAPTURE): base.mp4 に音だけ付ける
export async function fakeRender(ctx, {dir, out}) {
  await ctx.run('ffmpeg', ['-y', '-v', 'error', '-i', path.join(dir, 'base.mp4'), '-i', path.join(dir, 'mix.wav'), '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', out]);
}
