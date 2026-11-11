// Kimodo を読み込んだまま待つ作業プロセス tools/kimodo_worker.py の管理(docs/motion-text.md)。
// 標準入出力の 1 行 JSON で話す。読み込みに 1〜2 分(SSD。HDD では約 10 分)かかるので、使い終わっても 15 分は残し、使わなければ終了する。
// 起動した PID は <保管場所>/jobs/kimodo-worker.json に記録し、サーバーを止めるときにその PID の木だけを止める。
// 作りもの(fake): Kimodo の .venv ではなく ふだんの python で kimodo_worker.py --fake を動かし、同じ手順を通す。
// encoder: 文章のエンコーダの使い方(CHARASTA_KIMODO_ENCODER)。stream(既定。層ごとに読む別プロセス、CUDA)、stream-cpu(同じく CPU)、
// cpu(今までの経路。エンコーダを CPU に丸ごと読む)。stream の埋め込みは embedDir(<保管場所>/kimodo-cache/embeddings)に覚える。
import {spawn} from 'node:child_process';
import fsSync from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import {root} from './config.mjs';
import {venvPython} from './platform.mjs';
import {stopPid, alive} from './proc.mjs';

export const IDLE_MS = 15 * 60 * 1000;
const QUIT_WAIT_MS = 5000;

export class KimodoWorker {
  // kimodoDir: Kimodo のリポジトリ(.venv ごと使う)。fake: 作りものの種類(undefined なら本物)。pidFile: PID の記録
  constructor({kimodoDir, hfCacheDir, fake, pidFile, encoder = 'stream', embedDir, python = 'python', idleMs = IDLE_MS, quitWaitMs = QUIT_WAIT_MS, log = () => {}}) {
    embedDir ??= path.join(path.dirname(path.dirname(pidFile)), 'kimodo-cache', 'embeddings');   // pidFile は <保管場所>/jobs/kimodo-worker.json
    Object.assign(this, {kimodoDir, hfCacheDir, fake, pidFile, encoder, embedDir, python, idleMs, quitWaitMs, log});
    this.child = null; this.loaded = false; this.loading = null; this.starting = null;
    this.nextId = 1; this.pending = new Map(); this.timer = null; this.busy = 0; this.holds = 0; this.sink = null;
    this.stopped = Promise.resolve();
    this.closing = null;   // 終わらせている最中は、その終わりを待つ Promise
    this.shut = false;     // サーバーを止めるために閉じた。もう起動しない
  }

  get running() { return !!this.child; }
  get pid() { return this.child?.pid ?? null; }

  // 使えるか(本物は Kimodo の .venv の python があること)
  static available(kimodoDir, fake) { return !!fake || (!!kimodoDir && fsSync.existsSync(KimodoWorker.pythonOf(kimodoDir))); }
  static pythonOf(kimodoDir) { return venvPython(kimodoDir); }

  // 前のサーバーが残した PID の記録。プロセスが生きていれば {pid, alive: true}(所有を確かめられないので止めない)。死んでいれば記録を消す
  staleRecord() {
    let rec;
    try { rec = JSON.parse(fsSync.readFileSync(this.pidFile, 'utf8')); } catch { return null; }
    if (!rec?.pid || rec.pid === this.pid) return null;
    if (alive(rec.pid)) return {...rec, alive: true};
    fsSync.rmSync(this.pidFile, {force: true});
    return null;
  }

  #write(obj) { this.child.stdin.write(JSON.stringify(obj) + '\n'); }

  async #start() {
    for (;;) {
      if (this.shut) throw new Error('サーバーを止めているので、作業プロセスは起動しない');
      if (!this.closing) break;
      await this.closing;   // 終わらせている最中のプロセスが終わってから、起動し直す
    }
    if (this.child) return;
    await this.stopped;
    const fake = this.fake, env = {...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', TEXT_ENCODER_DEVICE: 'cpu', TEXT_ENCODER_MODE: 'local',
      CHARASTA_KIMODO_ENCODER: this.encoder, CHARASTA_KIMODO_EMBED_DIR: this.embedDir};
    if (this.hfCacheDir) env.HF_HUB_CACHE = this.hfCacheDir;
    const exe = fake ? this.python : KimodoWorker.pythonOf(this.kimodoDir);
    const args = ['-u', path.join(root, 'tools', 'kimodo_worker.py'), ...(fake ? ['--fake', String(fake)] : [])];
    this.log(`$ ${exe} ${args.join(' ')}\n`);
    const child = spawn(exe, args, {cwd: fake ? root : this.kimodoDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    this.child = child; this.loaded = false;
    const closed = new Promise(r => child.once('close', r));
    this.stopped = closed.then(() => {});
    child.stdin.on('error', () => {});   // 終わった子へ書いた EPIPE は close で扱う
    let ready;
    const first = new Promise((res, rej) => { ready = {res, rej}; });
    readline.createInterface({input: child.stdout}).on('line', line => {
      let m;
      try { m = JSON.parse(line); } catch { this.#note(line + '\n'); return; }
      // 応答は連想配列だけ。null や数や文字列の行(ライブラリが出力したもの)はログへ回す
      if (m === null || typeof m !== 'object' || Array.isArray(m)) { this.#note(line + '\n'); return; }
      if (m.event === 'ready') { ready.res(); return; }
      if (m.event === 'progress') { this.pending.get(m.id)?.onProgress?.(m.text); this.#note(m.text + '\n'); return; }
      const p = this.pending.get(m.id);
      if (!p) { this.#note(line + '\n'); return; }
      this.pending.delete(m.id);
      if (m.ok) p.res(m); else p.rej(new Error(m.error || '作業プロセスが失敗した'));
    });
    child.stderr.on('data', c => this.#note(c.toString('utf8')));
    child.once('error', e => ready.rej(new Error(`作業プロセスを起動できない: ${e.message}`)));
    closed.then(code => {
      if (this.child === child) { this.child = null; this.loaded = false; clearTimeout(this.timer); fsSync.rmSync(this.pidFile, {force: true}); }
      const err = new Error(`作業プロセスが終わった（終了コード ${code}）`);
      ready.rej(err);
      for (const p of this.pending.values()) p.rej(err);
      this.pending.clear();
    });
    fsSync.mkdirSync(path.dirname(this.pidFile), {recursive: true});
    fsSync.writeFileSync(this.pidFile, JSON.stringify({pid: child.pid, startedAt: new Date().toISOString(), kimodoDir: this.kimodoDir ?? null, fake: !!fake}));
    await first;
  }

  #note(text) { this.log(text); this.sink?.(text); }

  #arm() {
    clearTimeout(this.timer);
    if (this.idleMs > 0 && this.child && !this.busy && !this.holds && !this.closing) {
      this.timer = setTimeout(() => { this.log('\n== 作業プロセスを使わなかったので終わらせる\n'); this.close(); }, this.idleMs);
      this.timer.unref?.();
    }
  }

  // ジョブが使っている間は、使わないことによる終了のタイマーを止める。返す関数で戻す(要求と要求の間で終了しないように)
  hold() {
    this.holds++; clearTimeout(this.timer);
    let released = false;
    return () => { if (!released) { released = true; this.holds--; this.#arm(); } };
  }

  // 要求を 1 件送って応答を待つ。onProgress は途中経過、onLog は作業プロセスの標準エラーの出力
  async request(op, params = {}, {onProgress, onLog, timeoutMs = 0} = {}) {
    await (this.starting ??= this.#start().finally(() => { this.starting = null; }));
    clearTimeout(this.timer);
    this.busy++;
    this.sink = onLog ?? null;
    const id = this.nextId++, child = this.child;
    try {
      return await new Promise((res, rej) => {
        const t = timeoutMs > 0 ? setTimeout(() => { rej(new Error(`作業プロセスが ${Math.round(timeoutMs / 1000)} 秒で答えなかったので止めた`)); this.close(); }, timeoutMs) : null;
        this.pending.set(id, {res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); }, onProgress});
        this.#write({id, op, ...params});
      });
    } finally {
      this.busy--; this.sink = null; this.#arm();
    }
  }

  // モデルを読み込む。読み込み中に呼ばれても 1 回だけ読み込む
  async ensureLoaded(opts) {
    if (this.loaded) return {loaded: true, already: true};
    this.loading ??= this.request('load', {}, {...opts, timeoutMs: opts?.timeoutMs ?? 40 * 60 * 1000}).then(r => { this.loaded = true; return r; }).finally(() => { this.loading = null; });
    return this.loading;
  }

  // 終わらせる。まず quit を送り、答えなければ自分が起動した PID の木を止める。終わるまで loaded は false で、次の起動はこの終わりを待つ。
  // final: サーバーを止めるための終了。以後は起動しない
  close({final = false} = {}) {
    if (final) this.shut = true;
    clearTimeout(this.timer);
    const child = this.child;
    if (!child) return this.closing ?? Promise.resolve();
    if (this.closing) return this.closing;
    this.loaded = false;
    this.closing = (async () => {
      try { this.#write({id: this.nextId++, op: 'quit'}); child.stdin.end(); } catch { /* 既に閉じている */ }
      const done = this.stopped, wait = new Promise(r => setTimeout(r, this.quitWaitMs).unref?.());
      await Promise.race([done, wait]);
      if (this.child === child) { stopPid(child.pid); await done; }
    })().finally(() => { this.closing = null; });
    return this.closing;
  }

  // プロセスが終わる直前(同期)に、起動した PID の木を止める
  killSync() {
    this.shut = true;
    clearTimeout(this.timer);
    if (this.child?.pid) stopPid(this.child.pid);
    fsSync.rmSync(this.pidFile, {force: true});
  }
}
