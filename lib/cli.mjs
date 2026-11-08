// scripts/*.mjs 共通: 引数の解析と、保管場所の用意。
import {parseArgs} from 'node:util';
import {loadConfig} from './config.mjs';
import {Library} from './library.mjs';

export function cliArgs(options) {
  try {
    return parseArgs({options, strict: true, allowPositionals: false}).values;
  } catch (e) { fail(e.message, 2); }
}

export function need(values, ...names) {
  const missing = names.filter(n => values[n] == null || values[n] === '');
  if (missing.length) fail('必要な引数が無い: ' + missing.map(n => '--' + n).join(' '), 2);
}

export function fail(message, code = 1) { console.error(message); process.exit(code); }

export function openLibrary() {
  const cfg = loadConfig();
  return new Library(process.env.CHARASTA_LIBRARY || cfg.libraryDir);
}

export async function run(fn) {
  try { await fn(); } catch (e) { fail((e.code ? `[${e.code}] ` : '') + e.message); }
}
