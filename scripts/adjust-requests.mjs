#!/usr/bin/env node
// 直しの頼みごと(仕上げの「体型と揺れもの」の「Claude に頼む」、docs/adjust.md)を、エージェントが読んで片付ける CLI。
// 保管場所(CHARASTA_LIBRARY か config.json の libraryDir)のファイルを直に読み書きする。サーバーは動いていなくてよい
//   node scripts/adjust-requests.mjs list [--all] [--char <キャラ>] [--json]   対応待ちと作業中を古い順に。--all は完了と見送りも
//   node scripts/adjust-requests.mjs show <ID> [--json]                       1 件の全部。今の見た目の絵はファイルの場所で出す
//   node scripts/adjust-requests.mjs start <ID> [--json]                      作業中にする(画面から取り下げられなくなる)
//   node scripts/adjust-requests.mjs done <ID> --version <新しい版 ID> --reply "何をしたか" [--json]
//                                                                            完了にする。その版がこのキャラにあり、頼まれたときの版と別のときだけ
//   node scripts/adjust-requests.mjs decline <ID> --reply "直さない理由" [--json]
import path from 'node:path';
import {cliArgs, need, fail, run, openLibrary} from '../lib/cli.mjs';
import {ADJUST_AREAS, listAdjustRequests, getAdjustRequest, startAdjustRequest, finishAdjustRequest, declineAdjustRequest} from '../lib/adjust-requests.mjs';

const STATE_LABEL = {waiting: '対応待ち', working: '作業中', done: '完了', declined: '見送り'};
const USAGE = '使い方: adjust-requests.mjs list [--all] [--char <キャラ>] | show <ID> | start <ID> | done <ID> --version <新しい版 ID> --reply "…" | decline <ID> --reply "…"  (どれも --json を付けられる)';

const [cmd, ...rest] = process.argv.slice(2);
const id = rest[0] && !rest[0].startsWith('--') ? rest.shift() : null;
process.argv = [process.argv[0], process.argv[1], ...rest];
const v = cliArgs({all: {type: 'boolean'}, json: {type: 'boolean'}, char: {type: 'string'}, version: {type: 'string'}, reply: {type: 'string'}});

const lib = openLibrary();
// 絵はエージェントが開けるよう、ファイルの場所を付ける。元の版の VRM の場所も付ける
const full = r => ({...r, shotPath: r.shot ? path.join(lib.dir, 'adjust-requests', r.id, r.shot) : null,
  modelPath: path.join(lib.dir, 'characters', r.charId, 'versions', r.verId, 'model.vrm')});
const human = r => [`${r.id}  [${STATE_LABEL[r.state] ?? r.state}]  ${r.charId}/${r.verId}  ${ADJUST_AREAS[r.area] ?? r.area}`, `  ${r.text.replace(/\n/g, '\n  ')}`,
  ...(r.shotPath ? [`  今の見た目: ${r.shotPath}`] : []), `  元の版: ${r.modelPath}`,
  ...(r.newVersion ? [`  新しい版: ${r.newVersion}`] : []), ...(r.reply ? [`  返事: ${r.reply}`] : [])].join('\n');
const out = x => console.log(v.json ? JSON.stringify(x, null, 2) : Array.isArray(x) ? (x.length ? x.map(human).join('\n\n') : '頼みごとは無い') : human(x));
const needId = () => id ?? fail(USAGE, 2);

run(async () => {
  if (cmd === 'list') {
    const all = (await listAdjustRequests(lib.dir, {charId: v.char ?? null})).reverse();
    out(all.filter(r => v.all || r.state === 'waiting' || r.state === 'working').map(full));
  } else if (cmd === 'show') out(full(await getAdjustRequest(lib.dir, needId())));
  else if (cmd === 'start') out(full(await startAdjustRequest(lib.dir, needId())));
  else if (cmd === 'done') {
    needId(); need(v, 'version', 'reply');
    out(full(await finishAdjustRequest(lib, id, {version: v.version, reply: v.reply})));
  } else if (cmd === 'decline') {
    needId(); need(v, 'reply');
    out(full(await declineAdjustRequest(lib.dir, id, {reply: v.reply})));
  } else fail(USAGE, 2);
});
