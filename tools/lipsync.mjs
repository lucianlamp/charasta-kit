// セリフ 1 つのリップシンクを 1 コマずつ撮る（30 fps、顔のアップ）。音声は ffmpeg で付ける。
//   node tools/lipsync.mjs --char <キャラ> [--ver <バージョン>] --line hello --out frames_dir [--seconds 3.2] [--framing face|upper] [--port 8870]
//   ffmpeg -framerate 30 -i frames_dir/f%04d.png -i <保管場所>/characters/<キャラ>/lines/hello/audio.mp3 -t SECONDS -c:v libx264 -pix_fmt yuv420p -c:a aac out.mp4
// --line はセリフ ID。ビューアの window.viewer.playVoice(lineId, true) で口の計画だけ作り、voice.time を手で進める。
// --seconds を省くと、音声の長さ（voice.audio.duration）を使う。
import fs from 'node:fs';
import path from 'node:path';
import {loadConfig, loadPlaywright, parseArgs, needId, viewerUrl, openViewer, HIDE_PANEL_CSS} from './common.mjs';
import {launchGPU} from './gpu_browser.mjs';

const args = parseArgs(), out = args.out; if (!out) throw Error('--out DIR が要る');
const line = needId(args.line, 'line');
const framing = args.framing || 'face'; if (!['face', 'upper'].includes(framing)) throw Error('--framing は face か upper');
// face: 顔のアップ。upper: 胸から上(距離を取り、狙いを首の下へ下げる)
const [dist, drop] = framing === 'upper' ? [1.4, 0.15] : [0.85, 0.07];
fs.mkdirSync(out, {recursive: true});
const {chromium} = loadPlaywright(), url = viewerUrl(args, loadConfig());
const {browser} = await launchGPU(chromium);
try {
  const page = await browser.newPage({viewport: {width: 720, height: 720}});
  page.on('console', m => { if (m.type() === 'error') console.log('PAGE', m.text()); });
  await openViewer(page, url);
  await page.addStyleTag({content: HIDE_PANEL_CSS});
  const duration = await page.evaluate(async ([line, dist, drop]) => {
    dispatchEvent(new Event('resize')); const v = window.viewer;
    v.paused = true; v.vrm.humanoid.resetNormalizedPose(); v.face(dist);
    v.controls.target.y -= drop; v.camera.position.y -= drop; v.controls.update();
    await v.playVoice(line, true); v.voice.time = 0; for (let i = 0; i < 10; i++) v.step(1 / 30);
    const d = v.voice.audio.duration; return Number.isFinite(d) ? d : 0;
  }, [line, dist, drop]);
  const seconds = Number(args.seconds || duration);
  if (!(seconds > 0)) throw Error('長さが分からない。--seconds を付ける');
  const N = Math.round(seconds * 30);
  for (let f = 0; f < N; f++) {
    await page.evaluate((t) => { const v = window.viewer; v.voice.time = t; v.step(1 / 30); }, f / 30);
    await page.screenshot({path: path.join(out, `f${String(f).padStart(4, '0')}.png`)});
  }
  console.log('frames', N, 'seconds', seconds);
} finally { await browser.close(); }
