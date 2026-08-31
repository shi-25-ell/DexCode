import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApprovalEffect, ApprovalMode, ApprovalSubject } from '../shared/types.ts';
import { authorizeApproval, createApprovalFingerprint } from './approval-policy.ts';

function subject(effect: ApprovalEffect, extra: Partial<ApprovalSubject> = {}): ApprovalSubject {
  const normalizedInput = extra.normalizedInput ?? { path: 'src/app.ts' };
  return {
    origin: 'agent',
    toolName: effect === 'execute' ? 'run_command' : `tool_${effect}`,
    effect,
    summary: effect,
    normalizedInput,
    fingerprint: createApprovalFingerprint({ toolName: effect, effect, normalizedInput }),
    ...extra,
  };
}

test('approval policy covers the three mode effect matrix', () => {
  const modes: ApprovalMode[] = ['read_only', 'allowlist', 'full_access'];
  const effects: ApprovalEffect[] = ['read', 'write', 'execute', 'external', 'interactive'];
  const outcomes = Object.fromEntries(modes.map((mode) => [
    mode,
    Object.fromEntries(effects.map((effect) => [effect, authorizeApproval(subject(effect), mode).outcome])),
  ]));
  assert.deepEqual(outcomes, {
    read_only: { read: 'allow', write: 'ask', execute: 'ask', external: 'ask', interactive: 'allow' },
    allowlist: { read: 'allow', write: 'allow', execute: 'ask', external: 'ask', interactive: 'allow' },
    full_access: { read: 'allow', write: 'allow', execute: 'allow', external: 'allow', interactive: 'allow' },
  });
});

test('hard guards and user UI origin take precedence over ordinary mode rules', () => {
  for (const mode of ['read_only', 'allowlist', 'full_access'] as const) {
    assert.deepEqual(authorizeApproval(subject('write', { hardDeniedReason: 'PATH_OUTSIDE_WORKSPACE' }), mode), {
      outcome: 'deny', reason: 'PATH_OUTSIDE_WORKSPACE',
    });
    assert.equal(authorizeApproval(subject('write', { origin: 'user_ui' }), mode).outcome, 'allow');
  }
});

test('workspace command whitelist bypasses approval without widening other effects', () => {
  assert.equal(authorizeApproval(subject('execute', { matchedRule: 'wl-1' }), 'read_only').outcome, 'allow');
  assert.equal(authorizeApproval(subject('write', { matchedRule: undefined }), 'read_only').outcome, 'ask');
});

test('approval fingerprint is stable across object key order and changes with input', () => {
  const left = createApprovalFingerprint({ toolName: 'write_file', effect: 'write', normalizedInput: { path: 'a.ts', content: 'x' } });
  const reordered = createApprovalFingerprint({ toolName: 'write_file', effect: 'write', normalizedInput: { content: 'x', path: 'a.ts' } });
  const changed = createApprovalFingerprint({ toolName: 'write_file', effect: 'write', normalizedInput: { path: 'a.ts', content: 'y' } });
  assert.equal(left, reordered);
  assert.notEqual(left, changed);
});
