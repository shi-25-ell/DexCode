export type ToolFallbackHint = {
  message: string;
  suggestTools?: string[];
};

export function getToolFallback(toolName: string, result: unknown): ToolFallbackHint | null {
  const r = result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
  const errorText = String(r?.error ?? r?.stderr ?? '').toLowerCase();

  switch (toolName) {
    case 'patch_file':
      return {
        message:
          '补丁未匹配。可改用：1) unified diff；2) "旧内容\\n---\\n新内容"；3) 先 read_file 核对原文；4) 行号锚点 "@@ line 42" + 替换块。',
        suggestTools: ['read_file', 'search_in_workspace', 'diff_file'],
      };
    case 'read_file':
      return {
        message: '文件读取失败。先用 list_workspace 或 search_in_workspace 确认路径。',
        suggestTools: ['list_workspace', 'search_in_workspace'],
      };
    case 'run_command':
      if (errorText.includes('denied') || errorText.includes('拒绝')) {
        return {
          message: '用户拒绝或命令需确认。请说明原因并尝试 read_lints / 只读命令，或请用户加入白名单。',
          suggestTools: ['read_lints', 'ask_user'],
        };
      }
      return {
        message: '命令执行失败。检查命令拼写、依赖是否安装；静态检查优先 read_lints。',
        suggestTools: ['read_lints', 'read_file'],
      };
    case 'read_lints':
      return {
        message: 'Lint 检查无输出或失败。可 read_file 查看源文件，或用 run_command 运行项目 lint 脚本。',
        suggestTools: ['read_file', 'run_command'],
      };
    case 'diff_file':
      return {
        message: '无法对比差异。先 create_snapshot 创建快照，或 list_versions 查看可用版本。',
        suggestTools: ['create_snapshot', 'list_versions'],
      };
    case 'write_file':
      return {
        message: '写入失败。若只需小改，优先 patch_file；大文件可先 read_file 再 patch。',
        suggestTools: ['patch_file', 'read_file'],
      };
    case 'search_in_workspace':
      return {
        message: '未找到匹配。缩小 query 或指定 path 目录；也可 list_workspace 浏览结构。',
        suggestTools: ['list_workspace', 'read_file'],
      };
    default:
      if (r?.error) {
        return { message: `工具 ${toolName} 失败：${r.error}`, suggestTools: ['ask_user'] };
      }
      return null;
  }
}

export function enrichToolResult(toolName: string, result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const r = result as Record<string, unknown>;
  const failed =
    Boolean(r.error) ||
    r.ok === false ||
    r.status === 'failed' ||
    r.status === 'denied' ||
    r.status === 'blocked' ||
    r.action === 'patch_failed';

  if (!failed) return result;

  const fallback = getToolFallback(toolName, result);
  if (!fallback) return result;

  return { ...r, fallback };
}
