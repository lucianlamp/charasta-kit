#!/usr/bin/env node
// 版をゲーム用に書き出す(docs/game-export.md)。サーバーなしで、ジョブ game-export と同じ処理を動かす。
//   node scripts/game-export.mjs --char <キャラ> --ver <版> [--motions <モーション>,<モーション>] [--target 20000] [--springs skirt=1.5,0.6,0.3] [--springs hair=2,0.5,0.1]
// 結果は 保管場所/characters/<キャラ>/versions/<版>/game/<書き出し ID>/ に置く。--springs を一つでも渡すと、既定(skirt=1.5,0.6,0.3)は使わない。
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cliArgs, need, openLibrary, run} from '../lib/cli.mjs';
import {findPython} from '../lib/platform.mjs';
import {gameExportInput, runGameExport, parseSpringArgs} from '../lib/game-export.mjs';

const v = cliArgs({char: {type: 'string'}, ver: {type: 'string'}, motions: {type: 'string'}, target: {type: 'string'}, springs: {type: 'string', multiple: true}});
need(v, 'char', 'ver');
const exec = promisify(execFile);

await run(async () => {
  const lib = openLibrary();
  const input = await gameExportInput(lib, {charId: v.char, verId: v.ver, motions: v.motions ? v.motions.split(',').filter(Boolean) : [],
    ...(v.target !== undefined && {target: Number(v.target)}), ...(v.springs && {springs: parseSpringArgs(v.springs)})});
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'charasta-game-export-'));
  const ctx = {job: {input}, workDir, log: t => process.stderr.write(t), step: async s => console.error('== ' + s),
    run: async (cmd, args) => {
      if (cmd !== 'python') throw new Error('知らないコマンド: ' + cmd);
      console.error(`$ ${cmd} ${args.join(' ')}`);
      const r = await exec(findPython() ?? 'python', args, {env: {...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'}, maxBuffer: 1 << 26});
      if (r.stderr) process.stderr.write(r.stderr);
      return r.stdout;
    }};
  try { console.log(JSON.stringify(await runGameExport(ctx, {lib}), null, 2)); }
  finally { await fs.rm(workDir, {recursive: true, force: true}); }
});
