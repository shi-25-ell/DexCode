import type { FileDiff, ToolPresentation, ToolViewStatus } from '../shared/types.ts';
import { safeRawOutput } from './output-policy.ts';

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizedLines(value: string | null): string[] {
  if (value === null || value === '') return [];
  return value.replace(/\r\n/g, '\n').split('\n');
}

export function diffStat(diff?: FileDiff): { additions: number; deletions: number } | undefined {
  if (!diff) return undefined;
  const before = normalizedLines(diff.before);
  const after = normalizedLines(diff.after);
  const prefixLimit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < prefixLimit && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  return {
    additions: Math.max(0, after.length - prefix - suffix),
    deletions: Math.max(0, before.length - prefix - suffix),
  };
}

function outcomeStatus(result: unknown): ToolViewStatus {
  const object = objectValue(result);
  const status = String(object.status ?? '').toLowerCase();
  if (status === 'denied' || status === 'rejected') return 'denied';
  if (status === 'cancelled' || status === 'aborted') return 'cancelled';
  if ('error' in object && object.error) return 'failed';
  return 'succeeded';
}

function descriptor(tool: string, args: Record<string, unknown>) {
  const targetPath = typeof args.path === 'string' ? args.path.replaceAll('\\', '/') : undefined;
  if (tool === 'read_file') return { category: 'read' as const, name: '读取文件', target: targetPath };
  if (tool === 'write_file' || tool === 'patch_file') return { category: 'file' as const, name: '修改文件', target: targetPath };
  if (tool === 'run_command') return { category: 'command' as const, name: '执行命令', target: String(args.command ?? '') };
  if (tool === 'search_in_workspace') return { category: 'search' as const, name: '搜索代码', target: [args.query, args.path].filter(Boolean).join(' · ') };
  if (tool === 'list_workspace') return { category: 'read' as const, name: '浏览目录', target: targetPath ?? '当前项目' };
  if (tool === 'read_lints') return { category: 'read' as const, name: '检查问题', target: targetPath ?? '当前项目' };
  if (tool === 'list_skills') return { category: 'skill' as const, name: '浏览 Skill', target: '可用能力' };
  if (tool === 'read_skill' || tool === 'activate_skill' || tool === 'deactivate_skill') {
    return { category: 'skill' as const, name: tool === 'deactivate_skill' ? '停用 Skill' : '使用 Skill', target: String(args.name ?? 'Skill') };
  }
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__').filter(Boolean);
    return { category: 'mcp' as const, name: '调用 MCP', target: parts.length > 1 ? parts.slice(1).join(' · ') : '外部工具' };
  }
  if (tool === 'create_snapshot' || tool === 'restore_snapshot' || tool === 'list_versions') {
    return { category: 'snapshot' as const, name: tool === 'restore_snapshot' ? '恢复快照' : tool === 'create_snapshot' ? '创建快照' : '查看快照', target: String(args.name ?? args.snapshotId ?? '当前项目') };
  }
  return { category: 'other' as const, name: '调用工具', target: undefined };
}

function successSummary(tool: string, result: unknown, status: ToolViewStatus): string {
  if (status === 'denied') return '已拒绝执行';
  if (status === 'cancelled') return '已取消';
  if (status === 'failed') return String(objectValue(result).error ?? '执行失败').slice(0, 160);
  if (tool === 'read_file') {
    const object = objectValue(result);
    const content = typeof object.content === 'string' ? object.content : typeof result === 'string' ? result : '';
    return content ? `已读取 ${content.replace(/\r\n/g, '\n').split('\n').length.toLocaleString('zh-CN')} 行` : '读取完成';
  }
  if (tool === 'write_file' || tool === 'patch_file') return '文件已更新';
  if (tool === 'run_command') return '命令执行完成';
  if (tool === 'activate_skill' || tool === 'read_skill') return '已加载能力说明';
  if (tool.startsWith('mcp__')) return '外部工具调用完成';
  return '执行完成';
}

export function presentTool(input: {
  callRef: string;
  tool: string;
  args?: Record<string, unknown>;
  result?: unknown;
  status?: ToolViewStatus;
  fileDiff?: FileDiff;
}): ToolPresentation {
  const args = input.args ?? {};
  const details = descriptor(input.tool, args);
  const status = input.status ?? (input.result === undefined ? 'running' : outcomeStatus(input.result));
  const raw = input.result === undefined ? { truncated: false } : safeRawOutput(input.result);
  const stat = diffStat(input.fileDiff);
  return {
    callRef: input.callRef,
    ...details,
    status,
    summary: status === 'running' ? '正在执行…' : successSummary(input.tool, input.result, status),
    ...(raw.text ? { rawOutput: raw.text } : {}),
    ...(raw.truncated ? { truncated: true } : {}),
    ...(input.fileDiff ? {
      fileChange: {
        path: input.fileDiff.path.replaceAll('\\', '/'),
        ...(stat ?? {}),
      },
    } : {}),
  };
}
