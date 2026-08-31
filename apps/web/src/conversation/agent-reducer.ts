import type { AgentActivityEnvelope, AgentRecordView, AgentRunView, AgentTreeSnapshot } from '../types';

export type AgentActivityState = { tree: AgentTreeSnapshot | null; lastSeq: number; needsResync: boolean };
export const initialAgentActivityState: AgentActivityState = { tree: null, lastSeq: 0, needsResync: false };

export type AgentActivityAction =
  | { type: 'hydrate'; tree: AgentTreeSnapshot | null }
  | { type: 'event'; envelope: AgentActivityEnvelope }
  | { type: 'reset' };

function upsert<T extends { [key: string]: unknown }>(items: T[], key: keyof T, value: T): T[] {
  const index = items.findIndex((item) => item[key] === value[key]);
  if (index < 0) return [...items, value];
  const next = [...items]; next[index] = { ...items[index], ...value };
  return next;
}

export function agentActivityReducer(state: AgentActivityState, action: AgentActivityAction): AgentActivityState {
  if (action.type === 'reset') return initialAgentActivityState;
  if (action.type === 'hydrate') return { ...state, tree: action.tree, needsResync: false };
  const { envelope } = action;
  if (envelope.seq <= state.lastSeq) return state;
  if (state.lastSeq > 0 && envelope.seq !== state.lastSeq + 1) return { ...state, lastSeq: envelope.seq, needsResync: true };
  if (envelope.event.type === 'agent_resync_required') return { ...state, lastSeq: envelope.seq, needsResync: true };
  const tree = state.tree ? structuredClone(state.tree) : { version: 1 as const, sessionId: envelope.sessionId, rootAgentId: '', revision: 0, agents: [], runs: [] };
  const event = envelope.event;
  if (event.type === 'agent_created' && event.agent) {
    tree.agents = upsert(tree.agents as Array<AgentRecordView & Record<string, unknown>>, 'agentId', event.agent as AgentRecordView & Record<string, unknown>) as AgentRecordView[];
  } else if (event.type === 'agent_run_started' && event.run && event.agentId) {
    tree.runs = upsert(tree.runs as Array<AgentRunView & Record<string, unknown>>, 'agentRunId', event.run as AgentRunView & Record<string, unknown>) as AgentRunView[];
    tree.agents = tree.agents.map((agent) => agent.agentId === event.agentId ? { ...agent, status: 'running', currentRunId: event.run!.agentRunId, lastRunId: event.run!.agentRunId } : agent);
  } else if (event.type === 'agent_status_changed' && event.agentId && event.status) {
    const status = event.status;
    tree.agents = tree.agents.map((agent) => agent.agentId === event.agentId ? { ...agent, status } : agent);
  } else if ((event.type === 'agent_run_finished' || event.type === 'agent_recovered') && event.run && event.agentId) {
    tree.runs = upsert(tree.runs as Array<AgentRunView & Record<string, unknown>>, 'agentRunId', event.run as AgentRunView & Record<string, unknown>) as AgentRunView[];
    tree.agents = tree.agents.map((agent) => agent.agentId === event.agentId ? { ...agent, status: 'idle', currentRunId: undefined, lastRunId: event.run!.agentRunId } : agent);
  }
  tree.revision += 1;
  return { tree, lastSeq: envelope.seq, needsResync: false };
}
