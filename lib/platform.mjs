// OS ごとの違いと、外の道具の場所探し。Windows / macOS / Linux で同じ呼び方にそろえる。
// ここは設定ファイルを読まない(lib/config.mjs がここを使う)。設定の値は引数で受け取る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

// 実行ファイル名。Windows だけ .exe を付ける
export const exe = name => isWin ? name + '.exe' : name;

// 既定の保管場所(OS 標準のデータ置き場)
export function defaultLibraryDir(env = process.env, home = os.homedir()) {
  if (isWin) return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'charasta', 'library');
  if (isMac) return path.join(home, 'Library', 'Application Support', 'charasta', 'library');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'charasta', 'library');
}

// <dir>/.venv の python
export const venvPython = dir => path.join(dir, '.venv', ...(isWin ? ['Scripts', 'python.exe'] : ['bin', 'python']));

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// PATH から実行ファイルを探す(Windows は PATHEXT の拡張子も試す)。見つからなければ null
export function which(name, env = process.env) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = isWin && !path.extname(name) ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  for (const d of dirs) for (const x of exts) { const f = path.join(d, name + x); if (isFile(f)) return f; }
  return null;
}

const pyCache = new Map();
// python コマンド: CHARASTA_PYTHON、なければ python3、python の順(Windows は python、python3 の順。python3 は Store の入口で、python と別物のことがある)で、動くものを選ぶ。どれも動かなければ null
// (Windows の python3 は Microsoft Store への入口のことがあるので、実際に --version を動かして確かめる)
export function findPython(env = process.env) {
  if (env.CHARASTA_PYTHON) return env.CHARASTA_PYTHON;
  if (!pyCache.has('python')) {
    let found = null;
    for (const name of isWin ? ['python', 'python3'] : ['python3', 'python']) {
      const r = spawnSync(name, ['--version'], {encoding: 'utf8', timeout: 5000, windowsHide: true});
      if (r.status === 0 && /Python 3/.test(String(r.stdout) + String(r.stderr))) { found = name; break; }
    }
    pyCache.set('python', found);
  }
  return pyCache.get('python');
}

// Blender: 設定(config.blender か CHARASTA_BLENDER)、PATH の blender、Windows の Program Files の最新バージョン、macOS の /Applications の順。見つからなければ null
export function findBlender(configured, env = process.env) {
  if (env.CHARASTA_BLENDER) return env.CHARASTA_BLENDER;
  if (configured) return configured;
  const onPath = which('blender', env);
  if (onPath) return onPath;
  if (isWin) {
    const base = path.join(env.ProgramFiles || 'C:/Program Files', 'Blender Foundation');
    let names = [];
    try { names = fs.readdirSync(base).filter(n => /^Blender \d/.test(n)); } catch { /* 入っていない */ }
    names.sort((a, b) => b.localeCompare(a, 'en', {numeric: true}));
    for (const n of names) { const f = path.join(base, n, 'blender.exe'); if (isFile(f)) return f; }
  }
  if (isMac && isFile('/Applications/Blender.app/Contents/MacOS/Blender')) return '/Applications/Blender.app/Contents/MacOS/Blender';
  return null;
}

// shell スクリプトを動かす bash。Windows は設定の gitBash(PATH の bash は WSL の入口のことがあるので使わない)、
// 設定が無ければ Git for Windows の標準の場所。それ以外は /bin/bash
export function bashPath(config = {}) {
  if (!isWin) return '/bin/bash';
  if (config.gitBash) return config.gitBash;
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:/Program Files']) {
    if (!base) continue;
    const f = path.join(base, 'Git', 'bin', 'bash.exe');
    if (isFile(f)) return f;
  }
  return null;
}

// RGB MoCap(toyxyz_RGBMocap)の同梱 python。配布物が Windows 用なので、他の OS では見つからない(= ExMR は使えない)
export const rgbmocapPython = dir => path.join(dir, 'runtime', 'python.exe');
