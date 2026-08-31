import type { MemoryHeader } from './contracts.ts';

const TAXONOMY = [
  '- user: 用户角色、目标、知识背景和长期协作偏好。',
  '- feedback: 用户对 Agent 工作方式的纠正或明确认可，保留原因与适用条件。',
  '- project: 无法从代码、Git 或权威项目文档推导的目标、期限、事故背景和决策动机。',
  '- reference: 外部系统中最新信息的位置与用途，只保存指针，不复制易过期内容。',
].join('\n');

const FORBIDDEN = [
  '- 可从当前代码、Git、README、ADR、CONTEXT.md 或项目知识推导的事实；',
  '- 当前任务计划、TODO、临时状态、工具输出、调试或修复步骤；',
  '- 密钥、Token、Cookie、密码、私有凭证或完整连接串；',
  '- 未经用户确认的推断和与协作无关的个人信息。',
].join('\n');

export function buildMemoryPolicyPrompt(indexEmpty: boolean): string {
  return `# Auto Memory

你拥有当前 Workspace 的持久文件记忆。目录已由运行时准备；只能通过 memory_* 专用工具访问，不要用普通文件或命令工具检查状态目录。

只记录未来会话仍有价值的四类信息：
${TAXONOMY}

不得记录：
${FORBIDDEN}

用户明确要求记住时立即保存；明确要求忘记时先查找再删除。保存前先查重，按语义主题组织，优先更新已有 topic。feedback/project 正文保留 Why 与 How to apply，相对日期改为绝对日期。
MEMORY.md 只是索引；详细内容只能放在带严格 frontmatter 的 topic 文件里。memory_upsert 会原子同步 topic 与索引。
memory_* 的 topic path 只能填写记忆根目录中的裸文件名，例如 coding-agent-project.md；不要添加 topics/、projects/ 或任何目录前缀。
记忆可能过期。行动前核验其中的文件、函数、配置和当前状态；冲突时信任当前证据并修正旧记忆。
用户要求本轮忽略记忆时，不使用、引用、比较或暗示任何已存记忆。${indexEmpty ? '\n当前索引为空。' : ''}`;
}

export function formatManifest(headers: MemoryHeader[]): string {
  if (headers.length === 0) return '(当前没有 topic 文件)';
  return headers.map((header) => `- [${header.type}] ${header.path} (${new Date(header.mtimeMs).toISOString()}): ${header.description}`).join('\n');
}

export function buildExtractionPrompt(input: {
  manifest: MemoryHeader[];
  checkpointDescription: string;
  completedAt: string;
}): string {
  return `# Memory Extraction

你是记忆提取 Agent。只分析提供的最近消息，更新当前 Workspace 的自动记忆。当前轮完成时间：${input.completedAt}。
增量范围：${input.checkpointDescription}

你只能使用 memory_list、memory_read、memory_search、memory_upsert、memory_remove。现有 manifest 已提供，先判断是否真的需要保存；没有长期价值时不要调用写工具。topic path 只能填写记忆根目录中的裸文件名，例如 coding-agent-project.md，不要添加目录前缀。

允许的四类：
${TAXONOMY}

不得保存：
${FORBIDDEN}

必须优先更新已有 topic，不创建近重复文件；用户明确要求忘记时删除；feedback/project 保留 Why 与 How to apply；不要调查代码来验证本轮信息。

当前 manifest：
${formatManifest(input.manifest)}`;
}

export function buildConsolidationPrompt(input: { manifest: MemoryHeader[]; index: string; sessionIds: string[] }): string {
  return `# Memory Consolidation

整理当前 Workspace 的长期自动记忆。合并近重复主题，删除被新证据否定或已经没有召回价值的条目，修正相对日期，改进 description 和索引 hook。没有实质变化时不要写。topic path 只能填写记忆根目录中的裸文件名，例如 coding-agent-project.md，不要添加目录前缀。

必须继续遵守四类 taxonomy：
${TAXONOMY}

不得引入：
${FORBIDDEN}

索引必须保持在 200 行和 25,000 字节以内；详细正文仍只在 topic 中。

当前索引：
${input.index || '(空)'}

当前 manifest：
${formatManifest(input.manifest)}

触发本次整理的 Session：${input.sessionIds.join(', ') || '(manual)'}`;
}
