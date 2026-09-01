import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeToolResult, toolFailure } from './tool-result.ts';

test('ToolResult normalization preserves success data and assigns stable error codes', () => {
  assert.deepEqual(normalizeToolResult({ content: 'ok' }), {
    ok: true,
    status: 'succeeded',
    data: { content: 'ok' },
  });
  assert.deepEqual(toolFailure('invalid_arguments', 'INVALID_ARGUMENTS', 'bad offset'), {
    ok: false,
    status: 'invalid_arguments',
    error: { code: 'INVALID_ARGUMENTS', message: 'bad offset' },
  });
  const legacy = normalizeToolResult({ status: 'rejected', error: '$.offset is not supported' });
  assert.equal(legacy.ok, false);
  if (!legacy.ok) {
    assert.equal(legacy.status, 'invalid_arguments');
    assert.equal(legacy.error.code, 'INVALID_ARGUMENTS');
  }
  const structuredLegacy = normalizeToolResult({ status: 'failed', error: { code: 'NOT_FOUND', message: 'missing' } });
  assert.equal(structuredLegacy.ok, false);
  if (!structuredLegacy.ok) {
    assert.equal(structuredLegacy.error.code, 'NOT_FOUND');
    assert.equal(structuredLegacy.error.message, 'missing');
  }
});
