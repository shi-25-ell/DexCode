import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, matchesGlob, relative, resolve } from 'node:path';
import { DIRECTORY_LIMITS } from './tool-limits.ts';

export { DIRECTORY_LIMITS } from './tool-limits.ts';

export type DirectoryEntryType = 'file' | 'directory' | 'symlink';

export type DirectoryEntry = {
  name: string;
  path: string;
  type: DirectoryEntryType;
};

export type WorkspaceTreeNode = DirectoryEntry & { children?: WorkspaceTreeNode[] };

export type LsResult = {
  path: string;
  entries: DirectoryEntry[];
  total: number;
  truncated: boolean;
  truncation_reason?: 'result_limit' | 'byte_limit';
};

export type FindResult = {
  pattern: string;
  path: string;
  paths: string[];
  total: number;
  truncated: boolean;
  truncation_reason?: 'result_limit' | 'byte_limit';
};

export type ListWorkspaceResult = {
  root: WorkspaceTreeNode;
  node_count: number;
  truncated: boolean;
  truncation_reason?: 'depth' | 'node_limit' | 'byte_limit';
};

function posixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function within(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

export async function resolveWorkspacePath(root: string, requested = '.'): Promise<string> {
  const lexical = resolve(root, requested || '.');
  if (!within(root, lexical)) throw new Error('Workspace path escapes the root');
  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([realpath(root), realpath(lexical)]);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw new Error(`Path not found: ${requested || '.'}`);
    throw error;
  }
  if (!within(realRoot, realTarget)) throw new Error('Workspace path crosses a link outside the root');
  return realTarget;
}

function compareEntries(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.type === 'directory' && right.type !== 'directory') return -1;
  if (left.type !== 'directory' && right.type === 'directory') return 1;
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true })
    || left.name.localeCompare(right.name);
}

type IgnoreRule = { negative: boolean; directoryOnly: boolean; anchored: boolean; pattern: string };

async function readIgnoreRules(root: string): Promise<IgnoreRule[]> {
  let content = '';
  try {
    content = await readFile(resolve(root, '.gitignore'), 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const negative = line.startsWith('!');
      const raw = negative ? line.slice(1) : line;
      return {
        negative,
        directoryOnly: raw.endsWith('/'),
        anchored: raw.startsWith('/'),
        pattern: raw.replace(/^\//, '').replace(/\/$/, ''),
      };
    })
    .filter((rule) => rule.pattern.length > 0);
}

function globMatches(path: string, pattern: string): boolean {
  try {
    return matchesGlob(path, pattern);
  } catch {
    throw new Error(`Invalid glob pattern: ${pattern}`);
  }
}

function ignored(path: string, type: DirectoryEntryType, rules: IgnoreRule[]): boolean {
  if (path === '.git' || path.startsWith('.git/')) return true;
  const segments = path.split('/');
  let isIgnored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && type !== 'directory') continue;
    const candidatePatterns = rule.anchored || rule.pattern.includes('/')
      ? [rule.pattern, `${rule.pattern}/**`]
      : [rule.pattern, `**/${rule.pattern}`, `**/${rule.pattern}/**`];
    const matched = candidatePatterns.some((pattern) => globMatches(path, pattern))
      || (!rule.pattern.includes('/') && segments.includes(rule.pattern));
    if (matched) isIgnored = !rule.negative;
  }
  return isIgnored;
}

async function readEntries(root: string, directory: string, rules: IgnoreRule[]): Promise<Array<DirectoryEntry & { absolute: string }>> {
  const dirents = await readdir(directory, { withFileTypes: true });
  const entries: Array<DirectoryEntry & { absolute: string }> = [];
  for (const dirent of dirents) {
    const absolute = resolve(directory, dirent.name);
    const relativePath = posixPath(relative(root, absolute));
    let type: DirectoryEntryType;
    if (dirent.isSymbolicLink()) type = 'symlink';
    else if (dirent.isDirectory()) type = 'directory';
    else if (dirent.isFile()) type = 'file';
    else {
      const info = await lstat(absolute);
      type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file';
    }
    if (ignored(relativePath, type, rules)) continue;
    entries.push({ name: dirent.name, path: relativePath, type, absolute });
  }
  entries.sort(compareEntries);
  return entries;
}

export async function listDirectory(root: string, input: { path?: string; limit?: number } = {}): Promise<LsResult> {
  const directory = await resolveWorkspacePath(root, input.path ?? '.');
  if (!(await stat(directory)).isDirectory()) throw new Error(`Not a directory: ${input.path ?? '.'}`);
  const rules = await readIgnoreRules(root);
  const entries = await readEntries(root, directory, rules);
  const limit = Math.max(1, Math.min(DIRECTORY_LIMITS.lsMaxEntries, Math.floor(input.limit ?? DIRECTORY_LIMITS.lsDefaultEntries)));
  const selected: DirectoryEntry[] = [];
  let bytes = 0;
  let truncationReason: LsResult['truncation_reason'];
  for (const { absolute: _absolute, ...entry } of entries) {
    if (selected.length >= limit) { truncationReason = 'result_limit'; break; }
    const nextBytes = Buffer.byteLength(entry.name, 'utf8') + Buffer.byteLength(entry.path, 'utf8') + Buffer.byteLength(entry.type, 'utf8') + 24;
    if (bytes + nextBytes > DIRECTORY_LIMITS.maxBytes) { truncationReason = 'byte_limit'; break; }
    selected.push(entry);
    bytes += nextBytes;
  }
  return {
    path: posixPath(relative(root, directory)) || '.',
    entries: selected,
    total: entries.length,
    truncated: Boolean(truncationReason),
    ...(truncationReason ? { truncation_reason: truncationReason } : {}),
  };
}

export async function findPaths(
  root: string,
  input: { pattern: string; path?: string; limit?: number },
  signal?: AbortSignal,
): Promise<FindResult> {
  if (!input.pattern || input.pattern.includes('\0')) throw new Error('Invalid glob pattern');
  globMatches('probe', input.pattern);
  const searchRoot = await resolveWorkspacePath(root, input.path ?? '.');
  if (!(await stat(searchRoot)).isDirectory()) throw new Error(`Not a directory: ${input.path ?? '.'}`);
  const rules = await readIgnoreRules(root);
  const limit = Math.max(1, Math.min(DIRECTORY_LIMITS.findMaxResults, Math.floor(input.limit ?? DIRECTORY_LIMITS.findDefaultResults)));
  const matches: string[] = [];
  let bytes = 0;
  let truncated: FindResult['truncation_reason'];

  const visit = async (directory: string): Promise<void> => {
    if (signal?.aborted) throw new Error('Operation aborted');
    for (const entry of await readEntries(root, directory, rules)) {
      if (signal?.aborted) throw new Error('Operation aborted');
      const relativeToSearch = posixPath(relative(searchRoot, entry.absolute));
      const globCandidate = input.pattern.includes('/') ? relativeToSearch : entry.name;
      if (globMatches(globCandidate, input.pattern)) {
        const nextBytes = Buffer.byteLength(relativeToSearch, 'utf8') + 1;
        if (matches.length >= limit) { truncated = 'result_limit'; return; }
        if (bytes + nextBytes > DIRECTORY_LIMITS.maxBytes) { truncated = 'byte_limit'; return; }
        matches.push(relativeToSearch);
        bytes += nextBytes;
      }
      if (entry.type === 'directory') {
        await visit(entry.absolute);
        if (truncated) return;
      }
    }
  };
  await visit(searchRoot);
  matches.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true }) || left.localeCompare(right));
  return {
    pattern: input.pattern,
    path: posixPath(relative(root, searchRoot)) || '.',
    paths: matches,
    total: matches.length,
    truncated: Boolean(truncated),
    ...(truncated ? { truncation_reason: truncated } : {}),
  };
}

export async function buildWorkspaceTree(
  root: string,
  input: { depth?: number } = {},
  signal?: AbortSignal,
): Promise<ListWorkspaceResult> {
  const realRoot = await resolveWorkspacePath(root, '.');
  const rules = await readIgnoreRules(realRoot);
  const maxDepth = Math.max(1, Math.min(DIRECTORY_LIMITS.maxDepth, Math.floor(input.depth ?? DIRECTORY_LIMITS.maxDepth)));
  let nodes = 1;
  let bytes = Buffer.byteLength(basename(realRoot), 'utf8');
  let truncationReason: ListWorkspaceResult['truncation_reason'];

  const visit = async (directory: string, depth: number): Promise<WorkspaceTreeNode[]> => {
    if (signal?.aborted) throw new Error('Operation aborted');
    const output: WorkspaceTreeNode[] = [];
    const entries = await readEntries(realRoot, directory, rules);
    for (const entry of entries) {
      if (signal?.aborted) throw new Error('Operation aborted');
      if (nodes >= DIRECTORY_LIMITS.maxNodes) { truncationReason = 'node_limit'; break; }
      const nextBytes = Buffer.byteLength(entry.name, 'utf8') + Buffer.byteLength(entry.path, 'utf8') + 24;
      if (bytes + nextBytes > DIRECTORY_LIMITS.maxBytes) { truncationReason = 'byte_limit'; break; }
      nodes += 1;
      bytes += nextBytes;
      const node: WorkspaceTreeNode = { name: entry.name, path: entry.path, type: entry.type };
      if (entry.type === 'directory') {
        if (depth >= maxDepth) {
          const hasChildren = (await readEntries(realRoot, entry.absolute, rules)).length > 0;
          if (hasChildren && !truncationReason) truncationReason = 'depth';
          node.children = [];
        } else {
          node.children = await visit(entry.absolute, depth + 1);
        }
      }
      output.push(node);
      if (truncationReason === 'node_limit' || truncationReason === 'byte_limit') break;
    }
    return output;
  };

  const rootNode: WorkspaceTreeNode = {
    name: basename(realRoot),
    path: '',
    type: 'directory',
    children: await visit(realRoot, 1),
  };
  return {
    root: rootNode,
    node_count: nodes,
    truncated: Boolean(truncationReason),
    ...(truncationReason ? { truncation_reason: truncationReason } : {}),
  };
}
