import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedReadonlyCommand, isWhitelisted, suggestWhitelistPattern, validateCommand, type WhitelistEntry } from './command-safety.ts';

function entry(pattern: string, matchType: WhitelistEntry['matchType']): WhitelistEntry {
  return { id: 'test', pattern, matchType, addedAt: '2026-08-31T00:00:00.000Z', source: 'user' };
}

test('prefix whitelist matching requires a complete token boundary', () => {
  assert.equal(isWhitelisted('npm test', [entry('npm test', 'prefix')]), true);
  assert.equal(isWhitelisted('npm test -- --watch', [entry('npm test', 'prefix')]), true);
  assert.equal(isWhitelisted('npm testing', [entry('npm test', 'prefix')]), false);
});

test('automatic whitelist suggestions stay exact', () => {
  assert.deepEqual(suggestWhitelistPattern('git reset --hard HEAD'), {
    pattern: 'git reset --hard HEAD',
    matchType: 'exact',
    label: 'git reset --hard HEAD',
  });
});

test('readonly command recognition is conservative about project code and preprocessors', () => {
  assert.equal(isTrustedReadonlyCommand('git status --short --branch'), true);
  assert.equal(isTrustedReadonlyCommand('rg -n approval packages'), true);
  assert.equal(isTrustedReadonlyCommand('rg --pre node pattern'), false);
  assert.equal(isTrustedReadonlyCommand('npm run lint'), false);
  assert.equal(isTrustedReadonlyCommand('npx tsc --noEmit'), false);
});

test('compound scripts and explicit shell wrappers enter approval while hard guards remain non-approvable', () => {
  const compound = validateCommand('$files = Get-ChildItem; $files.Count', []);
  assert.equal(compound.allowed, true);
  assert.equal(compound.needsConfirmation, true);
  const wrapper = validateCommand('pwsh -Command Get-ChildItem', []);
  assert.equal(wrapper.allowed, true);
  assert.equal(wrapper.needsConfirmation, true);
  const destructive = validateCommand('Remove-Item -Recurse C:\\', []);
  assert.equal(destructive.allowed, false);
  assert.equal(destructive.needsConfirmation, false);
});
