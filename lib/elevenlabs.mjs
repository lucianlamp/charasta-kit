// ElevenLabs: ショートの声を作る。`/v1/text-to-speech/{voice_id}/with-timestamps` で音と文字ごとの時刻を受け取る。docs/shorts.md の「声の提供元」。
//   キーは環境の ELEVENLABS_API_KEY だけから読み、ヘッダーにしか載せない。ログ、画面、ファイル、エラーの文に出さない。
//   CHARASTA_FAKE_ELEVENLABS=1 API を呼ばず、文の長さに合わせた無音と文字の時刻を返す
import {silentWav, voicePhrases} from './voicevox.mjs';

const API = 'https://api.elevenlabs.io', SPEECH_DECAY = 0.15, VOICES_MS = 600000, FAKE_CHAR = 0.12, FAKE_LEAD = 0.1;
export const ELEVEN_MODEL = 'eleven_v3';   // 試した結果は docs/notes/shorts.md。timestamps に対応し、音声タグで演じ分けられる
export const ELEVEN_SETTINGS = {stability: 0.5, similarity_boost: 0.75};   // eleven_v3 の stability は 0、0.5、1 の 3 段
export const ELEVEN_DIALOGUE = {model: 'eleven_v4', language: 'ja', seed: 7};   // 全カットを 1 回で読ませる会話。演じ方(tone)のあるカットの行頭にだけ v4 のタグを付ける
// VOICE_TONES(lib/short.mjs)の値から v4 の英語タグへの対応。タグは文字数として課金されるので短い単語にする
export const DIALOGUE_TAGS = {whispers: 'whispers', sighs: 'sighs', sad: 'sad', angry: 'angry', excited: 'excited', nervous: 'nervous', crying: 'crying', trembling: 'trembling', terrified: 'terrified'};
export const toneTag = tone => (tone && DIALOGUE_TAGS[tone] ? `[${DIALOGUE_TAGS[tone]}]` : '');
const OUTPUT = 'mp3_44100_128', MP3_BPS = 128000;

// 文字の時刻が無いときの代わり: 音の長さを文字数で等分する
export function evenAlignment(text, seconds) {
  const characters = [...text], step = seconds / Math.max(characters.length, 1);
  return {characters, character_start_times_seconds: characters.map((_, i) => i * step), character_end_times_seconds: characters.map((_, i) => (i + 1) * step)};
}

// 使ってよい声: 日本語の professional の声だけ。LUCIAN の声と cloned の声は使わない
export const usableVoice = v => v.category === 'professional' && v.labels?.language === 'ja' && !/lucian/i.test(v.name);

export class ElevenLabs {
  #key;
  constructor({env = {}}) { this.#key = env.ELEVENLABS_API_KEY; this.fake = !!env.CHARASTA_FAKE_ELEVENLABS; this.cache = null; this.cacheAt = 0; }
  get ready() { return this.fake || !!this.#key; }

  async #fail(r) {
    const body = (await r.text()).replaceAll(this.#key ?? ' ', '***').slice(0, 200);
    return new Error(`ElevenLabs が失敗した(${r.status}): ${body}`);
  }

  // [{id, name, gender}]
  async voices() {
    if (this.fake) return [{id: 'fake-voice', name: '試しの声', gender: 'female'}];
    if (!this.ready) return [];
    if (this.cache && Date.now() - this.cacheAt < VOICES_MS) return this.cache;
    const r = await fetch(API + '/v1/voices', {headers: {'xi-api-key': this.#key}});
    if (!r.ok) throw await this.#fail(r);
    this.cache = (await r.json()).voices.filter(usableVoice).map(v => ({id: v.voice_id, name: v.name.trim(), gender: v.labels?.gender ?? ''}));
    this.cacheAt = Date.now();
    return this.cache;
  }

  // 文から音声と文字の時刻を作る。答えは {audio, ext, alignment, cost}。text は演じ方のタグを含んでよい
  async synth(text, voiceId, {model = ELEVEN_MODEL, settings = ELEVEN_SETTINGS} = {}) {
    if (this.fake) return fakeSpeech(text);
    if (!this.ready) throw new Error('ELEVENLABS_API_KEY が無い');
    if (!(await this.voices()).some(v => v.id === voiceId)) throw new Error(`使えない声: ${voiceId}。日本語の professional の声だけ使う`);
    const r = await fetch(`${API}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${OUTPUT}`, {method: 'POST', headers: {'xi-api-key': this.#key, 'content-type': 'application/json'}, body: JSON.stringify({text, model_id: model, language_code: 'ja', voice_settings: settings})});
    if (!r.ok) throw await this.#fail(r);
    const cost = Number(r.headers.get('character-cost')) || 0, j = await r.json(), audio = Buffer.from(j.audio_base64, 'base64');
    // 応答に文字の時刻が無くても、課金済みの音は捨てない
    return {audio, ext: 'mp3', alignment: j.alignment?.characters?.length ? j.alignment : evenAlignment(text, audio.length * 8 / MP3_BPS), cost};
  }

  // 全カットのセリフを 1 回の会話で読ませる。inputs は [{voice_id, text}]。答えは {audio, ext, alignment, segments, cost}。segments は voice_segments
  async dialogue(inputs, {model = ELEVEN_DIALOGUE.model, language = ELEVEN_DIALOGUE.language, seed = ELEVEN_DIALOGUE.seed} = {}) {
    if (this.fake) return fakeDialogue(inputs);
    if (!this.ready) throw new Error('ELEVENLABS_API_KEY が無い');
    const known = await this.voices(), bad = inputs.find(x => !known.some(v => v.id === x.voice_id));
    if (bad) throw new Error(`使えない声: ${bad.voice_id}。日本語の professional の声だけ使う`);
    const r = await fetch(`${API}/v1/text-to-dialogue/with-timestamps?output_format=${OUTPUT}`, {method: 'POST', headers: {'xi-api-key': this.#key, 'content-type': 'application/json'}, body: JSON.stringify({inputs, model_id: model, language_code: language, seed})});
    if (!r.ok) throw await this.#fail(r);
    const cost = Number(r.headers.get('character-cost')) || 0, j = await r.json();
    return {audio: Buffer.from(j.audio_base64, 'base64'), ext: 'mp3', alignment: j.alignment, segments: j.voice_segments, cost};
  }

  // 使った文字数の記録(subscription の character_count)。測れなければ null
  async used() {
    if (this.fake || !this.ready) return null;
    const r = await fetch(API + '/v1/user/subscription', {headers: {'xi-api-key': this.#key}});
    return r.ok ? (await r.json()).character_count : null;
  }
}

function fakeSpeech(text) {
  const characters = [...text], end = i => FAKE_LEAD + (i + 1) * FAKE_CHAR;
  return {audio: silentWav(end(characters.length) + FAKE_LEAD), ext: 'wav', cost: 0, alignment: {characters, character_start_times_seconds: characters.map((_, i) => end(i) - FAKE_CHAR), character_end_times_seconds: characters.map((_, i) => end(i))}};
}

function fakeDialogue(inputs) {
  const a = {characters: [], character_start_times_seconds: [], character_end_times_seconds: []}, segments = [];
  let t = 0;
  inputs.forEach(({voice_id, text}, i) => {
    const {alignment} = fakeSpeech(text), start = a.characters.length, begin = t;
    a.characters.push(...alignment.characters);
    a.character_start_times_seconds.push(...alignment.character_start_times_seconds.map(x => x + begin));
    a.character_end_times_seconds.push(...alignment.character_end_times_seconds.map(x => x + begin));
    t = a.character_end_times_seconds.at(-1) + FAKE_LEAD;
    segments.push({voice_id, start_time_seconds: begin, end_time_seconds: t, character_start_index: start, character_end_index: a.characters.length, dialogue_input_index: i});
  });
  return {audio: silentWav(t), ext: 'wav', cost: 0, alignment: a, segments};
}

export const isPause = c => /[\s、。，．,.!！?？…・「」『』（）()〜~-]/.test(c);
const isBreak = c => /[、。，．,.!！?？…]/.test(c);

// 表示の文の文字ごとの時刻。ElevenLabs の文字を順に突き合わせ、声に無い文字(心の声の括弧)は前の文字の終わりに置く。演じ方のタグは突き合わせで飛ぶ
export function alignedChars(plain, a) {
  let at = 0, last = 0;
  return [...plain].map(c => {
    const found = a.characters.indexOf(c, at);
    if (found < 0) return {c, from: last, to: last};
    at = found + 1; last = a.character_end_times_seconds[found];
    return {c, from: a.character_start_times_seconds[found], to: last};
  });
}

// 実際に声が終わる時刻。ElevenLabs の音は文末に長い無音が付くので、最後の文字の終わりに余韻を足す
export function speechEnd(chars) {
  const last = chars.findLast(x => !isPause(x.c));
  return last ? last.to + SPEECH_DECAY : 0;
}

// 文字の時刻を句読点で区切った声の区間。[{from, to}]
function speechRuns(chars) {
  const runs = [];
  chars.forEach((x, i) => {
    if (!runs.length || (isBreak(chars[i - 1].c) && !isBreak(x.c))) runs.push([]);
    if (!isPause(x.c)) runs.at(-1).push(x);
  });
  return runs.filter(r => r.length).map(r => ({from: r[0].from, to: r.at(-1).to, chars: r}));
}

// 句の時刻。読み(VOICEVOX の audio_query)があれば、読みの句を句読点の区間ごとに ElevenLabs の時刻へ伸縮する。無ければ文字をそのまま句にする(母音は無い)。
//   形は voicePhrases と同じ [{from, to, pause, moras: [{text, from, to, vowel}]}]
export function elevenPhrases(chars, query) {
  const runs = speechRuns(chars);
  if (!query) return runs.map(r => ({from: r.from, to: r.to, pause: true, moras: r.chars.map(x => ({text: x.c, from: x.from, to: x.to}))}));
  const groups = [];
  voicePhrases(query).forEach((p, i, all) => { if (!i || all[i - 1].pause) groups.push([]); groups.at(-1).push(p); });
  // 区間の数が合わないときは文全体を 1 つの区間として伸縮する
  const pairs = groups.length === runs.length ? groups.map((g, i) => [g, runs[i]]) : [[groups.flat(), {from: runs[0].from, to: runs.at(-1).to}]];
  return pairs.flatMap(([group, run]) => {
    const from = group[0].from, scale = (run.to - run.from) / Math.max(group.at(-1).to - from, 1e-3), at = t => run.from + (t - from) * scale;
    return group.map((p, i) => ({from: at(p.from), to: at(p.to), pause: i === group.length - 1, moras: p.moras.map(m => ({...m, from: at(m.from), to: at(m.to)}))}));
  });
}
