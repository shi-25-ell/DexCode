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

const MAX_LOG_PER_TOOL = 80;

function newLogId(): string {
  return `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function previewValue(value: unknown, maxLen = 240): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  } catch {
    return String(value).slice(0, maxLen);
  }
}

function isSuccessResult(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result !== 'object') return true;
  const r = result as Record<string, unknown>;
  if (r.error) return false;
  if (r.ok === false) return false;
  if (r.status === 'failed' || r.status === 'denied' || r.status === 'blocked') return false;
  if (r.action === 'patch_failed') return false;
  return true;
}

export function createToolCallLogStore() {
  const logsByTool = new Map<string, ToolCallLogEntry[]>();

  function append(
    toolName: string,
    args: unknown[],
    result: unknown,
    durationMs: number,
    thrown?: unknown,
  ): ToolCallLogEntry {
    const ok = !thrown && isSuccessResult(result);
    const entry: ToolCallLogEntry = {
      id: newLogId(),
      toolName,
      argsPreview: previewValue(args.length === 1 ? args[0] : args),
      ok,
      durationMs,
      at: new Date().toISOString(),
      resultPreview: thrown
        ? previewValue(thrown instanceof Error ? thrown.message : thrown)
        : previewValue(result),
      ...(thrown ? { error: String(thrown instanceof Error ? thrown.message : thrown) } : {}),
    };

    const list = logsByTool.get(toolName) ?? [];
    list.unshift(entry);
    if (list.length > MAX_LOG_PER_TOOL) list.length = MAX_LOG_PER_TOOL;
    logsByTool.set(toolName, list);
    return entry;
  }

  function getLogs(toolName: string, limit = 30): ToolCallLogEntry[] {
    const list = logsByTool.get(toolName) ?? [];
    return list.slice(0, Math.max(1, Math.min(limit, MAX_LOG_PER_TOOL)));
  }

  function getAllToolNames(): string[] {
    return [...logsByTool.keys()];
  }

  return { append, getLogs, getAllToolNames };
}

export type ToolCallLogStore = ReturnType<typeof createToolCallLogStore>;
