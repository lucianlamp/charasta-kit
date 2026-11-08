// プロフィールのタグを足すときの検査(public/profile.mjs の addTag)。決まりはサーバーの checkTags と同じ
import test from 'node:test';
import assert from 'node:assert/strict';
import {addTag, MAX_TAGS, MAX_TAG_LENGTH} from '../public/profile.mjs';

test('前後の空白を除いて末尾に足す。元の配列は変えない', () => {
  const tags = ['主役'];
  assert.deepEqual(addTag(tags, '  ナース '), {tags: ['主役', 'ナース']});
  assert.deepEqual(tags, ['主役']);
});

test('空、空白だけ、長すぎは断る。文字数はコードポイントで数える', () => {
  assert.ok(addTag([], '').error);
  assert.ok(addTag([], '   ').error);
  assert.ok(addTag([], 'あ'.repeat(MAX_TAG_LENGTH + 1)).error);
  assert.deepEqual(addTag([], 'あ'.repeat(MAX_TAG_LENGTH)), {tags: ['あ'.repeat(MAX_TAG_LENGTH)]});
  assert.deepEqual(addTag([], '😀'.repeat(MAX_TAG_LENGTH)).tags?.length, 1);
});

test('同じタグと、上限を超える 9 個目は断る', () => {
  assert.match(addTag(['主役'], ' 主役').error, /もう付いている/);
  const full = Array.from({length: MAX_TAGS}, (_, i) => 't' + i);
  assert.match(addTag(full, '新しい').error, /8 個まで/);
  assert.equal(addTag(full.slice(1), '新しい').tags.length, MAX_TAGS);
});
