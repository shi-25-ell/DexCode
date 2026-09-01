import type { FileDiff, ToolPresentation, ToolViewStatus } from '../shared/types.ts';
import { createTwoFilesPatch, structuredPatch } from 'diff';
import type { ManagedMemoryType } from '../managed-memory/contracts.ts';
import { serializeTopic } from '../managed-memory/format.ts';
import { safeDisplayOutput } from './output-policy.ts';
import { codingToolSpec } from '../tool-gateway/tool-registry.ts';

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const MAX_FILE_DIFF_CHARS = 64_000;

export function fileChangePresentation(diff?: FileDiff): ToolPresentation['fileChange'] {
  if (!diff) return undefined;
  const path = diff.path.replaceAll('\\', '/');
  const before = (diff.before ?? '').replace(/\r\n/g, '\n');
  const after = (diff.after ?? '').replace(/\r\n/g, '\n');
  const oldName = diff.before === null ? '/dev/null' : `a/${path}`;
  const newName = `b/${path}`;
  const structured = structuredPatch(oldName, newName, before, after, '', '', { context: 3 });
  let additions = 0;
  let deletions = 0;
  for (const hunk of structured.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
  }
  const complete = createTwoFilesPatch(oldName, newName, before, after, '', '', { context: 3 });
  const truncated = complete.length > MAX_FILE_DIFF_CHARS;
  return {
    path,
    kind: diff.before === null ? 'created' : 'modified',
    additions,
    deletions,
    diff: truncated ? `${complete.slice(0, MAX_FILE_DIFF_CHARS)}\n… unified diff 已截断 …\n` : complete,
    truncated,
  };
}

function outcomeStatus(result: unknown): ToolViewStatus {
  const object = objectValue(result);
  const status = String(object.status ?? '').toLowerCase();
  if (status === 'denied' || status === 'rejected') return 'denied';
  if (status === 'cancelled' || status === 'aborted') return 'cancelled';
  if (status === 'failed' || status === 'blocked') return 'failed';
  if ('error' in object && object.error) return 'failed';
  return 'succeeded';
}

function descriptor(tool: string, args: Record<string, unknown>) {
  const targetPath = typeof args.path === 'string' ? args.path.replaceAll('\\', '/') : undefined;
  const coding = codingToolSpec(tool);
  if (coding) {
    const target = tool === 'run_command'
      ? String(args.command ?? '')
      : tool === 'read_command_output' || tool === 'stop_command'
        ? String(args.task_id ?? '')
        : tool === 'find' || tool === 'grep'
          ? [args.pattern, args.path, tool === 'grep' ? args.glob : undefined].filter(Boolean).join(' · ')
          : tool === 'list_workspace'
            ? '当前项目'
            : targetPath;
    return { category: coding.presentation.category, name: coding.presentation.label, target };
  }
  if (tool === 'list_skills') return { category: 'skill' as const, name: '浏览 Skill', target: '可用能力' };
  if (tool.startsWith('memory_')) {
    const names: Record<string, string> = { memory_list: '浏览记忆', memory_read: '读取记忆', memory_search: '搜索记忆', memory_upsert: '更新记忆', memory_remove: '删除记忆' };
    return { category: 'memory' as const, name: names[tool] ?? '管理记忆', target: targetPath ?? '当前项目' };
  }
  if (tool === 'read_skill' || tool === 'activate_skill' || tool === 'deactivate_skill') {
    return { category: 'skill' as const, name: tool === 'deactivate_skill' ? '停用 Skill' : '使用 Skill', target: String(args.name ?? 'Skill') };
  }
  if (tool === 'spawn_agent') return { category: 'other' as const, name: '启动子 Agent', target: undefined };
  if (tool === 'wait_agent') {
    const agentCount = Array.isArray(args.agent_ids) ? args.agent_ids.length : 0;
    const timeoutSeconds = typeof args.timeout_ms === 'number' ? Math.max(0, Math.round(args.timeout_ms / 1_000)) : 0;
    const target = [agentCount ? `${agentCount} 个 Agent` : '', timeoutSeconds ? `最长 ${timeoutSeconds} 秒` : ''].filter(Boolean).join(' · ');
    return { category: 'other' as const, name: '等待子 Agent', target: target || undefined };
  }
  if (tool === 'followup_agent') return { category: 'other' as const, name: '继续子 Agent', target: undefined };
  if (tool === 'stop_agent') return { category: 'other' as const, name: '停止子 Agent', target: undefined };
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__').filter(Boolean);
    return { category: 'mcp' as const, name: '调用 MCP', target: parts.length > 1 ? parts.slice(1).join(' · ') : '外部工具' };
  }
  return { category: 'other' as const, name: '调用工具', target: tool };
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
  if (tool === 'find' || tool === 'ls') return `找到 ${Number(objectValue(result).total ?? 0).toLocaleString('zh-CN')} 项`;
  if (tool === 'list_workspace') return `已列出 ${Number(objectValue(result).node_count ?? 0).toLocaleString('zh-CN')} 个节点`;
  if (tool === 'grep') return `找到 ${Number(objectValue(result).match_count ?? 0).toLocaleString('zh-CN')} 个匹配`;
  if (tool === 'write_file' || tool === 'patch_file') return '文件已更新';
  if (tool === 'run_command') return String(objectValue(result).status ?? '') === 'background' ? '命令已转入后台' : '命令执行完成';
  if (tool === 'read_command_output') return String(objectValue(result).status ?? '') === 'background' ? '命令仍在后台运行' : '后台命令已结束';
  if (tool === 'stop_command') return '后台命令已停止';
  if (tool === 'activate_skill' || tool === 'read_skill') return '已加载能力说明';
  if (tool === 'memory_upsert') return '项目记忆已更新';
  if (tool === 'memory_remove') return '项目记忆已删除';
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
  const memoryUpsertContent = input.tool === 'memory_upsert' && status === 'succeeded'
    ? serializeTopic({
        name: String(args.name ?? ''),
        description: String(args.description ?? ''),
        type: String(args.type ?? '') as ManagedMemoryType,
        body: String(args.body ?? ''),
      })
    : undefined;
  const isFileMutation = input.tool === 'write_file' || input.tool === 'patch_file';
  const raw = input.result === undefined || isFileMutation || (input.tool === 'memory_remove' && status === 'succeeded')
    ? { truncated: false }
    : safeDisplayOutput(memoryUpsertContent ?? input.result);
  const fileChange = fileChangePresentation(input.fileDiff);
  return {
    callRef: input.callRef,
    toolName: input.tool,
    ...details,
    status,
    summary: status === 'queued' ? '准备执行…' : status === 'running' ? '正在执行…' : successSummary(input.tool, input.result, status),
    ...(raw.text ? { rawOutput: raw.text } : {}),
    ...(raw.truncated ? { truncated: true } : {}),
    ...(fileChange ? { fileChange } : {}),
  };
}
