// 使える機能の一覧(GET /api/capabilities、/api/overview の capabilities)。画面はこれを見て、道具の場所が未設定の機能を隠すか、使えない理由を出す。
// 各項目は {available, setting, note?}。setting は直す設定のキー(config.json)か環境変数の名前。試しの動き(CHARASTA_FAKE_*)のときは使えるとみなす。
import fs from 'node:fs';
import path from 'node:path';
import {findPython, rgbmocapPython, venvPython, which} from './platform.mjs';
import {editionCapabilities, editionOf} from './edition.mjs';
import {expectedBackend} from './motion-gen.mjs';

const isDir = d => { try { return !!d && fs.statSync(d).isDirectory(); } catch { return false; } };
const isFile = f => { try { return !!f && fs.statSync(f).isFile(); } catch { return false; } };
const onPath = (name, given) => !!given && (isFile(given) || !!which(given)) || !given && !!which(name);

// config: loadConfig の値。jobs: JobQueue(env、voicevox、kimodoAvailable を使う)
// 最後に版の種類で決まる項目を足す(lib/edition.mjs。キットで外した機能はここで使えないにする)。edition はその名前の文字列
export async function capabilities({config, jobs}) {
  const env = jobs.env, fake = k => !!env[k];
  const item = (available, setting, note) => ({available: !!available, setting, ...(note && !available ? {note} : {})});
  const blender = !!config.blender && (isFile(config.blender) || !!which(config.blender));
  return editionCapabilities(editionOf(config), {
    // 土台の道具
    ffmpeg: item(onPath('ffmpeg', env.CHARASTA_FFMPEG), 'CHARASTA_FFMPEG', 'ffmpeg を入れて PATH に通す'),
    python: item(findPython(env), 'CHARASTA_PYTHON', 'Python 3 を入れる'),
    blender: item(blender, 'blender', 'Blender を入れるか、設定の blender に実行ファイルを指定する'),
    // 画面の機能
    charakuru: item(isDir(config.charakuruApp), 'charakuruApp', 'きゃらくるのアプリの場所を設定する'),
    expressionStudio: item(isDir(config.charakuruApp) && blender, 'charakuruApp', 'きゃらくる(charakuruApp)と Blender が要る'),
    // backend: どの推論で動く見込みか(tensorrt / onnxruntime / fake)。NVIDIA の GPU が無くても ONNX Runtime で動く(docs/motionbricks.md)
    motionbricks: {...item(fake('CHARASTA_FAKE_MOTIONBRICKS') || isDir(config.motionbricksDir), 'motionbricksDir'),
      backend: expectedBackend(config.motionbricksBackend, {fake: fake('CHARASTA_FAKE_MOTIONBRICKS'), nvidia: !!which('nvidia-smi')})},
    kimodo: item(jobs.kimodoAvailable(), 'kimodoDir'),
    videoMotion: item(fake('CHARASTA_FAKE_VRMA_PIPELINE') || isFile(venvPython(config.vrmaPipelineDir ?? '')), 'vrmaPipelineDir'),
    rgbmocap: item(jobs.exmrAvailable(), 'rgbmocapDir', 'RGB MoCap は Windows 用'),
    videoDownload: item(fake('CHARASTA_FAKE_VRMA_PIPELINE') || onPath('yt-dlp', env.CHARASTA_YTDLP), 'CHARASTA_YTDLP', 'URL の動画を取るには yt-dlp が要る(手元のファイルは取り込める)'),
    stageStudio: item(isDir(config.stageStudioDir), 'stageStudioDir'),
    hyperframes: item(isFile(config.hyperframesCli), 'hyperframesCli'),
    voicevox: item(await jobs.voicevox.available(), 'voicevoxDir'),
    elevenlabs: item(jobs.eleven.ready, 'ELEVENLABS_API_KEY'),
    figureImageGen: item(isFile(config.figureImageGen) && !!config.gitBash, 'figureImageGen', 'Codex の image_gen のスクリプトと bash が要る'),
  });
}
