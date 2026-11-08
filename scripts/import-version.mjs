#!/usr/bin/env node
// node scripts/import-version.mjs --char <キャラ> --id <版> --label "..." --note "..." --src <path.vrm> [--charakuru-project <id>] [--latest]
// node scripts/import-version.mjs --char chara2 --id v1-shapekeys ... --src-charakit <project.charakit> --member documents/vrm/<sha>.vrm
// 元のファイルは読むだけ。保管場所へコピーして sha256 を記録する。
import fs from 'node:fs/promises';
import path from 'node:path';
import {cliArgs, need, fail, openLibrary, run} from '../lib/cli.mjs';
import {readZipMember} from '../lib/zip.mjs';
import {findPython} from '../lib/platform.mjs';

const v = cliArgs({char: {type: 'string'}, id: {type: 'string'}, label: {type: 'string'}, note: {type: 'string'},
  src: {type: 'string'}, 'src-charakit': {type: 'string'}, member: {type: 'string'},
  'charakuru-project': {type: 'string'}, latest: {type: 'boolean'}});
need(v, 'char', 'id');
if (!v.src === !v['src-charakit']) fail('--src か --src-charakit のどちらか一方を指定する', 2);
if (v['src-charakit']) need(v, 'member');

await run(async () => {
  let data, sourcePath;
  if (v.src) { sourcePath = path.resolve(v.src); data = await fs.readFile(sourcePath); }
  else { sourcePath = `${path.resolve(v['src-charakit'])}!${v.member}`; data = await readZipMember(v['src-charakit'], v.member); }
  const ver = await openLibrary().importVersion({charId: v.char, id: v.id, label: v.label ?? '', note: v.note ?? '',
    data, sourcePath, charakuruProject: v['charakuru-project'] ?? null, latest: !!v.latest});
  console.log(JSON.stringify(ver, null, 2));
  // スマホ用の軽い VRM を作る（失敗しても取り込みは済んでいる）
  const dir = path.join(openLibrary().dir, 'characters', v.char, 'versions', v.id);
  const {spawnSync} = await import('node:child_process');
  const r = spawnSync(findPython() ?? 'python', [path.join(import.meta.dirname, '..', 'tools', 'make_lite.py'), path.join(dir, 'model.vrm'), path.join(dir, 'model-lite.vrm')], {encoding: 'utf8'});
  console.log(r.status === 0 ? r.stdout.trim() : 'スマホ用の軽い VRM を作れなかった: ' + (r.stderr || r.error));
});
