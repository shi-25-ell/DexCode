import { normalizeToolResult } from '../shared/tool-result.ts';

export type ToolFallbackHint = {
  message: string;
  suggestTools?: string[];
};

export function getToolFallback(toolName: string, result: unknown): ToolFallbackHint | null {
  const r = result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
  const normalized = normalizeToolResult(result);
  const errorText = String(normalized.ok ? r?.stderr ?? '' : normalized.error.message).toLowerCase();

  switch (toolName) {
    case 'patch_file':
      return {
        message: '结构化编辑未匹配。先用 read_file 核对最新原文，再缩小 targeted 的 old_text，或修正 replace_all 的 expected_occurrences。',
        suggestTools: ['read_file', 'grep'],
      };
    case 'read_file':
      return {
        message: '文件读取失败。先用 find、ls 或 list_workspace 确认路径。',
        suggestTools: ['find', 'ls', 'list_workspace'],
      };
    case 'run_command':
      if (errorText.includes('denied') || errorText.includes('拒绝')) {
        return {
          message: '用户拒绝或命令需确认。请说明原因并改用只读工具，或在普通对话中请求用户批准。',
          suggestTools: ['read_file', 'grep'],
        };
      }
      return {
        message: '命令执行失败。检查当前 shell、命令拼写和依赖；项目检查可通过 run_command 调用仓库脚本。',
        suggestTools: ['read_file', 'run_command'],
      };
    case 'write_file':
      return {
        message: '写入失败。若只需小改，优先 patch_file；大文件可先 read_file 再 patch。',
        suggestTools: ['patch_file', 'read_file'],
      };
    case 'grep':
      return {
        message: '未找到匹配。检查 pattern、glob 或 path；也可用 find、ls 浏览结构。',
        suggestTools: ['find', 'ls', 'read_file'],
      };
    default:
      if (!normalized.ok) {
        return { message: `工具 ${toolName} 失败：${normalized.error.message}`, suggestTools: ['read_file', 'ls'] };
      }
      return null;
  }
}

export function enrichToolResult(toolName: string, result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const r = result as Record<string, unknown>;
  const failed = !normalizeToolResult(result).ok;

  if (!failed) return result;

  const fallback = getToolFallback(toolName, result);
  if (!fallback) return result;

  return { ...r, fallback };
}
