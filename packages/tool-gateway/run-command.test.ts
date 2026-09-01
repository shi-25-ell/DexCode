import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandRunner } from './run-command.ts';

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteBash(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function nodeCommand(shell: 'powershell' | 'bash', source: string): string {
  return shell === 'powershell'
    ? `& ${quotePowerShell(process.execPath)} -e ${quotePowerShell(source)}`
    : `${quoteBash(process.execPath)} -e ${quoteBash(source)}`;
}

test('starts a command directly in the background and collects its output', async () => {
  const runner = createCommandRunner();
  const started = await runner.run(
    nodeCommand(runner.shell.kind, "setTimeout(()=>process.stdout.write('done'),80)"),
    process.cwd(),
    { foregroundTimeoutMs: 1_000, runInBackground: true },
  );
  assert.equal(started.status, 'background');
  assert.ok(started.taskId);

  const completed = await runner.read(started.taskId, 2_000);
  assert.equal(completed.status, 'success');
  assert.equal(completed.stdout, 'done');
});

test('moves a slow foreground command to the background after its tool timeout', async () => {
  const runner = createCommandRunner();
  const started = await runner.run(
    nodeCommand(runner.shell.kind, "setTimeout(()=>process.stdout.write('later'),200)"),
    process.cwd(),
    { foregroundTimeoutMs: 20 },
  );
  assert.equal(started.status, 'background');
  assert.ok(started.taskId);

  const completed = await runner.read(started.taskId, 2_000);
  assert.equal(completed.status, 'success');
  assert.equal(completed.stdout, 'later');
});

test('stops a running background command by task id', async () => {
  const runner = createCommandRunner();
  const started = await runner.run(
    nodeCommand(runner.shell.kind, 'setTimeout(()=>{},10000)'),
    process.cwd(),
    { foregroundTimeoutMs: 1_000, runInBackground: true },
  );
  assert.ok(started.taskId);
  const stopped = await runner.stop(started.taskId);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.running, false);
});

test('selected shell executes native compound syntax without wrapper guessing', async () => {
  const runner = createCommandRunner();
  const command = runner.shell.kind === 'powershell'
    ? '$value = "left"; Write-Output "$value-right"'
    : 'value=left; printf "%s\\n" "$value-right"';
  const result = await runner.run(command, process.cwd(), { foregroundTimeoutMs: 2_000 });
  assert.equal(result.status, 'success');
  assert.equal(result.stdout, 'left-right');
  assert.equal(result.shell, runner.shell.kind);
});
