import type { WorkspaceFile } from '../workspace-manager/index.ts';

type WorkspaceSummary = {
  prompt: string;
  selectedFile: string | null;
  selectedFileContent: WorkspaceFile | null;
  workspaceSummary: string;
  projectKnowledgeSummary: string;
  contextBudget: {
    maxFiles: number;
    maxChars: number;
    includedFiles: string[];
    strategy: 'compact' | 'balanced' | 'deep';
  };
};

type BuildForPromptOptions = {
  projectKnowledge?: string;
};

type TaskComplexity = 'simple' | 'medium' | 'complex';

type RankedFile = WorkspaceFile & {
  score: number;
  reasons: string[];
};

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'you',
  'are',
  '请',
  '帮我',
  '一个',
  '这个',
  '那个',
  '进行',
  '代码',
  '项目',
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte']);
const TEST_MARKERS = ['test', 'spec', '__tests__'];

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: unknown): string[] {
  return normalizeText(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/gu)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function getExtension(filePath: string): string {
  const match = /\.[^.\/\\]+$/.exec(filePath.toLowerCase());
  return match?.[0] ?? '';
}

function uniqueByPath(files: RankedFile[]): RankedFile[] {
  const seen = new Set<string>();
  const result: RankedFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    result.push(file);
  }
  return result;
}

function assessComplexity(prompt: string, selectedFile: string | null): TaskComplexity {
  const tokens = tokenize(prompt);
  const lower = prompt.toLowerCase();
  const complexMarkers = ['重构', '架构', '上下文', 'memory', 'skill', '多轮', '全局', '优化', 'refactor', 'architecture'];
  const mediumMarkers = ['修改', '新增', '修复', '测试', '接口', '组件', 'add', 'fix', 'update', 'test'];

  if (tokens.length > 28 || complexMarkers.some((marker) => lower.includes(marker))) return 'complex';
  if (selectedFile || tokens.length > 12 || mediumMarkers.some((marker) => lower.includes(marker))) return 'medium';
  return 'simple';
}

function budgetForComplexity(base: { maxFiles: number; maxChars: number }, complexity: TaskComplexity) {
  if (complexity === 'simple') {
    return { maxFiles: Math.max(3, Math.min(base.maxFiles, 5)), maxChars: Math.max(4000, Math.round(base.maxChars * 0.65)), strategy: 'compact' as const };
  }
  if (complexity === 'complex') {
    return { maxFiles: Math.max(base.maxFiles, 12), maxChars: Math.max(base.maxChars, 18000), strategy: 'deep' as const };
  }
  return { ...base, strategy: 'balanced' as const };
}

function scoreFile(file: WorkspaceFile, promptTokens: string[], selectedFileTokens: string[], selectedFile: string | null): RankedFile {
  const filePath = file.path;
  const pathTokens = tokenize(filePath);
  const contentTokens = tokenize(file.content ?? '');
  const combined = new Set([...promptTokens, ...selectedFileTokens]);
  let score = 0;
  const reasons: string[] = [];

  if (selectedFile && filePath === selectedFile) {
    score += 100;
    reasons.push('selected');
  }

  for (const token of pathTokens) {
    if (combined.has(token)) {
      score += 8;
      reasons.push(`path:${token}`);
    }
    if (promptTokens.includes(token)) score += 4;
    if (selectedFileTokens.includes(token)) score += 3;
  }

  const contentTokenSet = new Set(contentTokens);
  const contentHits = promptTokens.filter((token) => contentTokenSet.has(token)).length;
  if (contentHits > 0) {
    score += Math.min(contentHits * 3, 24);
    reasons.push(`content:${contentHits}`);
  }

  if (filePath === 'package.json' || filePath.endsWith('tsconfig.json') || filePath.includes('/config')) {
    score += 5;
    reasons.push('config');
  }

  const extension = getExtension(filePath);
  if (SOURCE_EXTENSIONS.has(extension)) {
    score += 4;
    reasons.push('source');
  }
  if (TEST_MARKERS.some((marker) => filePath.toLowerCase().includes(marker))) {
    score += promptTokens.some((token) => ['test', '测试', '用例'].includes(token)) ? 8 : 1;
    reasons.push('test');
  }
  if (filePath.toLowerCase().includes('readme') || filePath.endsWith('.md')) {
    score += promptTokens.some((token) => ['文档', '总结', '说明', 'doc', 'readme'].includes(token)) ? 8 : 1;
    reasons.push('doc');
  }

  return { ...file, score, reasons };
}

function scoreLine(line: string, promptTokens: string[]): number {
  const lineTokens = new Set(tokenize(line));
  return promptTokens.reduce((sum, token) => sum + (lineTokens.has(token) ? 1 : 0), 0);
}

function compressFileContent(content: string | undefined, promptTokens: string[], maxLines = 24): string {
  const lines = String(content ?? '').split('\n');
  if (lines.length <= maxLines) return lines.join('\n');

  const scored = lines
    .map((line, index) => ({ index, score: scoreLine(line, promptTokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 4);

  if (scored.length === 0) {
    const head = lines.slice(0, Math.ceil(maxLines / 2));
    const tail = lines.slice(-Math.floor(maxLines / 2));
    return [...head, '... (content truncated) ...', ...tail].join('\n');
  }

  const selectedLineIndexes = new Set<number>();
  const radius = Math.max(1, Math.floor(maxLines / (scored.length * 2)));
  for (const item of scored) {
    for (let index = Math.max(0, item.index - radius); index <= Math.min(lines.length - 1, item.index + radius); index += 1) {
      selectedLineIndexes.add(index);
    }
  }

  const selected = [...selectedLineIndexes].sort((a, b) => a - b).slice(0, maxLines);
  const output: string[] = [];
  let previous = -1;
  for (const index of selected) {
    if (previous >= 0 && index > previous + 1) output.push('... (relevant section gap) ...');
    output.push(lines[index]);
    previous = index;
  }
  return output.join('\n');
}

function buildWorkspaceSummary(files: RankedFile[], options: { maxFiles: number; maxChars: number; selectedFile: string | null; promptTokens: string[] }): string {
  const { maxFiles, maxChars, selectedFile, promptTokens } = options;
  const summary: string[] = [];
  let charCount = 0;

  for (const file of files.slice(0, maxFiles)) {
    const maxLines = file.path === selectedFile ? 48 : file.score > 12 ? 28 : 16;
    const content = compressFileContent(file.content, promptTokens, maxLines);
    const reasonText = file.reasons.length > 0 ? ` (${file.reasons.slice(0, 4).join(', ')})` : '';
    const block = [`FILE: ${file.path}${reasonText}`, content ? content : '(empty)', ''].join('\n');
    if (charCount + block.length > maxChars) break;
    summary.push(block);
    charCount += block.length;
  }

  return summary.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function splitMemorySections(memory: string): Array<{ title: string; body: string }> {
  const lines = memory.replace(/\r\n/g, '\n').split('\n');
  const sections: Array<{ title: string; body: string[] }> = [];
  let current: { title: string; body: string[] } | null = null;

  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[2].trim(), body: [] };
      continue;
    }
    if (!current) current = { title: 'Project Knowledge', body: [] };
    current.body.push(line);
  }

  if (current) sections.push(current);
  return sections
    .map((section) => ({ title: section.title, body: section.body.join('\n').trim() }))
    .filter((section) => section.title || section.body);
}

function retrieveProjectKnowledge(knowledge: string, promptTokens: string[], maxChars: number): string {
  const normalized = knowledge.trim();
  if (!normalized) return '';
  if (normalized.length <= Math.min(maxChars, 2000)) return normalized;

  const sections = splitMemorySections(normalized)
    .map((section) => {
      const sectionTokens = new Set(tokenize(`${section.title}\n${section.body}`));
      const score = promptTokens.reduce((sum, token) => sum + (sectionTokens.has(token) ? 1 : 0), 0);
      return { ...section, score };
    })
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  const selected = sections.filter((section) => section.score > 0).slice(0, 4);
  const fallback = selected.length > 0 ? selected : sections.slice(0, 2);
  const output: string[] = [];
  let charCount = 0;

  for (const section of fallback) {
    const block = [`### ${section.title}`, section.body].join('\n').trim();
    if (charCount + block.length > maxChars) break;
    output.push(block);
    charCount += block.length;
  }

  return output.join('\n\n');
}

export function createContextManager(codingToolHost: {
  listWorkspaceFiles: () => any;
  readFile: (path: string) => any;
}, options: { maxFiles?: number; maxChars?: number } = {}) {
  const maxFiles = options.maxFiles ?? 8;
  const maxChars = options.maxChars ?? 12000;

  return {
    async buildForPrompt(prompt: string, selectedFile: string | null = null, buildOptions: BuildForPromptOptions = {}): Promise<WorkspaceSummary> {
      const files = await codingToolHost.listWorkspaceFiles() as WorkspaceFile[];
      const selectedFileContent = selectedFile ? await codingToolHost.readFile(selectedFile) : null;

      const promptTokens = tokenize(prompt);
      const selectedFileTokens = tokenize(selectedFile ?? '');
      const complexity = assessComplexity(prompt, selectedFile);
      const budget = budgetForComplexity({ maxFiles, maxChars }, complexity);

      const rankedFiles = uniqueByPath([
        ...files
          .map((file) => scoreFile(file, promptTokens, selectedFileTokens, selectedFile))
          .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)),
        ...files.map((file) => ({ ...file, score: 0, reasons: [] })),
      ]).slice(0, budget.maxFiles);

      const workspaceSummary = buildWorkspaceSummary(rankedFiles, {
        maxFiles: budget.maxFiles,
        maxChars: budget.maxChars,
        selectedFile,
        promptTokens,
      });
      const projectKnowledgeSummary = retrieveProjectKnowledge(
        buildOptions.projectKnowledge ?? '',
        promptTokens,
        Math.max(1200, Math.round(budget.maxChars * 0.2)),
      );

      return {
        prompt,
        selectedFile,
        selectedFileContent,
        workspaceSummary,
        projectKnowledgeSummary,
        contextBudget: {
          maxFiles: budget.maxFiles,
          maxChars: budget.maxChars,
          includedFiles: rankedFiles.map((file) => file.path),
          strategy: budget.strategy,
        },
      };
    },
  };
}

export const contextManagerInternals = {
  assessComplexity,
  retrieveProjectKnowledge,
  tokenize,
};
