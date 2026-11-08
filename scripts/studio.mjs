#!/usr/bin/env node
// 表情づくり(docs/expression-studio.md)の CLI。保管場所を直接読み書きする。ジョブ(run)と候補(candidate)は動いているサーバーに送る。
// 同じ表情づくりを持つサーバーが動いている間は、work.json を書く rects・options・video もサーバーの API を通す
// (サーバーのジョブや画面の書き込みと取り合わないため)。adopt は API が無いので、その間は断る(画面か API で行う、またはサーバーを止めてから)。
//   node scripts/studio.mjs create   --char chara4 [--id ID] [--note "..."]
//   node scripts/studio.mjs list     --char chara4
//   node scripts/studio.mjs status   --char chara4 --id ID
//   node scripts/studio.mjs projects                                   きゃらくるのプロジェクトの一覧(読むだけ)
//   node scripts/studio.mjs copy     --char chara4 --id ID (--project <きゃらくるのプロジェクト ID> | --from-studio <ID>)
//   node scripts/studio.mjs adopt    --char chara4 --id ID --from <フォルダかファイル> [--to <drawn/ の下>] [--pattern '*.png'] [--note "..."]
//   node scripts/studio.mjs rects    --char chara4 --id ID --json rects.json
//   node scripts/studio.mjs options  --char chara4 --id ID --json options.json   (front / build / video / springTune。2 段目まで重ねる)
//   node scripts/studio.mjs video    --char chara4 --id ID (--name blink --src blink.mp4 | --dir <NAME.mp4 のフォルダ>)
//   node scripts/studio.mjs run      --char chara4 --id ID --step front|build|video|checks [--proto N] [--set accept|full] [--wait] [--port 8870]
//   node scripts/studio.mjs promote  --char chara4 --id ID --proto N --ver <版 ID> --label "..." --note "変えたこと" [--latest]
//   node scripts/studio.mjs requests [--char chara4] [--id ID] [--all]  未着手の依頼(Claude が読む。--all で全部の状態)。却下した候補と理由も出す
//   node scripts/studio.mjs candidate --char chara4 --id ID --request r001 --file cand.png [--note "..."] [--port 8870]
//                                                                      候補を置く(動いているサーバーを通す。work.json をサーバーと取り合わないため)
// 候補の採用と却下は画面で人が決める(CLI には無い)。
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fail, run} from '../lib/cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {Library} from '../lib/library.mjs';
import {Studio, EXPRESSIONS, STUDIO_JOBS} from '../lib/studio.mjs';

const OPTS = {char: {type: 'string'}, id: {type: 'string'}, note: {type: 'string'}, project: {type: 'string'}, 'from-studio': {type: 'string'},
  from: {type: 'string'}, to: {type: 'string'}, pattern: {type: 'string'}, json: {type: 'string'}, name: {type: 'string'}, src: {type: 'string'},
  dir: {type: 'string'}, step: {type: 'string'}, proto: {type: 'string'}, set: {type: 'string'}, wait: {type: 'boolean'}, port: {type: 'string'},
  ver: {type: 'string'}, label: {type: 'string'}, latest: {type: 'boolean'}, all: {type: 'boolean'}, request: {type: 'string'}, file: {type: 'string'}};
const [cmd, ...rest] = process.argv.slice(2);
let v;
try { v = parseArgs({args: rest, options: OPTS, strict: true, allowPositionals: false}).values; } catch (e) { fail(e.message, 2); }
const need = (...names) => { const m = names.filter(n => v[n] == null || v[n] === ''); if (m.length) fail('必要な引数が無い: ' + m.map(n => '--' + n).join(' '), 2); };
const cfg = loadConfig();
const studio = new Studio(new Library(process.env.CHARASTA_LIBRARY || cfg.libraryDir), {charakuruApp: cfg.charakuruApp, blender: cfg.blender});
const out = x => console.log(JSON.stringify(x, null, 2));
const readJsonFile = async f => JSON.parse(await fs.readFile(f, 'utf8'));

const origin = () => `http://127.0.0.1:${v.port ?? cfg.port}`;
const studioUrl = (...rest) => `/api/studio/${[v.char, v.id, ...rest].map(encodeURIComponent).join('/')}`;

// 設定のポートで動いているサーバーが返す、この表情づくりの status(通らなければ null)
async function liveStatus() {
  try {
    const r = await fetch(origin() + studioUrl(), {signal: AbortSignal.timeout(3000)});
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
// そのサーバーの作業場所が、この CLI の保管場所のものか(CHARASTA_LIBRARY だけでテスト用を指したとき、本番のサーバーと取り違えない)
const sameWork = s => !!s?.dir && path.relative(path.resolve(s.dir), studio.dir(v.char, v.id)) === '';

async function api(method, url, body) {
  const r = await fetch(`${origin()}${url}`, {method, headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(j?.error ?? r.status), {code: j?.code});
  return j;
}

await run(async () => {
  switch (cmd) {
    case 'create': need('char'); return out(await studio.create({charId: v.char, id: v.id, note: v.note ?? ''}));
    case 'list': need('char'); return out(await studio.list(v.char));
    case 'status': need('char', 'id'); return out(await studio.status(v.char, v.id));
    case 'projects': return out(await studio.listProjects());
    case 'copy': {
      need('char', 'id');
      const w = await studio.copyInputs(v.char, v.id, {project: v.project, fromStudio: v['from-studio']});
      return out({source: w.source, inputs: w.inputs});
    }
    case 'adopt':
      need('char', 'id', 'from');
      if (sameWork(await liveStatus())) fail('サーバーが動いている間は adopt できない(API が無い)。画面か API で行うか、サーバーを止めてからやる', 1);
      return out(await studio.adopt(v.char, v.id, {from: path.resolve(v.from), to: v.to ?? '', pattern: v.pattern ?? '*', note: v.note ?? ''}));
    case 'rects': {
      need('char', 'id', 'json');
      const body = await readJsonFile(v.json);
      return out((sameWork(await liveStatus()) ? await api('PUT', studioUrl('rects'), body) : await studio.setRects(v.char, v.id, body)).rects);
    }
    case 'options': {
      need('char', 'id', 'json');
      const body = await readJsonFile(v.json);
      return out((sameWork(await liveStatus()) ? await api('PATCH', studioUrl('options'), body) : await studio.setOptions(v.char, v.id, body)).options);
    }
    case 'video': {
      need('char', 'id');
      const list = v.dir ? EXPRESSIONS.map(n => ({name: n, src: path.join(path.resolve(v.dir), n + '.mp4')}))
        : (need('name', 'src'), [{name: v.name, src: path.resolve(v.src)}]);
      const done = [], live = sameWork(await liveStatus());
      for (const x of list) {
        if (v.dir && !await fs.access(x.src).then(() => true, () => false)) continue;
        if (!live) { done.push(await studio.addVideo(v.char, v.id, x)); continue; }
        const r = await fetch(origin() + studioUrl('videos', x.name), {method: 'POST', headers: {'content-type': 'video/mp4'}, body: await fs.readFile(x.src)});
        const j = await r.json().catch(() => null);
        if (!r.ok) throw Object.assign(new Error(j?.error ?? r.status), {code: j?.code});
        const file = `video/${x.name}.mp4`;
        done.push({name: x.name, file, sha256: j.adopted.find(a => a.path === file).sha256});
      }
      if (!done.length) fail('置く動画が無い', 1);
      return out(done);
    }
    case 'run': {
      need('char', 'id', 'step');
      const type = Object.keys(STUDIO_JOBS).find(t => STUDIO_JOBS[t] === v.step);
      if (!type) fail('--step は ' + Object.values(STUDIO_JOBS).join(' / '), 2);
      let job = await api('POST', '/api/jobs', {type, charId: v.char, studioId: v.id, proto: v.proto, set: v.set});
      console.log(`積んだ: ${job.id} (${type})`);
      if (!v.wait) return out(job);
      let last = '';
      while (job.state === 'queued' || job.state === 'running') {
        await new Promise(r => setTimeout(r, 3000));
        job = await api('GET', '/api/jobs/' + job.id);
        if (job.step !== last) { console.log(new Date().toLocaleTimeString('ja-JP'), job.state, job.step); last = job.step; }
      }
      out({id: job.id, state: job.state, result: job.result, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt});
      if (job.state !== 'done') process.exit(1);
      return;
    }
    case 'promote': need('char', 'id', 'proto', 'ver', 'note'); return out(await studio.promote(v.char, v.id, {proto: v.proto, verId: v.ver, label: v.label ?? '', note: v.note, latest: !!v.latest}));
    case 'requests': {
      // Claude が読む形: 依頼に、作業場所と替える絵の場所(絶対パス)を足す。却下した候補の理由は candidates に入っている
      const chars = v.char ? [v.char] : (await fs.readdir(path.join(studio.lib.dir, 'studio')).catch(() => []));
      const list = [];
      for (const c of chars) for (const s of await studio.list(c)) {
        if (v.id && s.id !== v.id) continue;
        const dir = studio.dir(c, s.id);
        for (const r of (await studio.read(c, s.id)).requests ?? []) if (v.all || r.state === '未着手')
          list.push({charId: c, studioId: s.id, ...r, dir, targetFile: path.join(dir, ...r.target.split('/')),
            candidates: r.candidates.map(x => ({...x, path: path.join(dir, ...x.file.split('/'))}))});
      }
      return out(list);
    }
    case 'candidate': {
      need('char', 'id', 'request', 'file');
      const data = await fs.readFile(path.resolve(v.file));
      const live = await liveStatus();
      if (!live) fail(`サーバーに届かない(${origin()}、表情づくり ${v.char}/${v.id})。起動しているか、--port か設定のポートが合っているか確かめる`, 1);
      if (!sameWork(live)) fail(`サーバーの作業場所(${live.dir})が、この CLI の保管場所の作業場所(${studio.dir(v.char, v.id)})と違う。CHARASTA_CONFIG か --port を合わせる`, 1);
      const r = await fetch(origin() + studioUrl('requests', v.request, 'candidates'),
        {method: 'POST', headers: {'content-type': 'image/png', 'x-note': encodeURIComponent(v.note ?? ''), 'x-from': encodeURIComponent(path.resolve(v.file))}, body: data});
      const j = await r.json().catch(() => null);
      if (!r.ok) throw Object.assign(new Error(j?.error ?? r.status), {code: j?.code});
      return out(j);
    }
    default: fail('使い方: node scripts/studio.mjs create|list|status|projects|copy|adopt|rects|options|video|run|promote|requests|candidate ...(先頭のコメント)', 2);
  }
});
