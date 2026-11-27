// Fusion 配对选择器的纯函数（node:test 可测，无 DOM 依赖）。
// 数据源是探测到的 model configOption.options：
//   value = fusion-<leader>-sidekick-<sidekick>
//   name  = "Fusion (<Leader 名> + <Sidekick 名>)"
// 把 108 个配对拆成两列，选中后拼回 UID 写进 modelConfig.model。

const FUSION_RE = /^fusion-(.+)-sidekick-(.+)$/i;
const FUSION_NAME_RE = /^Fusion \((.*?) \+ (.*?)\)\s*$/;

export function isFusionValue(value) {
  return FUSION_RE.test(String(value || ''));
}

// 输入框第一个 token（不含空白）是否恰为 /fusion —— 触发配对选择器。
export function isFusionCommand(value) {
  const ws = String(value || '').search(/\s/);
  const token = ws === -1 ? String(value || '') : String(value).slice(0, ws);
  return token === '/fusion';
}

// 去掉输入的第一个 token，其余原样保留（前导空白归一化）。
// 选中配对后调用，把 '/fusion' 从草稿里剥掉。
export function stripFirstToken(value) {
  const ws = String(value || '').search(/\s/);
  return ws === -1 ? '' : String(value).slice(ws).replace(/^\s+/, '');
}

// options: [{value,name}] →
//   { leaders: [{key,label}],
//     sides: Map<leaderKey, [{key,label,uid}]> }
// 顺序与探测返回顺序一致；显示名优先取 "Fusion (A + B)" 的拆分，
// 其次同名普通模型选项的 name，最后回退原始 key。
export function parseFusionPairs(options) {
  const plain = new Map(); // 普通模型 value → name
  const pairs = [];
  for (const o of Array.isArray(options) ? options : []) {
    if (!o || typeof o.value !== 'string') continue;
    const m = FUSION_RE.exec(o.value);
    if (!m) {
      if (o.name) plain.set(o.value, String(o.name));
      continue;
    }
    const nm = FUSION_NAME_RE.exec(String(o.name || ''));
    pairs.push({
      uid: o.value,
      leader: m[1],
      side: m[2],
      leaderName: nm?.[1] || '',
      sideName: nm?.[2] || '',
    });
  }
  const leaders = [];
  const seen = new Set();
  const sides = new Map();
  for (const p of pairs) {
    if (!seen.has(p.leader)) {
      seen.add(p.leader);
      leaders.push({
        key: p.leader,
        label: p.leaderName || plain.get(p.leader) || p.leader,
      });
    }
    if (!sides.has(p.leader)) sides.set(p.leader, []);
    sides.get(p.leader).push({
      key: p.side,
      label: p.sideName || plain.get(p.side) || p.side,
      uid: p.uid,
    });
  }
  return { leaders, sides };
}

// 由当前 fusion uid 反推选择器初始焦点 {leaderIdx, sideIdx}；解析失败回 0。
export function fusionIndices(pairs, uid) {
  const m = FUSION_RE.exec(String(uid || ''));
  if (!m || !pairs) return { leaderIdx: 0, sideIdx: 0 };
  const leaderIdx = Math.max(
    0,
    pairs.leaders.findIndex((l) => l.key === m[1]),
  );
  const sides = pairs.sides.get(pairs.leaders[leaderIdx]?.key) || [];
  const sideIdx = Math.max(
    0,
    sides.findIndex((s) => s.key === m[2]),
  );
  return { leaderIdx, sideIdx };
}

// fusion uid 拆 Lead×Sidekick：fusion-<lead>-sidekick-<side> → {lead, side}。
export function splitFusionUid(uid) {
  const m = FUSION_RE.exec(String(uid || ''));
  return m ? { lead: m[1], side: m[2] } : null;
}

// 模型 sku 美化：去掉思考档/速度后缀（-medium/-high/-lightning/-fast 等），
// 留家族主体：claude-opus-5-5-medium → claude-opus-5-5。
export function prettifyModelKey(key) {
  return String(key || '').replace(
    /-(none|low|medium|high|xhigh|max)(-(lightning|fast|priority))*$/i,
    '',
  );
}
