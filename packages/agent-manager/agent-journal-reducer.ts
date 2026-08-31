import type { AgentStoreEvent, AgentTreeSnapshot } from './contracts.ts';

function conversation(snapshot: AgentTreeSnapshot, agentId: string) {
  let found = snapshot.conversations.find((item) => item.agentId === agentId);
  if (!found) {
    found = { agentId, messages: [], tools: [] };
    snapshot.conversations.push(found);
  }
  return found;
}

export function createAgentTreeSnapshot(sessionId: string, rootAgentId: string): AgentTreeSnapshot {
  return { version: 1, sessionId, rootAgentId, revision: 0, agents: [], runs: [], conversations: [], contexts: [], operations: {} };
}

export function applyAgentStoreEvent(snapshot: AgentTreeSnapshot, event: AgentStoreEvent): void {
  if (event.type === 'agent_created') {
    if (!snapshot.agents.some((agent) => agent.agentId === event.agent.agentId)) snapshot.agents.push(structuredClone(event.agent));
    snapshot.operations[event.operationId] = { agentId: event.agent.agentId, agentRunId: '' };
    conversation(snapshot, event.agent.agentId);
    return;
  }
  if (event.type === 'agent_run_started') {
    if (!snapshot.runs.some((run) => run.agentRunId === event.run.agentRunId)) snapshot.runs.push(structuredClone(event.run));
    const agent = snapshot.agents.find((item) => item.agentId === event.run.agentId);
    if (!agent) throw new Error(`Agent not found for run: ${event.run.agentId}`);
    agent.status = 'running';
    agent.currentRunId = event.run.agentRunId;
    agent.lastRunId = event.run.agentRunId;
    agent.updatedAt = event.run.startedAt;
    snapshot.operations[event.operationId] = { agentId: event.run.agentId, agentRunId: event.run.agentRunId };
    return;
  }
  if (event.type === 'agent_context_committed') {
    if (!snapshot.contexts.some((item) => item.agentRunId === event.context.agentRunId)) snapshot.contexts.push(structuredClone(event.context));
    return;
  }
  const agent = snapshot.agents.find((item) => item.agentId === event.agentId);
  const run = snapshot.runs.find((item) => item.agentRunId === event.agentRunId && item.agentId === event.agentId);
  if (!agent || !run) throw new Error(`Agent run not found: ${event.agentId}/${event.agentRunId}`);
  if (event.type === 'agent_message_committed') {
    conversation(snapshot, event.agentId).messages.push(structuredClone(event.message));
  } else if (event.type === 'agent_tool_started') {
    conversation(snapshot, event.agentId).tools.push(structuredClone(event.tool));
  } else if (event.type === 'agent_tool_finished') {
    const tool = conversation(snapshot, event.agentId).tools.find((item) => item.callId === event.callId);
    if (tool) {
      tool.status = 'finished';
      tool.presentation = structuredClone(event.presentation);
    }
  } else if (event.type === 'agent_stop_requested') {
    agent.status = 'stopping';
  } else {
    const status = event.type === 'agent_recovered' ? 'interrupted' : event.status;
    const result = event.type === 'agent_recovered'
      ? { status: 'interrupted' as const, terminationReason: 'recovered_interruption', finalContent: '', toolsUsed: [], filesModified: [], error: { code: 'RUN_INTERRUPTED', message: 'Agent Run was interrupted by process restart' } }
      : event.result;
    run.status = status;
    run.completedAt = event.completedAt;
    run.result = result;
    agent.status = 'idle';
    delete agent.currentRunId;
    agent.lastRunId = run.agentRunId;
    agent.updatedAt = event.completedAt;
  }
}
