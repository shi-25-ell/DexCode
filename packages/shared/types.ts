// ── LLM 标准消息类型（与 OpenAI tool use API 对齐）──

export type SystemMessage = {
  role: 'system';
  content: string;
};

export type UserMessage = {
  role: 'user';
  content: string;
};

export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type AssistantMessage = {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
};

export type ToolResultMessage = {
  role: 'tool';
  tool_call_id: string;
  name: string;
  content: string;
};

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

// ── 任务摘要（会话间记忆载体）──

export type TaskSummary = {
  taskId: string;
  prompt: string;
  startedAt: string;
  completedAt: string;
  status: 'completed' | 'aborted' | 'failed' | 'limited';
  summary: string;
  toolsUsed: string[];
  filesModified: string[];
  skillsUsed?: string[];
};

export type FileDiff = {
  path: string;
  before: string | null;
  after: string | null;
};


// ── 会话对象 ──

export type Session = {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  archived?: boolean;
  messages: ChatMessage[];
  taskSummaries: TaskSummary[];
  activeTaskId: string | null;
};

export type SessionMeta = {
  title?: string;
  archived?: boolean;
};

export type ToolInfo = {
  name: string;
  description: string;
  source: 'local' | 'external';
  enabled: boolean;
  callCount: number;
  successCount: number;
  avgDurationMs: number;
  lastCalledAt: string | null;
};

export type ToolCallLogEntry = {
  id: string;
  toolName: string;
  argsPreview: string;
  ok: boolean;
  durationMs: number;
  at: string;
  resultPreview: string;
  error?: string;
};

// ── SSE 事件类型（向后兼容原有 chunk/tool/result/error，新增以下类型）──

export type ChunkEvent = {
  type: 'chunk';
  chunk: string;
};

export type ReasoningChunkEvent = {
  type: 'reasoning_chunk';
  chunk: string;
};

export type ToolStatusEvent = {
  type: 'tool_status';
  callId: string;
  tool: string;
  status: 'running' | 'settled';
};

export type ToolEvent = {
  type: 'tool';
  tool: string;
  summary?: string;
  detail?: string;
};

export type ResultEvent = {
  type: 'result';
  result: unknown;
};

export type ErrorEvent = {
  type: 'error';
  message: string;
};

export type PlanEvent = {
  type: 'plan';
  taskId: string;
  steps: string[];
};

export type CommandRisk = 'low' | 'medium' | 'high';

export type ConfirmRequestEvent = {
  type: 'confirm_request';
  taskId: string;
  confirmId: string;
  question: string;
  options?: string[];
};

export type CommandConfirmRequestEvent = {
  type: 'command_confirm_request';
  taskId: string;
  confirmId: string;
  command: string;
  cwd: string;
  risk: CommandRisk;
  reason: string;
};

export type ConfirmResolvedEvent = {
  type: 'confirm_resolved';
  confirmId: string;
  answer: string;
};

export type TaskStatusEvent = {
  type: 'task_status';
  taskId: string;
  status: 'planning' | 'executing' | 'waiting_confirm' | 'summarizing' | 'done' | 'aborted' | 'error';
  note?: string;
};

export type SessionEvent = {
  type: 'session';
  sessionId: string;
  isNew: boolean;
};

export type SkillEvent = {
  type: 'skill';
  skill: string;
  action: 'listed' | 'read' | 'activated' | 'deactivated';
  trigger?: 'implicit' | 'explicit';
  reason?: string;
  summary?: string;
};

export type AgentEvent =
  | ChunkEvent
  | ReasoningChunkEvent
  | ToolStatusEvent
  | ToolEvent
  | ResultEvent
  | ErrorEvent
  | PlanEvent
  | ConfirmRequestEvent
  | CommandConfirmRequestEvent
  | ConfirmResolvedEvent
  | TaskStatusEvent
  | SessionEvent
  | SkillEvent;

// ── 挂起确认（服务端内存中维护）──

export type PendingConfirm = {
  confirmId: string;
  taskId: string;
  sessionId: string;
  question: string;
  options?: string[];
  createdAt: number;
  resolve: (answer: string) => void;
  reject: (reason: Error) => void;
};

export type PendingCommandConfirm = {
  confirmId: string;
  taskId: string;
  sessionId: string;
  command: string;
  cwd: string;
  risk: CommandRisk;
  reason: string;
  createdAt: number;
  resolve: (decision: 'allow_once' | 'allow_whitelist' | 'deny') => void;
  reject: (reason: Error) => void;
};
