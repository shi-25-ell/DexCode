import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApprovalModeStore } from './approval-mode-store.ts';

test('missing approval settings default to persisted allowlist and survive restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-approval-'));
  try {
    const file = join(root, 'approval-settings.json');
    const first = await createApprovalModeStore({ file, now: () => new Date('2026-08-31T00:00:00.000Z') });
    assert.equal(first.getMode(), 'allowlist');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).mode, 'allowlist');
    const saved = await first.setMode('full_access');
    assert.equal(saved.revision, 1);
    const restarted = await createApprovalModeStore({ file });
    assert.equal(restarted.getMode(), 'full_access');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt approval settings fail closed with a diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-approval-'));
  try {
    const file = join(root, 'approval-settings.json');
    await writeFile(file, '{bad json', 'utf8');
    const store = await createApprovalModeStore({ file });
    assert.equal(store.getMode(), 'read_only');
    assert.match(store.getDiagnostic() ?? '', /损坏/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('same approval mode is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-approval-'));
  try {
    const store = await createApprovalModeStore({ file: join(root, 'approval-settings.json') });
    const before = store.getState();
    const after = await store.setMode('allowlist');
    assert.deepEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed persistence does not change the in-memory approval mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-approval-'));
  try {
    const store = await createApprovalModeStore({ file: root });
    assert.equal(store.getMode(), 'read_only');
    await assert.rejects(() => store.setMode('full_access'));
    assert.equal(store.getMode(), 'read_only');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
