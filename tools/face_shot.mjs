// 顔を 1 枚撮る(Grok へ渡す最初の絵。休めの姿勢、瞬きなし、口は閉じたまま、1280x720)。
//   node tools/face_shot.mjs --char <キャラ> [--ver <バージョン>] --out face.png [--port 8870] [--dist 0.7]
// サーバーが動いている前提。声のジョブ(lib/jobs.mjs)が呼ぶ。
import fs from 'node:fs';
import path from 'node:path';
import {loadConfig, loadPlaywright, parseArgs, viewerUrl, openViewer, HIDE_PANEL_CSS} from './common.mjs';
import {launchGPU} from './gpu_browser.mjs';

const args = parseArgs(), out = args.out; if (!out) throw Error('--out FILE が要る');
fs.mkdirSync(path.dirname(path.resolve(out)), {recursive: true});
const {chromium} = loadPlaywright(), url = viewerUrl(args, loadConfig());
const {browser} = await launchGPU(chromium);
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});
  page.on('console', m => { if (m.type() === 'error') console.log('PAGE', m.text()); });
  await openViewer(page, url);
  await page.addStyleTag({content: HIDE_PANEL_CSS + ' canvas{position:fixed!important;left:0;top:0;width:100vw!important;height:100vh!important;z-index:99}'});
  await page.evaluate((dist) => {
    const v = window.viewer;
    const blink = document.getElementById('autoBlink'); if (blink) blink.checked = false;
    v.paused = true; v.vrm.humanoid.resetNormalizedPose(); dispatchEvent(new Event('resize'));
    v.face(dist); for (let i = 0; i < 10; i++) v.step(1 / 30);
  }, Number(args.dist || 0.7));
  await page.screenshot({path: out});
  console.log('saved', out);
} finally { await browser.close(); }
