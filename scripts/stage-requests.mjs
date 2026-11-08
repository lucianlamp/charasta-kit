#!/usr/bin/env node
// ステージの頼みごと(ステージの画面の「新しいステージを頼む」、docs/stages.md)を、エージェントが読んで片付ける CLI。
// 保管場所(CHARASTA_LIBRARY か config.json の libraryDir)のファイルを直に読み書きする。サーバーは動いていなくてよい
//   node scripts/stage-requests.mjs list [--all] [--json]          対応待ちと作業中を古い順に。--all は完了と見送りも
//   node scripts/stage-requests.mjs show <ID> [--json]             1 件の全部。参考の絵はファイルの場所で出す
//   node scripts/stage-requests.mjs start <ID> [--json]            作業中にする(画面から取り下げられなくなる)
//   node scripts/stage-requests.mjs done <ID> --stage <シーン ID> --reply "何をしたか" [--stage-studio <dir>] [--json]
//                                                                  完了にする。シーンが stage-studio の catalog.json にあり、サムネイルがあるときだけ
//   node scripts/stage-requests.mjs decline <ID> --reply "作らない理由" [--json]
import path from 'node:path';
import {cliArgs, need, fail, run, openLibrary} from '../lib/cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {listStageRequests, getStageRequest, startStageRequest, finishStageRequest, declineStageRequest} from '../lib/stage-requests.mjs';

const STATE_LABEL = {waiting: '対応待ち', working: '作業中', done: '完了', declined: '見送り'};
const USAGE = '使い方: stage-requests.mjs list [--all] | show <ID> | start <ID> | done <ID> --stage <シーン ID> --reply "…" | decline <ID> --reply "…"  (どれも --json を付けられる)';

const [cmd, ...rest] = process.argv.slice(2);
const id = rest[0] && !rest[0].startsWith('--') ? rest.shift() : null;
process.argv = [process.argv[0], process.argv[1], ...rest];
const v = cliArgs({all: {type: 'boolean'}, json: {type: 'boolean'}, stage: {type: 'string'}, reply: {type: 'string'}, 'stage-studio': {type: 'string'}});

const libDir = openLibrary().dir;
// 参考の絵はエージェントが開けるよう、ファイルの場所を付ける
const full = r => ({...r, refs: r.refs.map(f => ({...f, path: path.join(libDir, 'stage-requests', r.id, f.file)}))});
const human = r => [`${r.id}  [${STATE_LABEL[r.state] ?? r.state}]  ${r.label}`, `  ${r.description.replace(/\n/g, '\n  ')}`,
  ...r.refs.map(f => `  参考の絵: ${f.path}${f.name ? `(${f.name})` : ''}`),
  ...(r.stageId ? [`  シーン: ${r.stageId}`] : []), ...(r.reply ? [`  返事: ${r.reply}`] : [])].join('\n');
const out = x => console.log(v.json ? JSON.stringify(x, null, 2) : Array.isArray(x) ? (x.length ? x.map(human).join('\n\n') : '頼みごとは無い') : human(x));
const needId = () => id ?? fail(USAGE, 2);

run(async () => {
  if (cmd === 'list') {
    const all = (await listStageRequests(libDir)).reverse();
    out(all.filter(r => v.all || r.state === 'waiting' || r.state === 'working').map(full));
  } else if (cmd === 'show') out(full(await getStageRequest(libDir, needId())));
  else if (cmd === 'start') out(full(await startStageRequest(libDir, needId())));
  else if (cmd === 'done') {
    needId(); need(v, 'stage', 'reply');
    out(full(await finishStageRequest(libDir, id, {stageDir: v['stage-studio'] ?? loadConfig().stageStudioDir, stageId: v.stage, reply: v.reply})));
  } else if (cmd === 'decline') {
    needId(); need(v, 'reply');
    out(full(await declineStageRequest(libDir, id, {reply: v.reply})));
  } else fail(USAGE, 2);
});
