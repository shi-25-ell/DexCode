import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandRunner } from './run-command.ts';

function nodeCommand(source: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

test('starts a command directly in the background and collects its output', async () => {
  const runner = createCommandRunner();
  const started = await runner.run(
    nodeCommand("setTimeout(()=>process.stdout.write('done'),80)"),
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
    nodeCommand("setTimeout(()=>process.stdout.write('later'),200)"),
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
    nodeCommand('setTimeout(()=>{},10000)'),
    process.cwd(),
    { foregroundTimeoutMs: 1_000, runInBackground: true },
  );
  assert.ok(started.taskId);
  const stopped = await runner.stop(started.taskId);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.running, false);
});
