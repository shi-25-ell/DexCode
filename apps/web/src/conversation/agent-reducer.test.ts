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

  it('does not let a late snapshot overwrite newer streamed activity', () => {
    const agent = { agentId: 'a', sessionId: 'session-a', rootAgentId: 'root', parentAgentId: 'root', createdByRunId: 'main', name: 'a', task: 't', contextMode: 'fresh' as const, isolation: 'shared' as const, definitionName: 'general', status: 'running' as const, createdAt: '', updatedAt: '' };
    const streamed = agentActivityReducer(initialAgentActivityState, {
      type: 'event',
      envelope: { version: 1, sessionId: 'session-a', seq: 1, at: '', event: { type: 'agent_created', agent } },
    });

    const staleSnapshot = { version: 1 as const, sessionId: 'session-a', rootAgentId: 'root', revision: 0, agents: [], runs: [] };
    expect(agentActivityReducer(streamed, { type: 'hydrate', tree: staleSnapshot })).toEqual(streamed);
  });

  it('accepts a replacement snapshot when a stream gap requires resync', () => {
    const gapped = { ...initialAgentActivityState, lastSeq: 3, needsResync: true };
    const snapshot = { version: 1 as const, sessionId: 'session-a', rootAgentId: 'root', revision: 2, agents: [], runs: [] };
    expect(agentActivityReducer(gapped, { type: 'hydrate', tree: snapshot })).toEqual({
      tree: snapshot,
      lastSeq: 3,
      needsResync: false,
    });
  });
});
