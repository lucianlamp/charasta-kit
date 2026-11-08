// モーション中に、揺れる髪の頂点が顔の前の面より内側へ入った数と深さを数える。あわせて後ろの低い角度から撮る。
// node tools/face_hair.mjs --char X --ver Y --motion ID --out DIR --skin <材質名の一部> [--seconds 24] [--json FILE]
import path from 'node:path';
import fs from 'node:fs';
import {loadConfig, loadPlaywright, parseArgs, viewerUrl, openViewer} from './common.mjs';
import {launchGPU} from './gpu_browser.mjs';
const args = parseArgs(); const {chromium} = loadPlaywright(); const {browser} = await launchGPU(chromium);
fs.mkdirSync(args.out, {recursive: true});
const page = await browser.newPage({viewport: {width: 640, height: 640}});
page.setDefaultTimeout(120000);
await page.addInitScript(() => { let s = 12345; Math.random = () => (s = s * 16807 % 2147483647) / 2147483647; });
await openViewer(page, viewerUrl(args, loadConfig()) + '&embed=1');
await page.addStyleTag({content: '#overlay{display:none!important} aside,header,nav,#panel,#side{display:none!important} canvas{position:fixed!important;left:0;top:0;width:100vw!important;height:100vh!important;z-index:99}'});
await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
await page.waitForTimeout(200);
await page.evaluate(async ({motion, skinName}) => {
  const v = window.viewer; await v.prepareShot({motion}); dispatchEvent(new Event('resize'));
  v.shotExpression('none');
  const THREE = await import('/vendor/three.module.js');
  const head = v.vrm.humanoid.getNormalizedBoneNode('head');
  const meshes = []; v.vrm.scene.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
  const mat = o => ([].concat(o.material)[0].name || '');
  const skin = meshes.filter(o => mat(o).includes(skinName) && !mat(o).includes('liner')), hair = meshes.filter(o => /hair/i.test(mat(o)));
  v.paused = true; v.vrm.humanoid.resetNormalizedPose(); v.vrm.scene.updateMatrixWorld(true); v.vrm.update(0); v.vrm.scene.updateMatrixWorld(true);
  const inv = new THREE.Matrix4(), p = new THREE.Vector3();
  const local = (m, i) => m.getVertexPosition(i, p).applyMatrix4(m.matrixWorld).applyMatrix4(inv);
  // 頭の座標の xy の 1.5 mm 格子に、顔の皮の一番前の z を塗る
  inv.copy(head.matrixWorld).invert();
  const C = 0.0015, X0 = -0.15, Y0 = -0.1, N = 240, Z = new Float32Array(N * N).fill(NaN);
  let tris = 0; const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const m of skin) {
    const I = m.geometry.index.array;
    for (let t = 0; t < I.length; t += 3) {
      a.copy(local(m, I[t])); b.copy(local(m, I[t + 1])); c.copy(local(m, I[t + 2])); tris++;
      for (let u = 0; u <= 1; u += 0.05) for (let w = 0; w <= 1 - u; w += 0.05) {
        const x = a.x * u + b.x * w + c.x * (1 - u - w), y = a.y * u + b.y * w + c.y * (1 - u - w), z = a.z * u + b.z * w + c.z * (1 - u - w);
        const ix = Math.floor((x - X0) / C), iy = Math.floor((y - Y0) / C);
        if (ix >= 0 && iy >= 0 && ix < N && iy < N) { const k = iy * N + ix; if (!(Z[k] >= z)) Z[k] = z; }
      }
    }
  }
  // 顔の見える所: 目の少し上から顎まで(頭の骨からの高さは指定)
  window.pen = (ymin, ymax, xmax) => {
    v.vrm.scene.updateMatrixWorld(true); inv.copy(head.matrixWorld).invert();
    let n = 0, maxd = 0;
    for (const m of hair) {
      const cnt = m.geometry.attributes.position.count;
      for (let i = 0; i < cnt; i += 2) {
        const q = local(m, i);
        if (q.y < ymin || q.y > ymax || Math.abs(q.x) > xmax) continue;
        const k = Math.floor((q.y - Y0) / C) * N + Math.floor((q.x - X0) / C), zs = Z[k];
        if (Number.isNaN(zs)) continue;
        const d = zs - q.z;
        if (d > 0.002 && d < 0.05) { n++; if (d > maxd) maxd = d; }
      }
    }
    return [n, Math.round(maxd * 1000) / 10];
  };
  window.info = {tris, hairVerts: hair.reduce((s, m) => s + m.geometry.attributes.position.count, 0), filled: Z.reduce((s, z) => s + (Number.isNaN(z) ? 0 : 1), 0)};
  window.rest = window.pen(0.0, 0.12, 0.075);
  v.paused = false;
  v.hold = true; v.vrm.scene.updateMatrixWorld(true); v.vrm.update(0); v.vrm.springBoneManager?.reset();
  for (let i = 0; i < 180; i++) v.step(1 / 60);
  v.hold = false;
}, {motion: args.motion, skinName: args.skin});
const info = await page.evaluate(() => window.info);
console.log(args.ver, JSON.stringify(info));
if (!info.tris || !info.hairVerts) {   // 名前で見つからなければ 0 件のまま「最大 0」と出さない
  const reason = `測れない: 顔の面の三角形 ${info.tris}、髪の頂点 ${info.hairVerts}`;
  console.log(reason);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({measured: false, reason}));
  await browser.close();
  process.exit(0);
}
const secs = Number(args.seconds || 24), N = Math.round(secs * 7.5); let total = 0, worstD = 0, worstN = 0, worstF = -1, bad = 0;
for (let f = 0; f < N; f++) {
  const [n, d] = await page.evaluate(() => { const v = window.viewer; for (let i = 0; i < 8; i++) v.step(1 / 60); return window.pen(0.0, 0.12, 0.075); });
  total += n; if (n) bad++; if (n > worstN) { worstN = n; worstF = f; } if (d > worstD) worstD = d;
  if (f % 30 === 15) {   // 後ろの低い所から、今の頭を見る
    for (const [name, yaw] of [['back', 180], ['backL', 135]]) {
      await page.evaluate(yaw => {
        const v = window.viewer, T = v.camera.position.constructor, h = v.vrm.humanoid.getNormalizedBoneNode('head').getWorldPosition(new T());
        const a = yaw * Math.PI / 180, b = -30 * Math.PI / 180, dist = 0.7, t = h.clone(); t.y += .08;
        v.follow = false; v.controls.target.copy(t); v.camera.fov = 30; v.camera.updateProjectionMatrix();
        v.camera.position.set(t.x + dist * Math.sin(a) * Math.cos(b), t.y + dist * Math.sin(b), t.z + dist * Math.cos(a) * Math.cos(b));
        v.camera.lookAt(t); v.step(0);   // カメラを置いたあとに描く(時刻は進めない)
      }, yaw);
      await page.screenshot({path: path.join(args.out, `${name}_${String(f).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92});
    }
  }
}
console.log(args.ver, args.motion, 'frames', N, 'frames with hair inside', bad, 'worst verts', worstN, 'at', worstF, 'max depth mm', worstD);
if (args.json) fs.writeFileSync(args.json, JSON.stringify({measured: true, frames: N, framesWithHair: bad, worstVerts: worstN, worstFrame: worstF, maxDepthMm: worstD}));
await browser.close();
