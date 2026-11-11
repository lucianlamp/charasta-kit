#!/usr/bin/env node
// ショートの依頼(編集画面の「Claude に依頼する」)の CLI。動いているサーバーの API を通して読み書きする(画面の保存と同じ道を通るため)
//   node scripts/short-asks.mjs list [--short ID] [--port 8870]          対応待ちの依頼。カットの今のセリフ、テロップ、カメラも出す
//   node scripts/short-asks.mjs done --short ID (--cut N | --whole) --reply "何をしたか" [--port 8870]
//                                                                       直したあとに呼ぶ。返事を残して依頼を外し、カットの「確認した」も外す
import {cliArgs, need, fail, run} from '../lib/cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {pendingAsks, resolveAsk} from '../lib/short-asks.mjs';

const [cmd, ...rest] = process.argv.slice(2);
process.argv = [process.argv[0], process.argv[1], ...rest];
const v = cliArgs({short: {type: 'string'}, cut: {type: 'string'}, whole: {type: 'boolean'}, reply: {type: 'string'}, port: {type: 'string'}});
const base = `http://127.0.0.1:${v.port ?? loadConfig().port ?? 8870}`;
const api = async (method, path, body) => {
  const r = await fetch(base + path, {method, headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${j?.error ?? ''}`);
  return j;
};
const getShort = id => api('GET', '/api/shorts/' + encodeURIComponent(id));

run(async () => {
  if (cmd === 'list') {
    const all = v.short ? null : await api('GET', '/api/shorts'), ids = v.short ? [v.short] : (all.shorts ?? all).map(s => s.id);
    const asks = (await Promise.all(ids.map(async id => pendingAsks(await getShort(id))))).flat();
    console.log(JSON.stringify(asks, null, 2));
  } else if (cmd === 'done') {
    need(v, 'short', 'reply');
    if (!v.whole === !v.cut) fail('--cut N か --whole のどちらか 1 つ', 2);
    const short = await getShort(v.short);
    await api('PUT', '/api/shorts/' + encodeURIComponent(v.short), resolveAsk(short, {cut: v.whole ? null : Number(v.cut), reply: v.reply}));
    console.log(JSON.stringify({short: v.short, cut: v.whole ? 'whole' : Number(v.cut), reply: v.reply}));
  } else fail('使い方: short-asks.mjs list|done …', 2);
});
