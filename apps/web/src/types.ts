export type ConversationScope = { kind: 'general' } | { kind: 'workspace'; workspaceRef: string };

export type Capability = {
  id: string;
  label: string;
  route: string;
  icon: 'network' | 'wrench' | 'sparkles' | 'shield' | 'camera' | 'book';
  workspaceRequired: boolean;
};

export type ConversationListItem = {
  ref: string;
  title: string;
  preview?: string;
  updatedAt: string;
  state: 'idle' | 'running' | 'waiting' | 'failed';
  archived: boolean;
};

export type ToolPresentation = {
  callRef: string;
  category: 'read' | 'file' | 'command' | 'search' | 'skill' | 'mcp' | 'snapshot' | 'other';
  name: string;
  target?: string;
  status: 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled';
  summary: string;
  rawOutput?: string;
  truncated?: boolean;
  fileChange?: { path: string; additions?: number; deletions?: number; binary?: boolean };
};

export type ConversationItem =
  | { id: string; kind: 'user'; content: string }
  | { id: string; kind: 'assistant'; content: string }
  | { id: string; kind: 'tool'; tool: ToolPresentation }
  | { id: string; kind: 'approval'; approvalRef: string; approvalKind: 'question' | 'command'; title: string; target?: string; options: string[]; resolved?: string }
  | { id: string; kind: 'error'; title: string; message: string };

export type ContextUsage = {
  usedTokens?: number;
  limitTokens?: number;
  percentage?: number;
  source: 'provider' | 'estimated' | 'unknown';
  asOfTurn?: number;
};

export type ConversationSnapshot = {
  ref: string;
  title: string;
  state: 'idle' | 'running' | 'waiting' | 'failed';
  updatedAt: string;
  items: ConversationItem[];
  contextUsage: ContextUsage;
};

export type ModelDescriptor = {
  displayName: string;
  contextWindow?: number;
  providerDisplayName?: string;
};

export type StreamEvent =
  | { type: 'session'; sessionId: string; isNew: boolean }
  | { type: 'chunk'; chunk: string }
  | { type: 'tool_view'; presentation: ToolPresentation }
  | { type: 'context_usage'; usedTokens?: number; limitTokens?: number; source: ContextUsage['source']; asOfTurn?: number }
  | { type: 'task_status'; status: string; taskId: string; note?: string }
  | { type: 'confirm_request'; confirmId: string; question: string; options?: string[] }
  | { type: 'command_confirm_request'; confirmId: string; command: string; cwd: string; risk: string; reason: string }
  | { type: 'error'; message: string }
  | { type: 'result'; result: unknown }
  | { type: 'reasoning_chunk'; chunk: string }
  | { type: 'skill'; skill: string; action: string }
  | { type: 'tool_status'; callId: string; tool: string; status: string };
