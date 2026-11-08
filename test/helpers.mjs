// テスト共通: 一時の保管場所、最小の glb、最小の zip、自作の VRMA。実際の保管場所には触らない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {createServer} from '../server.mjs';

export async function tempDir(prefix = 'charasta-test-') { return fs.mkdtemp(path.join(os.tmpdir(), prefix)); }

// JSON チャンクだけの最小の glb(VRM の代わり)。
export function fakeGlb(extra = {}) {
  const json = Buffer.from(JSON.stringify({asset: {version: '2.0'}, ...extra}));
  const pad = Buffer.alloc((4 - (json.length % 4)) % 4, 0x20);
  const len = json.length + pad.length;
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + len, 8);
  head.writeUInt32LE(len, 12); head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, json, pad]);
}

export function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// entries: {name: Buffer}。method 8(deflate)で書く。
export function makeZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8'), comp = zlib.deflateRawSync(data), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp); centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(entries).length, 8); eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// 一時の保管場所でサーバーを立てる。extra は設定に足す(例 env: {CHARASTA_FAKE_GROK: "1"})。
export async function startServer(extra = {}) {
  const libraryDir = await tempDir();
  const server = createServer({libraryDir, port: 0, ...extra});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {base, libraryDir, server,
    async close() { await server.jobs.whenIdle(); server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(libraryDir, {recursive: true, force: true}); }};
}

// 自作の VRMA(test/fixtures/make-vrma.mjs が作る。市販のモーション集は再配布できないので使わない)
export const SAMPLE_VRMA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample.vrma');

// ジョブの試しの動き: Grok を呼ばず、ブラウザで撮らない(ffmpeg だけ要る)。
export const FAKE_ENV = {CHARASTA_FAKE_GROK: "1", CHARASTA_FAKE_CAPTURE: "1"};

// 表情づくりの試しの動き: Blender と Python のスクリプトとブラウザを呼ばない(ffmpeg は要る)。
export const STUDIO_ENV = {...FAKE_ENV, CHARASTA_FAKE_BLENDER: '1'};

// きゃらくるのアプリの形をした一時フォルダ: projects/<id>/work/character.blend, review.vrm, project.charakit
export async function fakeCharakuru() {
  const app = await tempDir('charasta-charakuru-'), work = path.join(app, 'projects', 'p1', 'work');
  await fs.mkdir(work, {recursive: true});
  await fs.writeFile(path.join(work, 'character.blend'), crypto.randomBytes(4096));
  await fs.writeFile(path.join(work, 'review.vrm'), fakeGlb({review: 1}));
  await fs.writeFile(path.join(app, 'projects', 'p1', 'project.charakit'), makeZip({'project.json': Buffer.from(JSON.stringify({name: 'キャラ1 の体', savedAt: '2026-10-30T00:00:00Z'}))}));
  return app;
}
