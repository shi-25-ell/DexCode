export type ToolResultStatus =
  | 'succeeded'
  | 'invalid_arguments'
  | 'blocked'
  | 'denied'
  | 'failed'
  | 'cancelled';

export type ToolErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'BLOCKED_BY_POLICY'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_MISMATCH'
  | 'UNSUPPORTED_TOOL'
  | 'TOOL_DISABLED'
  | 'NOT_FOUND'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'CONFLICT'
  | 'CANCELLED'
  | 'EXECUTION_FAILED';

export type ToolError = {
  code: ToolErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type ToolResult<T = unknown> =
  | { ok: true; status: 'succeeded'; data: T }
  | { ok: false; status: Exclude<ToolResultStatus, 'succeeded'>; error: ToolError; data?: T };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function legacyCode(value: unknown, status: Exclude<ToolResultStatus, 'succeeded'>): ToolErrorCode {
  const code = String(value ?? '').toUpperCase();
  if (code === 'INVALID_ARGUMENTS') return 'INVALID_ARGUMENTS';
  if (code === 'BLOCKED_BY_POLICY') return 'BLOCKED_BY_POLICY';
  if (code === 'APPROVAL_REQUIRED') return 'APPROVAL_REQUIRED';
  if (code === 'APPROVAL_DENIED') return 'APPROVAL_DENIED';
  if (code === 'APPROVAL_MISMATCH') return 'APPROVAL_MISMATCH';
  if (code === 'UNSUPPORTED_TOOL') return 'UNSUPPORTED_TOOL';
  if (code === 'TOOL_DISABLED') return 'TOOL_DISABLED';
  if (code === 'NOT_FOUND') return 'NOT_FOUND';
  if (code === 'PATH_OUTSIDE_WORKSPACE') return 'PATH_OUTSIDE_WORKSPACE';
  if (code === 'CONFLICT') return 'CONFLICT';
  if (code === 'CANCELLED') return 'CANCELLED';
  if (status === 'invalid_arguments') return 'INVALID_ARGUMENTS';
  if (status === 'blocked') return 'BLOCKED_BY_POLICY';
  if (status === 'denied') return 'APPROVAL_DENIED';
  if (status === 'cancelled') return 'CANCELLED';
  return 'EXECUTION_FAILED';
}

function failureStatus(value: Record<string, unknown>): Exclude<ToolResultStatus, 'succeeded'> | undefined {
  const status = String(value.status ?? '').toLowerCase();
  if (status === 'invalid_arguments' || status === 'rejected') return 'invalid_arguments';
  if (status === 'blocked') return 'blocked';
  if (status === 'denied') return 'denied';
  if (status === 'cancelled' || status === 'aborted') return 'cancelled';
  if (status === 'failed' || status === 'error') return 'failed';
  if (value.ok === false || value.action === 'patch_failed' || Boolean(value.error)) return 'failed';
  return undefined;
}

export function toolFailure(
  status: Exclude<ToolResultStatus, 'succeeded'>,
  code: ToolErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ToolResult<never> {
  return {
    ok: false,
    status,
    error: { code, message, ...(details ? { details } : {}) },
  };
}

export function normalizeToolResult<T = unknown>(value: T): ToolResult<T> {
  const object = record(value);
  if (object.ok === true && object.status === 'succeeded' && 'data' in object) {
    return value as unknown as ToolResult<T>;
  }
  if (object.ok === false && ['invalid_arguments', 'blocked', 'denied', 'failed', 'cancelled'].includes(String(object.status))) {
    const error = record(object.error);
    if (typeof error.code === 'string' && typeof error.message === 'string') {
      return value as unknown as ToolResult<T>;
    }
  }
  if (object.error && typeof object.error === 'object' && !Array.isArray(object.error)) {
    const error = object.error as Record<string, unknown>;
    const status = failureStatus(object) ?? 'failed';
    return {
      ok: false,
      status,
      error: {
        code: legacyCode(error.code ?? object.code, status),
        message: String(error.message ?? object.reason ?? 'Tool execution failed'),
        ...(error.details && typeof error.details === 'object' && !Array.isArray(error.details)
          ? { details: error.details as Record<string, unknown> }
          : {}),
      },
      data: value,
    };
  }
  const status = failureStatus(object);
  if (status) {
    return {
      ok: false,
      status,
      error: {
        code: legacyCode(object.code, status),
        message: String(object.error ?? object.reason ?? 'Tool execution failed'),
      },
      data: value,
    };
  }
  return { ok: true, status: 'succeeded', data: value };
}

export function toolResultData<T>(result: ToolResult<T>): T | undefined {
  return result.data;
}
