import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentActivityStream, parseAgentActivityEnvelope } from './agent-activity.ts';

test('Agent activity stream validates, replays terminals and requires resync outside the window', () => {
  const stream = createAgentActivityStream(2);
  stream.publish('session-a', { type: 'agent_status_changed', agentId: 'a', status: 'running', runId: 'r1' });
  stream.publish('session-a', { type: 'agent_status_changed', agentId: 'a', status: 'stopping', runId: 'r1' });
  const terminal = stream.publish('session-a', { type: 'agent_run_finished', agentId: 'a', run: { agentRunId: 'r1', agentId: 'a', invokedByRunId: 'main', trigger: 'spawn', status: 'completed', input: 'x', startedAt: '', completedAt: '', result: { status: 'completed', terminationReason: 'natural_completion', finalContent: 'done', toolsUsed: [], filesModified: [] } } });
  assert.equal(parseAgentActivityEnvelope(terminal).event.type, 'agent_run_finished');
  assert.equal(stream.replay('session-a', 1).events.at(-1)?.event.type, 'agent_run_finished');
  assert.equal(stream.replay('session-a', 0).resyncRequired, false);
  assert.equal(stream.replay('session-a', 99).resyncRequired, true);
});
