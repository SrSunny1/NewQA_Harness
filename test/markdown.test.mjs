import test from 'node:test';
import assert from 'node:assert/strict';
import { md, splitBlocks, renderBlocks, renderTimeline } from '../src/markdown.js';

test('顶层块分组：开闭标签成对，fence/hr 独立成块', () => {
  const text = [
    '# 标题',
    '',
    '第一段文字。',
    '',
    '> 引用内',
    '> 有多行',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '- a',
    '- b',
    '',
    '---',
    '',
    '结尾',
  ].join('\n');
  const blocks = renderBlocks(text);
  assert.equal(blocks.length, 7);
  assert.match(blocks[0].html, /<h1>/);
  assert.match(blocks[2].html, /<blockquote>/, '引用整体是一个块');
  assert.match(blocks[2].html, /有多行/);
  assert.match(blocks[3].html, /<pre>/);
  assert.match(blocks[4].html, /<ul>/);
  assert.match(blocks[5].html, /<hr/);
});

test('HTML 与远程图片被禁用', () => {
  const b = renderBlocks('<script>alert(1)</script>\n\n![alt](https://evil/x.png)');
  const html = b.map((x) => x.html).join('');
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /\[图片：alt\]/);
});

test('空文本与未闭合代码块不崩', () => {
  assert.equal(renderBlocks('').length, 0);
  const b = renderBlocks('```js\n未闭合');
  assert.match(b[0].html, /未闭合/);
});

test('renderTimeline：无 offset 的旧工具归入 olderTools，块索引与 renderBlocks 一致', () => {
  const text = '# 标题\n\n第一段。\n\n第二段。';
  const { items, olderTools, blockCount } = renderTimeline(text, [{ id: 'old' }]);
  const blocks = renderBlocks(text);
  assert.equal(blockCount, blocks.length);
  assert.equal(items.length, blocks.length);
  assert.deepEqual(
    items.map((i) => i.index),
    blocks.map((_, i) => i),
    'index 连续，与原 .source-block 序号一致',
  );
  assert.deepEqual(
    items.map((i) => i.html),
    blocks.map((b) => b.html),
    'html 与 renderBlocks 相同',
  );
  assert.equal(olderTools.length, 1);
  assert.equal(olderTools[0].id, 'old');
});
