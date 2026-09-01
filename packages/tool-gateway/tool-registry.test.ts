import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_TOOL_DEFINITIONS } from '../agent-core/tool-definitions.ts';
import {
  ACTIVE_CODING_TOOL_NAMES,
  agentCodingToolDefinitions,
  codingToolSpecs,
  validateCodingToolInput,
} from './tool-registry.ts';

const EXPECTED = [
  'find',
  'ls',
  'list_workspace',
  'read_file',
  'grep',
  'run_command',
  'patch_file',
  'write_file',
  'read_command_output',
  'stop_command',
];

test('registry is the exact authoritative set for first-party coding tools', () => {
  assert.deepEqual(ACTIVE_CODING_TOOL_NAMES, EXPECTED);
  assert.deepEqual(codingToolSpecs().map((tool) => tool.name), EXPECTED);
  assert.deepEqual(LOCAL_TOOL_DEFINITIONS.map((tool) => tool.function.name), EXPECTED);
  assert.deepEqual(agentCodingToolDefinitions().map((tool) => tool.function.parameters), codingToolSpecs().map((tool) => tool.inputSchema));
});

test('registry rejects removed names and validates both strict patch shapes', () => {
  for (const removed of ['search_in_workspace', 'read_lints', 'ask_user', 'diff_file', 'list_versions', 'create_snapshot', 'restore_snapshot']) {
    assert.match(String(validateCodingToolInput(removed, {})), /unknown or disabled tool/);
  }
  assert.equal(validateCodingToolInput('patch_file', {
    path: 'a.ts', mode: 'targeted', edits: [{ old_text: 'before', new_text: 'after' }],
  }), null);
  assert.equal(validateCodingToolInput('patch_file', {
    path: 'a.ts', mode: 'replace_all', old_text: 'a', new_text: 'b', expected_occurrences: 2,
  }), null);
  assert.match(String(validateCodingToolInput('patch_file', { path: 'a.ts', patch: 'legacy' })), /does not match/);
  assert.match(String(validateCodingToolInput('grep', { pattern: 'x', extra: true })), /not supported/);
});
