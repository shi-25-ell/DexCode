import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_TOOL_DEFINITIONS } from '../agent-core/tool-definitions.ts';
import {
  ACTIVE_CODING_TOOL_NAMES,
  agentCodingToolDefinitions,
  codingToolSpecs,
  validateCodingToolInput,
} from './tool-registry.ts';
import { DIRECTORY_LIMITS, GREP_LIMITS, READ_FILE_LIMITS } from './tool-limits.ts';

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

test('every agent tool exposes an object schema at the top level', () => {
  for (const tool of agentCodingToolDefinitions()) {
    assert.equal((tool.function.parameters as { type?: unknown }).type, 'object', tool.function.name);
  }
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

test('model-visible schemas and descriptions match the implemented read and search limits', () => {
  const definitions = new Map(agentCodingToolDefinitions().map((tool) => [tool.function.name, tool.function]));
  const read = definitions.get('read_file');
  const readProperties = (read?.parameters as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
  assert.deepEqual(Object.keys(readProperties), ['path', 'offset', 'limit']);
  assert.equal(readProperties.offset?.minimum, 1);
  assert.equal(readProperties.limit?.maximum, READ_FILE_LIMITS.maxLines);
  assert.match(read?.description ?? '', /offset.*1/);
  assert.match(read?.description ?? '', new RegExp(String(READ_FILE_LIMITS.maxBytes / 1024)));

  assert.equal(validateCodingToolInput('grep', { pattern: 'x', context: -2, limit: 0 }), null);
  const grep = definitions.get('grep');
  const grepProperties = (grep?.parameters as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
  assert.equal(grepProperties.context?.minimum, undefined);
  assert.equal(grepProperties.context?.maximum, GREP_LIMITS.maxContextLines);
  assert.equal(grepProperties.limit?.maximum, GREP_LIMITS.maxMatches);

  const find = definitions.get('find');
  const ls = definitions.get('ls');
  const tree = definitions.get('list_workspace');
  assert.match(find?.description ?? '', new RegExp(String(DIRECTORY_LIMITS.findDefaultResults)));
  assert.match(ls?.description ?? '', new RegExp(String(DIRECTORY_LIMITS.lsDefaultEntries)));
  assert.match(tree?.description ?? '', new RegExp(String(DIRECTORY_LIMITS.maxNodes)));
});
