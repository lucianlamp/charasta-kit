// 設定の読み込み(サーバーも tools/ も scripts/ もここ 1 つを使う)。config.json があればそれを読む。無ければ既定の値だけで動く。
// config.example.json は写して使う見本で、読み込みには使わない。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bashPath, defaultLibraryDir, findBlender} from './platform.mjs';
import {EDITIONS} from '../public/edition.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// MotionBricks の推論の選び方(設定の motionbricksBackend。lib/motion-gen.mjs、tools/mb_onnx_engine.py の BACKENDS と同じ)
export const MB_BACKENDS = ['auto', 'trt', 'onnx'];

// 表情づくりのジョブが使う外の道具: blender(背景で動かす)、patchVrm(VRM のメタを写す。charakuru-claude-code スキル)、
// springTune(髪の揺れ骨の当たりを整える。with-kimi スキル)。どちらのスキルも読むだけ。
// motionbricksDir: モーションを作るジョブが使う MotionBricks(NVIDIA)のリポジトリ。uv の環境ごと読むだけ(docs/motionbricks.md)。
// motionbricksBackend: その推論。auto(既定。TensorRT が動けば TensorRT、動かなければ ONNX Runtime)、trt、onnx。
// motionbricksOnnxRuntime: ONNX Runtime で動かすときに uv run --with で足すパッケージ(省くと onnxruntime==1.30.0)。
// kimodoDir: 文章からモーションを作るジョブが使う Kimodo(NVIDIA)のリポジトリ。.venv ごと使うだけで変えない。hfCacheDir: そのモデルの置き場(HF_HUB_CACHE)(docs/motion-text.md)。
// vrmaPipelineDir: 動画からモーションを作るジョブが使う vrma-pipeline。.venv ごと読むだけ(docs/video-to-vrma.md)。
// rgbmocapDir: 同じジョブの ExMR の変換が使う RGB MoCap(toyxyz_RGBMocap)。install.cmd を済ませた場所。runtime ごと読むだけ
// sam3dPython、sam3dCkptDir、sam3dSrc、dinov3Src: 同じジョブの sam3d の変換(SAM 3D Body、既定では使わない)。4 つそろうと選べる。NVIDIA の GPU 専用でキットには無い(docs/video-to-vrma.md)
//   sam3dPython: torch(CUDA)と SAM 3D Body の依存が入った Python。sam3dCkptDir: model.ckpt、model_config.yaml、assets/mhr_model.pt を置いたフォルダ
//   sam3dSrc: facebookresearch/sam-3d-body の checkout。dinov3Src: facebookresearch/dinov3 の checkout。どれも読むだけ
// stageStudioDir: MV のシーンと描画の道具(Blender)。読むだけ。out/ にも書かない(docs/shorts-dance-mv.md)
// voicevoxDir: ショート動画の声を作る VOICEVOX Engine(lib/voicevox.mjs)
// hyperframesCli: ショート動画の文字と演出を重ねる HyperFrames の CLI(node で直接呼ぶ。lib/short-compose.mjs)。0.8.33 で固定して導入して使っている
// hyperframesBrowser: その CLI が使う Chrome の実体。渡さないと CLI が自動でダウンロードする
// figureImageGen: ショートの図を Codex の image_gen で作るスクリプト(codex-image-gen スキル。読むだけ)。gitBash: それを動かす bash。PATH の bash は WSL の入口のことがあるので場所を決める
// gitBash: 設定が無いときは lib/platform.mjs の bashPath が決める。
// 外の道具の既定は「設定していない」(null)。null の機能は画面から隠すか、使えない理由を出す(lib/capabilities.mjs)。
// libraryDir だけは OS 標準のデータ置き場が既定。blender は設定、環境変数、PATH、標準の場所の順に自動で探す(lib/platform.mjs)。
// charakuruUrl: きゃらくるのアプリの URL(つくるの画面が開くだけ)
const DEFAULTS = {port: 8870, charakuruUrl: 'http://127.0.0.1:8766/',
  charakuruApp: null, patchVrm: null, springTune: null, motionbricksDir: null, motionbricksBackend: 'auto', motionbricksOnnxRuntime: null, vrmaPipelineDir: null, rgbmocapDir: null,
  sam3dPython: null, sam3dCkptDir: null, sam3dSrc: null, dinov3Src: null,
  kimodoDir: null, hfCacheDir: null, stageStudioDir: null, voicevoxDir: null, figureImageGen: null,
  hyperframesCli: null, hyperframesBrowser: null};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// 環境変数 CHARASTA_CONFIG に JSON ファイルのパスがあれば、config.json の代わりにそれを読む(確かめ用に別の保管場所を使うため)。
// 値が null か空の文字列のキーは「未設定」として既定に戻す。
// edition(版の種類、docs/edition.md): 環境変数 CHARASTA_EDITION、設定の edition、root の edition.json(配るキットに export-kit が書く)の順。どれも無ければ full
export function loadConfig(dir = root, env = process.env) {
  const file = env.CHARASTA_CONFIG;
  const cfg = (file ? readJson(path.resolve(file)) ?? (() => { throw Error('CHARASTA_CONFIG のファイルが無い: ' + file); })() : null)
    ?? readJson(path.join(dir, 'config.json')) ?? {};
  const set = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== null && v !== ''));
  const merged = {...DEFAULTS, libraryDir: defaultLibraryDir(env), ...set};
  // stageStudioDir の既定: キットの root に stage-studio フォルダがあればそれ、無ければ未設定
  const bundled = path.join(dir, 'stage-studio');
  if (!merged.stageStudioDir && fs.existsSync(bundled)) merged.stageStudioDir = bundled;
  const edition = env.CHARASTA_EDITION || merged.edition || readJson(path.join(dir, 'edition.json'))?.edition || 'full';
  if (!EDITIONS.includes(edition)) throw Error(`edition は ${EDITIONS.join(' か ')}: ${edition}`);
  if (!MB_BACKENDS.includes(merged.motionbricksBackend)) throw Error(`motionbricksBackend は ${MB_BACKENDS.join(' / ')}: ${merged.motionbricksBackend}`);
  return {...merged, edition, libraryDir: path.resolve(merged.libraryDir), blender: findBlender(merged.blender, env), gitBash: bashPath(merged)};
}
