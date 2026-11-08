// 段階 2 の保管場所: セリフの reading、キャラの更新(PATCH 用)、trash/、書き出した動画の一覧
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Library} from '../lib/library.mjs';
import {Trash} from '../lib/trash.mjs';
import {tempDir, fakeGlb} from './helpers.mjs';

test('セリフの reading: 保存、空なら text、段階 1 のセリフ(reading なし)も text になる', async () => {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'c1', name: 'C1', voice: 'grok:eve'});
  await lib.importLine({charId: 'c1', id: 'a', text: '今日は晴れ', reading: ' きょうははれ ', data: Buffer.from('x'), ext: '.mp3'});
  await lib.importLine({charId: 'c1', id: 'b', text: 'こんにちは', data: Buffer.from('x'), ext: '.mp3'});
  await lib.importLine({charId: 'c1', id: 'c', text: 'やあ', reading: '   ', data: Buffer.from('x'), ext: '.mp3'});
  // 段階 1 の line.json(reading のキーが無い)
  const old = path.join(lib.dir, 'characters/c1/lines/old'); await fs.mkdir(old);
  await fs.writeFile(path.join(old, 'line.json'), JSON.stringify({id: 'old', text: '昔のセリフ', audio: 'audio.mp3'}));
  const lines = Object.fromEntries((await lib.getCharacter('c1')).lines.map(l => [l.id, l]));
  assert.equal(lines.a.reading, 'きょうははれ'); assert.equal(lines.a.text, '今日は晴れ');
  assert.equal(lines.b.reading, 'こんにちは'); assert.equal(lines.c.reading, 'やあ'); assert.equal(lines.old.reading, '昔のセリフ');
  assert.deepEqual(lines.a.videos, []);
  assert.equal((await lib.getLine('c1', 'a')).reading, 'きょうははれ');
  await assert.rejects(lib.importLine({charId: 'c1', id: 'e', text: 't', emotion: 'angryy', data: Buffer.from('x'), ext: '.mp3'}), {code: 'bad-input'});
});

test('updateCharacter: voice / note / latestVersion だけ変えられる。ほかは何も変えずに拒否', async () => {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'c1', name: 'C1', note: 'n', voice: 'grok:eve'});
  await lib.importVersion({charId: 'c1', id: 'v1', data: fakeGlb({a: 1})});
  await lib.importVersion({charId: 'c1', id: 'v2', data: fakeGlb({a: 2})});
  const file = path.join(lib.dir, 'characters/c1/character.json');
  const before = await fs.readFile(file, 'utf8');
  for (const bad of [{name: 'X'}, {id: 'c2'}, {voice: 'grok:leo', createdAt: 'x'}, {versions: []}, {}, [], 'str', null]) {
    await assert.rejects(lib.updateCharacter('c1', bad), {code: 'bad-input'}, JSON.stringify(bad));
  }
  for (const bad of [{voice: 'noprovider'}, {voice: 'grok:'}, {voice: 'grok:a b'}, {voice: {provider: 'grok'}}, {note: 5}, {latestVersion: '../x'}]) {
    await assert.rejects(lib.updateCharacter('c1', bad), {code: /^bad-/}, JSON.stringify(bad));
  }
  await assert.rejects(lib.updateCharacter('c1', {latestVersion: 'v9'}), {code: 'not-found'});
  await assert.rejects(lib.updateCharacter('nope', {note: 'x'}), {code: 'not-found'});
  assert.equal(await fs.readFile(file, 'utf8'), before);

  const ch = await lib.updateCharacter('c1', {voice: 'grok:leo', note: 'new', latestVersion: 'v1'});
  assert.deepEqual(ch.voice, {provider: 'grok', id: 'leo'}); assert.equal(ch.note, 'new'); assert.equal(ch.latestVersion, 'v1'); assert.equal(ch.name, 'C1');
  assert.deepEqual((await lib.updateCharacter('c1', {voice: {provider: 'grok', id: 'rex'}})).voice, {provider: 'grok', id: 'rex'});
  assert.equal((await lib.updateCharacter('c1', {voice: null})).voice, null);
});

test('セリフをごみ箱へ移す: 一覧から消え、完全には消さない。同じ ID で作り直して消しても前のものは上書きされない', async () => {
  const lib = new Library(await tempDir()), trash = new Trash(lib);
  await lib.createCharacter({id: 'c1', name: 'C1'});
  await lib.importLine({charId: 'c1', id: 'a', text: 'あ', data: Buffer.from('audio-a'), ext: '.mp3'});
  await lib.importLine({charId: 'c1', id: 'b', text: 'い', data: Buffer.from('audio-b'), ext: '.mp3'});
  const item = await trash.move('line', {charId: 'c1', id: 'a'});
  assert.match(item.trashId, /-line-c1-a$/);
  assert.deepEqual((await lib.getCharacter('c1')).lines.map(l => l.id), ['b']);
  assert.equal(await fs.readFile(path.join(lib.dir, 'trash', item.trashId, 'files/characters/c1/lines/a/audio.mp3'), 'utf8'), 'audio-a');
  await assert.rejects(trash.move('line', {charId: 'c1', id: 'a'}), {code: 'not-found'});
  await assert.rejects(trash.move('line', {charId: 'c1', id: '..'}), {code: 'bad-id'});
  await lib.importLine({charId: 'c1', id: 'a', text: 'あ2', data: Buffer.from('audio-a2'), ext: '.mp3'});
  const item2 = await trash.move('line', {charId: 'c1', id: 'a'});
  assert.notEqual(item2.trashId, item.trashId);
  assert.equal(await fs.readFile(path.join(lib.dir, 'trash', item.trashId, 'files/characters/c1/lines/a/audio.mp3'), 'utf8'), 'audio-a');
});

test('セリフの videos: videos/<verId>-<framing>.mp4 を一覧に出す', async () => {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'c1', name: 'C1'});
  await lib.importLine({charId: 'c1', id: 'a', text: 'あ', data: Buffer.from('x'), ext: '.mp3'});
  const dir = path.join(lib.dir, 'characters/c1/lines/a/videos'); await fs.mkdir(dir);
  for (const f of ['v3-smile-mouth-face.mp4', 'v1-upper.mp4', 'junk.mp4', 'v1-face.tmp.mp4']) await fs.writeFile(path.join(dir, f), 'x');
  const [line] = (await lib.getCharacter('c1')).lines;
  assert.deepEqual(line.videos, [
    {verId: 'v1', framing: 'upper', url: '/lib/characters/c1/lines/a/videos/v1-upper.mp4'},
    {verId: 'v3-smile-mouth', framing: 'face', url: '/lib/characters/c1/lines/a/videos/v3-smile-mouth-face.mp4'}]);
});

test('updateCharacter: tags の検査。前後の空白を除き、重複は消す', async () => {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'c1', name: 'C1'});
  assert.deepEqual((await lib.getCharacter('c1')).tags, []);
  const file = path.join(lib.dir, 'characters/c1/character.json');
  const tooMany = Array.from({length: 9}, (_, i) => 't' + i);
  for (const bad of [['x'.repeat(21)], [''], ['  '], tooMany, [5], [null], 'abc', {a: 1}, null]) {
    await assert.rejects(lib.updateCharacter('c1', {tags: bad}), {code: 'bad-input'}, JSON.stringify(bad));
  }
  assert.equal((await fs.readFile(file, 'utf8')).includes('"tags"'), false);
  assert.deepEqual((await lib.updateCharacter('c1', {tags: [' 赤髪 ', 'x'.repeat(20), '赤髪', 'ロング']})).tags, ['赤髪', 'x'.repeat(20), 'ロング']);
  assert.equal((await lib.updateCharacter('c1', {tags: tooMany.slice(0, 8)})).tags.length, 8);
  assert.equal((await lib.updateCharacter('c1', {tags: [...tooMany.slice(0, 8), ' t0']})).tags.length, 8);
  assert.deepEqual((await lib.updateCharacter('c1', {tags: []})).tags, []);
});

test('getCharacter: appearances は charId か cast に出るショートを新しい順に返し、壊れた short.json は飛ばす', async () => {
  const lib = new Library(await tempDir());
  await lib.createCharacter({id: 'c1', name: 'C1'});
  await lib.createCharacter({id: 'c2', name: 'C2'});
  assert.deepEqual((await lib.getCharacter('c1')).appearances, []);
  const put = async (id, body) => {
    await fs.mkdir(path.join(lib.dir, 'shorts', id), {recursive: true});
    await fs.writeFile(path.join(lib.dir, 'shorts', id, 'short.json'), typeof body === 'string' ? body : JSON.stringify(body));
  };
  await put('s-old', {id: 's-old', title: '古い', style: 'trivia', charId: 'c1', updatedAt: '2026-01-01T00:00:00Z'});
  await put('s-new', {id: 's-new', title: '新しい', style: 'drama', cast: [{charId: 'c2'}, {charId: 'c1'}], updatedAt: '2026-03-01T00:00:00Z'});
  await put('s-other', {id: 's-other', title: '別', style: 'trivia', charId: 'c2', updatedAt: '2026-02-01T00:00:00Z'});
  await put('s-broken', '{壊れ');
  assert.deepEqual((await lib.getCharacter('c1')).appearances, [
    {shortId: 's-new', title: '新しい', style: 'drama', updatedAt: '2026-03-01T00:00:00Z'},
    {shortId: 's-old', title: '古い', style: 'trivia', updatedAt: '2026-01-01T00:00:00Z'}]);
  assert.deepEqual((await lib.getCharacter('c2')).appearances.map(a => a.shortId), ['s-new', 's-other']);
});
