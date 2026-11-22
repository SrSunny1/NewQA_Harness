// markdown 渲染：file:// 链接 → 文件名片；普通链接与数学不受影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBlocks } from '../src/markdown.js';

const html = (t) => renderBlocks(t).map((b) => b.html).join('\n');

test('file:// markdown 链接渲染为 md-file 片（含解码路径 title）', () => {
  const h = html('[agent_module.py](file:///mnt/e/%E7%A0%94%E7%A9%B6%E7%94%9F/x/src/agent_module.py)');
  assert.match(h, /class="md-file"/, '生成 md-file 片');
  assert.match(h, /agent_module\.py/, '保留标签文本');
  assert.match(h, /title="\/mnt\/e\/研究生\/x\/src\/agent_module\.py"/, 'title 为解码路径');
  assert.ok(!h.includes('<a href="file:'), '不生成 file:// 导航链接');
});

test('普通 https 链接仍是 <a>，裸文本不受影响', () => {
  const h = html('[doc](https://example.com/a) 和 plain text');
  assert.match(h, /<a href="https:\/\/example\.com\/a">doc<\/a>/);
});

test('数学公式仍渲染为 mjx-container', () => {
  assert.match(html('行内 $a_b$'), /mjx-container/);
});
