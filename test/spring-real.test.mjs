// ビューアの揺れ骨を本物のブラウザで確かめる試験。CHARASTA_TEST_VRM のときだけ動く(ブラウザと GPU を使う)。
//   CHARASTA_TEST_VRM=<center の指定が無い VRM> CHARASTA_TEST_VRM_CENTER=<center の指定がある VRM> CHARASTA_TEST_MOTION=<motion のフォルダ> node --test test/spring-real.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Library} from '../lib/library.mjs';
import {startServer, fakeCharakuru} from './helpers.mjs';
import {loadPlaywright, openViewer} from '../tools/common.mjs';
import {launchGPU} from '../tools/gpu_browser.mjs';

const VRM = process.env.CHARASTA_TEST_VRM, VRM_CENTER = process.env.CHARASTA_TEST_VRM_CENTER, MOTION = process.env.CHARASTA_TEST_MOTION;

// 頭から前へ出た髪の鎖を集め、window.bang() で、頭の座標での休めの向きとの角度の最大(度)を返す
const BANGS = () => {
  const v = window.viewer, vrm = v.vrm, head = vrm.humanoid.getRawBoneNode('head'), THREE = window.THREE;
  const joints = [...vrm.springBoneManager.joints], byBone = new Map(joints.map(j => [j.bone, j]));
  const tip = j => { let t = j; while (t.child && byBone.has(t.child)) t = byBone.get(t.child); return t.child || t.bone; };
  v.seek(0);   // 揺れを戻してから休めの向きを取る
  const local = o => head.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
  window.chains = joints.filter(j => !byBone.has(j.bone.parent) && /Hair/i.test(j.bone.name)).map(j => {
    const e = tip(j), a = local(j.bone), b = local(e);
    return {a: j.bone, e, rest: b.clone().sub(a).normalize(), front: b.z > 0.04};
  }).filter(c => c.front);
  window.bang = () => Math.max(...window.chains.map(c => local(c.e).sub(local(c.a)).normalize().angleTo(c.rest))) * 180 / Math.PI;
  return window.chains.length;
};

test('揺れ骨: seek、撮影の一致、center、等速と往復', {skip: VRM && MOTION ? false : 'CHARASTA_TEST_VRM と CHARASTA_TEST_MOTION が無い'}, async t => {
  const s = await startServer({charakuruApp: await fakeCharakuru()});
  const {browser} = await launchGPU(loadPlaywright().chromium);
  try {
    const lib = new Library(s.libraryDir), mid = path.basename(MOTION);
    await lib.createCharacter({id: 'c1', name: 'C1'});
    await lib.importVersion({charId: 'c1', id: 'v1', label: '', note: 'n', data: await fs.readFile(VRM), sourcePath: VRM});
    await fs.cp(MOTION, path.join(s.libraryDir, 'motions', mid), {recursive: true});
    const open = async ({stop = true, ch = 'c1'} = {}) => {
      const page = await browser.newPage({viewport: {width: 320, height: 320}});
      await page.addInitScript(() => { let n = 1; Math.random = () => (n = n * 16807 % 2147483647) / 2147483647; });
      await openViewer(page, `${s.base}/viewer?char=${ch}&ver=v1&follow=0&motion=${mid}`);
      await page.waitForFunction(() => window.viewer.duration > 0, null, {polling: 100});
      if (stop) { await page.evaluate(() => { window.requestAnimationFrame = () => 0; }); await page.waitForTimeout(100); }
      await page.evaluate(async () => { window.THREE = await import('/vendor/three.module.js'); });
      return page;
    };

    await t.test('hold のまま遠い時刻へ seek しても前髪は動かない', async () => {
      const page = await open();
      assert.ok(await page.evaluate(BANGS) > 0, '前髪の鎖が無い');
      const r = await page.evaluate(() => {
        const v = window.viewer; v.hold = true; for (let i = 0; i < 30; i++) v.step(1 / 60);
        const out = [];
        for (const f of [.8, .1, .6]) {
          v.seek(v.duration * f); let max = 0;
          for (let i = 0; i < 30; i++) { v.step(1 / 60); max = Math.max(max, window.bang()); }
          out.push(max);
        }
        return out;
      });
      assert.ok(Math.max(...r) < 5, `前髪の角度 ${r}`);   // 止まっていても頭のコライダーの分だけ 3.5 度ほど残る。seek で飛ぶと 90 度を超える
      await page.close();
    });

    await t.test('rAF の走る時間が違っても同じ撮影になる', async () => {
      const shot = async wait => {
        const page = await open({stop: false});
        await page.waitForTimeout(wait);
        await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
        await page.waitForTimeout(100);
        const r = await page.evaluate(async mid => {
          const v = window.viewer; await v.prepareShot({motion: mid}); v.aimShot({framing: 'full', aspect: 1});
          v.hold = true; v.vrm.scene.updateMatrixWorld(true); v.vrm.update(0); v.vrm.springBoneManager.reset();
          for (let i = 0; i < 30; i++) v.step(1 / 60);
          v.hold = false; const out = [];
          for (let i = 0; i < 40; i++) { v.step(1 / 60); v.step(1 / 60); if (i % 10 === 9) out.push(document.querySelector('canvas').toDataURL()); }
          return out;
        }, mid);
        await page.close(); return r;
      };
      const a = await shot(200), b = await shot(1700);
      assert.equal(a.length, 4);
      a.forEach((x, i) => assert.ok(x === b[i], `${i} 番目のコマが違う`));
    });

    await t.test('等速では前髪の角度が変わらず、左右の往復では揺れが残る', async () => {
      const page = await open();
      assert.ok(await page.evaluate(BANGS) > 0, '前髪の鎖が無い');
      const r = await page.evaluate(() => {
        const v = window.viewer, h = v.vrm.humanoid, dt = 1 / 60; v.paused = true; h.resetNormalizedPose();
        const hips = h.getNormalizedBoneNode('hips');
        for (let i = 0; i < 180; i++) v.step(dt);
        const base = window.bang();
        let x = hips.position.x;
        for (let i = 0; i < 240; i++) { x += 1.5 * Math.min(1, i / 60) * dt; hips.position.x = x; v.step(dt); }   // 1 秒で 1.5 m/s まで上げる
        let steady = 0; for (let i = 0; i < 180; i++) { x += 1.5 * dt; hips.position.x = x; v.step(dt); steady = Math.max(steady, window.bang()); }
        const end = x; let swing = 0;
        for (let i = 0; i < 240; i++) { hips.position.x = end + 0.08 * Math.sin(2 * Math.PI * 2 * i * dt); v.step(dt); if (i > 120) swing = Math.max(swing, window.bang()); }
        return {base, steady, swing};
      });
      assert.ok(r.steady - r.base < 6, JSON.stringify(r));
      assert.ok(r.swing - r.base > 8, JSON.stringify(r));
      await page.close();
    });

    await t.test('center の指定が無いモデルはビューアの点、指定があるモデルはその値', {skip: VRM_CENTER ? false : 'CHARASTA_TEST_VRM_CENTER が無い'}, async () => {
      await lib.createCharacter({id: 'c2', name: 'C2'});
      await lib.importVersion({charId: 'c2', id: 'v1', label: '', note: 'n', data: await fs.readFile(VRM_CENTER), sourcePath: VRM_CENTER});
      const centers = () => { const v = window.viewer; return [...new Set([...v.vrm.springBoneManager.joints].map(j => j.center))].map(c => { let p = c; while (p && p !== v.vrm.scene) p = p.parent; return {inModel: !!p, name: c.name}; }); };
      const a = await open(), b = await open({ch: 'c2'});
      assert.deepEqual(await a.evaluate(centers), [{inModel: false, name: ''}]);
      const cb = await b.evaluate(centers);
      assert.ok(cb.length === 1 && cb[0].inModel && cb[0].name, JSON.stringify(cb));
      await a.close(); await b.close();
    });
  } finally { await browser.close(); await s.close(); }
});
