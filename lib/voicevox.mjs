// VOICEVOX Engine: ショート動画の声を作る。無料でローカルに動く。動いていなければ起動し、このサーバーが起動したものだけ止める。
//   CHARASTA_FAKE_VOICEVOX=1 エンジンを呼ばず、文の長さに合わせた無音と音の時刻を返す
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {stopTree} from './proc.mjs';
import {exe as platformExe} from './platform.mjs';

const START_MS = 60000, FAKE_MORA = 0.13, RATE = 24000;
// 間を短くして抑揚を強める(ショートのテンポ)。声のキャッシュの鍵に入れる
export const VOICE_TUNING = {pauseLengthScale: 0.5, prePhonemeLength: 0.05, postPhonemeLength: 0.05, intonationScale: 1.3};

export function silentWav(seconds) {
  const n = Math.round(seconds * RATE) * 2, h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + n, 4); h.write('WAVEfmt ', 8, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36, 'latin1'); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.alloc(n)]);
}

function fakeQuery(text, speed) {
  const moras = [...text].map((_, i) => ({text: 'ア', vowel: 'aiueo'[i % 5], vowel_length: FAKE_MORA, consonant_length: null}));
  return {...VOICE_TUNING, speedScale: speed, accent_phrases: [{moras, pause_mora: null}]};
}

export class VoiceVox {
  constructor({dir, url = 'http://127.0.0.1:50021', env = {}}) { this.dir = dir; this.url = url; this.env = env; this.child = null; this.starting = null; this.cache = null; }
  get fake() { return !!this.env.CHARASTA_FAKE_VOICEVOX; }

  // 使えるか: 試しの動き、すでに 127.0.0.1 などで答えているエンジン、または設定の voicevoxDir に run がある
  async available() { return this.fake || await this.#alive() || !!this.dir && fs.existsSync(path.join(this.dir, platformExe('run'))); }

  async #alive() { try { return (await fetch(this.url + '/version', {signal: AbortSignal.timeout(1500)})).ok; } catch { return false; } }

  async ready() {
    if (this.fake || await this.#alive()) return;
    this.starting ??= this.#start().finally(() => { this.starting = null; });
    await this.starting;
  }

  async #start() {
    const exe = path.join(this.dir ?? '', platformExe('run'));
    if (!this.dir || !fs.existsSync(exe)) throw new Error('VOICEVOX Engine が見つからない: ' + exe);
    const child = spawn(exe, ['--port', new URL(this.url).port], {cwd: this.dir, stdio: 'ignore', windowsHide: true});
    const gone = () => { if (this.child === child) this.child = null; };
    this.child = child;
    child.on('error', gone); child.on('exit', gone);
    const end = Date.now() + START_MS;
    while (Date.now() < end && this.child === child) {
      if (await this.#alive()) return;
      await new Promise(r => setTimeout(r, 500));
    }
    if (this.child === child) stopTree(child);
    throw new Error('VOICEVOX Engine が起動しない');
  }

  // [{id, name}]: 話者とスタイルを 1 列に並べる
  async speakers() {
    if (this.fake) return [{id: 8, name: '試しの声'}];
    if (this.cache) return this.cache;
    await this.ready();
    const list = await (await fetch(this.url + '/speakers')).json();
    this.cache = list.flatMap(s => s.styles.map(t => ({id: t.id, name: `${s.name}（${t.name}）`, speaker: s.name})));
    return this.cache;
  }

  async #post(url, body, headers = {}) {
    const r = await fetch(this.url + url, {method: 'POST', body, headers});
    if (!r.ok) throw new Error(`VOICEVOX が失敗した(${r.status}): ${(await r.text()).slice(0, 200)}`);
    return r;
  }

  // 文から音声と音の時刻(audio_query の答え)を作る
  async synth(text, speaker, speed) {
    if (this.fake) { const query = fakeQuery(text, speed); return {query, wav: silentWav(voiceSeconds(query))}; }
    await this.ready();
    const query = await (await this.#post(`/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`)).json();
    Object.assign(query, VOICE_TUNING, {speedScale: speed});
    const wav = Buffer.from(await (await this.#post(`/synthesis?speaker=${speaker}`, JSON.stringify(query), {'content-type': 'application/json'})).arrayBuffer());
    return {query, wav};
  }

  // 文の読み(audio_query の答え)。音は作らない
  async reading(text, speaker) {
    if (this.fake) return fakeQuery(text, 1);
    await this.ready();
    return Object.assign(await (await this.#post(`/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`)).json(), VOICE_TUNING);
  }

  close() { if (this.child) stopTree(this.child); }
}

const pauseSec = (q, p) => p.pause_mora.vowel_length * (q.pauseLengthScale ?? 1);
const moraList = q => q.accent_phrases.flatMap(p => [...p.moras, ...(p.pause_mora ? [{...p.pause_mora, vowel_length: pauseSec(q, p)}] : [])]);

// 音声の長さ(秒)
export function voiceSeconds(q) {
  return (q.prePhonemeLength + moraList(q).reduce((t, m) => t + (m.consonant_length ?? 0) + m.vowel_length, 0) + q.postPhonemeLength) / q.speedScale;
}

// 句の時刻(秒、声の頭から)。[{from, to, pause, moras: [{text, from, to}]}]。pause はこの句のあとに間があること
export function voicePhrases(q) {
  let t = q.prePhonemeLength;
  const at = x => x / q.speedScale;
  return q.accent_phrases.map(p => {
    const moras = p.moras.map(m => { const from = t; t += (m.consonant_length ?? 0) + m.vowel_length; return {text: m.text, vowel: m.vowel, from: at(from), to: at(t)}; });
    const to = at(t);
    if (p.pause_mora) t += pauseSec(q, p);
    return {from: moras[0].from, to, pause: !!p.pause_mora, moras};
  });
}

const VISEME = {a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh'};
const OPEN = 0.8, FOLLOW = 0.55, CONSONANT = 0.25;   // 口の開きの最大と、1 コマで目標へ近づく割合

// 音の時刻からコマごとの口の形 [{aa: 0.7}, ...] を作る。ビューアの mouthOverride にそのまま渡す
export function lipFrames(q, frames, fps) {
  let t = q.prePhonemeLength;
  return lipsOfVowels(moraList(q).map(m => {
    t += m.consonant_length ?? 0;
    const from = t; t += m.vowel_length;
    return {from: from / q.speedScale, to: t / q.speedScale, vis: VISEME[m.vowel.toLowerCase()] ?? null};
  }), frames, fps);
}

// モーラの時刻 [{from, to, vowel}] からコマごとの口の形を作る。母音の時刻が無いので、頭の CONSONANT の割合を子音に充てる。open は口の開きの最大
export const lipsOfMoras = (moras, frames, fps, open = OPEN) => lipsOfVowels(moras.map(m => ({from: m.from + (m.to - m.from) * CONSONANT, to: m.to, vis: VISEME[m.vowel?.toLowerCase()] ?? null})), frames, fps, open);

function lipsOfVowels(seq, frames, fps, open = OPEN) {
  const cur = Object.fromEntries(Object.values(VISEME).map(v => [v, 0]));
  return Array.from({length: frames}, (_, f) => {
    const now = f / fps, goal = seq.find(s => s.from <= now && now < s.to)?.vis;
    const out = {};
    for (const v of Object.keys(cur)) {
      cur[v] += ((v === goal ? open : 0) - cur[v]) * FOLLOW;
      if (cur[v] > 0.01) out[v] = Number(cur[v].toFixed(3));
    }
    return out;
  });
}
