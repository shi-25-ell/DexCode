import { describe, expect, it } from 'vitest';
import { TOOL_TEST_PRESETS } from './tools-panel';

describe('tool settings presets', () => {
  it('tracks the exact active first-party coding tool set', () => {
    expect(Object.keys(TOOL_TEST_PRESETS)).toEqual([
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
    ]);
  });
});
