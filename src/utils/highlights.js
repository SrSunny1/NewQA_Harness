import { QUOTE_LIMIT } from '../model.js';

// ---------- 选区 → 锚点 ----------

export function blockElOf(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  return el?.closest?.('.source-block') || null;
}

function offsetInBlock(block, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setEnd(node, offset);
  return r.toString().length;
}

// 只取本回合自己的 source-block（不含支线 UI 里的块），端点之间按序拼接。
function quoteBetween(startBlock, startOffset, endBlock, endOffset, msgId) {
  const parts = [];
  for (let i = startBlock; i <= endBlock; i++) {
    const block = document.querySelector(
      `.source-block[data-msg="${msgId}"][data-block="${i}"]`,
    );
    if (!block) continue;
    const text = block.textContent || '';
    const s = i === startBlock ? startOffset : 0;
    const e = i === endBlock ? endOffset : text.length;
    parts.push(text.slice(s, e));
  }
  return parts.join('\n').slice(0, QUOTE_LIMIT);
}

export function readAnchorFromRange(range) {
  const sb = blockElOf(range.startContainer);
  const eb = blockElOf(range.endContainer);
  if (!sb || !eb) return null;
  const msgId = sb.dataset.msg;
  if (!msgId || msgId !== eb.dataset.msg) return null;
  // 端点落在界面件（引用头、笔记卡、输入框）里时拒绝；
  // 支线回答正文里的 source-block 仍可标注（支持嵌套支线）。
  if (sb.closest('.markup-ui') || eb.closest('.markup-ui')) return null;
  const startBlock = Number(sb.dataset.block);
  const endBlock = Number(eb.dataset.block);
  const startOffset = offsetInBlock(sb, range.startContainer, range.startOffset);
  const endOffset = offsetInBlock(eb, range.endContainer, range.endOffset);
  if (startBlock === endBlock && startOffset === endOffset) return null;
  const quote = quoteBetween(startBlock, startOffset, endBlock, endOffset, msgId);
  if (!quote.trim()) return null;
  return { msgId, anchor: { startBlock, startOffset, endBlock, endOffset, quote } };
}

function textRangesInBlock(block, segStart, segEnd) {
  const ranges = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.data.length;
    const ns = pos;
    const ne = pos + len;
    pos = ne;
    if (ne > segStart && ns < segEnd) {
      const s = Math.max(0, segStart - ns);
      const e = Math.min(len, segEnd - ns);
      if (e > s) {
        const r = document.createRange();
        r.setStart(node, s);
        r.setEnd(node, e);
        ranges.push(r);
      }
    }
    if (pos >= segEnd) break;
  }
  return ranges;
}

function directAnchorPieces(msgId, anchor) {
  if (anchor.startBlock > anchor.endBlock) return null;
  const pieces = [];
  const parts = [];
  for (let i = anchor.startBlock; i <= anchor.endBlock; i++) {
    const block = document.querySelector(
      `.source-block[data-msg="${msgId}"][data-block="${i}"]`,
    );
    if (!block) return null;
    const text = block.textContent || '';
    const s = i === anchor.startBlock ? anchor.startOffset : 0;
    const e = i === anchor.endBlock ? anchor.endOffset : text.length;
    if (s > e || s > text.length || e > text.length) return null;
    pieces.push({ block, start: s, end: e });
    parts.push(text.slice(s, e));
  }
  return { pieces, text: parts.join('\n').slice(0, QUOTE_LIMIT) };
}

function sourceBlocksFor(msgId) {
  return [...document.querySelectorAll(`.source-block[data-msg="${msgId}"]`)].sort(
    (a, b) => Number(a.dataset.block) - Number(b.dataset.block),
  );
}

function linearizeBlocks(blocks, separate, stripNewlines) {
  let text = '';
  const blockAt = [];
  const offsetAt = [];
  blocks.forEach((block, bi) => {
    const content = block.textContent || '';
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      if (stripNewlines && (ch === '\n' || ch === '\r')) continue;
      text += ch;
      blockAt.push(bi);
      offsetAt.push(i);
    }
    if (separate && bi < blocks.length - 1) {
      text += '\n';
      blockAt.push(-1);
      offsetAt.push(-1);
    }
  });
  return { text, blockAt, offsetAt };
}

function approxLinearPosition(blocks, anchor, separate, stripNewlines) {
  const target = Math.min(anchor.startBlock, blocks.length - 1);
  const lenOf = (text) => (stripNewlines ? text.replace(/[\r\n]/g, '').length : text.length);
  let pos = 0;
  for (let i = 0; i < target; i++) {
    pos += lenOf(blocks[i].textContent || '') + (separate ? 1 : 0);
  }
  const content = blocks[target]?.textContent || '';
  const rawPrefix = content.slice(0, Math.min(anchor.startOffset, content.length));
  return pos + lenOf(rawPrefix);
}

function bestQuoteMatch(haystack, needle, approx) {
  if (!needle) return -1;
  let at = 0;
  let best = -1;
  let bestDist = Infinity;
  for (;;) {
    const found = haystack.indexOf(needle, at);
    if (found < 0) break;
    const dist = Math.abs(found - approx);
    if (dist < bestDist) {
      best = found;
      bestDist = dist;
    }
    at = found + 1;
  }
  return best;
}

function rangesForLinearMatch(blocks, linear, start, end) {
  const spans = new Map();
  for (let pos = start; pos < end; pos++) {
    const bi = linear.blockAt[pos];
    if (bi < 0) continue;
    const block = blocks[bi];
    const offset = linear.offsetAt[pos];
    const span = spans.get(block);
    if (span) {
      span.start = Math.min(span.start, offset);
      span.end = Math.max(span.end, offset + 1);
    } else {
      spans.set(block, { start: offset, end: offset + 1 });
    }
  }
  return [...spans.entries()].flatMap(([block, span]) =>
    textRangesInBlock(block, span.start, span.end),
  );
}

function quoteFallbackRanges(msgId, anchor) {
  const quote = (anchor.quote || '').slice(0, QUOTE_LIMIT);
  if (!quote.trim()) return [];
  const blocks = sourceBlocksFor(msgId);
  if (!blocks.length) return [];
  const attempts = [
    { separate: true, stripNewlines: false, needle: quote },
    { separate: false, stripNewlines: true, needle: quote.replace(/[\r\n]/g, '') },
  ];
  for (const attempt of attempts) {
    if (!attempt.needle) continue;
    const linear = linearizeBlocks(blocks, attempt.separate, attempt.stripNewlines);
    const approx = approxLinearPosition(
      blocks,
      anchor,
      attempt.separate,
      attempt.stripNewlines,
    );
    const at = bestQuoteMatch(linear.text, attempt.needle, approx);
    if (at >= 0) return rangesForLinearMatch(blocks, linear, at, at + attempt.needle.length);
  }
  return [];
}

// 锚点 → DOM Range 列表（按块内 textContent 偏移走文本节点）。
export function rangesForAnchor(msgId, anchor) {
  const direct = directAnchorPieces(msgId, anchor);
  if (direct && direct.text === anchor.quote) {
    return direct.pieces.flatMap((p) => textRangesInBlock(p.block, p.start, p.end));
  }
  return quoteFallbackRanges(msgId, anchor);
}
