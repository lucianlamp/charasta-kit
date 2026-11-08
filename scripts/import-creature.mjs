#!/usr/bin/env node
// node scripts/import-creature.mjs --char crow --id v1 --label "..." --note "..." --src <model.blend> --spec <creature.json> [--latest] [--no-thumb]
// 生き物(style が creature のキャラ)の版を取り込む。元のファイルは読むだけ。model.blend をコピーして sha256 を記録し、creature.json と version.json を書く。
// spec の Action の名前が blend に無ければ、何も作らずに止める(Blender の背景で確かめる)。サムネイル(thumb.png、512x512、rest の姿勢)も Blender で撮る。
// Blender は設定の blender か、環境変数 CHARASTA_BLENDER。docs/creature.md
import fs from 'node:fs/promises';
import path from 'node:path';
import {cliArgs, need, fail, run, openLibrary} from '../lib/cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {blenderPath, importCreature} from '../lib/creature.mjs';

const v = cliArgs({char: {type: 'string'}, id: {type: 'string'}, label: {type: 'string'}, note: {type: 'string'},
  src: {type: 'string'}, spec: {type: 'string'}, latest: {type: 'boolean'}, 'no-thumb': {type: 'boolean'}});
need(v, 'char', 'id', 'src', 'spec');

await run(async () => {
  let spec;
  try { spec = JSON.parse(await fs.readFile(path.resolve(v.spec), 'utf8')); } catch (e) { fail('--spec を JSON として読めない: ' + e.message, 2); }
  const blender = blenderPath(loadConfig());
  const {version, warnings, thumbError} = await importCreature(openLibrary(), {charId: v.char, id: v.id, label: v.label ?? '', note: v.note ?? '', src: v.src, spec, latest: !!v.latest},
    {blender, ...(v['no-thumb'] ? {thumb: async () => { throw new Error('--no-thumb でサムネイルを撮らなかった'); }} : {})});
  console.log(JSON.stringify(version, null, 2));
  for (const w of warnings) console.log('注意: ' + w);
  console.log(thumbError ? 'サムネイルを撮れなかった(取り込みは済んでいる): ' + thumbError : 'サムネイル: ' + path.join(openLibrary().versionDir(v.char, v.id), 'thumb.png'));
});
