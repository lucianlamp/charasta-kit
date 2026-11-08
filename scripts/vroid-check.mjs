#!/usr/bin/env node
// VRoid 形式の検査(docs/vroid-format.md)。読むだけで、保管場所にもファイルにも書かない(reference だけは studio/vroid/reference.json を書く)
//   node scripts/vroid-check.mjs check (--char ID [--ver ID] | --file <vrm>) [--json]   版か VRM ファイルを手本と比べる
//   node scripts/vroid-check.mjs reference --file <vrm> --file <vrm> ... [--layout <vrm>]   手本を作り直す(VRoid 公式サンプルの VRM 1.0)。コライダーの置き方は --layout の VRM(無ければ最初の --file)から取る
import path from 'node:path';
import fs from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {fail, run, openLibrary} from '../lib/cli.mjs';
import {root} from '../lib/config.mjs';
import {readGlbJson} from '../lib/glb.mjs';
import {profileOf, referenceOf, checkVroid, summary} from '../lib/vroid-format.mjs';
import {colliderLayout} from '../lib/vroid-conform.mjs';

const [cmd, ...rest] = process.argv.slice(2);
let v;
try { v = parseArgs({args: rest, options: {char: {type: 'string'}, ver: {type: 'string'}, file: {type: 'string', multiple: true}, json: {type: 'boolean'}, layout: {type: 'string'}}, strict: true}).values; } catch (e) { fail(e.message, 2); }
const REF = path.join(root, 'studio', 'vroid', 'reference.json');

run(async () => {
  if (cmd === 'reference') {
    if (!v.file?.length) fail('--file を 1 つ以上', 2);
    const ref = referenceOf(await Promise.all(v.file.map(async f => profileOf(await readGlbJson(f)))), v.file.map(f => path.basename(path.dirname(path.dirname(path.dirname(f)))) || path.basename(f)));
    ref.colliderLayout = colliderLayout(await readGlbJson(v.layout ?? v.file[0]));
    await fs.mkdir(path.dirname(REF), {recursive: true});
    await fs.writeFile(REF, JSON.stringify(ref, null, 1) + '\n');
    console.log(`${REF}: キー ${ref.morphs.length}、骨 ${Object.keys(ref.human).length}、コライダーの骨 ${Object.keys(ref.colliders).length}`);
  } else if (cmd === 'check') {
    let file = v.file?.[0];
    if (!file) {
      if (!v.char) fail('--char か --file', 2);
      const lib = openLibrary(), c = await lib.getCharacter(v.char), ver = v.ver ?? c.latestVersion;
      file = path.join(lib.dir, 'characters', v.char, 'versions', ver, 'model.vrm');
    }
    const ref = JSON.parse(await fs.readFile(REF, 'utf8')), items = checkVroid(profileOf(await readGlbJson(file)), ref);
    if (v.json) { console.log(JSON.stringify({file, summary: summary(items), items}, null, 1)); return; }
    const mark = {ok: '○', warn: '△', ng: '×'};
    for (const i of items) console.log(`${mark[i.level]} ${i.label}: ${i.detail}`);
    const s = summary(items);
    console.log(`\n${path.basename(file)}: ○ ${s.ok} / △ ${s.warn} / × ${s.ng}(全 ${s.total} 項目)`);
  } else fail('使い方: vroid-check.mjs check|reference …', 2);
});
