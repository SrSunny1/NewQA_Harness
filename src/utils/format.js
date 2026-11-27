export const COLOR_NAMES = { yellow: '黄色', blue: '蓝色', green: '绿色', pink: '粉色' };

export function shorten(s, n = 60) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export const baseName = (p) => p.split('/').filter(Boolean).pop() || p;

export const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// 工具事件按 id 合并（tool_call / tool_call_update）。
// textOffset = 事件到达时已生成文本长度，即工具在时间线中的插入点；更新事件保留首现位置。
export function mergeTool(list, tool, textOffset) {
  const i = list.findIndex((t) => t.id === tool.id);
  if (i < 0) return [...list, { ...tool, textOffset }];
  return list.map((t, j) =>
    j === i
      ? {
          ...t,
          ...tool,
          textOffset: t.textOffset,
          output: tool.output || t.output,
          command: tool.command || t.command,
        }
      : t,
  );
}
