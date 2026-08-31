import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { BUILTIN_AGENT_DEFINITIONS, createAgentDefinitionRegistry, parseAgentDefinitionMarkdown } from './agent-definitions.ts';
import { createAgentStore } from './agent-store.ts';
import type { AgentRecord, AgentRunRecord } from './contracts.ts';

function records(sessionId: string) {
  const now = new Date().toISOString();
  const definition = structuredClone(BUILTIN_AGENT_DEFINITIONS[0]!);
  const agent: AgentRecord = {
    agentId: 'agent-a', sessionId, rootAgentId: 'agent-root', parentAgentId: null, createdByRunId: 'main-1',
    name: 'researcher', task: 'inspect', contextMode: 'fresh', isolation: 'shared', definitionName: definition.name,
    definitionDigest: 'sha256-test', definitionSnapshot: definition, contextSeed: [], status: 'running', currentRunId: 'agent-run-a',
    lastRunId: 'agent-run-a', createdAt: now, updatedAt: now,
  };
  const run: AgentRunRecord = { agentRunId: 'agent-run-a', agentId: agent.agentId, invokedByRunId: 'main-1', trigger: 'spawn', status: 'running', input: 'inspect', startedAt: now };
  return { agent, run };
}

test('Agent Store is lazy, repairs a torn tail and recovers once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-agent-store-'));
  const sessionId = 'session-abcd';
  try {
    const store = createAgentStore({ sessionsDir: root });
    assert.equal(await store.load(sessionId), null);
    const { agent, run } = records(sessionId);
    await store.createAgentRun(sessionId, agent, run, 'main-1:tool-1');
    const path = store.pathFor(sessionId);
    await writeFile(path, `${await readFile(path, 'utf8')}{"torn":`, 'utf8');
    const reopened = createAgentStore({ sessionsDir: root });
    const recovered = await reopened.load(sessionId);
    assert.equal(recovered?.revision, 2);
    assert.equal(recovered?.runs[0]?.status, 'interrupted');
    assert.equal((await reopened.load(sessionId))?.revision, 2);
    assert.equal((await readFile(path, 'utf8')).endsWith('\n'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Agent Store serializes concurrent appends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dexcode-agent-store-order-'));
  const sessionId = 'session-efgh';
  try {
    const store = createAgentStore({ sessionsDir: root });
    const { agent, run } = records(sessionId);
    await store.createAgentRun(sessionId, agent, run, 'main-1:tool-1');
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.append(sessionId, [{ type: 'agent_message_committed', agentId: agent.agentId, agentRunId: run.agentRunId, message: { role: 'user', content: String(index) } }])));
    const snapshot = await store.load(sessionId, false);
    assert.equal(snapshot?.revision, 13);
    assert.equal(snapshot?.conversations[0]?.messages.length, 13);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Definition parser rejects unknown fields and workspace definitions override user definitions', async () => {
  assert.throws(() => parseAgentDefinitionMarkdown('---\nname: scout\ndescription: test\nunknown: true\n---\nPrompt'), /Unknown/);
  const root = await mkdtemp(join(tmpdir(), 'dexcode-agent-def-'));
  const user = join(root, 'user');
  const workspace = join(root, 'workspace');
  await mkdir(user); await mkdir(workspace);
  const file = (description: string) => `---\nname: scout\ndescription: ${description}\nallowed-tools: [read_file]\n---\nInspect source.`;
  try {
    await writeFile(join(user, 'scout.md'), file('user'), 'utf8');
    await writeFile(join(workspace, 'scout.md'), file('workspace'), 'utf8');
    const registry = createAgentDefinitionRegistry({ userRoot: user, workspaceRoot: workspace });
    await registry.reload();
    assert.equal(registry.resolve('scout')?.definition.description, 'workspace');
    assert.deepEqual(registry.diagnostics(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
