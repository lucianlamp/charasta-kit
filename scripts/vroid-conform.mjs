#!/usr/bin/env node
// きゃらくるの VRM 1.0 を VRoid Studio と同じ中身の作りにそろえる(docs/vroid-format.md、lib/vroid-conform.mjs)。入力は読むだけ。
//   node scripts/vroid-conform.mjs --in <vrm> --out <vrm> [--map <材質の対応 JSON>] [--report <json>] [--ref <reference.json>] [--outline <mm>] [--hair-outline <mm>]
//   --outline: 目、口、眉の部品は線なし、顔の輪郭とほかは指定の太さ(mm、世界座標)の暗い赤茶の線。省くと線は元のまま
//   --hair-outline: --outline を付けたときの髪の線の太さ(mm)。既定 0.4
import path from 'node:path';
import fs from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {fail, run} from '../lib/cli.mjs';
import {root} from '../lib/config.mjs';
import {conformVrm, ConformError} from '../lib/vroid-conform.mjs';

let v;
try { v = parseArgs({options: {in: {type: 'string'}, out: {type: 'string'}, map: {type: 'string'}, report: {type: 'string'}, ref: {type: 'string'}, outline: {type: 'string'}, 'hair-outline': {type: 'string'}}, strict: true}).values; } catch (e) { fail(e.message, 2); }
if (!v.in || !v.out) fail('--in と --out が要る', 2);
const outline = v.outline == null ? null : Number(v.outline) / 1000;
if (outline != null && !Number.isFinite(outline)) fail('--outline は mm の数', 2);
const hairOutline = v['hair-outline'] == null ? undefined : Number(v['hair-outline']) / 1000;
if (hairOutline !== undefined && !Number.isFinite(hairOutline)) fail('--hair-outline は mm の数', 2);
if (path.resolve(v.in).toLowerCase() === path.resolve(v.out).toLowerCase()) fail('--in と --out が同じファイル', 2);

run(async () => {
  const ref = JSON.parse(await fs.readFile(v.ref ?? path.join(root, 'studio', 'vroid', 'reference.json'), 'utf8'));
  const map = v.map ? JSON.parse(await fs.readFile(v.map, 'utf8')) : {};
  const writeReport = r => v.report ? fs.writeFile(v.report, JSON.stringify(r, null, 1) + '\n') : null;
  try {
    const {glb, report} = conformVrm(await fs.readFile(v.in), {ref, map, from: v.in, outline, hairOutline});
    await fs.mkdir(path.dirname(path.resolve(v.out)), {recursive: true});
    await fs.writeFile(v.out, glb);
    await writeReport({stopped: null, ...report});
    console.log(`${v.out}: 骨 ${report.humanoidBones}、ひも ${report.springs.count}(${JSON.stringify(report.springs.byKind)})、コライダー ${report.colliders.count}、メッシュ ${report.meshes.map(m => m.role).join('・')}`);
  } catch (e) {
    if (!(e instanceof ConformError)) throw e;
    await writeReport({stopped: e.stops});
    fail(`止めた: ${e.stops.join(' / ')}`, 3);
  }
});
