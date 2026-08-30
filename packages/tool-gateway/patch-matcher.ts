/** 补丁匹配增强：空白归一化、fuzzy 块定位、行号锚点 */

export function normalizeMatchText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

export function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd());
}

export type FuzzyMatchResult = {
  found: boolean;
  startLine: number;
  endLine: number;
  content: string;
};

/** 滑动窗口：允许少量行不匹配 */
export function findFuzzyBlock(source: string, searchBlock: string, maxLineMismatch = 2): FuzzyMatchResult {
  const srcLines = normalizeLines(source);
  const searchLines = normalizeLines(searchBlock).filter((l) => l.length > 0);
  if (searchLines.length === 0) {
    return { found: false, startLine: -1, endLine: -1, content: '' };
  }

  const normSearch = searchLines.map((l) => normalizeMatchText(l));

  for (let i = 0; i <= srcLines.length - searchLines.length; i++) {
    let mismatches = 0;
    let matched = true;
    for (let j = 0; j < searchLines.length; j++) {
      const a = normalizeMatchText(srcLines[i + j] ?? '');
      const b = normSearch[j];
      if (a !== b && !a.includes(b) && !b.includes(a)) {
        mismatches++;
        if (mismatches > maxLineMismatch) {
          matched = false;
          break;
        }
      }
    }
    if (matched) {
      const block = srcLines.slice(i, i + searchLines.length).join('\n');
      return { found: true, startLine: i + 1, endLine: i + searchLines.length, content: block };
    }
  }

  return { found: false, startLine: -1, endLine: -1, content: '' };
}

export function parseLineAnchor(patchText: string): { line: number; rest: string } | null {
  const firstLine = patchText.split(/\r?\n/)[0]?.trim() ?? '';
  const m = firstLine.match(/^@@\s*(?:line|L)?\s*(\d+)\s*$/i) || firstLine.match(/^#\s*line\s*(\d+)\s*$/i);
  if (!m) return null;
  const line = Number(m[1]);
  if (!Number.isFinite(line) || line < 1) return null;
  const rest = patchText.split(/\r?\n/).slice(1).join('\n').trim();
  return { line, rest };
}

export function applyAtLineAnchor(
  source: string,
  line: number,
  beforeBlock: string,
  afterBlock: string,
): { content: string; replaced: boolean; hint?: string } {
  const lines = normalizeLines(source);
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { content: source, replaced: false, hint: `行号 ${line} 超出文件范围（共 ${lines.length} 行）` };
  }

  const fuzzy = findFuzzyBlock(lines.slice(idx).join('\n'), beforeBlock, 1);
  if (fuzzy.found) {
    const start = idx + fuzzy.startLine - 1;
    const end = idx + fuzzy.endLine - 1;
    const afterLines = normalizeLines(afterBlock);
    const next = [...lines.slice(0, start), ...afterLines, ...lines.slice(end + 1)];
    return { content: next.join('\n'), replaced: true };
  }

  const singleLine = lines[idx];
  if (beforeBlock.trim() && normalizeMatchText(singleLine).includes(normalizeMatchText(beforeBlock.trim()))) {
    const next = [...lines];
    next[idx] = afterBlock.split('\n')[0] ?? afterBlock;
    return { content: next.join('\n'), replaced: true };
  }

  const context = lines.slice(Math.max(0, idx - 2), Math.min(lines.length, idx + 3)).join('\n');
  return {
    content: source,
    replaced: false,
    hint: `第 ${line} 行附近未匹配。附近内容：\n${context}`,
  };
}

export function applyFuzzyReplacement(
  source: string,
  beforeBlock: string,
  afterBlock: string,
): { content: string; replaced: boolean; hint?: string } {
  const exactIndex = source.indexOf(beforeBlock);
  if (exactIndex >= 0) {
    return {
      content: source.slice(0, exactIndex) + afterBlock + source.slice(exactIndex + beforeBlock.length),
      replaced: true,
    };
  }

  const trimmedBefore = beforeBlock.trim();
  const trimmedIndex = source.indexOf(trimmedBefore);
  if (trimmedIndex >= 0) {
    return {
      content: source.slice(0, trimmedIndex) + afterBlock + source.slice(trimmedIndex + trimmedBefore.length),
      replaced: true,
    };
  }

  const fuzzy = findFuzzyBlock(source, beforeBlock);
  if (fuzzy.found) {
    const lines = normalizeLines(source);
    const start = fuzzy.startLine - 1;
    const end = fuzzy.endLine - 1;
    const afterLines = normalizeLines(afterBlock);
    const next = [...lines.slice(0, start), ...afterLines, ...lines.slice(end + 1)];
    return { content: next.join('\n'), replaced: true };
  }

  const partial = findFuzzyBlock(source, beforeBlock, 4);
  const hint = partial.startLine > 0
    ? `最接近匹配在第 ${partial.startLine}-${partial.endLine} 行，请 read_file 后重试。`
    : '未找到匹配块，建议 read_file 获取最新内容。';

  return { content: source, replaced: false, hint };
}
