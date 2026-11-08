// きゃらすたの本体(root)の探し方。引数 --charasta、環境変数 CHARASTA_ROOT、stage-studio がキットの中(<kit>/stage-studio)にあるときはその <kit> の順。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function charastaRoot(arg) {
  const v = arg || (process.env.CHARASTA_ROOT || '').trim();
  if (v) return v;
  const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (fs.existsSync(path.join(parent, 'tools', 'common.mjs'))) return parent;
  throw new Error('きゃらすたの場所が分からない。環境変数 CHARASTA_ROOT か引数 --charasta で指定してほしい(stage-studio をキットの中に置いた場合は自動で見つかる)');
}
