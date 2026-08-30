import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkspaceService } from './index.ts';
import { createWorkspaceRegistry } from './registry.ts';

test('Workspace registry gives a canonical directory a stable identity', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dexcode-registry-'));
  const rootA = join(temporary, 'workspace-a');
  const rootB = join(temporary, 'workspace-b');
  const registryFile = join(temporary, 'state', 'workspaces.json');
  try {
    await Promise.all([mkdir(rootA), mkdir(rootB)]);
    const registry = createWorkspaceRegistry({ registryFile });
    const first = await registry.register(rootA);
    const repeated = await registry.register(rootA);
    const second = await registry.register(rootB);
    const reopened = createWorkspaceRegistry({ registryFile });

    assert.equal(repeated.workspaceId, first.workspaceId);
    assert.notEqual(second.workspaceId, first.workspaceId);
    assert.equal((await reopened.resolveAvailable(first.workspaceId)).canonicalRootPath, first.canonicalRootPath);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('Workspace registry refuses to resolve a workspace whose directory disappeared', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dexcode-registry-missing-'));
  const root = join(temporary, 'workspace');
  try {
    await mkdir(root);
    const registry = createWorkspaceRegistry({ registryFile: join(temporary, 'workspaces.json') });
    const workspace = await registry.register(root);
    await rm(root, { recursive: true, force: true });
    await assert.rejects(() => registry.resolveAvailable(workspace.workspaceId));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('workspace runtime state can be isolated from sibling workspace roots', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dexcode-workspace-state-'));
  const rootA = join(temporary, 'roots', 'a');
  const rootB = join(temporary, 'roots', 'b');
  try {
    await Promise.all([mkdir(rootA, { recursive: true }), mkdir(rootB, { recursive: true })]);
    const workspaceA = createWorkspaceService({ rootDir: rootA, stateDir: join(temporary, 'state', 'a') });
    const workspaceB = createWorkspaceService({ rootDir: rootB, stateDir: join(temporary, 'state', 'b') });
    await Promise.all([workspaceA.loadFromDisk(), workspaceB.loadFromDisk()]);
    await workspaceA.createSnapshot('A');
    assert.equal((await workspaceA.listVersions()).length, 1);
    assert.equal((await workspaceB.listVersions()).length, 0);
    assert.notEqual(workspaceA.projectDir, workspaceB.projectDir);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
