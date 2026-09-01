import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkspaceService } from './index.ts';

test('workspace structured patch writes atomically and serializes concurrent edits per file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-patch-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'dex-patch-state-'));
  try {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n', 'utf8');
    const workspace = createWorkspaceService({ rootDir: root, stateDir, projectId: 'patch-test' });
    await workspace.loadFromDisk();
    await workspace.updateFile('src/new.ts', 'new file\n');
    assert.equal(await readFile(join(root, 'src', 'new.ts'), 'utf8'), 'new file\n');
    assert.deepEqual((await readdir(join(root, 'src'))).sort(), ['new.ts']);
    const [firstWrite, secondWrite] = await Promise.all([
      workspace.updateFile('serialized.txt', 'first\n'),
      workspace.updateFile('serialized.txt', 'second\n'),
    ]);
    assert.equal(firstWrite.ok, true);
    assert.equal(secondWrite.ok, true);
    assert.equal(await readFile(join(root, 'serialized.txt'), 'utf8'), 'second\n');
    assert.equal((await readdir(root)).some((name) => name.includes('.dexcode-') && name.endsWith('.tmp')), false);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => workspace.updateFile('a.txt', 'must not commit', controller.signal), /Operation aborted/);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');
    const [first, second] = await Promise.all([
      workspace.patchFile({ path: 'a.txt', mode: 'targeted', edits: [{ old_text: 'one', new_text: 'ONE' }] }),
      workspace.patchFile({ path: 'a.txt', mode: 'targeted', edits: [{ old_text: 'two', new_text: 'TWO' }] }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'ONE\nTWO\n');

    const rejected = await workspace.patchFile({ path: 'a.txt', mode: 'replace_all', old_text: 'ONE', new_text: 'one', expected_occurrences: 2 });
    assert.equal(rejected.ok, false);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'ONE\nTWO\n');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
