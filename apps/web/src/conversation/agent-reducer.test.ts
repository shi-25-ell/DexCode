import { describe, expect, it } from 'vitest';
import { agentActivityReducer, initialAgentActivityState } from './agent-reducer';

describe('agent activity reducer', () => {
  it('is deterministic for duplicates and requests resync on gaps', () => {
    const envelope = { version: 1 as const, sessionId: 'session-a', seq: 1, at: '', event: { type: 'agent_created', agent: { agentId: 'a', sessionId: 'session-a', rootAgentId: 'root', parentAgentId: 'root', createdByRunId: 'main', name: 'a', task: 't', contextMode: 'fresh' as const, isolation: 'shared' as const, definitionName: 'researcher', status: 'running' as const, createdAt: '', updatedAt: '' } } };
    const first = agentActivityReducer(initialAgentActivityState, { type: 'event', envelope });
    expect(agentActivityReducer(first, { type: 'event', envelope })).toEqual(first);
    const gap = agentActivityReducer(first, { type: 'event', envelope: { ...envelope, seq: 3, event: { type: 'agent_status_changed', agentId: 'a', status: 'idle' } } });
    expect(gap.needsResync).toBe(true);
  });
});
