import assert from 'node:assert/strict';
import test from 'node:test';
import { applyStructuredEdit } from './structured-edit.ts';
import { adaptLegacyPatch } from './legacy-patch-adapter.ts';

test('targeted edits require one exact non-overlapping match and preserve BOM plus CRLF', () => {
  const result = applyStructuredEdit('\uFEFFalpha\r\nbeta\r\n', {
    path: 'a.txt', mode: 'targeted', edits: [{ old_text: 'beta', new_text: 'gamma' }],
  });
  assert.equal(result.content, '\uFEFFalpha\r\ngamma\r\n');
  assert.equal(result.bom, true);
  assert.equal(result.eol, 'CRLF');
  assert.equal(result.replacements, 1);
  assert.match(result.diff, /-beta/);
  assert.match(result.diff, /\+gamma/);

  assert.throws(() => applyStructuredEdit('same same', {
    path: 'a.txt', mode: 'targeted', edits: [{ old_text: 'same', new_text: 'next' }],
  }), /found 2/);
  assert.throws(() => applyStructuredEdit('abcdef', {
    path: 'a.txt', mode: 'targeted', edits: [
      { old_text: 'abc', new_text: 'x' },
      { old_text: 'bcde', new_text: 'y' },
    ],
  }), /overlap/);
});

test('replace_all checks the expected occurrence count before mutation', () => {
  assert.throws(() => applyStructuredEdit('a a a', {
    path: 'a.txt', mode: 'replace_all', old_text: 'a', new_text: 'b', expected_occurrences: 2,
  }), /found 3/);
  const result = applyStructuredEdit('a a a', {
    path: 'a.txt', mode: 'replace_all', old_text: 'a', new_text: 'b', expected_occurrences: 3,
  });
  assert.equal(result.content, 'b b b');
  assert.equal(result.replacements, 3);
});

test('legacy adapter is backend-only and accepts only declared exact separators', () => {
  assert.deepEqual(adaptLegacyPatch('a.txt', 'before\n---\nafter'), {
    path: 'a.txt', mode: 'targeted', edits: [{ old_text: 'before', new_text: 'after' }],
  });
  assert.deepEqual(adaptLegacyPatch('a.txt', 'old => new'), {
    path: 'a.txt', mode: 'targeted', edits: [{ old_text: 'old', new_text: 'new' }],
  });
  assert.throws(() => adaptLegacyPatch('a.txt', '@@ -1 +1 @@\n-old\n+new'), /unsupported/);
  assert.throws(() => adaptLegacyPatch('a.txt', 'old text only'), /unsupported/);
});
