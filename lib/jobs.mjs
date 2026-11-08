// ジョブの順番待ち(docs/jobs.md)。時間のかかる判断の要らない処理を 1 件ずつ動かす。
//   voice: 顔を撮る -> Grok で声付きの動画 -> 音声を取り出す -> 声の区間を確かめる -> セリフとして取り込む
//   video: セリフの口の動きを 1 コマずつ撮る -> 音声と合わせて mp4
//   shoot: モーション・セリフ・音声を当てて 1 コマずつ撮る -> 動画にまとめる(lib/shoot.mjs)
//   game-export: 版の VRM をゲーム用に書き出す(primitive をまとめ、三角形を減らし、揺れものと meta を直し、画像を縮める)と、選んだモーションをその場にする(lib/game-export.mjs)
//   mv: Blender のシーンで踊らせ、カメラワーク付きの動画にまとめる(lib/mv.mjs)
//   short: カット表から声、口、文字と演出の付いた縦動画を作る(lib/short.mjs)
//   short-draft: テーマからカット表の下書きを新しいショートとして作る。動画は作らない(lib/short-draft.mjs)
//   short-figures: カットの図の説明から Codex の image_gen で透過の図を作り、カットに入れる(lib/short-figures.mjs)
//   motion-gen: MotionBricks で動きを作る -> VRM の骨に移し替えて VRMA にし、確認を待つ。取り込むのは画面のボタン(lib/motion-gen.mjs)
//   video-motion: 動画から VRMA と比較の動画を作り、確認を待つ。取り込むのは画面のボタン(lib/video-motion.mjs)
//   motion-text: 文章を英語の説明文に直し -> Kimodo の作業プロセスで候補を作り、確認を待つ。取り込むのは画面のボタン(lib/motion-text.mjs)
//   motion-recipe: 保管場所のモーション、確認待ちの文章・動画・MotionBricks の結果、MotionBricks の条件を並べ、間を MotionBricks でつないで 1 本の VRMA にし、確認を待つ。取り込むのは画面のボタン(lib/motion-recipe.mjs)
// 保管場所の jobs/<jobId>.json(状態)、jobs/<jobId>.log(外部コマンドの出力)、jobs/<jobId>/(作業フォルダ)に書く。
// 試しの動き(環境変数。サーバーの config.env でも渡せる):
//   CHARASTA_FAKE_GROK=1        grok を呼ばず、決まった短い音声付き動画(sine 1.5 秒)を返す。silent は無音、fail は失敗
//   CHARASTA_FAKE_CAPTURE=1     ブラウザで撮らず、無地の画像とコマで済ませる。shoot の hang は撮影が終わらない。mv も Blender を呼ばない
//   CHARASTA_SHOOT_TIMEOUT_MS   shoot の時間の上限を決め打ちにする
//   CHARASTA_ENCODER=cpu        動画を最初から libx264(CPU)で書く。ふだんはまず NVENC(GPU)で書き、失敗したら libx264 で書き直す(lib/encoder.mjs)
//   CHARASTA_FAKE_MOTIONBRICKS=1 MotionBricks を呼ばず、作りものの動きでモーションを作る。fail は失敗
//   CHARASTA_FAKE_KIMODO=1      claude と Kimodo を呼ばず、作りものの動きで通す。high / fail / load-fail / claude-fail はそれぞれの失敗
//   CHARASTA_FAKE_DRAFT=1       claude を呼ばず、決まった下書きを作る。bad-json / bad / warn / claude-fail はそれぞれの経路(lib/short-draft.mjs)
//   CHARASTA_FAKE_FIGURE=1     Codex を呼ばず、決まった透過の図を作る。fail / opaque / corner / edge / empty はそれぞれの失敗(lib/short-figures.mjs)
//   CHARASTA_FAKE_VRMA_PIPELINE=1 vrma-pipeline と Blender と yt-dlp を呼ばず、作りものの動きで通す。fail は失敗、hang は終わらない
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {stopTree} from './proc.mjs';
import {root} from './config.mjs';
import {bashPath, findPython, rgbmocapPython, venvPython} from './platform.mjs';
import {LibraryError, checkId, inside, rejectCreature, EMOTIONS, FRAMINGS, parseVoice, readJsonOr, writeJson} from './library.mjs';
import {parseWav, voicedSeconds, mediaSeconds} from './audio.mjs';
import {STUDIO_JOBS} from './studio.mjs';
import {studioJobInput, runStudioJob} from './studio-jobs.mjs';
import {motionGenInput, runMotionGen, importMotionGen, genFile} from './motion-gen.mjs';
import {shootInput, runShoot} from './shoot.mjs';
import {mvInput, runMv} from './mv.mjs';
import {shortJobInput, runShort} from './short.mjs';
import {draftInput, runShortDraft} from './short-draft.mjs';
import {figuresInput, runShortFigures} from './short-figures.mjs';
import {VoiceVox} from './voicevox.mjs';
import {ElevenLabs} from './elevenlabs.mjs';
import {recordTrash} from './trash.mjs';
import {FACE_CHECK_JOB, faceCheckInput, runFaceCheck} from './face-check.mjs';
import {GAME_EXPORT_JOB, gameExportInput, runGameExport} from './game-export.mjs';
import {UPLOAD_DIR, videoMotionInput, runVideoMotion, importVideoMotion} from './video-motion.mjs';
import {motionTextInput, runMotionText, importMotionText, dropCandidate, candidateFile} from './motion-text.mjs';
import {motionRecipeInput, runMotionRecipe, importMotionRecipe, recipeFile, jobSources} from './motion-recipe.mjs';
import {KimodoWorker} from './kimodo-worker.mjs';

export const JOB_TYPES = ['voice', 'video', 'shoot', 'mv', 'short', 'short-draft', 'short-figures', 'motion-gen', 'video-motion', 'motion-text', 'motion-recipe', ...Object.keys(STUDIO_JOBS)];
export const MIN_VOICED_SEC = 0.3;
const LIST_MAX = 50;
const MAX_TEXT = 200;
const FPS = 30;
JOB_TYPES.push(FACE_CHECK_JOB, GAME_EXPORT_JOB);

const now = () => new Date().toISOString();
const jobActive = j => j.state === 'queued' || j.state === 'running';
function str(v) {
  if (v == null) return '';
  if (typeof v !== 'string') throw new LibraryError('bad-input', '文字列で渡す: ' + JSON.stringify(v));
  return v.trim();
}

export class JobQueue {
  // getPort: ブラウザで撮るときにビューアへつなぐ、このサーバーのポートを返す関数
  // studio: 表情づくり(lib/studio.mjs)、tools: ジョブが使う外の道具 {blender, kit, patchVrm, springTune, motionbricksDir, vrmaPipelineDir, rgbmocapDir, kimodoDir, hfCacheDir}
  //   tools.freeMemGB() と tools.gpuFreeMiB() は RAM と GPU の空きを答える関数(省くと本物を測る。テストが差し替える)
  constructor({lib, studio = null, tools = {}, getPort = () => 8870, env = {}}) {
    this.lib = lib; this.studio = studio; this.tools = tools; this.getPort = getPort; this.extraEnv = env;
    // ElevenLabs のキーは ElevenLabs だけが持つ。子プロセスへ渡らないよう環境から消す
    this.eleven = new ElevenLabs({env: this.env});
    delete process.env.ELEVENLABS_API_KEY; delete env.ELEVENLABS_API_KEY;
    this.voicevox = new VoiceVox({dir: tools.voicevoxDir, env: this.env});
    this.dir = path.join(lib.dir, 'jobs');
    this.jobs = new Map();
    this.child = null; this.running = null; this.idleWaiters = []; this.closed = false; this.kimodo = null; this.abort = new AbortController(); this.saving = new Map();
    this.ready = this.#init();
  }

  get env() { return {...process.env, ...this.extraEnv}; }

  async #init() {
    await fs.mkdir(this.dir, {recursive: true});
    for (const f of await fs.readdir(this.dir)) {
      if (!/\.json$/.test(f)) continue;
      const job = await readJsonOr(path.join(this.dir, f));
      if (!job?.id) continue;
      // 前のサーバーが止まったときの残り。再開はしない(Grok をボタンなしで呼ばないため)
      if (job.state === 'running' || job.state === 'queued') {
        job.state = 'failed'; job.finishedAt = now(); job.error = 'サーバーが止まった';
        await writeJson(path.join(this.dir, f), job);
        if (job.input?.upload) await fs.rm(inside(this.lib.dir, UPLOAD_DIR, job.input.upload), {force: true});   // 順番待ちのまま止まった動画を残さない
      }
      // 表情づくりの工程の状態も直す(CLI は work.json の状態で、動いているジョブを見る)。
      // 終わっていないジョブ(失敗したのに work.json に queued / running が残ったものも)を指す工程だけ failed にする
      const step = STUDIO_JOBS[job.type];
      if (step && this.studio && job.state !== 'done') await this.studio.update(job.input.charId, job.input.studioId, w => {
        const s = w.steps[step];
        if (s?.jobId === job.id && (s.state === 'queued' || s.state === 'running')) w.steps[step] = {...s, state: 'failed', error: job.error ?? 'ジョブが終わらなかった', at: job.finishedAt ?? now()};
      }).catch(e => console.error('表情づくりの工程を直せない', job.id, e.message));
      this.jobs.set(job.id, job);
    }
    // 前のサーバーが残した作業プロセスは、持ち主を確かめられないので止めない。残っていれば知らせるだけ
    const stale = this.kimodoWorker().staleRecord();
    if (stale) console.warn(`Kimodo の作業プロセス(PID ${stale.pid})が前のサーバーから残っている。不要なら PID を確かめて止める`);
  }

  async list() {
    await this.ready;
    return [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1)).slice(0, LIST_MAX);
  }

  async get(id) {
    await this.ready;
    const job = this.jobs.get(checkId(id, 'ジョブ ID'));
    if (!job) throw new LibraryError('not-found', `ジョブ ${id} が無い`);
    let logTail = '';
    try { logTail = (await fs.readFile(path.join(this.dir, id + '.log'), 'utf8')).slice(-4000); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return {...job, logTail};
  }

  // 入力を確かめて積む。入力の誤りは LibraryError(400/404/409)。返すのは積んだジョブ。
  async enqueue(body) {
    await this.ready;
    if (this.closed) throw new LibraryError('bad-input', 'サーバーが止まりかけている');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LibraryError('bad-input', '本文が JSON の連想配列ではない');
    if (!JOB_TYPES.includes(body.type)) throw new LibraryError('bad-input', 'type は ' + JOB_TYPES.join(' / '));
    if (body.type === FACE_CHECK_JOB) return this.#push(body.type, await faceCheckInput(this.lib, body, i => [...this.jobs.values()].some(j => j.type === FACE_CHECK_JOB && jobActive(j) && j.input.charId === i.charId && j.input.verId === i.verId && j.input.set === i.set)));
    if (body.type === GAME_EXPORT_JOB) return this.#push(body.type, await gameExportInput(this.lib, body, i => [...this.jobs.values()].some(j => j.type === GAME_EXPORT_JOB && jobActive(j) && j.input.charId === i.charId && j.input.verId === i.verId)));
    if (STUDIO_JOBS[body.type]) {
      if (!this.studio) throw new LibraryError('bad-input', '表情づくりが使えない');
      return this.#push(body.type, await studioJobInput(this.studio, body, (c, s, step) => this.#pendingStudio(c, s, step)));
    }
    if (body.type === 'motion-gen') {
      return this.#push(body.type, await motionGenInput(this.lib, body, id => [...this.jobs.values()].some(j => j.type === 'motion-gen' && (j.state === 'queued' || j.state === 'running' || (j.state === 'done' && j.result?.review === 'waiting')) && j.input.motionId === id)));
    }
    if (body.type === 'motion-text') return this.#push(body.type, motionTextInput(body));
    if (body.type === 'motion-recipe') return this.#push(body.type, await motionRecipeInput(this.lib, body, this.#jobLookup()));
    if (body.type === 'short') return this.#push(body.type, await shortJobInput(this.lib, body, id => [...this.jobs.values()].some(j => j.type === 'short' && jobActive(j) && j.input.shortId === id), this.tools.stageStudioDir));
    if (body.type === 'short-draft') return this.#push(body.type, await draftInput(this.lib, this.tools.stageStudioDir, body));
    if (body.type === 'short-figures') return this.#push(body.type, await figuresInput(this.lib, body, id => [...this.jobs.values()].some(j => j.type === 'short-figures' && jobActive(j) && j.input.shortId === id)));
    const ch = rejectCreature(await this.lib.getCharacterJson(checkId(body.charId, 'キャラ ID')), '動画を撮る・動きを作る');
    const verId = body.verId ? checkId(body.verId, '版 ID') : ch.latestVersion;
    if (!verId) throw new LibraryError('bad-input', 'このキャラには版が無い');
    if (!await this.lib.versionExists(ch.id, verId)) throw new LibraryError('not-found', `版 ${ch.id}/${verId} が無い`);
    const input = {charId: ch.id, verId};
    if (body.type === 'shoot') return this.#push(body.type, await shootInput(this.lib, input, body));
    if (body.type === 'mv') return this.#push(body.type, await mvInput(this.lib, input, body, {stageDir: this.tools.stageStudioDir, active: key => [...this.jobs.values()].some(j => j.type === 'mv' && jobActive(j) && j.input.key === key)}));
    if (body.type === 'video-motion') return this.#push(body.type, videoMotionInput(this.lib, input, body, {exmrAvailable: this.exmrAvailable()}));

    if (body.type === 'voice') {
      input.text = str(body.text);
      if (!input.text) throw new LibraryError('bad-input', 'text が要る');
      if ([...input.text].length > MAX_TEXT) throw new LibraryError('bad-input', `text は ${MAX_TEXT} 文字まで`);
      input.reading = str(body.reading) || input.text;
      input.emotion = body.emotion || null;
      if (input.emotion && !EMOTIONS.includes(input.emotion)) throw new LibraryError('bad-input', '感情は ' + EMOTIONS.join(' / '));
      input.voice = parseVoice(body.voice) ?? ch.voice;
      if (!input.voice) throw new LibraryError('bad-input', 'voice が要る(キャラに声の種類が決まっていない)');
      if (input.voice.provider !== 'grok') throw new LibraryError('bad-input', '声を作れるのは provider が grok のときだけ: ' + input.voice.provider);
      input.lineId = body.lineId ? checkId(body.lineId, 'セリフ ID') : 'line-' + Date.now().toString(36) + crypto.randomBytes(1).toString('hex');
      if (await this.lib.lineExists(ch.id, input.lineId)) throw new LibraryError('exists', `セリフ ${ch.id}/${input.lineId} は既にある(上書きしない)`);
      if (this.#pendingVoiceLine(ch.id, input.lineId)) throw new LibraryError('exists', `セリフ ${ch.id}/${input.lineId} を作るジョブが既にある`);
    } else {
      input.lineId = checkId(body.lineId, 'セリフ ID');
      input.framing = body.framing ?? 'face';
      if (!FRAMINGS.includes(input.framing)) throw new LibraryError('bad-input', 'framing は ' + FRAMINGS.join(' / '));
      await this.lib.getLine(ch.id, input.lineId);
    }
    return this.#push(body.type, input);
  }

  async #push(type, input) {
    const job = {id: 'j' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), type, state: 'queued', step: '順番待ち',
      input, result: null, error: null, createdAt: now(), startedAt: null, finishedAt: null};
    this.jobs.set(job.id, job);
    await this.#save(job);
    if (STUDIO_JOBS[type]) {   // 表情づくりの工程に「順番待ち」を書く(画面はここから工程の状態を読む)
      await this.studio.update(input.charId, input.studioId, w => { w.steps[STUDIO_JOBS[type]] = {...(w.steps[STUDIO_JOBS[type]] ?? {}), state: 'queued', jobId: job.id}; });
    }
    const queued = {...job}; // 返すのは積んだ時点の姿(#pump がすぐ running にする)
    this.#pump();
    return queued;
  }

  // 動画を保存する前に、ファイル以外の入力を確かめる(手元の動画を送る API)
  async checkVideoMotion(body) {
    await this.ready;
    const ch = rejectCreature(await this.lib.getCharacterJson(checkId(body.charId, 'キャラ ID')), '動画からのモーション作り');
    const verId = body.verId ? checkId(body.verId, '版 ID') : ch.latestVersion;
    if (!verId || !await this.lib.versionExists(ch.id, verId)) throw new LibraryError('not-found', `版 ${ch.id}/${verId} が無い`);
    videoMotionInput(this.lib, {charId: ch.id, verId}, body, {source: false, exmrAvailable: this.exmrAvailable()});
  }

  // 動画からモーションの exmr(RGB MoCap)を使えるか。試しの動きでは使えるとみなす
  exmrAvailable() {
    return !!this.env.CHARASTA_FAKE_VRMA_PIPELINE || fsSync.existsSync(rgbmocapPython(this.tools.rgbmocapDir ?? ''));
  }

  // 確認待ちのジョブ(一覧の上限にかかわらず全部)
  async videoMotionsWaiting() {
    await this.ready;
    return [...this.jobs.values()].filter(j => j.type === 'video-motion' && j.state === 'done' && j.result?.review === 'waiting');
  }

  #reviewing(id, type = 'video-motion') {
    const job = this.jobs.get(checkId(id, 'ジョブ ID'));
    if (job?.type !== type) throw new LibraryError('not-found', `${{'video-motion': '動画から', 'motion-text': '文章から', 'motion-recipe': 'つなぐ', 'motion-gen': 'MotionBricks の'}[type]}のジョブ ${id} が無い`);
    if (job.state !== 'done' || job.result?.review !== 'waiting') throw new LibraryError('exists', `ジョブ ${id} は確認待ちではない`);
    return job;
  }

  // 比較の動画のファイル。配るのは確認に要るこの 1 つだけ
  async videoMotionCompare(id) {
    await this.ready;
    if (this.jobs.get(checkId(id, 'ジョブ ID'))?.type !== 'video-motion') throw new LibraryError('not-found', `動画からのジョブ ${id} が無い`);
    return path.join(this.dir, id, 'compare.mp4');
  }

  // 確認の画面の「取り込む」
  async importVideoMotion(id, body) {
    await this.ready;
    const job = this.#reviewing(id), m = await importVideoMotion(this.lib, path.join(this.dir, id), job, body);
    job.result = {...job.result, review: 'imported', motionId: m.id};
    await this.#save(job);
    return m;
  }

  // 確認の画面の「捨てる」。作業フォルダは保管場所の trash/ へ移す
  async discardVideoMotion(id) {
    await this.ready;
    const job = this.#reviewing(id);
    this.#refuseIfRecipeUses(id);
    const dir = path.join(this.dir, id), to = inside(this.lib.dir, 'trash', `video-motion-${id}`);
    await fs.mkdir(path.dirname(to), {recursive: true});
    // 画面が読み込み中の compare.mp4 が開いていると Windows ではフォルダを移せない。開いたファイルそのものは移せるので先に出す
    await fs.rename(path.join(dir, 'compare.mp4'), to + '.compare.mp4');
    await fs.rename(dir, to);
    await fs.rename(to + '.compare.mp4', path.join(to, 'compare.mp4'));
    await recordTrash(to, {kind: 'video-motion', id: id, charId: job.result.charId, charName: job.result.charName, label: `動画からのモーション: ${job.result.label}`});   // 戻す先は無いので paths は空
    job.result = {...job.result, review: 'discarded'};
    await this.#save(job);
    return job;
  }

  // ---- 文章からのモーション(motion-text)の確認。動画からの確認と同じ形で、動画のかわりに候補ごとの VRMA を配る ----
  async textMotionsWaiting() {
    await this.ready;
    return [...this.jobs.values()].filter(j => j.type === 'motion-text' && j.state === 'done' && j.result?.review === 'waiting');
  }

  // 候補のファイル(VRMA か contacts.json)。確認待ちのジョブのものだけ配る
  async textMotionFile(id, n, name) {
    await this.ready;
    this.#reviewing(id, 'motion-text');
    return candidateFile(path.join(this.dir, id), n, name);
  }

  async importTextMotion(id, body) {
    await this.ready;
    const job = this.#reviewing(id, 'motion-text');
    // 順番待ちか実行中のつなぐジョブが使う候補は、選ばなくても消さない(つなぐジョブは実行の直前に写す)
    const keep = this.#candidatesInUse(id);
    const m = await importMotionText(this.lib, path.join(this.dir, id), job, body, this.env, keep);
    job.result = {...job.result, review: 'imported', motionId: m.id, importedCandidate: Number(body.n)};
    await this.#save(job);
    return m;
  }

  // 全部捨てる。作業フォルダは保管場所の trash/ へ移す
  async discardTextMotion(id) {
    await this.ready;
    const job = this.#reviewing(id, 'motion-text');
    this.#refuseIfRecipeUses(id);
    const dir = path.join(this.dir, id), to = inside(this.lib.dir, 'trash', `text-motion-${id}`);
    await fs.mkdir(path.dirname(to), {recursive: true});
    await fs.rename(dir, to);
    await recordTrash(to, {kind: 'text-motion', id, label: `文章からのモーション: ${job.result.label}`});   // 戻す先は無いので paths は空
    job.result = {...job.result, review: 'discarded'};
    await this.#save(job);
    return job;
  }

  // ---- つないだモーション(motion-recipe)の確認。文章からの確認と同じ形で、つないだ 1 本の VRMA を配る ----
  async recipeMotionsWaiting() {
    await this.ready;
    return [...this.jobs.values()].filter(j => j.type === 'motion-recipe' && j.state === 'done' && j.result?.review === 'waiting');
  }

  // 「つくる」の区間に使える確認待ちの結果(文章の候補、動画の結果、MotionBricks の結果)
  async recipeSources() {
    return jobSources(this.#jobLookup(), [...await this.textMotionsWaiting(), ...await this.videoMotionsWaiting(), ...await this.genMotionsWaiting()]);
  }

  // つなぐジョブが区間のジョブを引くもの(lib/motion-recipe.mjs の jobSource)
  #jobLookup() { return {get: id => this.jobs.get(id) ?? null, dir: id => path.join(this.dir, id)}; }

  // 順番待ちか実行中で、ジョブ id の結果を区間に使うつなぐジョブ
  #recipesUsing(id) {
    return [...this.jobs.values()].filter(j => j.type === 'motion-recipe' && jobActive(j) && j.input.segments.some(s => s.source === 'job' && s.job === id));
  }

  // 順番待ちか実行中のつなぐジョブが区間に使っている、ジョブ id の候補の番号
  #candidatesInUse(id) {
    return new Set(this.#recipesUsing(id).flatMap(j => j.input.segments.filter(s => s.source === 'job' && s.job === id).map(s => s.n)));
  }

  // つなぐジョブが終わったあと、取り込みのときに使われていて残した候補のフォルダを消す(取り込み済みで、取り込んだ候補ではなく、ほかのつなぐジョブも使っていないもの)。確認待ちのジョブの候補は選ぶ前なので消さない
  async #dropKeptCandidates(recipe) {
    for (const id of new Set(recipe.input.segments.filter(s => s.source === 'job').map(s => s.job))) {
      const j = this.jobs.get(checkId(id, 'ジョブ ID'));
      if (j?.type !== 'motion-text' || j.result?.review !== 'imported') continue;
      const inUse = this.#candidatesInUse(id);
      for (const c of j.result.candidates ?? []) if (c.n !== j.result.importedCandidate && !inUse.has(c.n)) await dropCandidate(path.join(this.dir, id), c.n);
    }
  }

  // 確認待ちのジョブを捨てる前に。使うつなぐジョブがあれば断る(ごみ箱がモーションを断るのと同じ文)
  #refuseIfRecipeUses(id) {
    const busy = this.#recipesUsing(id);
    if (busy.length) throw new LibraryError('busy', `順番待ちか実行中の処理が使っている(${busy.map(j => `ジョブ ${j.id}`).join('、')})。終わってからにする`);
  }

  // つないだ VRMA か contacts.json。確認待ちのジョブのものだけ配る
  async recipeMotionFile(id, name) {
    await this.ready;
    this.#reviewing(id, 'motion-recipe');
    return recipeFile(path.join(this.dir, id), name);
  }

  async importRecipeMotion(id, body) {
    await this.ready;
    const job = this.#reviewing(id, 'motion-recipe'), m = await importMotionRecipe(this.lib, path.join(this.dir, id), job, body);
    job.result = {...job.result, review: 'imported', motionId: m.id};
    await this.#save(job);
    return m;
  }

  // 捨てる。作業フォルダは保管場所の trash/ へ移す
  async discardRecipeMotion(id) {
    await this.ready;
    const job = this.#reviewing(id, 'motion-recipe'), dir = path.join(this.dir, id), to = inside(this.lib.dir, 'trash', `motion-recipe-${id}`);
    await fs.mkdir(path.dirname(to), {recursive: true});
    await fs.rename(dir, to);
    await recordTrash(to, {kind: 'motion-recipe', id, label: `つないだモーション: ${job.result.label}`});   // 戻す先は無いので paths は空
    job.result = {...job.result, review: 'discarded'};
    await this.#save(job);
    return job;
  }

  // ---- MotionBricks の条件で作ったモーション(motion-gen)の確認。つなぐと同じ形で、作った 1 本の VRMA を配る ----
  async genMotionsWaiting() {
    await this.ready;
    return [...this.jobs.values()].filter(j => j.type === 'motion-gen' && j.state === 'done' && j.result?.review === 'waiting');
  }

  async genMotionFile(id, name) {
    await this.ready;
    this.#reviewing(id, 'motion-gen');
    return genFile(path.join(this.dir, id), name);
  }

  async importGenMotion(id, body) {
    await this.ready;
    const job = this.#reviewing(id, 'motion-gen'), m = await importMotionGen(this.lib, path.join(this.dir, id), job, body);
    job.result = {...job.result, review: 'imported', motionId: m.id};
    await this.#save(job);
    return m;
  }

  // 捨てる。作業フォルダは保管場所の trash/ へ移す。使うつなぐジョブがあれば断る
  async discardGenMotion(id) {
    await this.ready;
    const job = this.#reviewing(id, 'motion-gen');
    this.#refuseIfRecipeUses(id);
    const dir = path.join(this.dir, id), to = inside(this.lib.dir, 'trash', `motion-gen-${id}`);
    await fs.mkdir(path.dirname(to), {recursive: true});
    await fs.rename(dir, to);
    await recordTrash(to, {kind: 'motion-gen', id, label: `MotionBricks のモーション: ${job.result.label}`});   // 戻す先は無いので paths は空
    job.result = {...job.result, review: 'discarded'};
    await this.#save(job);
    return job;
  }

  // Kimodo の作業プロセス。最初に使うときに作る(起動は最初の要求のとき)
  kimodoWorker() {
    const env = this.env;
    this.kimodo ??= new KimodoWorker({kimodoDir: this.tools.kimodoDir, hfCacheDir: this.tools.hfCacheDir, fake: env.CHARASTA_FAKE_KIMODO ? String(env.CHARASTA_FAKE_KIMODO) : undefined,
      pidFile: path.join(this.dir, 'kimodo-worker.json'), encoder: env.CHARASTA_KIMODO_ENCODER || 'stream', embedDir: path.join(this.lib.dir, 'kimodo-cache', 'embeddings'),
      python: findPython(env) ?? 'python', idleMs: env.CHARASTA_KIMODO_IDLE_MS === undefined ? undefined : Number(env.CHARASTA_KIMODO_IDLE_MS),
      quitWaitMs: env.CHARASTA_KIMODO_QUIT_WAIT_MS === undefined ? undefined : Number(env.CHARASTA_KIMODO_QUIT_WAIT_MS),
      log: text => { try { fsSync.appendFileSync(path.join(this.dir, 'kimodo-worker.log'), text); } catch { /* ログが書けなくても動かす */ } }});
    return this.kimodo;
  }

  // 作業プロセスが使えるか(GET /api/motion-texts)
  kimodoAvailable() { return KimodoWorker.available(this.tools.kimodoDir, this.env.CHARASTA_FAKE_KIMODO); }

  // 順番待ちか実行中のジョブ。ごみ箱が、消す対象を使っているかを調べるのに使う
  async active() {
    await this.ready;
    return [...this.jobs.values()].filter(jobActive);
  }

  // ID のジョブ(無ければ null)。表情づくりの画面が工程の状態を読むときに使う
  peek(id) { return this.jobs.get(id) ?? null; }

  #pendingStudio(charId, studioId, step) {
    return [...this.jobs.values()].some(j => STUDIO_JOBS[j.type] === step && (j.state === 'queued' || j.state === 'running') && j.input.charId === charId && j.input.studioId === studioId);
  }

  #pendingVoiceLine(charId, lineId) {
    return [...this.jobs.values()].some(j => j.type === 'voice' && (j.state === 'queued' || j.state === 'running') && j.input.charId === charId && j.input.lineId === lineId);
  }

  // 同じジョブの保存は 1 件ずつ順に書く(writeJson は同じ .tmp を使うので、作業プロセスの途中経過と段階の保存が重なると rename が失敗する)
  #save(job) {
    const next = (this.saving.get(job.id) ?? Promise.resolve()).catch(() => {}).then(() => writeJson(path.join(this.dir, job.id + '.json'), job));
    this.saving.set(job.id, next);
    return next.finally(() => { if (this.saving.get(job.id) === next) this.saving.delete(job.id); });
  }

  // 順番待ちも実行中も無くなるまで待つ(テスト用)
  async whenIdle() {
    await this.ready;
    if (!this.running && ![...this.jobs.values()].some(j => j.state === 'queued')) return;
    await new Promise(r => this.idleWaiters.push(r));
  }

  // 今の外部コマンドを止める(自分が起動した子だけ)。以後は積めない。
  async close() {
    this.closed = true;
    this.abort.abort();   // 待っているジョブ(GPU 待ちなど)を中断させる
    this.voicevox.close();
    try { if (this.child) stopTree(this.child); } catch { /* 既に終わっている */ }
    await this.kimodo?.close({final: true});   // 作業プロセスを止めると、待っているジョブが失敗して終わる(以後は起動しない)
    await this.running?.catch(() => {});
  }

  #pump() {
    if (this.running) return;
    const next = [...this.jobs.values()].filter(j => j.state === 'queued').sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))[0];
    if (!next || this.closed) {
      if (!next) { const w = this.idleWaiters.splice(0); w.forEach(r => r()); }
      return;
    }
    this.running = this.#execute(next).finally(() => { this.running = null; this.#pump(); });
  }

  async #execute(job) {
    const logFile = path.join(this.dir, job.id + '.log'), workDir = path.join(this.dir, job.id);
    const log = text => fsSync.appendFileSync(logFile, text);
    const ctx = {
      job, workDir, log, signal: this.abort.signal,   // signal: サーバーを止めるときの取り消し(close)
      step: async s => { job.step = s; log(`\n== ${s}\n`); await this.#save(job); },
      run: (cmd, args, opts) => this.run(cmd, args, log, opts),
    };
    job.state = 'running'; job.startedAt = now(); job.step = '始めた';
    await this.#save(job);
    try {
      await fs.mkdir(workDir, {recursive: true});
      if (job.type === FACE_CHECK_JOB) job.result = await runFaceCheck(ctx, {lib: this.lib, getPort: this.getPort, env: this.env});
      else if (job.type === GAME_EXPORT_JOB) job.result = await runGameExport(ctx, {lib: this.lib});
      else job.result = STUDIO_JOBS[job.type] ? await runStudioJob(ctx, {studio: this.studio, tools: this.tools, getPort: this.getPort, env: this.env})
        : job.type === 'motion-gen' ? await runMotionGen(ctx, {motionbricksDir: this.tools.motionbricksDir, env: this.env})
        : job.type === 'motion-text' ? await runMotionText(ctx, {worker: this.kimodoWorker(), env: this.env, tools: this.tools})
        : job.type === 'motion-recipe' ? await runMotionRecipe(ctx, {lib: this.lib, tools: this.tools, env: this.env, jobs: this.#jobLookup()})
        : job.type === 'video-motion' ? await runVideoMotion(ctx, {lib: this.lib, pipelineDir: this.tools.vrmaPipelineDir, rgbmocapDir: this.tools.rgbmocapDir, blender: this.env.CHARASTA_BLENDER || this.tools.blender, env: this.env})
        : job.type === 'shoot' ? await runShoot(ctx, {lib: this.lib, getPort: this.getPort, env: this.env})
        : job.type === 'short' ? await runShort(ctx, {lib: this.lib, voicevox: this.voicevox, eleven: this.eleven, stageDir: this.tools.stageStudioDir, hyperframesCli: this.tools.hyperframesCli, hyperframesBrowser: this.tools.hyperframesBrowser, blender: this.env.CHARASTA_BLENDER || this.tools.blender, getPort: this.getPort, env: this.env})
        : job.type === 'short-draft' ? await runShortDraft(ctx, {lib: this.lib, stageDir: this.tools.stageStudioDir, env: this.env})
        : job.type === 'short-figures' ? await runShortFigures(ctx, {lib: this.lib, imageGen: this.tools.figureImageGen, env: this.env, active: () => this.active()})
        : job.type === 'mv' ? await runMv(ctx, {lib: this.lib, stageDir: this.tools.stageStudioDir, blender: this.env.CHARASTA_BLENDER || this.tools.blender, getPort: this.getPort, env: this.env})
        : job.type === 'voice' ? await this.#voice(ctx) : await this.#video(ctx);
      job.state = 'done'; job.step = '終わった';
    } catch (e) {
      job.state = 'failed'; job.error = e.message || String(e);
      log(`\n!! ${job.error}\n`);
    }
    job.finishedAt = now();
    try { await this.#save(job); } catch (e) { console.error('ジョブを保存できない', e); }
    if (job.type === 'motion-recipe') await this.#dropKeptCandidates(job).catch(e => console.error('使い終えた候補を消せない', e));
  }

  // 外部コマンドを起動し、出力をログへ流す。終了コードが 0 でなければ例外。capture なら標準出力を返す(失敗したときは例外の stdout に入る)。onOutput はログへ流す出力を受け取る。extraEnv はこの 1 回だけ足す環境変数。
  // timeoutMs を渡すと、その時間で終わらなければ子のプロセスごと止めて例外にする。省くと上限なし。input を渡すと標準入力に書いて閉じる。
  run(cmd, args, log, {capture = false, cwd = root, env: extraEnv = {}, timeoutMs = 0, input = null, onOutput = null} = {}) {
    if (this.closed) return Promise.reject(Object.assign(new Error('サーバーが止まりかけている'), {stopped: true}));
    const env = this.env;
    const exe = cmd === 'node' ? process.execPath : cmd === 'python' ? (findPython(env) ?? 'python') : cmd === 'ffmpeg' ? (env.CHARASTA_FFMPEG || 'ffmpeg')
      : cmd === 'yt-dlp' ? (env.CHARASTA_YTDLP || 'yt-dlp') : cmd === 'ffprobe' ? (env.CHARASTA_FFPROBE || 'ffprobe') : cmd === 'blender' ? (env.CHARASTA_BLENDER || this.tools.blender) : cmd === 'bash' ? bashPath(this.tools) : cmd === 'uv' ? (env.CHARASTA_UV || 'uv')
      : cmd === 'claude' ? (env.CHARASTA_CLAUDE || 'claude') : cmd === 'vrma-python' ? venvPython(this.tools.vrmaPipelineDir ?? '')
      : (() => { throw Error('知らないコマンド: ' + cmd); })();
    if (!exe) throw Error(cmd + ' の場所が設定に無い');
    log(`$ ${cmd} ${args.join(' ')}\n`);
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, {cwd, env: {...env, ...extraEnv, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'}, windowsHide: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe']});
      this.child = child;
      if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input); }   // 標準入力で渡す(引数にも shell にも載せない)
      let timedOut = false;
      const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; stopTree(child); }, timeoutMs) : null;
      const out = []; let tail = '', outTail = '';
      const note = c => { log(c); onOutput?.(c.toString('utf8')); tail = (tail + c.toString('utf8')).slice(-600); };
      child.stdout.on('data', c => { if (capture) { out.push(c); outTail = (outTail + c.toString('utf8')).slice(-600); } else note(c); });
      child.stderr.on('data', note);
      child.on('error', e => { clearTimeout(timer); this.child = null; reject(new Error(`${cmd} を起動できない: ${e.message}`)); });
      child.on('close', code => {
        clearTimeout(timer); this.child = null;
        // stopped: 時間切れ、またはサーバーの停止(close)で止めた。呼び出し側が別のやり方でやり直さないための印
        const fail = (message, stopped) => reject(Object.assign(new Error(message), {stopped, stdout: capture ? Buffer.concat(out).toString('utf8') : undefined}));
        if (timedOut) fail(`${cmd} が ${Math.round(timeoutMs / 1000)} 秒で終わらなかったので止めた`, true);
        else if (code === 0) resolve(capture ? Buffer.concat(out).toString('utf8') : '');
        // 画面に出すのは最後の行だけ（ツールは最後に理由を 1 行で書いて終わる）。全文はジョブのログにある
        else fail(`${cmd} が失敗した(終了コード ${code}): ${tail.trim().split(/\r?\n/).at(-1).slice(-300)}${capture && outTail.trim() ? ` / 標準出力の末尾: ${outTail.trim().slice(-300)}` : ''}`, this.closed);
      });
    });
  }

  async #voice(ctx) {
    const {charId, verId, lineId, text, reading, emotion, voice} = ctx.job.input;
    const env = this.env, dir = ctx.workDir;
    const face = path.join(dir, 'face.png'), source = path.join(dir, 'source.mp4');

    await ctx.step('顔を撮る');
    if (env.CHARASTA_FAKE_CAPTURE) {
      await ctx.run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x886655:s=1280x720', '-frames:v', '1', face]);
    } else {
      await ctx.run('node', [path.join(root, 'tools', 'face_shot.mjs'), '--char', charId, '--ver', verId, '--out', face, '--port', String(this.getPort())]);
    }

    await ctx.step(env.CHARASTA_FAKE_GROK ? '声付きの動画を作る(試しの動き)' : 'Grok で声付きの動画を作る');
    if (env.CHARASTA_FAKE_GROK) await this.#fakeGrok(ctx, source, String(env.CHARASTA_FAKE_GROK));
    else await ctx.run('python', [path.join(root, 'tools', 'grok_voice.py'), source, '--first', face, '--voice', voice.id, '--text=' + text]);

    await ctx.step('音声を取り出す');
    const wav = path.join(dir, 'audio.wav'), mp3 = path.join(dir, 'audio.mp3');
    try {
      await ctx.run('ffmpeg', ['-y', '-v', 'error', '-i', source, '-vn', '-ac', '1', '-ar', '48000', wav]);
    } catch { throw new Error('動画から音声を取り出せなかった(音声が無い動画かもしれない)'); }
    await ctx.run('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '4', mp3]);

    await ctx.step('声の区間を確かめる');
    const {voiced, total} = voicedSeconds(parseWav(await fs.readFile(wav)));
    ctx.log(`声の区間 合計 ${voiced.toFixed(2)} 秒 / 音声 ${total.toFixed(2)} 秒\n`);
    if (voiced < MIN_VOICED_SEC) throw new Error(`声がほとんど無い(声の区間 ${voiced.toFixed(2)} 秒 / 音声 ${total.toFixed(2)} 秒。${MIN_VOICED_SEC} 秒未満)`);

    await ctx.step('セリフとして取り込む');
    const line = await this.lib.importLine({charId, id: lineId, text, reading, emotion, voice, data: await fs.readFile(mp3), ext: '.mp3',
      source: {grokJob: ctx.job.id, video: 'source.mp4'}, files: {'source.mp4': source}});
    return {lineId, voicedSec: Number(voiced.toFixed(2)), audioUrl: `/lib/characters/${charId}/lines/${lineId}/${line.audio}`,
      sourceUrl: `/lib/characters/${charId}/lines/${lineId}/source.mp4`};
  }

  async #fakeGrok(ctx, out, mode) {
    if (mode === 'fail') throw new Error('試しの動き: Grok が失敗した');
    const audio = mode === 'silent' ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono'] : ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=1.5', '-af', 'adelay=300:all=1,apad=whole_dur=2'];
    await ctx.run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x335577:s=1280x720:r=30', ...audio,
      '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]);
  }

  async #video(ctx) {
    const {charId, verId, lineId, framing} = ctx.job.input;
    const env = this.env, frames = path.join(ctx.workDir, 'frames');
    const line = await this.lib.getLine(charId, lineId);
    const seconds = await mediaSeconds(ctx, line.audioFile);

    const file = this.lib.videoFile(charId, lineId, verId, framing), tmp = file.replace(/\.mp4$/, '.tmp.mp4');
    try {
      await ctx.step('口の動きを撮る');
      await fs.rm(frames, {recursive: true, force: true});
      await fs.mkdir(frames, {recursive: true});
      if (env.CHARASTA_FAKE_CAPTURE) {
        await ctx.run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x445566:s=720x720:r=30', '-t', String(seconds), '-start_number', '0', path.join(frames, 'f%04d.png')]);
      } else {
        await ctx.run('node', [path.join(root, 'tools', 'lipsync.mjs'), '--char', charId, '--ver', verId, '--line', lineId, '--framing', framing, '--seconds', String(seconds),
          '--out', frames, '--port', String(this.getPort())]);
      }

      await ctx.step('音声と合わせて動画にする');
      await fs.mkdir(path.dirname(file), {recursive: true});
      await ctx.run('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png'), '-i', line.audioFile,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', tmp]);
      await fs.rename(tmp, file); // 同じ版・構図の動画があれば置き換える(作り直せる派生物)
    } finally {   // 失敗しても作業のコマと途中の動画を残さない
      await fs.rm(frames, {recursive: true, force: true});
      await fs.rm(tmp, {force: true});
    }
    return {lineId, verId, framing, url: this.lib.videoUrl(charId, lineId, verId, framing)};
  }
}
