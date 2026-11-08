#!/usr/bin/env node
// node scripts/new-character.mjs --id chara4 --name キャラ4 --style standard|chibi|creature --note "..." [--voice grok:eve]
import {cliArgs, need, openLibrary, run} from '../lib/cli.mjs';

const v = cliArgs({id: {type: 'string'}, name: {type: 'string'}, note: {type: 'string'}, voice: {type: 'string'}, style: {type: 'string'}});
need(v, 'id', 'name', 'style');
await run(async () => {
  const ch = await openLibrary().createCharacter({id: v.id, name: v.name, note: v.note ?? '', voice: v.voice, style: v.style});
  console.log(JSON.stringify(ch, null, 2));
});
