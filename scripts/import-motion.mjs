#!/usr/bin/env node
// node scripts/import-motion.mjs --id vrma-02 --label 挨拶 --src <path.vrma> --license-json <file> [--expressions-json <file>] [--generated-json <file>] [--contacts-json <file>] [--name VRMA_02] [--pack "..."]
import fs from 'node:fs/promises';
import path from 'node:path';
import {cliArgs, need, openLibrary, run} from '../lib/cli.mjs';

const v = cliArgs({id: {type: 'string'}, label: {type: 'string'}, name: {type: 'string'}, src: {type: 'string'}, pack: {type: 'string'},
  'license-json': {type: 'string'}, 'expressions-json': {type: 'string'}, 'generated-json': {type: 'string'}, 'contacts-json': {type: 'string'}});
need(v, 'id', 'src', 'license-json');

await run(async () => {
  const src = path.resolve(v.src);
  const data = await fs.readFile(src);
  const license = JSON.parse(await fs.readFile(v['license-json'], 'utf8'));
  const readJson = async f => f ? JSON.parse(await fs.readFile(f, 'utf8')) : null;
  const expressions = await readJson(v['expressions-json']) ?? [];
  const m = await openLibrary().importMotion({id: v.id, name: v.name ?? path.basename(src, path.extname(src)), label: v.label ?? '',
    data, sourcePath: src, pack: v.pack ?? null, license, expressions, generated: await readJson(v['generated-json']), contacts: await readJson(v['contacts-json'])});
  console.log(JSON.stringify(m, null, 2));
});
