#!/usr/bin/env node
// node scripts/import-line.mjs --char chara4 --id hello --text "こんにちは、よろしくね！" [--emotion relaxed] --voice grok:eve --src <audio>
import fs from 'node:fs/promises';
import path from 'node:path';
import {cliArgs, need, openLibrary, run} from '../lib/cli.mjs';

const v = cliArgs({char: {type: 'string'}, id: {type: 'string'}, text: {type: 'string'}, emotion: {type: 'string'},
  voice: {type: 'string'}, src: {type: 'string'}});
need(v, 'char', 'id', 'text', 'src');

await run(async () => {
  const src = path.resolve(v.src);
  const line = await openLibrary().importLine({charId: v.char, id: v.id, text: v.text, emotion: v.emotion ?? null,
    voice: v.voice, data: await fs.readFile(src), ext: path.extname(src), sourcePath: src});
  console.log(JSON.stringify(line, null, 2));
});
