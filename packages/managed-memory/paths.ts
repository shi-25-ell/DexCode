import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat } from 'node:fs/promises';
import { ManagedMemoryValidationError } from './format.ts';

export const TOPIC_FILENAME_PATTERN_SOURCE = '^[a-z0-9][a-z0-9_-]{0,79}\\.md$';
const TOPIC_PATTERN = new RegExp(TOPIC_FILENAME_PATTERN_SOURCE);
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export type ManagedMemoryPaths = {
  root: string;
  state: string;
  index: string;
  settings: string;
  checkpoints: string;
  operations: string;
  recovery: string;
  consolidation: string;
};

export function createManagedMemoryPaths(workspaceStateDir: string): ManagedMemoryPaths {
  const root = resolve(workspaceStateDir, 'managed-memory');
  const state = join(root, '.state');
  return {
    root,
    state,
    index: join(root, 'MEMORY.md'),
    settings: join(state, 'settings.json'),
    checkpoints: join(state, 'extraction-checkpoints.json'),
    operations: join(state, 'operations.jsonl'),
    recovery: join(state, 'recovery.json'),
    consolidation: join(state, 'consolidation.json'),
  };
}

export function validateTopicPath(pathInput: string): string {
  const path = pathInput.normalize('NFC').replaceAll('\\', '/');
  if (!path || path.includes('\0') || isAbsolute(pathInput) || /^[a-z]:/i.test(pathInput) || pathInput.startsWith('\\\\') || pathInput.startsWith('//')) {
    throw new ManagedMemoryValidationError('Memory path must be a safe relative topic filename');
  }
  if (path.includes('/') || path === '.' || path === '..' || path.includes('..') || WINDOWS_DEVICE.test(path)) {
    throw new ManagedMemoryValidationError('Memory topic path must be a bare filename such as coding-agent-project.md; directory prefixes such as topics/ are not allowed');
  }
  if (path.toLowerCase() === 'memory.md' || !TOPIC_PATTERN.test(path)) {
    throw new ManagedMemoryValidationError('Topic filename must match [a-z0-9][a-z0-9_-]{0,79}.md');
  }
  return path;
}

export function resolveContained(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  const comparable = process.platform === 'win32' ? rel.toLowerCase() : rel;
  if (!rel || comparable === '..' || comparable.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ManagedMemoryValidationError('Memory path escapes its workspace root');
  }
  return target;
}

export async function assertNoSymlink(path: string, allowMissing = true): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new ManagedMemoryValidationError('Symlinks and junctions are not allowed in managed memory');
  } catch (error) {
    if (allowMissing && (error as { code?: string }).code === 'ENOENT') return;
    throw error;
  }
}
