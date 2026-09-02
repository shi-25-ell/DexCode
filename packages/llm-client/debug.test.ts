import assert from 'node:assert/strict';
import test from 'node:test';
import { debugLog } from '../shared/debug.ts';

test('debug errors are opt-in, bounded and redact credentials without recording a transcript', (t) => {
  const before = process.env.DEXCODE_DEBUG;
  const logs: string[] = [];
  t.mock.method(console, 'error', (value: string) => logs.push(value));
  try {
    delete process.env.DEXCODE_DEBUG;
    debugLog('test', new Error('must remain quiet'));
    assert.equal(logs.length, 0);
    process.env.DEXCODE_DEBUG = '1';
    debugLog('test', new Error('Missing reasoning_content. Bearer credential-123\napi_key=secret-value https://user:password@example.test/?token=a ' + 'x'.repeat(3_000)), ['credential-123']);
    assert.equal(logs.length, 1);
    const event = JSON.parse(logs[0]!) as { type: string; detail: string };
    assert.match(event.detail, /Missing reasoning_content/);
    assert.doesNotMatch(event.detail, /credential-123|secret-value|user:password|token=a|\n/);
    assert.ok(event.detail.length <= 2_000);
    assert.deepEqual(Object.keys(event), ['type', 'detail']);
  } finally {
    if (before === undefined) delete process.env.DEXCODE_DEBUG;
    else process.env.DEXCODE_DEBUG = before;
  }
});
