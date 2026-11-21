import test from 'node:test';
import assert from 'node:assert/strict';
import { slashToken, filterSlashCommands, acceptSlash } from '../src/slash.js';

test('slashToken：仅 '/' 起始且 caret 在首 token 内', () => {
  assert.deepEqual(slashToken('/', 1), { prefix: '', tokenEnd: 1 });
  assert.deepEqual(slashToken('/co', 3), { prefix: 'co', tokenEnd: 3 });
  // caret 在 token 中间 → 前缀取到 caret 处
  assert.deepEqual(slashToken('/compact', 3), { prefix: 'co', tokenEnd: 8 });
  // caret 越过首 token（空格之后）→ 不弹
  assert.equal(slashToken('/compact foo', 9), null);
  // caret 正好在 token 末端（空格处）→ 仍算在内
  assert.deepEqual(slashToken('/compact foo', 8), { prefix: 'compact', tokenEnd: 8 });
  // 非 '/' 起始、空值、越界 caret → null
  assert.equal(slashToken('a/b', 2), null);
  assert.equal(slashToken('', 0), null);
  assert.equal(slashToken('/ab', 5), null);
  assert.equal(slashToken('/ab', -1), null);
  // caret 落在 token 后的空白上（首 token 为 '/'，caret 已过空白）→ null
  assert.equal(slashToken('/ ', 2), null);
  assert.equal(slashToken('/ x', 2), null);
  // caret 仍在首 token '/' 内（空白之前）→ 仍弹
  assert.deepEqual(slashToken('/ ', 1), { prefix: '', tokenEnd: 1 });
});

test('filterSlashCommands：name 大小写不敏感前缀过滤，cap 上限', () => {
  const cmds = [
    { name: 'compact' },
    { name: 'context' },
    { name: 'CompactAll' },
    { name: 'ask' },
    { name: 'bug' },
  ];
  assert.deepEqual(
    filterSlashCommands(cmds, 'co').map((c) => c.name),
    ['compact', 'context', 'CompactAll'],
    '大小写不敏感前缀',
  );
  assert.deepEqual(filterSlashCommands(cmds, '').map((c) => c.name), [
    'compact',
    'context',
    'CompactAll',
    'ask',
    'bug',
  ]);
  assert.deepEqual(filterSlashCommands(cmds, 'ASK').map((c) => c.name), ['ask']);
  assert.deepEqual(filterSlashCommands(cmds, 'zzz'), []);
  // 上限截断
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `c${i}` }));
  assert.equal(filterSlashCommands(many, 'c').length, 12);
  assert.equal(filterSlashCommands(many, 'c', 5).length, 5);
  // 非数组 / 缺 name 条目安全忽略
  assert.deepEqual(filterSlashCommands(null, 'a'), []);
  assert.deepEqual(filterSlashCommands([{ name: 'ask' }, {}, { name: 5 }], 'a'), [
    { name: 'ask' },
  ]);
});

test('acceptSlash：替换首 token 为 /name + 空格，保留其后原文', () => {
  assert.deepEqual(acceptSlash('/co', 'compact'), {
    value: '/compact ',
    caret: '/compact '.length,
  });
  assert.deepEqual(acceptSlash('/co extra text', 'compact'), {
    value: '/compact extra text',
    caret: 9,
  });
  // 多个前导空白归一化为一个
  assert.deepEqual(acceptSlash('/co   keep', 'compact'), {
    value: '/compact keep',
    caret: 9,
  });
});
