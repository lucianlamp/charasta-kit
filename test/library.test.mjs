import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {Library, checkId, inside} from '../lib/library.mjs';
import {readZipMember} from '../lib/zip.mjs';
import {tempDir, fakeGlb, makeZip} from './helpers.mjs';

test('ID の検査', () => {
  for (const ok of ['chara4', 'v3-smile-mouth', 'vrma-02', '0']) assert.equal(checkId(ok), ok);
  for (const bad of ['', 'Chara', 'a b', 'a/b', '..', '../x', 'a\\b', '-a', 'a_b', 'あ', null, 'x'.repeat(65)]) {
    assert.throws(() => checkId(bad), {code: 'bad-id'}, String(bad));
  }
});

test('パスの外へ出る指定を拒否する', () => {
  const base = path.resolve('/tmp/x-lib');
  assert.ok(inside(base, 'characters', 'a').startsWith(base));
  for (const rel of [['..', 'etc'], ['characters', '..', '..', 'y'], ['..'], ['']]) {
    assert.throws(() => inside(base, ...rel), {code: 'outside'}, rel.join('/'));
  }
  assert.throws(() => inside(base, 'a\0b'), {code: 'outside'});
});

test('キャラ作成・バージョンの取り込み: コピーと sha256、order、最新バージョン', async () => {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'chara4', name: 'キャラ4', note: 'n', voice: 'grok:eve'});
  const a = fakeGlb({a: 1}), b = fakeGlb({b: 2});
  const v1 = await lib.importVersion({charId: 'chara4', id: 'v1', label: 'l1', data: a, sourcePath: 'S1'});
  const v2 = await lib.importVersion({charId: 'chara4', id: 'v2', label: 'l2', data: b, sourcePath: 'S2', charakuruProject: 'p-1', latest: true});
  assert.equal(v1.order, 1); assert.equal(v2.order, 2);
  assert.equal(v1.sha256, crypto.createHash('sha256').update(a).digest('hex'));
  assert.equal(v2.sizeBytes, b.length);
  assert.equal(v2.source.charakuruProject, 'p-1'); assert.equal(v1.source.charakuruProject, null);
  const copied = await fs.readFile(path.join(lib.dir, 'characters/chara4/versions/v1/model.vrm'));
  assert.deepEqual(copied, a);
  const ch = await lib.getCharacter('chara4');
  assert.equal(ch.latestVersion, 'v2');
  assert.deepEqual(ch.voice, {provider: 'grok', id: 'eve'});
  assert.deepEqual(ch.versions.map(v => v.id), ['v1', 'v2']);
  assert.equal(ch.versions[0].model, '/lib/characters/chara4/versions/v1/model.vrm');
  assert.equal(ch.versions[0].thumb, null);
});

test('最初のバージョンは --latest が無くても最新になり、後のバージョンは --latest が無ければ変わらない', async () => {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'c', name: 'C'});
  await lib.importVersion({charId: 'c', id: 'v1', data: fakeGlb()});
  await lib.importVersion({charId: 'c', id: 'v2', data: fakeGlb({x: 1})});
  assert.equal((await lib.getCharacterJson('c')).latestVersion, 'v1');
});

test('同じ ID では止まり、元のファイルは変わらない', async () => {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'c', name: 'C'});
  await assert.rejects(lib.createCharacter({id: 'c', name: 'D'}), {code: 'exists'});
  const first = fakeGlb({a: 1});
  await lib.importVersion({charId: 'c', id: 'v1', data: first});
  await assert.rejects(lib.importVersion({charId: 'c', id: 'v1', data: fakeGlb({a: 2})}), {code: 'exists'});
  assert.deepEqual(await fs.readFile(path.join(lib.dir, 'characters/c/versions/v1/model.vrm')), first);
  assert.equal((await lib.getCharacter('c')).versions.length, 1);
});

test('VRM でないデータは取り込まず、空のフォルダも残さない', async () => {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'c', name: 'C'});
  await assert.rejects(lib.importVersion({charId: 'c', id: 'v1', data: Buffer.from('not a glb data at all....')}), {code: 'bad-input'});
  await assert.rejects(fs.access(path.join(lib.dir, 'characters/c/versions/v1')));
});

test('キャラが無いとバージョンは取り込めない', async () => {
  const lib = new Library(await tempDir());
  await assert.rejects(lib.importVersion({charId: 'nope', id: 'v1', data: fakeGlb()}), {code: 'not-found'});
});

test('セリフの取り込み', async () => {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'c', name: 'C', voice: 'grok:eve'});
  const audio = Buffer.from('ID3-fake');
  const line = await lib.importLine({charId: 'c', id: 'hello', text: 'こんにちは', data: audio, ext: '.MP3', sourcePath: 'S'});
  assert.equal(line.audio, 'audio.mp3'); assert.equal(line.emotion, null);
  assert.deepEqual(line.voice, {provider: 'grok', id: 'eve'});
  await assert.rejects(lib.importLine({charId: 'c', id: 'hello', text: 'x', data: audio, ext: '.mp3'}), {code: 'exists'});
  await assert.rejects(lib.importLine({charId: 'c', id: 'x1', text: 'x', data: audio, ext: '.ogg'}), {code: 'bad-input'});
  const ch = await lib.getCharacter('c');
  assert.equal(ch.lines[0].audioUrl, '/lib/characters/c/lines/hello/audio.mp3');
  const list = await lib.listCharacters();
  assert.equal(list[0].lineCount, 1); assert.equal(list[0].latest, null);
});

test('zip(charakit)からメンバーを読む', async () => {
  const dir = await tempDir();
  const vrm = fakeGlb({zip: true});
  const file = path.join(dir, 'p.charakit');
  await fs.writeFile(file, makeZip({'a.txt': Buffer.from('hello'), 'documents/vrm/abc.vrm': vrm}));
  assert.deepEqual(await readZipMember(file, 'documents/vrm/abc.vrm'), vrm);
  await assert.rejects(readZipMember(file, 'nope'), /無い/);
});
