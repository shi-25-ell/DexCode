import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCommandWhitelistStore } from './command-whitelist-store.ts';

test('legacy broad builtins are removed while user rules are preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-whitelist-'));
  try {
    await mkdir(root, { recursive: true });
    const file = join(root, 'command-whitelist.json');
    await writeFile(file, JSON.stringify({
      version: 1,
      updatedAt: '2026-08-30T00:00:00.000Z',
      entries: [
        { id: 'default-npm-run', pattern: 'npm run', matchType: 'prefix', addedAt: '2026-08-30T00:00:00.000Z' },
        { id: 'user-rule', pattern: 'npm run verify', matchType: 'exact', addedAt: '2026-08-30T00:00:00.000Z' },
      ],
    }), 'utf8');
    const entries = await createCommandWhitelistStore(root).list();
    assert.equal(entries.some((entry) => entry.id === 'default-npm-run'), false);
    assert.equal(entries.some((entry) => entry.id === 'user-rule' && entry.source === 'user'), true);
    assert.equal(entries.some((entry) => entry.id === 'builtin-git-status' && entry.source === 'builtin'), true);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).entries, entries);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt whitelist files fail visibly instead of restoring defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-whitelist-'));
  try {
    await writeFile(join(root, 'command-whitelist.json'), '{bad json', 'utf8');
    await assert.rejects(() => createCommandWhitelistStore(root).list(), /配置损坏/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('automatic command approval creates only an exact user rule', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-whitelist-'));
  try {
    const store = createCommandWhitelistStore(root);
    const created = await store.addFromCommand('git reset --hard HEAD');
    assert.equal(created.matchType, 'exact');
    assert.equal(created.pattern, 'git reset --hard HEAD');
    assert.equal(created.source, 'user');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
