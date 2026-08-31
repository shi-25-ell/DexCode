import type { AgentActivityEnvelope, AgentActivityEvent, AgentStoreEvent, AgentTreeSnapshot } from '../agent-manager/contracts.ts';

export class AgentActivityProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentActivityProtocolError'; }
}

export function parseAgentActivityEnvelope(value: unknown): AgentActivityEnvelope {
  if (!value || typeof value !== 'object') throw new AgentActivityProtocolError('Agent activity envelope must be an object');
  const envelope = value as Partial<AgentActivityEnvelope>;
  if (envelope.version !== 1 || typeof envelope.sessionId !== 'string' || !Number.isSafeInteger(envelope.seq) || Number(envelope.seq) < 1 || typeof envelope.at !== 'string') {
    throw new AgentActivityProtocolError('Invalid Agent activity envelope');
  }
  if (!envelope.event || typeof envelope.event !== 'object' || typeof (envelope.event as { type?: unknown }).type !== 'string') throw new AgentActivityProtocolError('Agent activity event is missing');
  const allowed = new Set(['agent_created', 'agent_run_started', 'agent_status_changed', 'agent_run_finished', 'agent_recovered', 'agent_resync_required']);
  if (!allowed.has(envelope.event.type)) throw new AgentActivityProtocolError(`Unknown Agent activity event: ${envelope.event.type}`);
  return envelope as AgentActivityEnvelope;
}

export function createAgentActivityStream(limit = 512) {
  const histories = new Map<string, AgentActivityEnvelope[]>();
  const subscribers = new Map<string, Set<(envelope: AgentActivityEnvelope) => void>>();
  function publish(sessionId: string, event: AgentActivityEvent): AgentActivityEnvelope {
    const history = histories.get(sessionId) ?? [];
    const envelope: AgentActivityEnvelope = { version: 1, sessionId, seq: (history.at(-1)?.seq ?? 0) + 1, at: new Date().toISOString(), event };
    parseAgentActivityEnvelope(envelope);
    history.push(envelope);
    if (history.length > limit) history.splice(0, history.length - limit);
    histories.set(sessionId, history);
    for (const listener of subscribers.get(sessionId) ?? []) listener(structuredClone(envelope));
    return envelope;
  }
  function replay(sessionId: string, afterSeq = 0): { events: AgentActivityEnvelope[]; resyncRequired: boolean; latestSeq: number } {
    const history = histories.get(sessionId) ?? [];
    const latestSeq = history.at(-1)?.seq ?? 0;
    const earliest = history[0]?.seq ?? latestSeq + 1;
    return { events: history.filter((item) => item.seq > afterSeq).map((item) => structuredClone(item)), resyncRequired: afterSeq > 0 && (afterSeq < earliest - 1 || afterSeq > latestSeq), latestSeq };
  }
  function subscribe(sessionId: string, listener: (envelope: AgentActivityEnvelope) => void): () => void {
    const set = subscribers.get(sessionId) ?? new Set();
    set.add(listener); subscribers.set(sessionId, set);
    return () => { set.delete(listener); if (set.size === 0) subscribers.delete(sessionId); };
  }
  return { publish, replay, subscribe };
}

export function activityEventsFromStore(events: AgentStoreEvent[], snapshot: AgentTreeSnapshot): AgentActivityEvent[] {
  const result: AgentActivityEvent[] = [];
  for (const event of events) {
    if (event.type === 'agent_created') result.push({ type: 'agent_created', agent: structuredClone(event.agent) });
    else if (event.type === 'agent_run_started') result.push({ type: 'agent_run_started', agentId: event.run.agentId, run: structuredClone(event.run) });
    else if (event.type === 'agent_stop_requested') result.push({ type: 'agent_status_changed', agentId: event.agentId, status: 'stopping', runId: event.agentRunId });
    else if (event.type === 'agent_run_terminal' || event.type === 'agent_recovered') {
      const run = snapshot.runs.find((item) => item.agentRunId === event.agentRunId);
      if (run) result.push(event.type === 'agent_recovered' ? { type: 'agent_recovered', agentId: event.agentId, run: structuredClone(run) } : { type: 'agent_run_finished', agentId: event.agentId, run: structuredClone(run) });
    }
  }
  return result;
}

export type AgentActivityStream = ReturnType<typeof createAgentActivityStream>;
