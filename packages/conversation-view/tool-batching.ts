import type { ToolBatchPresentation, ToolBatchType, ToolPresentation, ToolViewStatus } from '../shared/types.ts';

const INSPECTION_TOOLS = new Set(['read_file', 'search_in_workspace', 'list_workspace', 'read_lints', 'diff_file']);
const MODIFICATION_TOOLS = new Set(['write_file', 'patch_file']);

export type ToolSequenceInput<T extends Pick<ToolPresentation, 'callRef' | 'toolName'>, B> =
  | { kind: 'tool'; key: string; tool: T }
  | { kind: 'boundary'; key: string; value: B; transparentFor?: ToolBatchType[] };

export type ToolSequenceOutput<T extends Pick<ToolPresentation, 'callRef' | 'toolName'>, B> =
  | { kind: 'tool_batch'; key: string; batch: { id: string; type: ToolBatchType; members: T[] } }
  | { kind: 'tool'; key: string; tool: T }
  | { kind: 'boundary'; key: string; value: B; transparentFor?: ToolBatchType[] };

export function toolBatchType(toolName: string): ToolBatchType | undefined {
  if (INSPECTION_TOOLS.has(toolName)) return 'inspection';
  if (MODIFICATION_TOOLS.has(toolName)) return 'modification';
  if (toolName === 'run_command') return 'command';
  return undefined;
}

export function batchToolSequence<T extends Pick<ToolPresentation, 'callRef' | 'toolName'>, B>(
  entries: ToolSequenceInput<T, B>[],
): ToolSequenceOutput<T, B>[] {
  const result: ToolSequenceOutput<T, B>[] = [];
  let active: Extract<ToolSequenceOutput<T, B>, { kind: 'tool_batch' }> | undefined;
  for (const entry of entries) {
    if (entry.kind === 'boundary') {
      if (!active || !entry.transparentFor?.includes(active.batch.type)) active = undefined;
      result.push(entry);
      continue;
    }
    const type = toolBatchType(entry.tool.toolName);
    if (!type) {
      active = undefined;
      result.push(entry);
      continue;
    }
    if (!active || active.batch.type !== type) {
      active = {
        kind: 'tool_batch',
        key: `tool-batch-${type}-${entry.tool.callRef}`,
        batch: { id: `tool-batch-${type}-${entry.tool.callRef}`, type, members: [entry.tool] },
      };
      result.push(active);
    } else {
      active.batch.members.push(entry.tool);
    }
  }
  return result;
}

export type ToolBatchStatus = 'running' | 'succeeded' | 'warning' | 'failed' | 'denied' | 'cancelled';

export function toolBatchStatus(batch: Pick<ToolBatchPresentation, 'members'>): { status: ToolBatchStatus; failed: number } {
  const statuses = batch.members.map((member) => member.status);
  const failed = statuses.filter((status) => status === 'failed').length;
  if (statuses.some((status) => status === 'queued' || status === 'running')) return { status: 'running', failed };
  if (statuses.every((status) => status === 'succeeded')) return { status: 'succeeded', failed };
  if (statuses.every((status) => status === 'failed')) return { status: 'failed', failed };
  if (statuses.every((status) => status === 'denied' || status === 'cancelled')) {
    return { status: statuses.some((status) => status === 'denied') ? 'denied' : 'cancelled', failed };
  }
  return { status: 'warning', failed };
}

export function toolBatchSummary(batch: Pick<ToolBatchPresentation, 'type' | 'members'>): string {
  if (batch.type === 'inspection') {
    const files = new Set(batch.members.flatMap((member) => (
      (member.toolName === 'read_file' || member.toolName === 'diff_file') && member.target ? [member.target] : []
    ))).size;
    const searches = batch.members.filter((member) => member.toolName === 'search_in_workspace').length;
    return [files ? `检查了 ${files} 个文件` : '', searches ? `搜索 ${searches} 次` : '', `${batch.members.length} 项操作`].filter(Boolean).join(' · ');
  }
  if (batch.type === 'command') {
    const failed = batch.members.filter((member) => member.status === 'failed').length;
    return `执行了 ${batch.members.length} 个命令 · 失败 ${failed} 个`;
  }
  const files = new Set(batch.members.flatMap((member) => {
    const path = member.fileChange?.path ?? member.target;
    return path ? [path] : [];
  })).size;
  const additions = batch.members.reduce((total, member) => total + (member.fileChange?.additions ?? 0), 0);
  const deletions = batch.members.reduce((total, member) => total + (member.fileChange?.deletions ?? 0), 0);
  return `修改 ${files} 个文件 · ${batch.members.length} 次操作 · +${additions} −${deletions}`;
}

export function asToolBatch(batch: { id: string; type: ToolBatchType; members: ToolPresentation[] }): ToolBatchPresentation {
  return batch;
}
