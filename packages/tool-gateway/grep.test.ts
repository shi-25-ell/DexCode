import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { grepWorkspace } from './grep.ts';
import { ensureRg, ManagedToolError } from './managed-tools/ensure-rg.ts';

test('grep searches current disk content with literal, glob, context and bounded matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-grep-'));
  const managedDir = join(root, '.managed-rg');
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'before\nneedle.one\nafter\nneedle.two\n', 'utf8');
    await writeFile(join(root, 'src', 'skip.txt'), 'needle.txt\n', 'utf8');
    const result = await grepWorkspace(root, {
      pattern: 'needle.', path: 'src', glob: '*.ts', literal: true, context: 1, limit: 1,
    }, { managedDir, offline: true });
    assert.equal(result.ok, true);
    assert.equal(result.match_count, 1);
    assert.equal(result.details.matchLimitReached, 1);
    assert.match(result.output, /a\.ts:2: needle\.one/);
    assert.match(result.output, /a\.ts-1- before/);
    assert.doesNotMatch(result.output, /needle\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('grep observes cancellation before starting managed tool discovery', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => grepWorkspace(process.cwd(), { pattern: 'x' }, {
    managedDir: join(process.cwd(), '.missing-managed-rg'), offline: true,
  }, controller.signal), /aborted/i);
});

test('grep enforces total output and single-line limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-grep-limits-'));
  try {
    const lines = Array.from({ length: 200 }, (_, index) => `needle-${index}-${'x'.repeat(600)}`).join('\n');
    await writeFile(join(root, 'large.txt'), lines, 'utf8');
    const result = await grepWorkspace(root, { pattern: 'needle-', literal: true, limit: 200 }, {
      managedDir: join(root, '.managed-rg'), offline: true,
    });
    assert.equal(result.details.truncation.truncated, true);
    assert.equal(result.details.linesTruncated, true);
    assert.ok(Buffer.byteLength(result.output, 'utf8') <= 50 * 1024);
    assert.ok(result.output.split('\n').filter((line) => !line.startsWith('[')).every((line) => line.length <= 500));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('managed ripgrep reports an actionable offline-missing error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-rg-offline-'));
  try {
    await assert.rejects(() => ensureRg({ managedDir: root, offline: true, env: { PATH: '' } }), (error: unknown) => {
      assert.ok(error instanceof ManagedToolError);
      assert.equal(error.code, 'offline_missing');
      assert.match(error.message, /install rg on PATH/i);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
