// 斜杠命令面板的纯函数（node:test 可测，无 DOM 依赖）。
// 交互契约：输入以 '/' 开头且 caret 落在第一个 token 内时弹命令面板；
// 接受候选 = 把第一个 token 替换为 `/{name} `，其后原文保留。

// value 以 '/' 开头、caret 在第一个 token（不含空白的连续串）内 →
// { prefix: '/' 到 caret 之间已输入的过滤前缀, tokenEnd }；否则 null。
export function slashToken(value, caret) {
  if (typeof value !== 'string' || value[0] !== '/') return null;
  if (!Number.isInteger(caret) || caret < 0 || caret > value.length) return null;
  const ws = value.search(/\s/);
  const tokenEnd = ws === -1 ? value.length : ws;
  if (caret > tokenEnd) return null;
  const token = value.slice(0, tokenEnd);
  if (!/^\/\S*$/.test(token)) return null;
  return { prefix: value.slice(1, caret), tokenEnd };
}

// 按 name 做大小写不敏感的前缀过滤，最多 limit 条。
export function filterSlashCommands(commands, prefix, limit = 12) {
  const p = String(prefix ?? '').toLowerCase();
  return (Array.isArray(commands) ? commands : [])
    .filter((c) => c && typeof c.name === 'string' && c.name.toLowerCase().startsWith(p))
    .slice(0, limit);
}

// 接受候选：第一个 token 替换为 `/{name} `，其后文本原样保留
// （分隔空白归一化为一个空格）。返回 { value, caret }。
export function acceptSlash(value, name) {
  const ws = String(value).search(/\s/);
  const rest = ws === -1 ? '' : String(value).slice(ws).replace(/^\s+/, '');
  const next = `/${name} ${rest}`;
  return { value: next, caret: name.length + 2 };
}
