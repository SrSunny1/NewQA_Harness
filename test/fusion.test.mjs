import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFusionValue,
  isFusionCommand,
  stripFirstToken,
  parseFusionPairs,
  fusionIndices,
} from '../src/fusion.js';

const OPTS = [
  { value: 'swe-2-medium', name: 'SWE-2 Medium' },
  { value: 'swe-2-high', name: 'SWE-2 High' },
  {
    value: 'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium',
    name: 'Fusion (Claude Opus 5.5 Medium + SWE-2 Medium)',
  },
  {
    value: 'fusion-claude-opus-5-5-medium-sidekick-swe-2-high',
    name: 'Fusion (Claude Opus 5.5 Medium + SWE-2 High)',
  },
  {
    value: 'fusion-gpt-6-sol-high-sidekick-swe-2-medium',
    name: 'Fusion (GPT-6 Sol High Thinking + SWE-2 Medium)',
  },
  { value: 'fusion-x-lead-sidekick-y-side', name: 'Fusion' }, // 名称不匹配 → 回退
];

test('isFusionValue：fusion-*-sidekick-* 判定', () => {
  assert.ok(isFusionValue('fusion-a-sidekick-b'));
  assert.ok(!isFusionValue('swe-2-high'));
  assert.ok(!isFusionValue('fusion-alone'));
  assert.ok(!isFusionValue(''));
  assert.ok(!isFusionValue(null));
});

test('isFusionCommand：首 token 恰为 /fusion', () => {
  assert.ok(isFusionCommand('/fusion'));
  assert.ok(isFusionCommand('/fusion 帮我改代码'));
  assert.ok(!isFusionCommand('/fusionx'));
  assert.ok(!isFusionCommand('a /fusion'));
  assert.ok(!isFusionCommand(''));
});

test('stripFirstToken：剥掉首 token 保留正文', () => {
  assert.equal(stripFirstToken('/fusion'), '');
  assert.equal(stripFirstToken('/fusion 你好'), '你好');
  assert.equal(stripFirstToken('/fusion   多 空 格'), '多 空 格');
});

test('parseFusionPairs：按 leader 分组 sidekick，名称拆分', () => {
  const { leaders, sides } = parseFusionPairs(OPTS);
  assert.deepEqual(
    leaders.map((l) => l.label),
    ['Claude Opus 5.5 Medium', 'GPT-6 Sol High Thinking', 'x-lead'],
  );
  assert.equal(leaders[0].key, 'claude-opus-5-5-medium');
  // 名称解析失败时回退：先普通模型 name，再原始 key
  const claudeSides = sides.get('claude-opus-5-5-medium');
  assert.deepEqual(
    claudeSides.map((s) => s.label),
    ['SWE-2 Medium', 'SWE-2 High'],
  );
  assert.equal(claudeSides[1].uid, 'fusion-claude-opus-5-5-medium-sidekick-swe-2-high');
  assert.equal(sides.get('x-lead')[0].label, 'y-side'); // name 'Fusion' 不匹配 → key
  // 空/非法输入
  assert.deepEqual(parseFusionPairs(null).leaders, []);
  assert.deepEqual(parseFusionPairs([{ value: 'swe-2-high' }]).sides.size, 0);
});

test('fusionIndices：由 uid 反推焦点，解析失败回 0', () => {
  const pairs = parseFusionPairs(OPTS);
  assert.deepEqual(
    fusionIndices(pairs, 'fusion-gpt-6-sol-high-sidekick-swe-2-medium'),
    { leaderIdx: 1, sideIdx: 0 },
  );
  assert.deepEqual(fusionIndices(pairs, 'swe-2-high'), { leaderIdx: 0, sideIdx: 0 });
  assert.deepEqual(fusionIndices(pairs, ''), { leaderIdx: 0, sideIdx: 0 });
  assert.deepEqual(fusionIndices(null, 'fusion-a-sidekick-b'), { leaderIdx: 0, sideIdx: 0 });
});
