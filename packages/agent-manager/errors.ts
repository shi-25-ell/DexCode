export type AgentErrorCode =
  | 'feature_disabled'
  | 'not_found'
  | 'agent_busy'
  | 'capacity_exceeded'
  | 'history_capacity_exceeded'
  | 'depth_exceeded'
  | 'definition_not_found'
  | 'context_mode_forbidden'
  | 'isolation_forbidden'
  | 'write_capacity_exceeded'
  | 'invalid_input';

export class AgentManagerError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = 'AgentManagerError';
    this.code = code;
  }
}

export function agentErrorResult(error: unknown): { status: 'error'; code: string; message: string } {
  return error instanceof AgentManagerError
    ? { status: 'error', code: error.code, message: error.message }
    : { status: 'error', code: 'internal_error', message: error instanceof Error ? error.message : String(error) };
}
