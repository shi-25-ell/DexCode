import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandRunner } from './run-command.ts';
import { resolveShellCapabilities } from './shell/shell-resolver.ts';

test('shell resolution is explicit, immutable, and never selects Windows WSL bash', () => {
  const capabilities = resolveShellCapabilities();
  assert.equal(capabilities.selected.kind, process.platform === 'win32' ? 'powershell' : 'bash');
  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(Object.isFrozen(capabilities.available), true);
  assert.equal(Object.isFrozen(capabilities.selected), true);
  assert.equal(capabilities.available.some((shell) => /[\\/]windows[\\/]system32[\\/]bash\.exe$/i.test(shell.executable)), false);
});

test('optional Git Bash executes Bash syntax when it is explicitly selected', async (context) => {
  const capabilities = resolveShellCapabilities();
  const bash = capabilities.available.find((shell) => shell.kind === 'bash');
  if (!bash) {
    context.skip('Git Bash is not installed');
    return;
  }
  const runner = createCommandRunner({ shell: bash });
  const result = await runner.run('value=git-bash; printf "%s\\n" "$value"', process.cwd(), { foregroundTimeoutMs: 2_000 });
  assert.equal(result.status, 'success');
  assert.equal(result.stdout, 'git-bash');
  assert.equal(result.shell, 'bash');
});
