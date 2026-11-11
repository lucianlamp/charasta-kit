// サムネイル撮影: バージョンの正面の全身を 512x512 で撮り、保管場所の versions/<ver>/thumb.png に書く。
// node tools/thumb.mjs --char <キャラ> --ver <バージョン> [--port <ポート>]   （サーバーが動いている前提。--port は設定と違うポートで動いているとき）
import fs from 'node:fs';
import path from 'node:path';
import {loadConfig, loadPlaywright, parseArgs, needId, viewerUrl, openViewer, HIDE_PANEL_CSS} from './common.mjs';
import {launchGPU} from './gpu_browser.mjs';

const args = parseArgs(), config = loadConfig();
const char = needId(args.char, 'char'), ver = needId(args.ver, 'ver');
const dir = path.join(config.libraryDir, 'characters', char, 'versions', ver);
if (!fs.existsSync(path.join(dir, 'version.json'))) throw Error(`バージョンがない: ${dir}`);

const {chromium} = loadPlaywright();
const {browser} = await launchGPU(chromium);
try {
  const page = await browser.newPage({viewport: {width: 512, height: 512}});
  page.on('console', m => { if (m.type() === 'error') console.log('PAGE', m.text()); });
  await openViewer(page, viewerUrl({char, ver, port: args.port}, config));
  await page.addStyleTag({content: HIDE_PANEL_CSS + ' canvas{position:fixed!important;left:0;top:0;width:100vw!important;height:100vh!important;z-index:99}'});
  await page.evaluate(() => {
    const v = window.viewer; v.paused = true; dispatchEvent(new Event('resize'));
    v.vrm.humanoid.resetNormalizedPose();   // 休めの姿勢（腕を下ろす）
    for (const [b, z] of [['leftUpperArm', -1.15], ['rightUpperArm', 1.15]]) v.vrm.humanoid.getNormalizedBoneNode(b).rotation.z = z;
    v.vrm.lookAt.target = null;
    // 正面の全身: モデルの外接箱から距離を決める
    const T = v.camera.position.constructor, box = {min: new T(1e9, 1e9, 1e9), max: new T(-1e9, -1e9, -1e9)};
    v.vrm.scene.updateMatrixWorld(true);
    v.vrm.scene.traverse(o => { if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingBox(); const b = o.geometry.boundingBox, m = o.matrixWorld;
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        const p = new T(x, y, z).applyMatrix4(m); box.min.min(p); box.max.max(p); } });
    const h = box.max.y - box.min.y, cy = (box.max.y + box.min.y) / 2, fov = 30;
    v.camera.fov = fov; v.camera.near = 0.01; v.camera.far = 100; v.camera.aspect = 1; v.camera.updateProjectionMatrix();
    const dist = (h * 0.58) / Math.tan(fov * Math.PI / 360);
    v.controls.target.set(0, cy, 0); v.camera.position.set(0, cy, dist); v.controls.update();
    for (let i = 0; i < 5; i++) v.step(1 / 60);
  });
  const file = path.join(dir, 'thumb.png');
  await page.screenshot({path: file});
  console.log('thumb', file);
} finally { await browser.close(); }
