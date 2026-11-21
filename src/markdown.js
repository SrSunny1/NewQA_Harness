// Markdown 渲染：markdown-it，禁用 HTML；远端图片降级为文字标签。
import MarkdownIt from 'markdown-it';

export const md = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: false,
});

// 不把 markdown 图片渲染成 <img>（避免加载远程资源），改为文字标签。
md.renderer.rules.image = (tokens, idx) => {
  const alt = tokens[idx].content || '';
  return `<span class="md-img">[图片：${md.utils.escapeHtml(alt)}]</span>`;
};

// 把 token 流切成顶层「完整块」：开标签与其匹配闭标签（含 inline 子 token）
// 归为一组；fence/hr 等无嵌套 token 单独成块。
export function splitBlocks(tokens) {
  const blocks = [];
  let current = [];
  let depth = 0;
  for (const token of tokens) {
    current.push(token);
    depth += token.nesting;
    if (depth === 0) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

// 返回 [{ html }]，每个元素对应一个 .source-block。
export function renderBlocks(text) {
  const tokens = md.parse(String(text ?? ''), {});
  return splitBlocks(tokens).map((group) => ({
    html: md.renderer.render(group, md.options, {}),
  }));
}

// 把工具调用按 textOffset 插回正文时间线：pending 与持久回合共用。
// 返回 { items, olderTools, blockCount }；items 元素是文本块（含 index/html）
// 或 { tools } 组（同一 offset 的连续工具归为一组）；无有效 offset 的旧工具
// 进 olderTools，由调用方折叠展示。文本块 index 即原 .source-block 序号，
// 保证支线锚点（按块定位）在有无工具时一致。
export function renderTimeline(text, tools = []) {
  const positioned = [];
  const olderTools = [];
  for (const tool of tools) {
    const offset = tool.textOffset;
    if (Number.isInteger(offset) && offset >= 0 && offset <= text.length) positioned.push(tool);
    else olderTools.push(tool);
  }
  positioned.sort((a, b) => a.textOffset - b.textOffset);
  const items = [];
  let from = 0;
  let blockCount = 0;
  const appendText = (to) => {
    if (to > from) {
      for (const block of renderBlocks(text.slice(from, to))) {
        items.push({ ...block, index: blockCount++ });
      }
    }
    from = to;
  };
  for (let i = 0; i < positioned.length;) {
    const offset = positioned[i].textOffset;
    appendText(offset);
    let end = i + 1;
    while (end < positioned.length && positioned[end].textOffset === offset) end++;
    items.push({ tools: positioned.slice(i, end) });
    i = end;
  }
  appendText(text.length);
  return { items, olderTools, blockCount };
}
