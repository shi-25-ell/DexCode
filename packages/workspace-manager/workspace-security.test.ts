import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createWorkspaceService } from './index.ts';

test('workspace mutations reject lexical path traversal', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dexcode-workspace-'));
  const root = join(temporary, 'root');
  try {
    const workspace = createWorkspaceService({ rootDir: root, projectId: `test-${crypto.randomUUID()}` });
    await workspace.loadFromDisk();
    await assert.rejects(() => workspace.updateFile('../outside.txt', 'unsafe'), /escapes the root/);
    await assert.rejects(() => access(join(temporary, 'outside.txt')));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('workspace mutations reject Windows junction traversal', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dexcode-junction-'));
  const root = join(temporary, 'root');
  const outside = join(temporary, 'outside');
  try {
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, 'escape'), 'junction');
    const workspace = createWorkspaceService({ rootDir: root, projectId: `test-${crypto.randomUUID()}` });
    await workspace.loadFromDisk();
    await assert.rejects(() => workspace.updateFile('escape/payload.txt', 'unsafe'), /symlink or junction/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
