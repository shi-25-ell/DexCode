import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeToolResult } from '../shared/tool-result.ts';
import { READ_FILE_LIMITS, readWorkspaceFile } from './read-file.ts';

test('read_file reads 1-based line ranges and returns an actionable continuation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-read-'));
  try {
    await writeFile(join(root, 'sample.txt'), 'one\r\ntwo\r\nthree\r\nfour\r\n', 'utf8');
    const result = await readWorkspaceFile(root, { path: 'sample.txt', offset: 2, limit: 2 });
    assert.equal(normalizeToolResult(result).ok, true);
    assert.deepEqual(result, {
      path: 'sample.txt',
      content: 'two\nthree',
      start_line: 2,
      end_line: 3,
      total_lines: 4,
      output_lines: 2,
      output_bytes: 9,
      truncated: true,
      truncation_reason: 'requested_limit',
      next_offset: 4,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read_file enforces the byte ceiling without returning a partial line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-read-byte-'));
  try {
    const line = 'x'.repeat(1_000);
    await writeFile(join(root, 'large.txt'), Array.from({ length: 100 }, () => line).join('\n'), 'utf8');
    const result = await readWorkspaceFile(root, { path: 'large.txt' });
    assert.equal('truncated' in result && result.truncated, true);
    assert.equal('truncation_reason' in result && result.truncation_reason, 'byte_limit');
    assert.ok('output_bytes' in result && result.output_bytes <= READ_FILE_LIMITS.maxBytes);
    assert.ok('next_offset' in result && Number(result.next_offset) > 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read_file returns coded failures for invalid offsets, binary data, and workspace escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dex-read-error-'));
  try {
    await writeFile(join(root, 'short.txt'), 'one\ntwo', 'utf8');
    await writeFile(join(root, 'binary.bin'), Buffer.from([1, 0, 2]));
    const offset = normalizeToolResult(await readWorkspaceFile(root, { path: 'short.txt', offset: 3 }));
    const invalidLimit = normalizeToolResult(await readWorkspaceFile(root, { path: 'short.txt', limit: READ_FILE_LIMITS.maxLines + 1 }));
    const binary = normalizeToolResult(await readWorkspaceFile(root, { path: 'binary.bin' }));
    const escaped = normalizeToolResult(await readWorkspaceFile(root, { path: '../outside.txt' }));
    const controller = new AbortController();
    controller.abort();
    const cancelled = normalizeToolResult(await readWorkspaceFile(root, { path: 'short.txt' }, controller.signal));
    assert.equal(offset.ok, false);
    if (!offset.ok) assert.equal(offset.error.code, 'INVALID_ARGUMENTS');
    assert.equal(invalidLimit.ok, false);
    if (!invalidLimit.ok) assert.equal(invalidLimit.error.code, 'INVALID_ARGUMENTS');
    assert.equal(binary.ok, false);
    if (!binary.ok) assert.equal(binary.error.code, 'EXECUTION_FAILED');
    assert.equal(escaped.ok, false);
    if (!escaped.ok) assert.equal(escaped.error.code, 'PATH_OUTSIDE_WORKSPACE');
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.error.code, 'CANCELLED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
