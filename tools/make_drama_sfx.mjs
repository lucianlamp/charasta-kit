// ドラマの環境音と効果音を ElevenLabs の sound-generation で作り、assets/sfx/drama/ に置く。ある音は作り直さない。
//   使い方: node tools/make_drama_sfx.mjs [音の名前 ...]。環境の ELEVENLABS_API_KEY を使い、キーは出さない。費用はファイルごとにかかるので、要る音だけ作る
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sfx', 'drama');
const SOUNDS = {
  footsteps: {text: 'Soft footsteps of one person in indoor school shoes walking slowly on a wooden classroom floor, four steps, quiet empty room', seconds: 3},
  paper: {text: 'A folded paper letter being slowly unfolded, close up crisp paper rustle, nothing else', seconds: 1.5},
  wind: {text: 'Gentle evening wind coming through an open classroom window, soft curtain flutter, calm room tone, no voices', seconds: 10, loop: true},
  chime: {text: 'Japanese school bell, the Westminster chime melody on soft electronic bells over a distant loudspeaker, slightly reverberant, fading away', seconds: 7},
  heartbeat: {text: 'Slow tense human heartbeat, two pairs of deep soft thumps, close and low, no music', seconds: 3},
  door: {text: 'Wooden classroom sliding door slowly sliding open on its rail, soft rattle, then stops', seconds: 2},
  snap: {text: 'A sheet of paper snapped sharply through the air and slapped forward, one quick crisp paper whip, close', seconds: 0.7},
  hit: {text: 'One deep low cinematic sub impact, dark boom with a short tail, no music', seconds: 2},
  ring: {text: 'High pitched tinnitus ear ringing tone slowly rising, thin and tense, no other sound', seconds: 3},
  gravel: {text: 'One single footstep of a person in sneakers on an outdoor gravel path, one crisp dry gravel crunch, close, nothing else, no voices, no wind', seconds: 0.8},
  scuff: {text: 'A person in sneakers stopping abruptly on an outdoor gravel path, one short heavy sliding scuff and crunch of gravel under the shoe, close, nothing else, no voices, no wind', seconds: 0.8},
  caw: {text: 'One single loud harsh caw of a large crow, close, one call only, nothing else, no other birds, no wind', seconds: 1},
  crows: {text: 'Distant crows cawing far away at dusk over a quiet Japanese town, faint evening ambience, no voices', seconds: 10, loop: true},
};

fs.mkdirSync(OUT, {recursive: true});
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SOUNDS)) {
  const file = path.join(OUT, name + '.mp3'), s = SOUNDS[name];
  if (fs.existsSync(file)) { console.log(name, 'ある'); continue; }
  const r = await fetch('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', {method: 'POST', headers: {'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json'},
    body: JSON.stringify({text: s.text, duration_seconds: s.seconds, prompt_influence: 0.5, loop: !!s.loop, model_id: 'eleven_text_to_sound_v2'})});
  if (!r.ok) { console.log(name, '失敗', r.status, (await r.text()).replaceAll(process.env.ELEVENLABS_API_KEY, '***').slice(0, 200)); process.exit(1); }
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  console.log(name, '作った', r.headers.get('character-cost'));
}
