// シェイプキー方式の版の、Fcl_ のキーを 1 つずつ撮る(docs/expression-studio.md)。サーバーが動いている前提。
//   node tools/face_keys.mjs --char <キャラ> --ver <版> --out DIR [--port 8870]
// 全部のキーと、開いた口でないと見えない歯のキーの組み合わせを、正面の寄りで撮る。DIR/index.json に lib/face-check.mjs の keyPlan の一覧を書く。
// VRM の表情の更新は止め、モーフの重みを直接置く(プリセットに割り当てていないキーも同じに撮るため)。
import fs from 'node:fs';
import path from 'node:path';
import {loadConfig, loadPlaywright, parseArgs, viewerUrl, openViewer, HIDE_PANEL_CSS} from './common.mjs';
import {launchGPU} from './gpu_browser.mjs';
import {isFcl, keyPlan} from '../lib/face-check.mjs';

const args = parseArgs();
if (!args.out) throw Error('--out DIR が要る');
fs.mkdirSync(args.out, {recursive: true});
const {chromium} = loadPlaywright(), {browser} = await launchGPU(chromium);
try {
  const page = await browser.newPage({viewport: {width: 560, height: 560}});
  page.setDefaultTimeout(120000);
  page.on('console', m => { if (m.type() === 'error') console.log('PAGE', m.text()); });
  await openViewer(page, viewerUrl(args, loadConfig()));
  await page.addStyleTag({content: HIDE_PANEL_CSS + ' canvas{position:fixed!important;left:0;top:0;width:100vw!important;height:100vh!important;z-index:99} #overlay{display:none!important}'});
  const names = await page.evaluate(() => {
    const v = window.viewer; v.paused = true; v.vrm.humanoid.resetNormalizedPose(); dispatchEvent(new Event('resize'));
    v.vrm.expressionManager.update = () => {};
    v.vrm.lookAt.target = null; v.camera.fov = 24; v.camera.near = 0.01; v.camera.updateProjectionMatrix();
    const T = v.camera.position.constructor, h = v.vrm.humanoid.getNormalizedBoneNode('head').getWorldPosition(new T()); h.y += 0.07;
    v.controls.target.copy(h); v.camera.position.set(h.x, h.y, h.z + 0.5); v.controls.update();
    const ms = []; v.vrm.scene.traverse(o => { if (o.isMesh && o.morphTargetDictionary && Object.keys(o.morphTargetDictionary).some(k => /(^|_)Fcl_EYE_Close$/.test(k))) ms.push(o); });
    if (!ms.length) throw Error('Fcl_ のキーを持つメッシュが無い');
    window.setKey = k => { for (const m of ms) { m.morphTargetInfluences.fill(0); for (const q of k.split('+')) m.morphTargetInfluences[m.morphTargetDictionary[q]] = 1; } for (let i = 0; i < 3; i++) v.step(1 / 60); };
    return Object.keys(ms[0].morphTargetDictionary);
  });
  const index = keyPlan(names.filter(isFcl));
  for (const p of index) {
    await page.evaluate(k => window.setKey(k), p.key);
    await page.screenshot({path: path.join(args.out, p.file)});
  }
  fs.writeFileSync(path.join(args.out, 'index.json'), JSON.stringify(index, null, 1));
  console.log('keys', index.length);
} finally { await browser.close(); }
