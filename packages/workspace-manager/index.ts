import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_PROJECT_ID, type VersionSnapshot } from '../shared/index.ts';
export { createWorkspaceRegistry, type WorkspaceRecord } from './registry.ts';
import { FileMutationQueue } from '../tool-gateway/file-mutation-queue.ts';
import { adaptLegacyPatch } from '../tool-gateway/legacy-patch-adapter.ts';
import { applyStructuredEdit, type PatchFileInput } from '../tool-gateway/structured-edit.ts';

export type PatchFileResult = {
  ok: boolean;
  action: 'patched' | 'patch_failed';
  file?: WorkspaceFile;
  tree?: TreeNode[];
  diff?: { beforeLines: number; afterLines: number; replacements: number; unified: string; eol: 'LF' | 'CRLF'; bom: boolean };
  deprecated?: boolean;
  error?: string;
};

export type TreeNode = {
  id: string;
  name: string;
  type: 'folder' | 'file';
  content?: string;
  children?: TreeNode[];
  path?: string;
};

export type WorkspaceFile = {
  path: string;
  content?: string;
};

type WorkspaceServiceState = {
  tree: TreeNode[];
  rootDir: string;
  projectDir: string;
  snapshotsDir: string;
  versionsFile: string;
};

function createDefaultTree(): TreeNode[] {
  return [];
}

function normalizePath(path: string) {
  const candidate = path.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
  if (!candidate || candidate === '.') return '';
  if (candidate.includes('\0') || candidate.startsWith('/') || /^[a-zA-Z]:\//.test(candidate) || candidate.startsWith('//')) {
    throw new Error('Workspace path must be relative');
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '..')) throw new Error('Workspace path escapes the root');
  return segments.filter((segment) => segment && segment !== '.').join('/');
}

function createNodeId(type: 'file' | 'folder', path: string) {
  const normalized = normalizePath(path);
  return `${type}-${normalized.replace(/[^\w.-]+/g, '-') || 'root'}`;
}


function flattenTree(nodes: TreeNode[], prefix = ''): WorkspaceFile[] {
  return nodes.flatMap((node) => {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type === 'folder') return flattenTree(node.children ?? [], path);
    return [{ path, content: node.content }];
  });
}

function attachChildrenPath(node: TreeNode, parentPath = ''): TreeNode {
  const path = parentPath ? `${parentPath}/${node.name}` : node.name;
  if (node.type === 'folder') {
    return {
      ...node,
      path,
      children: (node.children ?? []).map((child) => attachChildrenPath(child, path)),
    };
  }
  return { ...node, path };
}

function upsertNode(nodes: TreeNode[], segments: string[], content: string): TreeNode[] {
  const [head, ...rest] = segments;
  const index = nodes.findIndex((node) => node.name === head);

  if (rest.length === 0) {
    const fileNode: TreeNode = { id: createNodeId('file', segments.join('/')), name: head, type: 'file', content };
    if (index >= 0) {
      const existing = nodes[index];
      const next = [...nodes];
      next[index] = { ...existing, type: 'file', content };
      return next;
    }
    return [...nodes, fileNode];
  }

  let folderNode: TreeNode;
  if (index >= 0 && nodes[index].type === 'folder') {
    folderNode = nodes[index];
  } else if (index >= 0) {
    folderNode = { ...nodes[index], type: 'folder', children: [] };
  } else {
    folderNode = { id: createNodeId('folder', segments.slice(0, segments.length - rest.length).join('/')), name: head, type: 'folder', children: [] };
  }

  const updatedFolder: TreeNode = {
    ...folderNode,
    children: upsertNode(folderNode.children ?? [], rest, content),
  };

  if (index >= 0) {
    const next = [...nodes];
    next[index] = updatedFolder;
    return next;
  }
  return [...nodes, updatedFolder];
}

function removeNode(nodes: TreeNode[], segments: string[]): TreeNode[] {
  const [head, ...rest] = segments;
  const index = nodes.findIndex((node) => node.name === head);
  if (index < 0) return nodes;
  if (rest.length === 0) {
    return nodes.filter((_, i) => i !== index);
  }

  const node = nodes[index];
  if (node.type !== 'folder') return nodes;
  const updated: TreeNode = {
    ...node,
    children: removeNode(node.children ?? [], rest),
  };
  const next = [...nodes];
  next[index] = updated;
  return next;
}

function renameNode(nodes: TreeNode[], segments: string[], nextName: string): TreeNode[] {
  const [head, ...rest] = segments;
  const index = nodes.findIndex((node) => node.name === head);
  if (index < 0) return nodes;

  if (rest.length === 0) {
    const node = nodes[index];
    const next = [...nodes];
    next[index] = { ...node, name: nextName };
    return next;
  }

  const node = nodes[index];
  if (node.type !== 'folder') return nodes;
  const updated: TreeNode = {
    ...node,
    children: renameNode(node.children ?? [], rest, nextName),
  };
  const next = [...nodes];
  next[index] = updated;
  return next;
}

export function createWorkspaceService(options: { projectId?: string; rootDir?: string; stateDir?: string; initialTree?: TreeNode[] } = {}) {
  const projectId = options.projectId ?? DEFAULT_PROJECT_ID;
  const rootDir = options.rootDir ?? `${process.cwd()}/workspaces/${projectId}/workspace`;

  function createVersionPaths(nextRootDir: string) {
    const projectDir = options.stateDir ? resolve(options.stateDir) : dirname(nextRootDir);
    return {
      projectDir,
      snapshotsDir: join(projectDir, 'snapshots'),
      versionsFile: join(projectDir, 'versions.json'),
    };
  }

  function resolveWorkspacePath(...parts: string[]) {
    const normalized = normalizePath(parts.filter(Boolean).join('/'));
    const target = resolve(state.rootDir, normalized);
    const relation = relative(resolve(state.rootDir), target);
    if (relation.startsWith('..') || isAbsolute(relation)) throw new Error('Workspace path escapes the root');
    return target;
  }
  const state: WorkspaceServiceState = {
    tree: options.initialTree ?? createDefaultTree(),
    rootDir,
    ...createVersionPaths(rootDir),
  };
  const mutationQueue = new FileMutationQueue();

  async function ensureWorkspaceDir() {
    await mkdir(state.rootDir, { recursive: true });
  }

  async function assertNoReparsePoint(path: string): Promise<void> {
    const normalized = normalizePath(path);
    let current = resolve(state.rootDir);
    for (const segment of normalized.split('/').filter(Boolean)) {
      current = resolve(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(`Workspace path crosses a symlink or junction: ${normalized}`);
        }
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return;
        throw error;
      }
    }
  }

  async function ensureProjectLayout() {
    await ensureWorkspaceDir();
    await mkdir(state.snapshotsDir, { recursive: true });
    try {
      await stat(state.versionsFile);
    } catch {
      await writeFile(state.versionsFile, '[]\n', 'utf8');
    }
  }

  async function ensureDirectoryNode(dirPath: string) {
    const normalized = normalizePath(dirPath);
    await assertNoReparsePoint(normalized);
    const absolute = resolveWorkspacePath(normalized);
    await mkdir(absolute, { recursive: true });
  }

  async function readVersions(): Promise<VersionSnapshot[]> {
    await ensureProjectLayout();
    try {
      const raw = await readFile(state.versionsFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is VersionSnapshot => {
        return Boolean(
          item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          typeof item.name === 'string' &&
          typeof item.description === 'string' &&
          typeof item.snapshotPath === 'string' &&
          typeof item.createdAt === 'string'
        );
      });
    } catch {
      return [];
    }
  }

  async function writeVersions(versions: VersionSnapshot[]) {
    await ensureProjectLayout();
    await writeFile(state.versionsFile, `${JSON.stringify(versions, null, 2)}\n`, 'utf8');
  }

  async function nextSnapshotId() {
    const versions = await readVersions();
    const maxId = versions.reduce((max, item) => {
      const match = /^v(\d+)$/.exec(item.id);
      const value = match ? Number(match[1]) : 0;
      return Math.max(max, value);
    }, 0);
    return `v${maxId + 1}`;
  }

  async function removePath(path: string, recursive = false) {
    let lastError: unknown;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(path, { recursive, force: true, maxRetries: 5, retryDelay: 50 });
        return;
      } catch (error: unknown) {
        lastError = error;
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: string }).code)
          : '';
        if (code !== 'EPERM' && code !== 'EBUSY') throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 120 * (attempt + 1)));
      }
    }

    throw lastError;
  }

  async function copyDirectoryContents(sourceDir: string, targetDir: string) {
    await mkdir(targetDir, { recursive: true });
    const entries = await readdir(sourceDir, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>;
    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (entry.isDirectory()) {
        await copyDirectoryContents(sourcePath, targetPath);
        continue;
      }
      const content = await readFile(sourcePath, 'utf8');
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content, 'utf8');
    }
  }

  function listTree(): TreeNode[] {
    return state.tree.map((node) => attachChildrenPath(node));
  }

  function listFiles(): WorkspaceFile[] {
    return flattenTree(state.tree);
  }

  function findFile(path: string): WorkspaceFile | null {
    const normalized = normalizePath(path);
    return listFiles().find((item) => item.path === normalized) ?? null;
  }


  async function patchFile(input: PatchFileInput): Promise<PatchFileResult>;
  async function patchFile(path: string, legacyPatch: string): Promise<PatchFileResult>;
  async function patchFile(inputOrPath: PatchFileInput | string, legacyPatch?: string): Promise<PatchFileResult> {
    const legacy = typeof inputOrPath === 'string';
    let input: PatchFileInput;
    try {
      input = legacy
        ? adaptLegacyPatch(inputOrPath, String(legacyPatch ?? ''))
        : inputOrPath;
    } catch (error) {
      return { ok: false, action: 'patch_failed', error: error instanceof Error ? error.message : String(error) };
    }
    const normalized = normalizePath(input.path);
    return mutationQueue.run(normalized, async () => {
      await ensureWorkspaceDir();
      await assertNoReparsePoint(normalized);
      const filePath = resolveWorkspacePath(normalized);
      let before: string;
      try {
        before = await readFile(filePath, 'utf8');
      } catch (error) {
        return {
          ok: false,
          action: 'patch_failed',
          error: (error as { code?: string }).code === 'ENOENT' ? `File not found: ${normalized}` : String(error),
        };
      }
      let applied;
      try {
        applied = applyStructuredEdit(before, { ...input, path: normalized });
      } catch (error) {
        return { ok: false, action: 'patch_failed', error: error instanceof Error ? error.message : String(error) };
      }

      const temporary = `${filePath}.dexcode-${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, applied.content, 'utf8');
        await rename(temporary, filePath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        return { ok: false, action: 'patch_failed', error: `Atomic file replacement failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      state.tree = upsertNode(state.tree, normalized.split('/').filter(Boolean), applied.content);
      if (legacy) console.warn(`[tool-deprecation] legacy patch_file input used for ${normalized}`);
      return {
        ok: true,
        action: 'patched',
        file: { path: normalized, content: applied.content },
        tree: listTree(),
        diff: {
          beforeLines: applied.beforeLines,
          afterLines: applied.afterLines,
          replacements: applied.replacements,
          unified: applied.diff,
          eol: applied.eol,
          bom: applied.bom,
        },
        ...(legacy ? { deprecated: true } : {}),
      };
    });
  }

  async function updateFile(path: string, content: string, signal?: AbortSignal) {
    const normalized = normalizePath(path);
    return mutationQueue.run(normalized, async () => {
      const abort = () => {
        if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
      };
      abort();
      await ensureWorkspaceDir();
      await assertNoReparsePoint(normalized);
      const filePath = resolveWorkspacePath(normalized);
      let before: string | null = null;
      try {
        before = await readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') {
          return { ok: false, action: 'write_failed', error: error instanceof Error ? error.message : String(error) };
        }
      }
      abort();
      const dir = dirname(filePath);
      if (dir) await mkdir(dir, { recursive: true });
      abort();
      const temporary = `${filePath}.dexcode-${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, 'utf8');
        abort();
        await rename(temporary, filePath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        return { ok: false, action: 'write_failed', error: `Atomic file replacement failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      state.tree = upsertNode(state.tree, normalized.split('/').filter(Boolean), content);
      return {
        ok: true,
        action: before === null ? 'created' : 'updated',
        file: { path: normalized, content },
        tree: listTree(),
      };
    });
  }

  async function createFolder(path: string) {
    await ensureWorkspaceDir();
    const normalized = normalizePath(path);
    await ensureDirectoryNode(normalized);

    const segments = normalized.split('/').filter(Boolean);
    state.tree = upsertNode(state.tree, [...segments, '.folder-marker'], '');
    state.tree = removeNode(state.tree, [...segments, '.folder-marker']);

    return {
      ok: true,
      action: 'created',
      folder: { path: normalized },
      tree: listTree(),
    };
  }

  async function renameItem(path: string, nextName: string) {
    await ensureWorkspaceDir();
    const normalized = normalizePath(path);
    if (normalizePath(nextName).includes('/')) throw new Error('nextName must be one path segment');
    const segments = normalized.split('/').filter(Boolean);
    const parentPath = segments.slice(0, -1).join('/');
    const oldAbsolute = resolveWorkspacePath(normalized);
    const nextPath = parentPath ? `${parentPath}/${nextName}` : nextName;
    await assertNoReparsePoint(normalized);
    await assertNoReparsePoint(nextPath);
    const nextAbsolute = resolveWorkspacePath(nextPath);

    const nextDir = dirname(nextAbsolute);
    if (nextDir) await mkdir(nextDir, { recursive: true });
    await rename(oldAbsolute, nextAbsolute);

    state.tree = renameNode(state.tree, segments, nextName);

    return {
      ok: true,
      action: 'renamed',
      from: { path: normalized },
      to: { path: nextPath },
      tree: listTree(),
    };
  }

  async function deleteItem(path: string) {
    await ensureWorkspaceDir();
    const normalized = normalizePath(path);
    await assertNoReparsePoint(normalized);
    const segments = normalized.split('/').filter(Boolean);
    const absolute = resolveWorkspacePath(normalized);
    const stats = await stat(absolute);

    if (stats.isDirectory()) {
      await rm(absolute, { recursive: true, force: true });
      state.tree = removeNode(state.tree, segments);
      return {
        ok: true,
        action: 'deleted',
        target: { path: normalized, type: 'folder' },
        tree: listTree(),
      };
    }

    await rm(absolute, { force: true });
    state.tree = removeNode(state.tree, segments);
    return {
      ok: true,
      action: 'deleted',
      target: { path: normalized, type: 'file' },
      tree: listTree(),
    };
  }

  const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', '__pycache__', '.cache', 'vendor', '.yarn', 'build', 'coverage', '.next', '.nuxt', 'out']);
  const MAX_SCAN_DEPTH = 6;

  async function scanDir(dir: string, depth = 0): Promise<TreeNode[]> {
    if (depth > MAX_SCAN_DEPTH) return [];
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>;
    } catch {
      return [];
    }
    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        nodes.push({
          id: `folder-${entry.name}`,
          name: entry.name,
          type: 'folder',
          children: await scanDir(fullPath, depth + 1),
        });
      } else {
        nodes.push({ id: `file-${entry.name}`, name: entry.name, type: 'file' });
      }
    }
    return nodes;
  }

  async function loadFromDisk() {
    await ensureProjectLayout();
    state.tree = await scanDir(state.rootDir);
    return state.tree;
  }

  function getRootDir(): string {
    return state.rootDir;
  }

  async function switchRoot(newRootDir: string): Promise<TreeNode[]> {
    const resolved = resolve(newRootDir);
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error(`不是目录：${resolved}`);
    state.rootDir = resolved;
    Object.assign(state, createVersionPaths(resolved));
    state.tree = [];
    await ensureProjectLayout();
    state.tree = await scanDir(state.rootDir);
    return state.tree;
  }

  async function listVersions() {
    const versions = await readVersions();
    return versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function createSnapshot(name = '', description = '') {
    await ensureProjectLayout();

    const snapshotId = await nextSnapshotId();
    const snapshotDir = join(state.snapshotsDir, snapshotId);
    const snapshot: VersionSnapshot = {
      id: snapshotId,
      name: name.trim() || `Snapshot ${snapshotId}`,
      description: description.trim(),
      snapshotPath: normalizePath(relative(state.projectDir, snapshotDir)),
      createdAt: new Date().toISOString(),
    };

    await removePath(snapshotDir, true);
    await cp(state.rootDir, snapshotDir, { recursive: true, force: true });

    const versions = await readVersions();
    versions.push(snapshot);
    await writeVersions(versions);

    return {
      ok: true,
      snapshot,
      versions: await listVersions(),
    };
  }

  async function restoreSnapshot(snapshotId: string) {
    await ensureProjectLayout();

    const versions = await readVersions();
    const snapshot = versions.find((item) => item.id === snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

    const snapshotDir = resolve(state.projectDir, snapshot.snapshotPath);
    await stat(snapshotDir);
    let warning: string | undefined;
    try {
      await removePath(state.rootDir, true);
      await cp(snapshotDir, state.rootDir, { recursive: true, force: true });
    } catch (error: unknown) {
      warning = `无法先清空工作区，已改为覆盖恢复：${error instanceof Error ? error.message : String(error)}`;
      await copyDirectoryContents(snapshotDir, state.rootDir);
    }
    state.tree = await scanDir(state.rootDir);

    return {
      ok: true,
      restoredVersion: snapshot,
      tree: listTree(),
      versions: await listVersions(),
      ...(warning ? { warning } : {}),
    };
  }

  return {
    projectId,
    rootDir,
    projectDir: state.projectDir,
    snapshotsDir: state.snapshotsDir,
    versionsFile: state.versionsFile,
    getRootDir,
    switchRoot,
    listTree,
    listFiles,
    findFile,
    patchFile,
    updateFile,
    createFolder,
    renameItem,
    deleteItem,
    loadFromDisk,
    listVersions,
    createSnapshot,
    restoreSnapshot,
  };
}
