import type { ChatMessage, FileDiff, ToolPresentation } from '../shared/types.ts';
import type { ToolPolicy } from '../agent-core/executor.ts';

export const AGENT_STATUSES = ['creating', 'running', 'stopping', 'idle'] as const;
export type AgentStatus = typeof AGENT_STATUSES[number];
export const AGENT_RUN_STATUSES = ['running', 'completed', 'failed', 'interrupted', 'limited'] as const;
export type AgentRunStatus = typeof AGENT_RUN_STATUSES[number];
export type AgentContextMode = 'fresh' | 'fork';
export type AgentIsolation = 'shared' | 'worktree';

export type AgentDefinition = {
  name: string;
  description: string;
  systemPrompt: string;
  toolPolicy: ToolPolicy;
  defaultContextMode: AgentContextMode;
  allowedContextModes: AgentContextMode[];
  budget: {
    maxModelTurns: number;
    maxModelAttempts?: number;
    maxRetriesPerTurn?: number;
    maxOutputTokens?: number;
    maxResultBytes?: number;
  };
  model?: string;
  memoryPolicy: { read: boolean; write: boolean; automaticExtraction: false };
  isolationPolicy: { default: AgentIsolation; allowed: AgentIsolation[] };
};

export type AgentRecord = {
  agentId: string;
  sessionId: string;
  rootAgentId: string;
  parentAgentId: string | null;
  createdByRunId: string;
  name: string;
  task: string;
  contextMode: AgentContextMode;
  isolation: AgentIsolation;
  definitionName: string;
  definitionDigest: string;
  definitionSnapshot: AgentDefinition;
  contextSeed: ChatMessage[];
  delegationGroupId?: string;
  status: AgentStatus;
  currentRunId?: string;
  lastRunId?: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredAgentRunResult = {
  status: Exclude<AgentRunStatus, 'running'>;
  terminationReason: string;
  finalContent: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; unknown?: number };
  toolsUsed: string[];
  filesModified: string[];
  fileChanges?: FileDiff[];
  error?: { code: string; message: string };
};

export type AgentRunRecord = {
  agentRunId: string;
  agentId: string;
  invokedByRunId: string;
  trigger: 'spawn' | 'followup';
  status: AgentRunStatus;
  input: string;
  startedAt: string;
  completedAt?: string;
  result?: StoredAgentRunResult;
};

export type AgentToolRecord = {
  callId: string;
  name: string;
  input?: Record<string, unknown>;
  status: 'running' | 'finished';
  presentation?: ToolPresentation;
};

export type AgentConversation = {
  agentId: string;
  messages: ChatMessage[];
  tools: AgentToolRecord[];
};

export type AgentContextRecord = {
  owner: { kind: 'agent'; sessionId: string; agentId: string };
  agentRunId: string;
  mode: AgentContextMode;
  seedMessageCount: number;
  seedDigest: string;
  committedAt: string;
};

export type AgentTreeSnapshot = {
  version: 1;
  sessionId: string;
  rootAgentId: string;
  revision: number;
  agents: AgentRecord[];
  runs: AgentRunRecord[];
  conversations: AgentConversation[];
  contexts: AgentContextRecord[];
  operations: Record<string, { agentId: string; agentRunId: string }>;
};

export type AgentStoreEvent =
  | { type: 'agent_created'; agent: AgentRecord; operationId: string }
  | { type: 'agent_run_started'; run: AgentRunRecord; operationId: string }
  | { type: 'agent_message_committed'; agentId: string; agentRunId: string; message: ChatMessage }
  | { type: 'agent_context_committed'; context: AgentContextRecord }
  | { type: 'agent_tool_started'; agentId: string; agentRunId: string; tool: AgentToolRecord }
  | { type: 'agent_tool_finished'; agentId: string; agentRunId: string; callId: string; presentation: ToolPresentation }
  | { type: 'agent_stop_requested'; agentId: string; agentRunId: string; reason?: string }
  | { type: 'agent_run_terminal'; agentId: string; agentRunId: string; status: Exclude<AgentRunStatus, 'running'>; result: StoredAgentRunResult; completedAt: string }
  | { type: 'agent_recovered'; agentId: string; agentRunId: string; completedAt: string };

export type AgentActivityEvent =
  | { type: 'agent_created'; agent: AgentRecord }
  | { type: 'agent_run_started'; agentId: string; run: AgentRunRecord }
  | { type: 'agent_status_changed'; agentId: string; status: AgentStatus; runId?: string }
  | { type: 'agent_run_finished'; agentId: string; run: AgentRunRecord }
  | { type: 'agent_recovered'; agentId: string; run: AgentRunRecord }
  | { type: 'agent_resync_required'; revision: number };

export type AgentActivityEnvelope = {
  version: 1;
  sessionId: string;
  seq: number;
  at: string;
  event: AgentActivityEvent;
};

export type AgentCallerContext = {
  sessionId: string;
  callerAgentId?: string;
  callerRunId: string;
  toolCallId: string;
  delegationGroupId: string;
  forkSnapshot: ChatMessage[];
};

export interface AgentOrchestrationPort {
  definitions?(): Array<{ name: string; description: string }>;
  spawn(input: { task: string; agent: string; contextMode?: AgentContextMode; name?: string; isolation?: AgentIsolation }, caller: AgentCallerContext): Promise<unknown>;
  wait(input: { agentIds: string[]; mode?: 'any' | 'all'; timeoutMs?: number }, caller: AgentCallerContext): Promise<unknown>;
  followup(input: { agentId: string; task: string }, caller: AgentCallerContext): Promise<unknown>;
  stop(input: { agentId: string; reason?: string }, caller: AgentCallerContext): Promise<unknown>;
}

export const AGENT_ORCHESTRATION_TOOL_NAMES = ['spawn_agent', 'wait_agent', 'followup_agent', 'stop_agent'] as const;
export type AgentOrchestrationToolName = typeof AGENT_ORCHESTRATION_TOOL_NAMES[number];

export function isAgentOrchestrationTool(name: string): name is AgentOrchestrationToolName {
  return (AGENT_ORCHESTRATION_TOOL_NAMES as readonly string[]).includes(name);
}

export function assertValidAgentDefinition(definition: AgentDefinition): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(definition.name)) throw new Error('Agent definition name is invalid');
  if (!definition.description.trim() || !definition.systemPrompt.trim()) throw new Error('Agent definition requires description and systemPrompt');
  if (!definition.allowedContextModes.includes(definition.defaultContextMode)) throw new Error('Default context mode must be allowed');
  if (!definition.isolationPolicy.allowed.includes(definition.isolationPolicy.default)) throw new Error('Default isolation must be allowed');
  if (!Number.isInteger(definition.budget.maxModelTurns) || definition.budget.maxModelTurns < 1) throw new Error('maxModelTurns must be a positive integer');
  for (const [key, value] of Object.entries(definition.budget)) {
    if (key === 'maxRetriesPerTurn') {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new Error(`${key} must be a non-negative integer`);
    } else if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`${key} must be a positive integer`);
  }
  if (definition.memoryPolicy.automaticExtraction !== false) throw new Error('Child automatic memory extraction must be false');
}

export function validateOrchestrationToolInput(name: AgentOrchestrationToolName, args: Record<string, unknown>): string | undefined {
  if (name === 'spawn_agent') {
    if (typeof args.task !== 'string' || !args.task.trim()) return 'task is required';
    if (typeof args.agent !== 'string' || !args.agent.trim()) return 'agent is required';
    if (args.context_mode !== undefined && args.context_mode !== 'fresh' && args.context_mode !== 'fork') return 'context_mode must be fresh or fork';
    if (args.isolation !== undefined && args.isolation !== 'shared' && args.isolation !== 'worktree') return 'isolation must be shared or worktree';
  } else if (name === 'wait_agent') {
    if (!Array.isArray(args.agent_ids) || args.agent_ids.length < 1 || args.agent_ids.some((id) => typeof id !== 'string' || !id)) return 'agent_ids must be a non-empty string array';
    if (args.mode !== undefined && args.mode !== 'any' && args.mode !== 'all') return 'mode must be any or all';
    if (args.timeout_ms !== undefined && (!Number.isInteger(args.timeout_ms) || Number(args.timeout_ms) < 0 || Number(args.timeout_ms) > 60_000)) return 'timeout_ms must be an integer from 0 to 60000';
  } else if (name === 'followup_agent') {
    if (typeof args.agent_id !== 'string' || !args.agent_id) return 'agent_id is required';
    if (typeof args.task !== 'string' || !args.task.trim()) return 'task is required';
  } else if (typeof args.agent_id !== 'string' || !args.agent_id) return 'agent_id is required';
  return undefined;
}
