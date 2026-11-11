// グラフィック MV(ダンス MV のショートの演出 music.look === 'graphic')。docs/shorts-graphic-mv.md の「グラフィック」。
//   描画と重ね合わせは stage-studio の tools/make_graphic_mv.py が受け持つ。きゃらすたは文字、色、表情、確認、ジョブを受け持つ
//   short.music.graphic: {text: {title, titleEn, credit, words}, palette: {preset, bg[3], ink, accent, light}, cues: [{from, to, expr, ease?}], skirt: [硬さ, 抵抗], skirtDamp}
//   カット: {scene, wipe, word?, seconds}。stage と camera は持たない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {root} from './config.mjs';
import {LibraryError} from './library.mjs';
import {MAX_SECONDS} from '../public/shoot-plan.mjs';
import {GRAPHIC_PALETTES, GRAPHIC_WORDS, MV_FPS, graphicWords} from '../public/mv-plan.mjs';
import {readGlbJson} from './glb.mjs';

const exec = promisify(execFile);
export const GRAPHIC_LIMITS = {title: 24, titleEn: 24, credit: 60, word: 16, words: 16, cues: 40, exprs: 8};
export const GRAPHIC_PRESETS = ['pop', 'chara', 'mono', 'custom'];
export const GRAPHIC_WIPES = ['iris', 'diag', 'bars', 'slab', 'columns', 'none'];
export const GRAPHIC_SKIRT = [3, 0.4], GRAPHIC_SKIRT_DAMP = 0.6;   // memory の値(スカートの揺れ骨を硬く、回転を 0.6 倍)
const HEX = /^#[0-9A-Fa-f]{6}$/, EXPR_NAME = /^[\w.-]{1,64}$/;
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const round6 = n => Math.round(n * 1e6) / 1e6;
const bad = msg => new LibraryError('bad-input', msg);

// stage-studio にグラフィック MV の道具があるか(古い stage-studio では「グラフィック」を出さない)
export async function supportsGraphic(stageDir) {
  return !!stageDir && !!await fs.stat(path.join(stageDir, 'tools', 'make_graphic_mv.py')).catch(() => null);
}

// 場面の一覧(tools/graphic_mv/catalog.json)。無ければ空
export async function graphicCatalog(stageDir) {
  if (!stageDir) return [];
  return JSON.parse(await fs.readFile(path.join(stageDir, 'tools', 'graphic_mv', 'catalog.json'), 'utf8').catch(() => '[]'));
}

// ---- 値の検査 ----
const str = (v, what, max, {ascii = false, empty = true} = {}) => {
  if (typeof v !== 'string') throw bad(`${what} は文字列`);
  const s = v.trim();
  if ([...s].length > max) throw bad(`${what} は ${max} 文字まで`);
  if (!empty && !s) throw bad(`${what} が空`);
  if (ascii && !/^[\x20-\x7e]*$/.test(s)) throw bad(`${what} は英数字と記号だけ`);
  return s;
};
const num = (v, what, lo, hi) => {
  const n = Number(v);
  if (v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(n) || n < lo || n > hi) throw bad(`${what} は ${lo} から ${hi}: ${JSON.stringify(v)}`);
  return n;
};
export const color = (v, what) => { if (typeof v !== 'string' || !HEX.test(v)) throw bad(`${what} は #RRGGBB: ${JSON.stringify(v)}`); return v.toUpperCase(); };

// music.graphic の形と範囲を確かめる(表情の名前と動画の長さは checkGraphicFit)。答えは保存の形
export function graphicBody(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('music.graphic が連想配列ではない');
  const t = raw.text ?? {}, p = raw.palette ?? {};
  if (typeof t !== 'object' || typeof p !== 'object') throw bad('music.graphic の text と palette は連想配列');
  const words = t.words ?? GRAPHIC_WORDS;
  if (!Array.isArray(words) || !words.length || words.length > GRAPHIC_LIMITS.words) throw bad(`text.words は 1 から ${GRAPHIC_LIMITS.words} 個の配列`);
  const text = {title: str(t.title ?? '', 'タイトル', GRAPHIC_LIMITS.title), titleEn: str(t.titleEn ?? 'DANCE', '英字の名前', GRAPHIC_LIMITS.titleEn, {ascii: true, empty: false}),
    credit: str(t.credit ?? '', 'クレジット', GRAPHIC_LIMITS.credit), words: words.map((w, i) => str(w, `言葉 ${i + 1}`, GRAPHIC_LIMITS.word, {empty: false}))};
  const preset = p.preset ?? 'pop';
  if (!GRAPHIC_PRESETS.includes(preset)) throw bad(`palette.preset は ${GRAPHIC_PRESETS.join(' / ')}: ${JSON.stringify(preset)}`);
  const base = GRAPHIC_PALETTES[preset] ?? {};
  const bg = p.bg ?? base.bg;
  if (!Array.isArray(bg) || bg.length !== 3) throw bad('palette.bg は 3 色の配列');
  const palette = {preset, bg: bg.map((c, i) => color(c, `背景の色 ${i + 1}`)), ink: color(p.ink ?? base.ink, '文字の色'), accent: color(p.accent ?? base.accent, '差し色'), light: color(p.light ?? base.light, '明るい地の色')};
  const cues = raw.cues ?? [];
  if (!Array.isArray(cues) || cues.length > GRAPHIC_LIMITS.cues) throw bad(`cues は ${GRAPHIC_LIMITS.cues} 個までの配列`);
  const outCues = cues.map((c, i) => {
    const at = `表情 ${i + 1}`;
    if (!c || typeof c !== 'object' || !c.expr || typeof c.expr !== 'object' || Array.isArray(c.expr)) throw bad(`${at} は {from, to, expr: {名前: 重み}}`);
    const from = num(c.from, `${at} の from`, 0, MAX_SECONDS), to = num(c.to, `${at} の to`, 0, MAX_SECONDS);
    if (!(from < to)) throw bad(`${at} は from < to: ${from}〜${to}`);
    const names = Object.keys(c.expr);
    if (!names.length || names.length > GRAPHIC_LIMITS.exprs) throw bad(`${at} の expr は 1 から ${GRAPHIC_LIMITS.exprs} 個`);
    const expr = Object.fromEntries(names.map(n => { if (!EXPR_NAME.test(n)) throw bad(`${at} の表情の名前が正しくない: ${JSON.stringify(n)}`); return [n, num(c.expr[n], `${at} の ${n} の重み`, 0, 1)]; }));
    return {from: round6(from), to: round6(to), expr, ...(c.ease != null ? {ease: num(c.ease, `${at} の ease`, 0.01, 2)} : {}), ...(typeof c.note === 'string' && c.note.trim() ? {note: str(c.note, `${at} の note`, 100)} : {})};
  });
  const skirt = raw.skirt ?? GRAPHIC_SKIRT;
  if (!Array.isArray(skirt) || skirt.length !== 2) throw bad('skirt は [硬さ, 抵抗]');
  return {text, palette, cues: outCues, skirt: [num(skirt[0], 'スカートの硬さ', 0, 10), num(skirt[1], 'スカートの抵抗', 0, 1)], skirtDamp: num(raw.skirtDamp ?? GRAPHIC_SKIRT_DAMP, 'skirtDamp', 0, 1)};
}

// 表情の名前がその VRM にあるか、時刻が動画の長さの中かを確かめる。expressions が null(VRM を読めない)なら名前は見ない
export function checkGraphicFit(graphic, {seconds, expressions}) {
  graphic.cues.forEach((c, i) => {
    if (seconds != null && c.from >= seconds) throw bad(`表情 ${i + 1} の from ${c.from} 秒が動画の長さ ${seconds} 秒より後`);
    if (expressions) for (const n of Object.keys(c.expr)) if (!expressions.includes(n)) throw bad(`表情 ${i + 1} の ${JSON.stringify(n)} はこの VRM に無い(${expressions.slice(0, 40).join(', ')})`);
  });
}

// グラフィックのカット。scene は catalog の ID、wipe は入りのワイプ、word は言葉の枠(複数は / で区切る)
export function graphicCutBody(c, ids) {
  if (!ids.includes(c.scene)) throw bad(`知らない場面: ${JSON.stringify(c.scene)}`);
  const out = {scene: c.scene, seconds: num(c.seconds, 'seconds', 0.2, 60)};
  if (c.wipe != null && c.wipe !== '') { if (!GRAPHIC_WIPES.includes(c.wipe)) throw bad(`wipe は ${GRAPHIC_WIPES.join(' / ')}: ${JSON.stringify(c.wipe)}`); out.wipe = c.wipe; }
  if (c.word != null && String(c.word).trim()) {   // 言葉の枠が複数のときは / で区切る。1 語ずつ GRAPHIC_LIMITS.word 文字まで
    const parts = String(c.word).split('/');
    parts.forEach((w, i) => str(w, `場面の言葉 ${i + 1} 語目`, GRAPHIC_LIMITS.word));
    out.word = str(c.word, '場面の言葉', GRAPHIC_LIMITS.word * parts.length + parts.length - 1);
  }
  return out;
}

// ---- VRM の表情の名前(glTF の JSON から preset と custom を読む) ----
const VRM0_PRESET = {joy: 'happy', angry: 'angry', sorrow: 'sad', fun: 'relaxed', surprised: 'surprised', a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh', blink: 'blink', blink_l: 'blinkLeft', blink_r: 'blinkRight', neutral: 'neutral', lookup: 'lookUp', lookdown: 'lookDown', lookleft: 'lookLeft', lookright: 'lookRight'};
export async function vrmExpressions(file) {
  try {
    const ext = (await readGlbJson(file)).extensions ?? {};
    if (ext.VRMC_vrm) { const e = ext.VRMC_vrm.expressions ?? {}; return [...Object.keys(e.preset ?? {}), ...Object.keys(e.custom ?? {})]; }
    if (ext.VRM) return (ext.VRM.blendShapeMaster?.blendShapeGroups ?? []).map(g => (g.presetName && g.presetName !== 'unknown' ? VRM0_PRESET[g.presetName] ?? g.presetName : g.name)).filter(Boolean);
    return null;
  } catch { return null; }
}

// ---- 既定値 ----
// 英字の名前: キャラ ID を大文字に(英字が無ければ DANCE)。クレジット: モーションの表示名の「(」より前を大文字にし、DANCE を前に付ける
export function defaultText({character, motion}) {
  const en = String(character?.id ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().slice(0, GRAPHIC_LIMITS.titleEn).trim();
  const label = String(motion?.label || motion?.name || motion?.id || '').split(/[(（]/)[0].trim().toUpperCase();
  return {title: [...String(character?.name ?? character?.id ?? '')].slice(0, GRAPHIC_LIMITS.title).join(''), titleEn: /[A-Z]/.test(en) ? en : 'DANCE',
    credit: [...(label ? `DANCE  ${label}` : 'DANCE')].slice(0, GRAPHIC_LIMITS.credit).join(''), words: [...GRAPHIC_WORDS]};
}

// 表情の既定: 顔の寄りの場面は全体に happy 0.6 と 3 拍目の片目のウインク(0.5 拍)、END は blink_smile か happy 0.8。VRM に無い名前は使わない
//   plan: [{scene, start, end}](秒)
export function defaultCues(plan, expressions) {
  const has = n => !expressions || expressions.includes(n), out = [];
  for (const e of plan) {
    const len = e.end - e.start;
    if (e.scene === 'face') {
      if (has('happy')) out.push({from: round6(e.start), to: round6(e.end), expr: {happy: 0.6}});
      const wink = ['blink_smile_L', 'blink_L', 'blinkLeft'].find(has);
      if (wink) out.push({from: round6(e.start + len / 2), to: round6(e.start + len / 2 + len / 8), expr: {[wink]: 1}, ease: 0.12});
    }
    if (e.scene === 'end') {
      const smile = ['blink_smile', 'happy'].find(has);
      if (smile) out.push({from: round6(e.start), to: round6(e.end), expr: {[smile]: 0.8}});
    }
  }
  return out;
}

// ---- 色(chara: バージョンのサムネイルから彩度の高い色を 2 つ取る) ----
const hsl2hex = (h, s, l) => {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
};
const lum = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// 画素(RGB の並び)から色相を 2 つ選び、背景の 3 色と差し色を作る
export function paletteFromPixels(rgb) {
  const hues = [];
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const [r, g, b] = [rgb[i] / 255, rgb[i + 1] / 255, rgb[i + 2] / 255], mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (mx < 0.2 || d / mx < 0.35) continue;   // 暗い色と、白や灰色に近い色は数えない
    const h = d === 0 ? 0 : mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    hues.push([(h + 360) % 360, d / mx * mx]);
  }
  const bins = Array(12).fill(0);
  for (const [h, w] of hues) bins[Math.floor(h / 30) % 12] += w;
  const order = bins.map((w, i) => [w, i]).sort((a, b) => b[0] - a[0]);
  const h1 = order[0][0] > 0 ? order[0][1] * 30 + 15 : 330;
  const second = order.find(([w, i]) => w > 0 && Math.min(Math.abs(i * 30 + 15 - h1), 360 - Math.abs(i * 30 + 15 - h1)) >= 60);
  const h2 = second ? second[1] * 30 + 15 : (h1 + 150) % 360;
  const bg = [hsl2hex((h1 + 30) % 360, 0.95, 0.62), hsl2hex(h2, 0.85, 0.6), hsl2hex((h1 + 180) % 360, 0.8, 0.45)];
  const navy = '#141432', white = '#FFFFFF', avg = bg.reduce((s, c) => s + contrast(c, navy), 0) >= bg.reduce((s, c) => s + contrast(c, white), 0);
  return {preset: 'chara', bg, ink: avg ? navy : white, accent: hsl2hex(h1, 0.9, 0.55), light: '#F3F0E8'};
}
export async function charaPalette(thumbFile) {
  if (!thumbFile || !await fs.stat(thumbFile).catch(() => null)) return {preset: 'chara', ...GRAPHIC_PALETTES.pop};
  let stdout;
  try {
    ({stdout} = await exec(process.env.CHARASTA_FFMPEG || 'ffmpeg', ['-v', 'error', '-i', thumbFile, '-vf', 'scale=24:24:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {encoding: 'buffer', timeout: 30000, windowsHide: true, maxBuffer: 1 << 20}));
  } catch (e) {
    throw bad(`サムネイルから色を取れなかった(ffmpeg): ${(e.stderr?.toString() || e.message || String(e)).trim().split('\n').slice(-2).join(' / ')}`);
  }
  return paletteFromPixels(stdout);
}

// 新しく作るときと「既定に戻す」で使う music.graphic。plan はカットの場面と秒(無ければ表情の既定は空)
export async function graphicDefaults({lib, short, preset = 'pop'}) {
  const cast = short.cast?.[0] ?? {charId: short.charId, verId: short.verId}, character = await lib.getCharacterJson(cast.charId);
  const motionId = short.music?.motionId ?? short.cuts?.[0]?.motionId, motion = motionId ? await lib.getMotion(motionId) : null;
  const vdir = path.join(lib.dir, 'characters', cast.charId, 'versions', cast.verId), expressions = await vrmExpressions(path.join(vdir, 'model.vrm'));
  let at = 0;
  const plan = (short.cuts ?? []).filter(c => c.scene).map(c => { const s = at; at = round6(at + c.seconds); return {scene: c.scene, start: s, end: at}; });
  const palette = preset === 'chara' ? await charaPalette(path.join(vdir, 'thumb.png')) : {preset, ...(GRAPHIC_PALETTES[preset] ?? GRAPHIC_PALETTES.pop)};
  return graphicBody({text: defaultText({character, motion}), palette, cues: defaultCues(plan, expressions), skirt: GRAPHIC_SKIRT, skirtDamp: GRAPHIC_SKIRT_DAMP});
}

// 拍から割り直したときの music.graphic。文字、色、スカートは今のものを残し、表情は新しい場面の並びから作り直す。
//   手で足した表情(前の割りの既定と違うもの)は、新しい長さの中にあるものだけ残す(後ろははみ出すので消し、またぐものは終わりを詰める)
export async function graphicResplit({lib, short, music, cuts}) {
  const fresh = await graphicDefaults({lib, short: {...short, music, cuts}}), old = music.graphic;
  if (!old) return fresh;
  const seconds = cuts.reduce((a, c) => round6(a + c.seconds), 0), key = c => JSON.stringify([c.from, c.to, c.expr, c.ease ?? null]);
  const auto = new Set((await graphicDefaults({lib, short: {...short, music}})).cues.map(key));
  const kept = old.cues.filter(c => !auto.has(key(c)) && c.from < seconds).map(c => (c.to > seconds ? {...c, to: seconds} : c));
  return {...old, cues: [...fresh.cues, ...kept].sort((a, b) => a.from - b.from).slice(0, GRAPHIC_LIMITS.cues)};
}

// ---- 作業フォルダの鍵 ----
// 踊る人の鍵: バージョン、モーション、秒、表情、スカート、品質、描画のコード。文字、色、場面の並びは入れない
export function dancerKey({code, version, motion, seconds, graphic, pct, samples}) {
  return sha1(JSON.stringify(['dancer', code, version, motion, round6(seconds), graphic.cues, graphic.skirt, graphic.skirtDamp, pct, samples])).slice(0, 16);
}
// 重ねの鍵: 踊る人の鍵、場面の並び、文字、色、拍(曲と開始位置か bpm)、重ねのコード、書き出しの大きさ
export function composeKey({dancer, code, cuts, graphic, bpm, audio, audioStart, width, height}) {
  return sha1(JSON.stringify(['compose', dancer, code, cuts.map(c => [c.scene, c.wipe ?? null, c.word ?? null, c.seconds]), graphic.text, graphic.palette, bpm, audio, audioStart, width, height])).slice(0, 16);
}

// make_graphic_mv.py に渡す spec
export function graphicSpec({short, motionId, cast, audio, q}) {
  const m = short.music, g = m.graphic, {preset, ...palette} = g.palette;
  let at = 0;
  const plan = short.cuts.map(c => { const start = at; at = round6(at + c.seconds); return {scene: c.scene, start, end: at, ...(c.wipe ? {wipe: c.wipe} : {}), ...(c.word ? {word: c.word} : {})}; });
  return {char: cast.charId, ver: cast.verId, motion: motionId, seconds: at, bpm: m.bpm, ...(audio ? {audio: audio.file} : {}), audioStart: m.audioStart, seed: m.seed,
    springs: {skirt: g.skirt}, skirtDamp: g.skirtDamp, cues: g.cues.map(({note, ...c}) => c), text: g.text, palette, plan, pct: q.pct, samples: q.samples, compW: q.width, compH: q.height};
}

// ---- 拍から割る(--plan-only) ----
const SPLIT_TIMEOUT_MS = 180000;
export async function graphicPlan({stageDir, python = 'python'}, spec) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'charasta-graphic-'));
  try {
    const file = path.join(tmp, 'spec.json');
    await fs.writeFile(file, JSON.stringify(spec));
    const r = await exec(python, [path.join(stageDir, 'tools', 'make_graphic_mv.py'), '--plan-only', '--spec', file], {cwd: stageDir, timeout: SPLIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 24, env: {...process.env, CHARASTA_ROOT: root, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8'}});
    return JSON.parse(r.stdout);
  } catch (e) {
    throw bad(`場面の並びを作れなかった: ${(e.stderr || e.message || String(e)).toString().trim().split('\n').slice(-2).join(' / ')}`);
  } finally { await fs.rm(tmp, {recursive: true, force: true}); }
}
// --plan-only の答えをカットにする。word は既定の配り方(graphicWords)と同じなら持たない
export const graphicCutsFromPlan = (plan, motionId) => plan.map(p => ({scene: p.scene, motionId, ...(p.wipe ? {wipe: p.wipe} : {}), seconds: round6(p.end - p.start)}));

// ---- 書き出し ----
// shots.json(場面の並びと秒)をカット表と照らす
export function checkGraphicShots(cuts, shots) {
  const hint = '拍から割り直す';
  if (!Array.isArray(shots) || shots.length !== cuts.length) throw new Error(`カット表は ${cuts.length} カットだが、描いた場面は ${shots?.length ?? 0} 個。${hint}`);
  let at = 0;
  cuts.forEach((c, i) => {
    const s = shots[i], start = at;
    at = round6(at + c.seconds);
    if (s.scene !== c.scene) throw new Error(`カット ${i + 1} の場面がカット表(${c.scene})と違う(${s.scene})。${hint}`);
    if (Math.abs(s.start - start) > 0.02 || Math.abs(s.end - at) > 0.02) throw new Error(`カット ${i + 1} の時刻がカット表と違う（表 ${start.toFixed(3)}〜${at.toFixed(3)}、描画 ${Number(s.start).toFixed(3)}〜${Number(s.end).toFixed(3)} 秒）。${hint}`);
  });
}

const PHASES = {bake: 'モーションを焼く', check: 'スカートを確認する', render: '踊る人を描く', compose: '重ねる', done: '動画にまとめる'};
const PASS_LABEL = {full: '全身', mid: '膝上', face: '顔の寄り'};
const pngs = async dir => (await fs.readdir(dir).catch(() => [])).filter(f => /^\d{5}\.png$/.test(f)).length;
// 今の工程の表示(15 秒ごとに数える)
export async function graphicProgress(mvDir, dancerDir) {
  const p = JSON.parse(await fs.readFile(path.join(mvDir, 'progress.json'), 'utf8').catch(() => 'null'));
  if (!p) return null;
  if (p.phase === 'render') return `${PHASES.render} ${PASS_LABEL[p.pass_] ?? p.pass_} ${await pngs(path.join(dancerDir, p.pass_))} / ${p.total}`;
  if (p.phase === 'compose') return `${PHASES.compose} ${await pngs(path.join(mvDir, 'frames'))} / ${p.total}`;
  if (p.phase === 'check') return `${PHASES.check}(${PASS_LABEL[p.pass_] ?? p.pass_})`;
  return PHASES[p.phase] ?? null;
}

// コマを描く(描いたコマが揃っていれば何もしない)。mvDir/frames/00001.png から frames 枚と shots.json、report.json ができる。
//   股の前が見えるコマがあれば、秒を付けて失敗にする(スカートを硬くする案内)
export async function drawGraphic(ctx, {lib, short, stageDir, blender, getPort, mvDir, dancerDir, frames, q, quality, left, spec}) {
  const dir = path.join(mvDir, 'frames'), shotsFile = path.join(mvDir, 'shots.json');
  await fs.mkdir(dir, {recursive: true});
  if (await pngs(dir) >= frames && await fs.stat(shotsFile).catch(() => null) && await fs.stat(path.join(mvDir, 'report.json')).catch(() => null)) { ctx.log('重ねたコマが揃っているので、描き直さない\n'); return readReport(mvDir); }
  const specFile = path.join(mvDir, 'spec.json');
  await fs.writeFile(specFile, JSON.stringify(spec, null, 1));
  try {
    await ctx.run('python', [path.join(stageDir, 'tools', 'make_graphic_mv.py'), '--spec', specFile, '--out', mvDir, '--dancer-dir', dancerDir, '--quality', quality, '--base', `http://127.0.0.1:${getPort()}`, '--charasta', root],
      {cwd: stageDir, timeoutMs: left(), env: {CHARASTA_LIBRARY: lib.dir, CHARASTA_ROOT: root, ...(blender && {BLENDER: blender}), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8'}});
  } catch (e) {
    const rep = await readReport(mvDir);
    if (rep?.exposed?.length) {
      const secs = [...new Set(rep.exposed.flatMap(x => x.seconds))].sort((a, b) => a - b);
      throw new Error(`スカートの中が見えるコマがある（${secs.slice(0, 12).join('、')} 秒${secs.length > 12 ? ' ほか' : ''}）。グラフィックの「スカートの硬さ」を上げるか、skirtDamp を下げて描き直す`);
    }
    throw e;
  }
  return readReport(mvDir);
}
const readReport = async mvDir => JSON.parse(await fs.readFile(path.join(mvDir, 'report.json'), 'utf8').catch(() => 'null'));

// 顔にかかった文字のコマを、カットごとの数にする
export function faceHitsByCut(faceHits, counts) {
  const out = [];
  let lo = 1;
  counts.forEach((n, i) => { const k = (faceHits ?? []).filter(([f]) => f >= lo && f < lo + n).length; if (k) out.push({cut: i, frames: k}); lo += n; });
  return out;
}

export {graphicWords, MV_FPS};
