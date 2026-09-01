import { describe, expect, it } from 'vitest';
import type { AgentRecordView, AgentRunView, AgentTreeSnapshot } from '../types';
import { groupAgentTimeline } from './agent-timeline';

function agent(overrides: Partial<AgentRecordView>): AgentRecordView {
  return {
    agentId: 'agent-a', sessionId: 'session-a', rootAgentId: 'root', parentAgentId: 'root', createdByRunId: 'run-1',
    name: 'worker', task: 'work', contextMode: 'fork', isolation: 'shared', definitionName: 'general-purpose',
    status: 'running', createdAt: '', updatedAt: '',
    ...overrides,
  };
}

function run(overrides: Partial<AgentRunView>): AgentRunView {
  return {
    agentRunId: 'agent-run-a', agentId: 'agent-a', invokedByRunId: 'run-1', trigger: 'spawn',
    status: 'running', input: 'work', startedAt: '',
    ...overrides,
  };
}

describe('agent timeline grouping', () => {
  it('groups parallel children and preserves the invoking model turn', () => {
    const tree: AgentTreeSnapshot = {
      version: 1, sessionId: 'session-a', rootAgentId: 'root', revision: 1,
      agents: [agent({ agentId: 'agent-a' }), agent({ agentId: 'agent-b' })],
      runs: [
        run({ agentRunId: 'run-a', agentId: 'agent-a', delegationGroupId: 'batch-1', invokedByTurn: 2 }),
        run({ agentRunId: 'run-b', agentId: 'agent-b', delegationGroupId: 'batch-1', invokedByTurn: 2 }),
      ],
    };
    expect(groupAgentTimeline(tree)).toEqual([{
      key: 'batch-1', agentRunIds: ['run-a', 'run-b'], sourceRunId: 'run-1', sourceTurn: 2,
    }]);
  });

  it('derives the turn from legacy delegation ids', () => {
    const tree: AgentTreeSnapshot = {
      version: 1, sessionId: 'session-a', rootAgentId: 'root', revision: 1,
      agents: [agent({ delegationGroupId: 'delegation-run-1-3' } as Partial<AgentRecordView>)],
      runs: [run({})],
    };
    expect(groupAgentTimeline(tree)[0]?.sourceTurn).toBe(3);
  });
});
