import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { RunEventEnvelope } from './contracts.ts';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to reserve a local port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function parseEvents(text: string): RunEventEnvelope[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as RunEventEnvelope);
}

test('runtime V2 streams a terminal snapshot and replays it idempotently after seq', { timeout: 15_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-runtime-v2-'));
  const port = await freePort();
  const runtime = spawn(process.execPath, ['--experimental-strip-types', resolve('server.ts')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      WORKSPACE_DIR: root,
      LLM_API_KEY: '',
      LLM_MODEL: '',
      DOUBAO_API_KEY: '',
      DOUBAO_MODEL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  runtime.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  runtime.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  context.after(async () => {
    if (runtime.exitCode === null) {
      runtime.kill();
      await Promise.race([
        once(runtime, 'exit'),
        new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
      ]);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/meta`)).ok) break;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  if (runtime.exitCode !== null) assert.fail(`runtime exited early (${runtime.exitCode})\n${output}`);

  const request = {
    prompt: 'stream contract smoke',
    clientRequestId: 'request-v2-smoke',
    scope: { kind: 'general' },
  };
  const firstResponse = await fetch(`${baseUrl}/api/conversation-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DexCode-Stream-Version': '2' },
    body: JSON.stringify(request),
  });
  assert.equal(firstResponse.status, 200);
  const first = parseEvents(await firstResponse.text());
  assert.equal(first[0]?.event.type, 'run_started');
  assert.deepEqual(first.map((event) => event.seq), first.map((_, index) => index + 1));
  assert.equal(first.some((event) => event.event.type === 'assistant_message_committed'), true);
  const terminal = first.at(-1);
  assert.equal(terminal?.event.type, 'run_finished');
  if (terminal?.event.type !== 'run_finished') return;
  assert.equal(terminal.event.conversationRevision, terminal.event.conversation.revision);
  assert.equal(terminal.event.conversation.items.some((item) => item.kind === 'assistant' && item.final), true);

  const started = first[0]?.event;
  if (started?.type !== 'run_started') return;
  const replayResponse = await fetch(`${baseUrl}/api/conversation-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DexCode-Stream-Version': '2' },
    body: JSON.stringify({ ...request, conversationRef: started.sessionId, afterSeq: terminal.seq - 1 }),
  });
  const replay = parseEvents(await replayResponse.text());
  assert.deepEqual(replay.map((event) => event.seq), [terminal.seq]);
  assert.equal(replay[0]?.event.type, 'run_finished');
  if (replay[0]?.event.type === 'run_finished') {
    assert.deepEqual(replay[0].event.conversation, terminal.event.conversation);
  }

  const enqueueResponse = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(started.sessionId)}/queued-messages?scope=general`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'queued follow-up', delivery: 'next_run', operationId: 'queue-v2-chain' }),
  });
  assert.equal(enqueueResponse.status, 200);
  const chainResponse = await fetch(`${baseUrl}/api/conversation-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DexCode-Stream-Version': '2' },
    body: JSON.stringify({
      prompt: 'start a run chain',
      clientRequestId: 'request-v2-chain',
      conversationRef: started.sessionId,
      scope: { kind: 'general' },
    }),
  });
  const chainEvents = parseEvents(await chainResponse.text());
  const chainRunIds = chainEvents
    .filter((event) => event.event.type === 'run_started')
    .map((event) => event.runId);
  assert.equal(chainRunIds.length, 2);
  assert.notEqual(chainRunIds[0], chainRunIds[1]);
  for (const chainRunId of chainRunIds) {
    const events = chainEvents.filter((event) => event.runId === chainRunId);
    assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
    assert.equal(events.at(-1)?.event.type, 'run_finished');
  }
  assert.equal(chainEvents.some((event) => event.event.type === 'queue_item_updated'), true);
  assert.equal(chainEvents.some((event) => event.event.type === 'user_message_committed'), true);
  const chainTerminal = chainEvents.at(-1);
  assert.equal(chainTerminal?.event.type, 'run_finished');
  if (chainTerminal?.event.type === 'run_finished') {
    assert.equal(chainTerminal.event.conversation.items.some((item) => item.kind === 'user' && item.content === 'queued follow-up'), true);
  }

  const legacyResponse = await fetch(`${baseUrl}/api/conversation-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'legacy contract smoke',
      clientRequestId: 'request-legacy-smoke',
      conversationRef: started.sessionId,
      scope: { kind: 'general' },
    }),
  });
  assert.equal(legacyResponse.status, 200);
  const legacyEvents = (await legacyResponse.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as { type?: string });
  assert.equal(legacyEvents.some((item) => item.type === 'session'), true);
  assert.equal(legacyEvents.some((item) => item.type === 'chunk'), true);
  assert.equal(legacyEvents.at(-1)?.type, 'result');
});
