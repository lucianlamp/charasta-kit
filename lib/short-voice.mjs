// ショートの声: 出演者の声の提供元ごとに音と時刻を作り、口の動きまで決める。docs/shorts.md の「声の提供元」。
//   ElevenLabs の声は文、声 ID、モデル、設定のハッシュで保管場所の voice-cache/ に置き、ショートをまたいで同じ文を 2 度生成しない
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {readJsonOr} from './library.mjs';
import {mediaSeconds} from './audio.mjs';
import {ELEVEN_DIALOGUE, ELEVEN_MODEL, ELEVEN_SETTINGS, alignedChars, toneTag, elevenPhrases, isPause} from './elevenlabs.mjs';
import {VOICE_TUNING, lipFrames, lipsOfMoras, voicePhrases, voiceSeconds} from './voicevox.mjs';

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const READING_SPEAKER = 8;   // 読みと母音を取るだけなので声はどれでもよい
const LEVEL_RATE = 8000;
export const THOUGHT = /^[（(](.*)[）)]$/s;
export const spokenText = line => line.replace(THOUGHT, '$1');   // 心の声の括弧は声に渡さない

const vvKey = (line, member) => sha1(JSON.stringify([line, member.speaker, member.speed, VOICE_TUNING]));
const elKey = (line, member) => sha1(JSON.stringify([line, member.voiceId, ELEVEN_MODEL, ELEVEN_SETTINGS, member.tone ?? '']));
const elText = (line, tone) => (tone ? `[${tone}] ${spokenText(line)}` : spokenText(line));

// 保管した ElevenLabs の声の時刻から、timeline と口へ渡す形を作る
const fromEleven = (line, rec, file) => {
  const chars = alignedChars(line, rec.alignment), phrases = elevenPhrases(chars, rec.query ?? null);
  return {file, phrases, chars, reading: !!rec.query};
};

// 実行中の生成。同じ文を同時に頼まれても 1 回だけ課金する
const making = new Map();

async function elevenVoice(tools, member, line) {
  const id = path.join(tools.lib.dir, elKey(line, member));
  if (!making.has(id)) making.set(id, makeEleven(tools, member, line).finally(() => making.delete(id)));
  return making.get(id);
}

async function makeEleven({lib, voicevox, eleven, log}, member, line) {
  const dir = path.join(lib.dir, 'voice-cache'), key = elKey(line, member), json = path.join(dir, key + '.json');
  let rec = await readJsonOr(json);
  if (!rec) {
    await fs.mkdir(dir, {recursive: true});
    const text = elText(line, member.tone), made = await eleven.synth(text, member.voiceId);
    rec = {text, voiceId: member.voiceId, model: ELEVEN_MODEL, ext: made.ext, alignment: made.alignment, cost: made.cost};
    await fs.writeFile(path.join(dir, `${key}.${made.ext}`), made.audio);
    await fs.writeFile(json, JSON.stringify(rec));
    log?.(`ElevenLabs ${[...text].length} 文字、消費 ${made.cost}\n`);
  }
  if (rec.query === undefined) {   // 読みは VOICEVOX が動いたときに取り、次回から使う
    rec.query = await voicevox.reading(spokenText(line), READING_SPEAKER).catch(() => null);
    if (rec.query) await fs.writeFile(json, JSON.stringify(rec));
  }
  return fromEleven(line, rec, path.join(dir, `${key}.${rec.ext}`));
}

async function voicevoxVoice({voicevox}, member, line, voiceDir) {
  const key = vvKey(line, member), file = path.join(voiceDir, key + '.wav'), json = path.join(voiceDir, key + '.json');
  let query = await readJsonOr(json);
  if (!query) {
    const made = await voicevox.synth(line, member.speaker, member.speed);
    await fs.writeFile(file, made.wav); await fs.writeFile(json, JSON.stringify(made.query)); query = made.query;
  }
  return {file, query, phrases: voicePhrases(query), reading: true};
}

// 出演者 1 人の 1 文の声。答えは {file, phrases, chars?, query?, reading}
export const voiceOf = (tools, member, line, voiceDir) => (member.provider === 'elevenlabs' ? elevenVoice(tools, member, line) : voicevoxVoice(tools, member, line, voiceDir));

// voiceOf に音の長さを足す
export async function speak(tools, member, line, voiceDir) {
  const voice = await voiceOf(tools, member, line, voiceDir);
  return {...voice, seconds: await mediaSeconds(tools.ctx, voice.file)};
}

// 声を作らずに保管済みのものを読む(編集画面のプレビュー)。無ければ null
export async function storedVoice(lib, member, line, voiceDir) {
  if (member.provider === 'elevenlabs') {
    const key = elKey(line, member), rec = await readJsonOr(path.join(lib.dir, 'voice-cache', key + '.json'));
    if (!rec) return null;
    const voice = fromEleven(line, rec, '');
    return {...voice, seconds: rec.alignment.character_end_times_seconds.at(-1)};
  }
  const query = await readJsonOr(path.join(voiceDir, vvKey(line, member) + '.json'));
  return query && {query, phrases: voicePhrases(query), seconds: voiceSeconds(query)};
}

// 音量からコマごとの口の形を作る。読みが取れないときの代わり
async function levelLips(ctx, file, frames, fps) {
  const raw = `${file}.level.raw`;
  await ctx.run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', String(LEVEL_RATE), raw]);
  const data = await fs.readFile(raw);
  await fs.rm(raw);
  const step = Math.round(LEVEL_RATE / fps), levels = Array.from({length: frames}, (_, f) => {
    let sum = 0, n = 0;
    for (let i = f * step; i < (f + 1) * step && i * 2 + 1 < data.length; i++, n++) sum += data.readInt16LE(i * 2) ** 2;
    return n ? Math.sqrt(sum / n) : 0;
  });
  const peak = Math.max(...levels, 1);
  return levels.map(v => { const open = v / peak; return open > 0.12 ? {aa: Number((0.8 * open).toFixed(3))} : {}; });
}

// ---- 全カットを 1 回で読ませる会話 ----
// 会話の経路に入るのは、short.json に dialogue: true があり、出演者が全員 ElevenLabs の 2 人以上のとき。欄の無い既存のショートは 1 文ずつの経路(v3)のまま
//   (会話は声も課金も v3 と別なので、勝手に切り替えない)。castDialogue は新しく作るショートに欄を付けるかの判断
//   演じ方(tone)のあるカットは行頭に v4 のタグを付けて送る。lines は [{line, member, tone?}]
export const castDialogue = cast => cast.length > 1 && cast.every(m => m.provider === 'elevenlabs');
export const useDialogue = (short, cast) => short.dialogue === true && castDialogue(cast);
export const DIALOGUE_MAX_CHARS = 2000;   // 1 回の会話で送れる文字数の合計
export const DIALOGUE_TEMPO = 1.1;      // 仕上げの速さ。音程は保つ(atempo)
const DIALOGUE_OPEN = 1;                // 口の開きの最大。会話は 1.1 倍速でモーラが短く、0.8 では開ききらずに小さく見えた
const DIALOGUE_FLOOR = 413;             // 無音と見なす波の高さ(16 bit で約 -38 dB)
const DIALOGUE_STEP = 0.01, DIALOGUE_SILENCE = 0.03, DIALOGUE_LOOK = 0.6, DIALOGUE_AFTER = 0.1, DIALOGUE_LAG = 0.3;   // 測る幅、無音と見なす長さ、境目から前へ探す秒(最後の語の時刻が分からないとき)、境目から後ろへ探す秒、alignment が声より遅れうる秒
const tagged = l => { const tag = toneTag(l.tone); return tag ? `${tag} ${spokenText(l.line)}` : spokenText(l.line); };
const dialogueText = lines => lines.map(l => [tagged(l), l.member.voiceId]);
const dialogueKey = lines => sha1(JSON.stringify(['dialogue', dialogueText(lines), ELEVEN_DIALOGUE]));
const sliceKey = () => sha1(JSON.stringify(['wave3', DIALOGUE_TEMPO, DIALOGUE_FLOOR, DIALOGUE_SILENCE, DIALOGUE_LOOK, DIALOGUE_AFTER, DIALOGUE_LAG]));

// 会話の応答(または保管した記録)が使える形かを確かめる。使えなければ日本語のエラー
//   alignment の文字と時刻、行ごとに 1 個ずつの voice_segments(dialogue_input_index が 0 から行数-1)
export function checkDialogueRec(rec, count) {
  const a = rec?.alignment, list = x => Array.isArray(x);
  if (!a || !list(a.characters) || !a.characters.length || !list(a.character_start_times_seconds) || !list(a.character_end_times_seconds) || a.character_start_times_seconds.length !== a.characters.length || a.character_end_times_seconds.length !== a.characters.length) throw new Error('会話の応答に文字ごとの時刻(alignment)が無い、または欠けている');
  const segs = rec.segments;
  if (!list(segs) || segs.length !== count || Array.from({length: count}, (_, i) => segs.filter(s => s?.dialogue_input_index === i).length).some(n => n !== 1)) throw new Error(`会話の応答の区間(voice_segments)が行の数 ${count} と合わない`);
}

async function makeDialogue({lib, voicevox, eleven, log}, lines) {
  const dir = path.join(lib.dir, 'voice-cache'), key = dialogueKey(lines), json = path.join(dir, key + '.json');
  let rec = await readJsonOr(json);
  if (!rec) {
    const total = dialogueText(lines).reduce((n, [text]) => n + [...text].length, 0);
    if (total > DIALOGUE_MAX_CHARS) throw new Error(`会話の文字数が ${total} 字で、上限の ${DIALOGUE_MAX_CHARS} 字を超える。セリフを減らすか、dialogue を外して 1 文ずつの声にする`);
    await fs.mkdir(dir, {recursive: true});
    const made = await eleven.dialogue(dialogueText(lines).map(([text, voice_id]) => ({voice_id, text})));
    rec = {lines: dialogueText(lines), ...ELEVEN_DIALOGUE, ext: made.ext, alignment: made.alignment, segments: made.segments, cost: made.cost};
    checkDialogueRec(rec, lines.length);   // 課金済みでも、壊れた応答はキャッシュへ書かない
    await fs.writeFile(path.join(dir, `${key}.${made.ext}`), made.audio);
    await fs.writeFile(json, JSON.stringify(rec));
    log?.(`ElevenLabs 会話 ${lines.length} 行、${rec.alignment.characters.length} 文字、消費 ${made.cost}\n`);
  } else checkDialogueRec(rec, lines.length);
  if (!rec.queries?.every(Boolean)) {   // 読みは VOICEVOX が動いたときに取り、次回から使う
    rec.queries = await Promise.all(lines.map((l, i) => rec.queries?.[i] ?? voicevox.reading(spokenText(l.line), READING_SPEAKER).catch(() => null)));
    if (rec.queries.some(Boolean)) await fs.writeFile(json, JSON.stringify(rec));
  }
  return rec;
}

// 16 bit の音を DIALOGUE_STEP ごとの波の高さにする
function waveLevels(pcm, rate) {
  const step = Math.round(rate * DIALOGUE_STEP), n = Math.floor(pcm.length / 2 / step);
  return Array.from({length: n}, (_, w) => {
    let peak = 0;
    for (let i = w * step; i < (w + 1) * step; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i * 2)));
    return peak;
  });
}

// 行の切り位置を元の音の波形で決める。voice_segments の境目は声の始まりより遅いことがあるので、そのまま使わない。
//   lasts[k] は k 行目の最後の発音される文字の開始時刻(alignment)。alignment も声より遅れうるので、DIALOGUE_LAG 引いた所を探す範囲の下限にする
//   (行の最後の語の前の溜めを境目と取り違えないため)。lasts が無い行は境目の DIALOGUE_LOOK 前を下限にする。
//   下限から境目の DIALOGUE_AFTER 後までの 30 ms 以上の無音のうち境目に一番近いものを、前の行の終わりと次の行の始めにする。
//   前の行は無音の始まりから 30 ms 後で終わる(終わりの 30 ms が無音)。無音が無ければ範囲内で一番小さい 1 区間を境にする。前の行の終わりは次の行の始めを超えない。
//   boundaries は 2 行目からの境目の秒。答えは [{from, to, joined}]。joined は無音が無くて境を選んだ行
export function dialogueCuts(pcm, rate, boundaries, lasts = []) {
  const levels = waveLevels(pcm, rate), quiet = w => levels[w] <= DIALOGUE_FLOOR, need = Math.round(DIALOGUE_SILENCE / DIALOGUE_STEP), last = levels.length;
  const voiced = levels.findIndex(v => v > DIALOGUE_FLOOR), end = levels.findLastIndex(v => v > DIALOGUE_FLOOR) + 1;
  const cuts = [{from: Math.max(0, voiced) * DIALOGUE_STEP, to: end * DIALOGUE_STEP, joined: false}];
  const voicedRun = t => {   // t 秒の直前の声の連なり(30 ms 以上の無音で区切る)の始まり。声が無ければ null
    const m = Math.min(last - 1, Math.round(t / DIALOGUE_STEP) + 2), back = Math.round(DIALOGUE_LAG / DIALOGUE_STEP);
    let s = m;
    while (s >= 0 && s >= m - back && quiet(s)) s--;
    if (s < 0 || quiet(s)) return null;
    while (s > 0) {
      if (!quiet(s - 1)) { s--; continue; }
      let g = 0;
      while (s - 1 - g >= 0 && quiet(s - 1 - g)) g++;
      if (g >= need) break;
      s -= g;
    }
    return s;
  };
  const search = (from, to, at, lo) => {   // from から to の間の 30 ms 以上の無音のうち at に一番近いもの
    let best = null;
    for (let w = from; w < to; w++) {
      if (!quiet(w)) continue;
      let s = w, e = w;
      while (s > lo && quiet(s - 1)) s--;     // 下限より前の無音は使わない(その前は最後の語の前の溜め)
      while (e < last && quiet(e)) e++;
      const near = Math.max(s - at, at - e, 0);
      if (e - s >= need && (!best || near < best.near || (near === best.near && e - s > best.e - best.s))) best = {s, e, near};
      w = e;
    }
    return best;
  };
  for (const [k, b] of boundaries.entries()) {
    const at = Math.min(last, Math.round(b / DIALOGUE_STEP)), hi = Math.min(last, at + Math.round(DIALOGUE_AFTER / DIALOGUE_STEP));
    const known = Number.isFinite(lasts[k]), floor = known ? Math.round((lasts[k] - DIALOGUE_LAG) / DIALOGUE_STEP) : at - Math.round(DIALOGUE_LOOK / DIALOGUE_STEP);
    let lo = Math.max(0, Math.min(floor, hi - 1), Math.round(cuts.at(-1).from / DIALOGUE_STEP));
    if (known) lo = Math.max(lo, Math.min(voicedRun(lasts[k]) ?? 0, hi - 1));   // 最後の語が属する声の連なりより前(語の中の短い息継ぎ)は境目にしない
    // 境目が声の終わりより早いこともあるので、範囲に無音が無ければ境目の DIALOGUE_LOOK 後まで進めて最初の無音を使う
    let best = search(lo, hi, at, lo) ?? (known ? search(hi, Math.min(last, at + Math.round(DIALOGUE_LOOK / DIALOGUE_STEP)), at, lo) : null);
    let joined = false;
    if (!best) {
      let w = lo;
      for (let j = lo; j < hi; j++) if (levels[j] < levels[w]) w = j;
      best = {s: w, e: w + 1}; joined = true;
    }
    cuts.at(-1).to = (joined ? best.s : best.s + need) * DIALOGUE_STEP;   // 無音の頭から 30 ms 進め、前の行の終わりの 30 ms を無音にする
    cuts.push({from: best.e * DIALOGUE_STEP, to: end * DIALOGUE_STEP, joined});
  }
  return cuts;
}

// 書き出しの前の検査: 各行の始まりの前が無音で、前の行の終わりが次の行の始まりを超えない。答えは問題のある行の番号。境を選んだ行は除く
export function checkDialogueCuts(pcm, rate, cuts) {
  const levels = waveLevels(pcm, rate), need = Math.round(DIALOGUE_SILENCE / DIALOGUE_STEP);
  return cuts.flatMap((c, i) => {
    if (!i || c.joined) return [];
    const w = Math.round(c.from / DIALOGUE_STEP), before = levels.slice(Math.max(0, w - need), w);
    return before.length < need || before.some(v => v > DIALOGUE_FLOOR) || cuts[i - 1].to > c.from ? [i] : [];
  });
}

// 書き出しの前の警告: 各行の終わりの前 30 ms が無音か、最後の語が行の区間に残っているか、次の行の頭に前の行の最後の語が入っていないかを、alignment の時刻から確かめる。
//   lasts は [{start, end}] (行ごとの最後の発音される文字の時刻)。答えは文の配列(外れが無ければ空)
export function warnDialogueCuts(pcm, rate, cuts, lasts) {
  const levels = waveLevels(pcm, rate), need = Math.round(DIALOGUE_SILENCE / DIALOGUE_STEP), warns = [];
  cuts.forEach((c, i) => {
    const w = Math.round(c.to / DIALOGUE_STEP), tail = levels.slice(Math.max(0, w - need), w), l = lasts[i];
    if (!c.joined && i < cuts.length - 1 && tail.some(v => v > DIALOGUE_FLOOR)) warns.push(`${i + 1} 行目の終わりの 30 ms に音がある`);
    if (l && c.to < l.start - DIALOGUE_LAG) warns.push(`${i + 1} 行目の最後の語(${l.start.toFixed(2)} 秒)が切り出しの終わり(${c.to.toFixed(2)} 秒)より後にある`);
    const prev = lasts[i - 1];
    if (prev && c.from < prev.start - DIALOGUE_LAG) warns.push(`${i + 1} 行目の頭(${c.from.toFixed(2)} 秒)に前の行の最後の語(${prev.start.toFixed(2)} 秒)が入っている`);
  });
  return warns;
}

// 行ごとの最後の発音される文字の時刻。声の無い行は null
function lastVoiced(rec, i) {
  const seg = rec.segments.find(s => s.dialogue_input_index === i), a = rec.alignment;
  if (!seg) return null;
  for (let k = seg.character_end_index - 1; k >= seg.character_start_index; k--) if (!isPause(a.characters[k])) return {start: a.character_start_times_seconds[k], end: a.character_end_times_seconds[k]};
  return null;
}

// 1 行の声。文字の時刻は、行の最初の文字の始めから声のある最後の文字の終わりまでを、波形で決めた区間へ写し、仕上げの速さで縮める
//   送った文の行頭のタグ(`[whispers] `)の文字も alignment に入るので、字幕と口の時刻から除く
function dialogueLine(rec, i, line, file) {
  const seg = rec.segments.find(s => s.dialogue_input_index === i), a = rec.alignment, e = seg.character_end_index, {from, to} = rec.cuts[sliceKey()][i];
  const sent = rec.lines[i][0], tagLength = sent.length - spokenText(line).length;   // 送った文はタグ + 空白 + 本文
  let s = seg.character_start_index;
  if (tagLength > 0 && a.characters.slice(s, s + tagLength).join('') === sent.slice(0, tagLength)) s += tagLength;
  const characters = a.characters.slice(s, e), starts = a.character_start_times_seconds.slice(s, e), ends = a.character_end_times_seconds.slice(s, e), first = starts[0], close = ends[characters.findLastIndex(c => !isPause(c))];   // 文末の記号は声が無いのに時間を持つ
  const seconds = (to - from) / DIALOGUE_TEMPO, scale = seconds / Math.max(close - first, 1e-3), at = t => Math.min(seconds, (t - first) * scale);
  const alignment = {characters, character_start_times_seconds: starts.map(at), character_end_times_seconds: ends.map(at)};
  return {...fromEleven(line, {alignment, query: rec.queries?.[i] ?? null}, file), seconds, dialogue: true};
}

const makingDialogue = new Map();

// lines: [{line, member}]。答えは行ごとの speak と同じ形。切り出した音は voice-cache/ に残す
export async function speakDialogue(tools, lines) {
  const id = path.join(tools.lib.dir, dialogueKey(lines));
  if (!makingDialogue.has(id)) makingDialogue.set(id, makeDialogue(tools, lines).finally(() => makingDialogue.delete(id)));
  const rec = await makingDialogue.get(id), dir = path.join(tools.lib.dir, 'voice-cache'), key = dialogueKey(lines), source = path.join(dir, `${key}.${rec.ext}`), fileOf = i => path.join(dir, `${key}-${sliceKey()}-${i}.wav`);
  if (!rec.cuts?.[sliceKey()]) {
    const raw = `${source}.raw`;
    await tools.ctx.run('ffmpeg', ['-y', '-v', 'error', '-i', source, '-f', 's16le', '-ac', '1', '-ar', String(LEVEL_RATE), raw]);
    const pcm = await fs.readFile(raw);
    await fs.rm(raw);
    const starts = rec.segments.slice().sort((a, b) => a.dialogue_input_index - b.dialogue_input_index).slice(1).map(s => s.start_time_seconds), lasts = lines.map((_, i) => lastVoiced(rec, i)), cuts = dialogueCuts(pcm, LEVEL_RATE, starts, lasts.slice(0, -1).map(l => l?.start)), bad = checkDialogueCuts(pcm, LEVEL_RATE, cuts);
    if (bad.length) throw new Error(`会話の切り位置の前に音がある: ${bad.map(i => i + 1).join('、')} 行目`);
    for (const w of warnDialogueCuts(pcm, LEVEL_RATE, cuts, lasts)) tools.log?.(`警告: 会話の${w}\n`);
    for (const [i, c] of cuts.entries()) {
      if (c.joined) tools.log?.(`会話の ${i + 1} 行目は前に無音が無いので、一番小さい所を境にした\n`);
      const file = fileOf(i), part = `${file}.part.wav`;
      await tools.ctx.run('ffmpeg', ['-y', '-v', 'error', '-i', source, '-af', `atrim=start=${c.from}:end=${c.to},asetpts=PTS-STARTPTS,atempo=${DIALOGUE_TEMPO}`, '-ar', '48000', '-c:a', 'pcm_s16le', part]);
      await fs.rename(part, file);
    }
    rec.cuts = {...rec.cuts, [sliceKey()]: cuts};
    await fs.writeFile(path.join(dir, key + '.json'), JSON.stringify(rec));
  }
  return lines.map(({line}, i) => dialogueLine(rec, i, line, fileOf(i)));
}

// 声を作らずに保管済みの会話を読む(編集画面のプレビュー)。無ければ null
export async function storedDialogue(lib, lines) {
  const dir = path.join(lib.dir, 'voice-cache'), key = dialogueKey(lines), rec = await readJsonOr(path.join(dir, key + '.json'));
  if (!rec?.cuts?.[sliceKey()]) return null;
  checkDialogueRec(rec, lines.length);
  return lines.map(({line}, i) => dialogueLine(rec, i, line, path.join(dir, `${key}-${sliceKey()}-${i}.wav`)));
}

// コマごとの口の形
export async function voiceLips(ctx, voice, frames, fps) {
  if (voice.query) return lipFrames(voice.query, frames, fps);
  if (voice.reading) return lipsOfMoras(voice.phrases.flatMap(p => p.moras), frames, fps, voice.dialogue ? DIALOGUE_OPEN : undefined);
  return levelLips(ctx, voice.file, frames, fps);
}
