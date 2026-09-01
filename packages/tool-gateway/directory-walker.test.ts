import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildWorkspaceTree, findPaths, listDirectory } from './directory-walker.ts';

test('directory tools share ignore rules, stable ordering, scope and no-content results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-directory-'));
  try {
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await mkdir(join(root, 'ignored'), { recursive: true });
    await writeFile(join(root, '.gitignore'), 'ignored/\n*.log\n', 'utf8');
    await writeFile(join(root, '.env.example'), 'visible', 'utf8');
    await writeFile(join(root, 'z.ts'), 'root', 'utf8');
    await writeFile(join(root, 'src', 'a.ts'), 'secret-content', 'utf8');
    await writeFile(join(root, 'src', 'nested', 'b.ts'), 'nested', 'utf8');
    await writeFile(join(root, 'src', 'skip.log'), 'ignored', 'utf8');
    await writeFile(join(root, 'ignored', 'hidden.ts'), 'ignored', 'utf8');

    const listed = await listDirectory(root);
    assert.deepEqual(listed.entries.map((entry) => entry.name), ['src', '.env.example', '.gitignore', 'z.ts']);
    assert.equal(JSON.stringify(listed).includes('secret-content'), false);

    const found = await findPaths(root, { pattern: '*.ts' });
    assert.deepEqual(found.paths, ['src/a.ts', 'src/nested/b.ts', 'z.ts']);
    const scoped = await findPaths(root, { pattern: '**/*.ts', path: 'src' });
    assert.deepEqual(scoped.paths, ['a.ts', 'nested/b.ts']);

    const tree = await buildWorkspaceTree(root, { depth: 1 });
    assert.equal(tree.truncated, true);
    assert.equal(tree.truncation_reason, 'depth');
    assert.equal(JSON.stringify(tree).includes('secret-content'), false);
    assert.equal(JSON.stringify(tree).includes('ignored'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
