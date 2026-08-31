# DexCode 项目级自动记忆系统开发文档

> 文档状态：开发基线与完整实施计划  
> 目标读者：负责 DexCode 后端 Agent Runtime、Context Engine、Session 持久化与 Web 设置页的开发者或 Coding Agent  
> 核心目标：为每个 DexCode Workspace 提供一套由 LLM 自主维护、跨会话持久化、按需召回、可审计、可关闭的文件记忆系统。

---

## 1. 结论先行

DexCode 应新增一个独立的 `managed-memory` 深模块。它不是现有“项目知识”的自动写入版，也不是把历史对话做摘要后永久塞进 system prompt。

完整链路必须同时包含：

1. **稳定的项目级存储**：一个 Workspace 对应一个自动记忆目录，入口是 `MEMORY.md`，详细内容按主题拆成多个 Markdown 文件。
2. **主 Agent 直接维护**：system prompt 明确告诉主 Agent 什么应记、什么不应记；用户明确要求“记住/忘记”时，主 Agent 可立即调用专用工具更新记忆。
3. **后台补提取**：每个完整 Main Run 结束后，后台 Memory Agent 检查本轮新增对话；若主 Agent 没有直接写记忆，则补提取遗漏的信息。
4. **新任务按需召回**：每个新 Run 根据用户请求，从主题文件的 frontmatter 清单中选择最多 5 个高相关文件，受限读取并注入本轮上下文。
5. **索引常驻与分层加载**：`MEMORY.md` 只保存短索引；索引有严格行数和字节上限，主题文件按需加载，不能把整个记忆目录全量注入。
6. **长期整理**：在达到时间与会话阈值后，由后台 Memory Agent 合并重复主题、修正冲突、清理陈旧条目并收紧索引。
7. **生产语义**：Workspace 隔离、原子写、乐观并发、崩溃恢复、后台任务合并、退出前排空、Abort、预算、错误隔离、可观测性和关闭开关缺一不可。

最终结构应是：

```text
用户请求
  ├─> Memory Recall：索引 + 相关主题文件
  │       └─> Context Sections：managedMemory
  ├─> Main Agent
  │       └─> memory_* 专用工具（可立即记住或忘记）
  └─> Main Run terminal
          └─> Memory Extraction Coordinator（后台、非阻塞）
                  └─> Internal Memory Agent
                          └─> 同一套 memory_* 专用工具

若干会话后
  └─> Memory Consolidation Coordinator
          └─> Internal Memory Agent
                  └─> 合并、纠错、清理、重建索引
```

---

## 2. 术语与产品边界

本文统一使用以下术语：

| 术语 | 含义 |
| --- | --- |
| 项目知识（Project Knowledge） | 现有用户手动编辑的 `project-memory.md`。内容偏项目约定、架构说明、编码规范和人工维护的经验。 |
| 自动记忆（Managed Memory） | 本文新增的 LLM-managed file memory。由 Agent 在对话中自主创建、更新、删除和召回。 |
| 入口索引（Entrypoint） | 自动记忆目录中的 `MEMORY.md`。只包含主题文件链接和一句话 hook，不直接承载详细记忆。 |
| 主题文件（Topic File） | 带 frontmatter 的 Markdown 文件，例如 `feedback_testing.md`、`project_release_context.md`。 |
| Main Agent | 直接处理用户编码任务的 Agent，`origin: "user"`。 |
| Memory Agent | 负责提取或整理记忆的内部 Agent，`origin: "internal"`、`profile: "memory"`。 |
| Recall | 根据当前用户请求挑选并注入相关主题文件。 |
| Extraction | 从刚结束的 Main Run 中提取未来会话仍有价值的信息。 |
| Consolidation | 跨多个会话反思、合并、纠错和清理已有记忆。 |

### 2.1 自动记忆与项目知识必须分离

这两套能力在存储、接口、上下文来源、UI 和写入权限上都必须独立：

| 维度 | 项目知识 | 自动记忆 |
| --- | --- | --- |
| 谁维护 | 用户手动编辑 | LLM 主动维护，用户可查看/关闭/删除 |
| 当前文件 | `workspace-data/<workspaceId>/project-memory.md` | `workspace-data/<workspaceId>/managed-memory/**` |
| 典型内容 | 架构、规范、稳定说明 | 用户偏好、纠正与确认、非代码可推导的背景、外部信息指针 |
| Context source | `projectMemory` | 新增 `managedMemory` |
| 写入入口 | 现有 HTTP API / 设置页 | `memory_*` Agent 工具 + 独立诊断 API |
| 检索 | 现有 Markdown 分段匹配 | `MEMORY.md` + frontmatter manifest + 模型选择器 |

禁止事项：

- 不把现有 `/api/project-memory` 改造成自动记忆接口。
- 不让后台 Memory Agent 调用 `writeProjectMemory()` 或 `appendProjectMemory()`。
- 不在现有“项目知识”设置面板中偷偷加入自动写入。
- 不把两者合并成同一个 `ContextSection`，否则无法单独计量、关闭和诊断。
- 不迁移用户现有 `project-memory.md`；它保持原语义和原路径。

---

## 3. 当前 DexCode 基线

开发必须基于当前代码，而不是另起一套 Agent Loop。

### 3.1 已经具备的可复用能力

1. `packages/agent-core/agent-runtime.ts`
   - 已有 `runAgent()` / `runInternalAgent()`。
   - 已有 `origin: "user" | "internal"`，可防止后台 Agent 递归触发自身。
   - 已有 `persistence: "none"`，内部 Agent 可运行但不污染用户 Session。
   - 已有 ToolPolicy、模型轮数预算、Abort、生命周期事件和 hook 错误隔离。

2. `packages/agent-core/index.ts`
   - 已在 Run 开始时构建 `ContextSection[]`。
   - 已读取并注入项目知识。
   - 已有 `ContextEngine` 与 `legacy` 两套上下文策略。
   - 已有 `runTask()` 完整 terminal、RunReport、TaskSummary 和 Session commit 路径。

3. `packages/context-engine/index.ts`
   - `ContextEngine.prepare()` 是每次模型请求上下文整理的深模块接口。
   - system sections 不参与对话摘要，会在每次模型请求重新组装。
   - 已有 token breakdown、manifest、overflow recovery、artifact 和 provider usage 校准。

4. `packages/session-store/index.ts`
   - Session 采用持久 journal，Run 语义可恢复。
   - Workspace 数据已经按稳定 `workspaceId` 隔离。
   - 已有 `workspace-data/<workspaceId>` 存储位置。

5. `packages/agent-core/conversation-run-coordinator.ts`
   - 已预留 `createLifecycleHooks()`。
   - 同一 Session 的 Main Run 串行，不同 Session 可并发。

6. `packages/tool-gateway` 与 `packages/agent-core/executor.ts`
   - 已有工具定义、ToolPolicy、审批、执行、结果持久化和展示路径。

### 3.2 当前缺口

1. `AgentProfile` 还没有 `memory`。
2. `createLifecycleHooks` 当前没有接入自动记忆实现。
3. 没有项目级自动记忆 Store、frontmatter schema、索引和 topic scan。
4. 主 Agent 没有记忆专用工具；通用文件工具只能访问 Workspace，不能安全写入 Workspace 外的状态目录。
5. 没有 Recall selector、相关记忆注入、去重、大小限制和陈旧性提示。
6. 没有 Run 结束后的后台 Extraction、直接写入互斥、游标、合并运行与退出 drain。
7. 没有跨会话 Consolidation。
8. `ContextSection.source` 和 `ContextBreakdown` 只有 `projectMemory`，无法区分自动记忆。
9. 现有 `project-memory.md` 写入不是本系统的事务基础，不能直接扩展来承载并发 LLM 写入。
10. Runtime Server 当前没有统一的后台记忆任务关闭与排空流程。

---

## 4. 记忆内容模型

### 4.1 封闭的四类记忆

只允许以下类型：

```ts
export const MANAGED_MEMORY_TYPES = [
  'user',
  'feedback',
  'project',
  'reference',
] as const;

export type ManagedMemoryType = typeof MANAGED_MEMORY_TYPES[number];
```

#### `user`

记录用户的角色、目标、职责、知识背景和长期协作偏好，用于调整解释深度和协作方式。

示例：用户熟悉 C++/Java，但刚接触 React；解释前端状态时可以用熟悉的后端概念类比。

#### `feedback`

记录用户对 Agent 工作方式的纠正或确认。既要记录“不要再这样做”，也要记录用户明确认可的非显然做法。

推荐正文结构：

```markdown
规则或偏好。

**Why:** 用户给出的原因或历史事件。

**How to apply:** 在哪些任务、目录或风险条件下应用。
```

#### `project`

记录无法从当前代码或 Git 历史直接推导的项目背景，例如目标、截止日期、事故背景、决策动机、人员协作状态。

相对日期必须转换为绝对日期。例如将“下周四冻结合并”保存为明确日期。

#### `reference`

记录外部系统中信息的位置与用途，例如 Issue 项目、监控面板、内部文档或沟通频道。它保存“去哪里找最新信息”，而不是复制一份容易过期的外部内容。

### 4.2 明确禁止保存的内容

以下内容即使用户说“记住”，也不能直接作为自动记忆保存；应询问其中真正不可推导、值得长期保留的部分：

- 可从当前代码推导的架构、模块关系、函数名、文件路径和编码模式。
- Git 历史、最近提交列表、谁修改了什么。
- 调试步骤、修复配方或已经体现在代码中的 bug 修复。
- 已经写入项目知识、README、ADR、CONTEXT.md 或其他权威文档的内容。
- 当前 Run 的 TODO、计划、临时状态、正在等待的命令或未完成工作。
- 密钥、Token、密码、Cookie、私有凭证、完整连接串等敏感数据。
- 对用户的负面评价、与协作无关的个人信息。
- 无依据的 Agent 推断。

### 4.3 召回后的信任规则

记忆是某个时间点的观察，不是当前事实：

- 记忆提到文件时，行动前确认文件仍存在。
- 记忆提到函数、配置或 flag 时，行动前搜索当前代码。
- 记忆与当前代码、用户最新说明或权威外部数据冲突时，以当前证据为准，并更新或删除旧记忆。
- 主题文件超过 1 天时，注入内容必须附带年龄与核验提醒。
- 用户明确要求忽略记忆时，本轮不得注入索引或主题内容，也不得在回答中引用、比较或暗示记忆内容。

---

## 5. 文件布局与持久化格式

### 5.1 路径

每个 Workspace 的根目录固定为：

```text
workspaces/<dexcodeProjectId>/workspace-data/<workspaceId>/managed-memory/
```

建议布局：

```text
managed-memory/
├── MEMORY.md
├── user_role.md
├── feedback_testing.md
├── project_release_context.md
├── reference_observability.md
└── .state/
    ├── settings.json
    ├── extraction-checkpoints.json
    ├── operations.jsonl
    └── consolidation.json
```

约束：

- 作用域只由 `workspaceId` 决定，不使用当前 CWD 字符串直接拼接。
- general conversation 不得加载、读取或写入任何 Workspace 自动记忆。
- `.state` 永远不进入主题扫描，也不对 LLM 暴露绝对路径。
- 不在用户源码仓库内创建 `.dexcode/memory`，避免污染 Git 工作树。
- Workspace 被重新注册为新 `workspaceId` 时，默认得到独立记忆；跨 Workspace 合并必须是未来显式迁移功能。

### 5.2 `MEMORY.md`

`MEMORY.md` 是索引，不是记忆正文。格式示例：

```markdown
# Managed Memory

- [测试策略偏好](feedback_testing.md) — 集成测试优先真实数据库，并保留原因与适用范围。
- [发布冻结背景](project_release_context.md) — 记录当前发布冻结的绝对日期和业务动机。
```

硬限制：

- 最多 200 行。
- 最多 25,000 字节。
- 每个条目一行，建议少于 150 字符，硬上限 200 字符。
- 只允许指向同一自动记忆目录内的合法 topic 文件。
- 不允许 frontmatter。
- 不允许把详细正文直接写进索引。

读取超限索引时：

1. 先按 200 行截断。
2. 再按 25,000 字节截断；优先退到完整换行，不能截断多字节字符。
3. 在注入内容末尾附加明确警告，指出行数或字节限制已触发。
4. 记录诊断事件，但不能让 Main Run 失败。

写入超限索引时必须拒绝，由 Memory Agent 缩短或清理条目后重试，不能静默截断磁盘文件。

### 5.3 主题文件

主题文件采用严格 frontmatter：

```markdown
---
name: 真实数据库测试约束
description: 用户要求集成测试使用真实数据库，包含历史事故原因和适用范围
type: feedback
---

集成测试必须连接真实数据库，不使用只模拟 SQL 行为的 mock。

**Why:** 过去出现过 mock 测试通过、生产迁移失败的事故。

**How to apply:** 涉及迁移、事务、约束和数据库方言的测试必须使用真实数据库适配器。
```

限制：

- 文件名只允许 `[a-z0-9][a-z0-9_-]{0,79}.md`。
- `MEMORY.md` 是保留名，不能作为 topic 路径传入普通 upsert。
- `name`、`description`、`type` 必填。
- `type` 必须属于四类封闭集合。
- `description` 必须是一行，建议不超过 240 字符；它是 Recall selector 的主要输入。
- 单文件写入上限建议 64 KiB；超过时要求拆分主题。
- 统一使用 UTF-8 和 LF。

### 5.4 元数据与审计

`.state/operations.jsonl` 记录每次成功或失败的 mutation：

```ts
type ManagedMemoryOperation = {
  version: 1;
  operationId: string;
  workspaceId: string;
  at: string;
  actor: 'main-agent' | 'memory-extractor' | 'memory-consolidator' | 'user';
  action: 'upsert' | 'remove' | 'settings';
  path?: string;
  beforeDigest?: string;
  afterDigest?: string;
  runId?: string;
  sessionId?: string;
  outcome: 'committed' | 'conflict' | 'rejected' | 'failed';
  reason?: string;
};
```

审计文件只保存路径、摘要和结果，不复制记忆正文，不进入模型上下文。

---

## 6. 深模块与接口

新增：

```text
packages/managed-memory/
├── index.ts
├── contracts.ts
├── paths.ts
├── store.ts
├── format.ts
├── scanner.ts
├── prompt.ts
├── recall.ts
├── extraction.ts
├── consolidation.ts
├── tools.ts
├── coordinator.ts
└── *.test.ts
```

外部调用者只应学习一个主要接口：

```ts
export interface ManagedMemorySystem {
  prepareRun(input: PrepareManagedMemoryInput): Promise<PreparedManagedMemory>;
  enqueueExtraction(input: EnqueueMemoryExtractionInput): void;
  drain(input?: { timeoutMs?: number }): Promise<ManagedMemoryDrainResult>;
  inspect(workspaceId: string): Promise<ManagedMemorySnapshot>;
  updateSettings(workspaceId: string, patch: ManagedMemorySettingsPatch): Promise<ManagedMemorySettings>;
  clearProjectMemory(workspaceId: string, input: ClearProjectMemoryInput): Promise<ClearProjectMemoryResult>;
}
```

其中：

```ts
export type PrepareManagedMemoryInput = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  query: string;
  signal?: AbortSignal;
};

export type ManagedMemoryContextRef = {
  path: string;
  digest: string;
  mtimeMs: number;
  bytes: number;
  truncated: boolean;
  reason: 'index' | 'relevant';
};

export type PreparedManagedMemory = {
  enabled: boolean;
  sections: ContextSection[];
  refs: ManagedMemoryContextRef[];
  recall: {
    candidateCount: number;
    selectedCount: number;
    selector: 'model' | 'lexical-fallback' | 'none';
    durationMs: number;
    warning?: string;
  };
};

export type EnqueueMemoryExtractionInput = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  completedAt: string;
  status: 'completed' | 'aborted' | 'failed' | 'limited';
  messages: ChatMessage[];
  systemSections: ContextSection[];
  toolCalls: Array<{ name: string; input: unknown; outcome?: unknown }>;
};
```

这个接口隐藏以下实现：

- 目录创建与路径规范化。
- frontmatter 解析与 schema 校验。
- `MEMORY.md` 截断与索引同步。
- 主题扫描、manifest 构建和排序。
- Recall selector、fallback、读取上限和去重。
- Memory Agent prompt、工具策略和运行预算。
- extraction checkpoint、后台队列、合并运行和重试。
- 原子 mutation、乐观并发、operation journal 和恢复。
- consolidation 的时间/会话 gate 与进程锁。
- telemetry、诊断状态和 shutdown drain。

### 6.1 内部 seam

这些 seam 只供模块实现与测试使用，不应扩散到 `agent-core`：

```ts
interface ManagedMemoryStore {
  ensure(workspaceId: string): Promise<void>;
  readIndex(workspaceId: string): Promise<MemoryFileView | null>;
  scan(workspaceId: string, signal?: AbortSignal): Promise<MemoryHeader[]>;
  readTopic(workspaceId: string, path: string, limits: ReadLimits): Promise<MemoryTopicView>;
  upsert(input: MemoryUpsertInput): Promise<MemoryMutationResult>;
  remove(input: MemoryRemoveInput): Promise<MemoryMutationResult>;
}

interface MemorySelector {
  select(input: MemorySelectionInput): Promise<string[]>;
}

interface InternalMemoryRunner {
  run(input: InternalMemoryRunInput): Promise<AgentRunResult>;
}
```

生产 adapter 与测试 adapter：

- Store：真实文件系统 adapter；测试使用临时目录中的真实文件系统，不写一个行为不同的内存假实现。
- Selector：模型 adapter；测试使用 scripted selector。
- Internal runner：`AgentRuntime.runInternalAgent()` adapter；测试使用 scripted runner。
- Clock：生产系统时钟；测试使用 fixed clock。

---

## 7. 专用记忆工具

不能给现有 `read_file` / `write_file` 增加任意状态目录写权限。主 Agent 和 Memory Agent 统一使用以下专用工具：

### 7.1 `memory_list`

返回有界 manifest：相对路径、name、description、type、mtime、digest。默认最多 200 个，按 mtime 新到旧排序。

### 7.2 `memory_read`

```ts
{
  path: string;
  offset?: number;
  limit?: number;
}
```

- 只接受 topic 相对路径或 `MEMORY.md`。
- 默认最多读取 200 行 / 16 KiB；可分页，但单次仍受限。
- 返回 raw Markdown、parsed frontmatter、digest、mtime、是否截断。

### 7.3 `memory_search`

```ts
{
  query: string;
  type?: ManagedMemoryType;
  maxResults?: number;
}
```

- 只做 literal/escaped text search，不把输入直接拼成 shell。
- 搜索范围仅为当前 Workspace 的 `.md` topic 文件。
- 默认 20 条、硬上限 50 条，每条片段长度受限。

### 7.4 `memory_upsert`

```ts
{
  path: string;
  name: string;
  description: string;
  type: ManagedMemoryType;
  body: string;
  indexTitle: string;
  indexHook: string;
  expectedDigest?: string | null;
  operationId: string;
}
```

语义：

- 新建文件时 `expectedDigest: null`。
- 更新文件时必须传最近一次 `memory_list` 或 `memory_read` 返回的 digest。
- Store 在同一 Workspace mutation lock 内校验 digest、写 topic、更新唯一索引条目、写 operation journal。
- 同名索引条目只能有一个；重复调用同一 `operationId` 必须返回之前的结果，不得重复追加。
- topic 已写而索引未写的中间状态必须由 recovery intent 修复，不能交给下次模型碰运气。

### 7.5 `memory_remove`

```ts
{
  path: string;
  expectedDigest: string;
  reason: string;
  operationId: string;
}
```

语义：

- 删除 topic 并同时删除索引指针。
- 不允许删除 `MEMORY.md`；清空全部记忆只能走用户明确触发的管理 API。
- 删除是显式“忘记”语义，必须留下不含正文的审计记录。

### 7.6 工具权限

Main Agent：

- Workspace scope 且自动记忆开启时可见全部 `memory_*` 工具。
- 仍受 ToolPolicy、参数 schema、Workspace 绑定和 Store guard 约束。
- 不要求普通用户审批每次记忆写入，但设置中必须能整体关闭。

Memory Agent：

```ts
const MEMORY_AGENT_TOOL_POLICY: ToolPolicy = {
  allow: [
    'memory_list',
    'memory_read',
    'memory_search',
    'memory_upsert',
    'memory_remove',
  ],
  allowExternalMcp: false,
  allowSkills: false,
};
```

Memory Agent 不得调用：

- `write_file`、`patch_file`、`restore_snapshot`。
- `run_command`。
- 任意外部 MCP。
- Agent/多 Agent 工具。
- 需要用户确认的工具。

---

## 8. System Prompt 契约

自动记忆开启时，Workspace Main Agent system prompt 新增稳定 section：

```text
# Auto Memory

你拥有当前 Workspace 的持久文件记忆。记忆目录已经由运行时准备好，不要检查或创建目录。

应在未来会话仍有价值时记录：
- 用户角色、知识背景与长期偏好；
- 用户对工作方式的纠正与明确认可；
- 无法从代码/Git/项目知识推导的目标、事故、期限、决策原因；
- 外部系统信息的位置与用途。

不得记录：
- 可从代码、Git、README、ADR、CONTEXT.md 或项目知识获取的事实；
- 当前任务计划、临时状态、TODO、工具输出和修复步骤；
- 凭证与敏感数据；
- 未经用户确认的推断。

用户明确要求记住时，立即使用 memory_* 工具保存。
用户明确要求忘记时，先定位相关 topic，再使用 memory_remove 删除。
保存前先查重；优先更新已有 topic，按语义主题组织，不按日期堆文件。
feedback/project 正文应保留 Why 与 How to apply。

MEMORY.md 只是索引；详细内容必须在 topic 文件中。memory_upsert 会原子同步 topic 与索引。

记忆可能过期。行动前核验其中的文件、函数、配置和当前状态；冲突时信任当前证据并修正旧记忆。
用户要求本轮忽略记忆时，不使用、引用或暗示任何已存记忆。
```

要求：

- Prompt 文本由 `packages/managed-memory/prompt.ts` 单点生成。
- Main Agent 与 Extraction/Consolidation prompt 复用同一 taxonomy 和禁止列表，避免规则漂移。
- 空记忆目录仍注入行为规则，但用简短文本表示索引为空。
- 自动记忆关闭时，不注入规则、索引、topic，也不暴露工具。
- Prompt 自身不得泄漏状态目录绝对路径；工具只使用相对路径。

---

## 9. Recall 完整链路

### 9.1 触发时机

在 `runTask()` 的 `preparing_context` 阶段，与 Workspace Summary 构建并行启动：

```ts
const [workspaceContext, managedMemory] = await Promise.all([
  contextManager.buildForPrompt(...),
  managedMemorySystem.prepareRun(...),
]);
```

这保证：

- Recall 不写进 Executor。
- `legacy` 与 `four_layer` 两种上下文策略都得到一致的自动记忆。
- Recall 失败只影响自动记忆 section，不影响 Main Run。
- queued next-run 和 steer refresh 都可以用新 directive 重新 prepare。

### 9.2 扫描

`scanner.ts`：

1. 递归列出 `.md`。
2. 排除 `MEMORY.md`、`.state/**`、隐藏文件和非普通文件。
3. 最多处理 200 个 topic。
4. 每个文件只读取前 30 行解析 frontmatter，并取得 mtime、bytes、digest。
5. 单文件失败用 `Promise.allSettled` 隔离，不因一个坏文件丢掉整个 manifest。
6. 返回结果按 mtime 新到旧排序。

### 9.3 选择器

选择器使用快速、低成本模型，结构化输出：

```json
{
  "useMemory": true,
  "selected": ["feedback_testing.md", "project_release_context.md"]
}
```

输入只包含：

- 当前用户请求。
- topic 的 type、filename、description、mtime。
- 本 Session 当前上下文中已经注入且 digest 未变化的 topic。
- 可选的最近成功工具名，用于抑制无意义的工具说明类记忆。

选择规则：

- 最多 5 个。
- 只有明确有帮助的才选择；不确定就不选。
- 选择结果必须在 manifest 白名单内，模型虚构路径直接过滤。
- 用户明确要求忽略记忆时返回 `useMemory: false`。
- selector 超时、格式错误或 provider 失败时使用 lexical fallback；fallback 仍无结果时只注入入口索引。

### 9.4 读取与注入

每个选中 topic：

- 最多 200 行。
- 最多 4 KiB。
- 最多 5 个，即单 Run topic 注入上限约 20 KiB。
- 超限时保留 frontmatter 和开头内容，并附带“已截断，可用 `memory_read` 读取全文”的提示。
- 注入 header 包含相对路径、保存年龄和 digest 短值。
- 大于 1 天时附带陈旧性提醒。

生成三个独立 section：

```ts
[
  { source: 'systemPrompt', content: memoryPolicy },
  { source: 'managedMemory', content: memoryIndex },
  { source: 'managedMemory', content: relevantTopics },
]
```

### 9.5 去重与证据

`PreparedManagedMemory.refs` 必须进入持久上下文证据：

- 扩展 `ContextManifestV2`，加入 `managedMemoryRefs?: ManagedMemoryContextRef[]`。
- `legacy` manifest 也记录同样 refs，不能因为切换策略丢失审计。
- 同一 Session 已注入同一路径且 digest 未变化时，选择器可降权；digest 变化后允许重新注入。
- 记忆正文不追加到用户可见 conversation messages，避免跨 Run 无限累积；持久化 refs 和 digest 即可。

### 9.6 Steer 与队列

- steer directive 被消费后，`refreshDirective` 必须重新调用 `prepareRun()`，不能沿用旧 query 的 topic 选择。
- next-run 本来就是新 `runTask()`，自然重新 Recall。
- Recall 使用本 Run 的 AbortSignal；用户停止 Run 后，未完成的 selector 立即取消。

---

## 10. Main Agent 直接写入链路

1. system prompt 持续提供保存/删除规则。
2. 主 Agent 判断信息值得跨会话保留，或用户明确要求记住/忘记。
3. 主 Agent 先使用预注入 manifest，必要时调用 `memory_list` / `memory_search` / `memory_read` 查重。
4. 调用 `memory_upsert` 或 `memory_remove`。
5. Store 完成校验、mutation、索引同步和 operation journal。
6. Tool result 返回 topic 路径、digest、索引状态和 `mutationCommitted: true`。
7. Executor 正常提交 assistant tool call 与 tool outcome，形成可审计的 Main Run 证据。
8. Run 结束时 Extraction Coordinator 检查本轮 tool calls；只要出现成功的 `memory_upsert` 或 `memory_remove`，本轮后台 Extraction 跳过并推进 checkpoint。

互斥规则是有意的：同一轮中 Main Agent 已经管理记忆时，不再让第二个 LLM 从同一消息范围重复写入。

---

## 11. 后台 Extraction 完整链路

### 11.1 触发

只在以下条件同时满足时入队：

- Workspace scope。
- 自动记忆和自动提取均开启。
- Main Agent：`origin === "user" && profile === "main"`。
- Run 状态为 `completed`；`aborted`、`failed`、`limited` 默认不提取。
- Run 已有完整 committed assistant response。
- 不是 general conversation。

`onAgentEnd` 只做快照和 `enqueueExtraction()`，必须立即返回。后台提取失败不能把已成功的 Main Run 改成 failed，也不能延迟 `run_finished`。

### 11.2 Agent Runtime 接入

扩展：

```ts
export type AgentProfile =
  | 'main'
  | 'memory'
  | 'internal'
  | 'internal-readonly';
```

Memory Agent 运行参数：

```ts
runtime.runInternalAgent({
  runId: `memory-${crypto.randomUUID()}`,
  parentRunId: mainRunId,
  profile: 'memory',
  messages: forkedConversationSnapshot,
  systemSections: extractionSystemSections,
  toolPolicy: MEMORY_AGENT_TOOL_POLICY,
  toolHost: managedMemoryToolHost,
  contextPolicy: { mode: 'isolated' },
  budget: {
    maxModelTurns: 5,
    maxModelAttempts: 6,
    maxRetriesPerTurn: 1,
  },
});
```

说明：

- 复用现有 Agent Runtime、模型 streaming、tool loop、retry、Abort 和预算。
- `runInternalAgent()` 会在内部固定使用 `persistence: "none"`，调用方不重复传入该字段。
- 不创建第二套 ReAct Loop。
- `persistence: none` 不等于跳过权限；ToolPolicy 与 Store guard 仍必须执行。
- 内部 Agent 的 `agent_end` 不调用 Main Agent 的 post-run hook，防止递归。
- Internal Run 不进入用户 Session transcript，也不占 Main Run model turn counter。

### 11.3 增量游标

Checkpoint 按 Workspace + Session 保存：

```ts
type ExtractionCheckpoint = {
  sessionId: string;
  lastProcessedRunId?: string;
  lastProcessedMessageId?: string;
  updatedAt: string;
};
```

规则：

- 第一次提取分析当前 Session 可见消息。
- 后续只处理 checkpoint 之后的 model-visible user/assistant messages。
- checkpoint 对应消息因 compaction 不可见时，退化为当前可用窗口，不能永久停止提取。
- 只有 Internal Run 成功结束或检测到 Main Agent 已直接写记忆时才推进 checkpoint。
- Internal Run 失败、超时、Abort 或 mutation conflict 未解决时不推进，下次重新考虑。

### 11.4 后台队列与并发

DexCode 是多 Session、长驻 Runtime，不能使用单个全局布尔值。

每个 Workspace 维护：

```ts
type WorkspaceExtractionState = {
  inProgress: boolean;
  pendingBySession: Map<string, EnqueueMemoryExtractionInput>;
  inFlight: Set<Promise<void>>;
};
```

行为：

- 同一 Workspace 同时最多一个 Memory Agent 写记忆。
- 新请求到达时按 Session 保存最新快照；同一 Session 的旧 pending 被覆盖，因为新快照包含更多已提交消息。
- 当前提取结束后继续处理 pending，直到队列为空。
- 不同 Workspace 可以并行，但文件 Store 和模型并发仍受全局上限控制。
- Main Agent 的直接 mutation 与后台 mutation 共享 Workspace mutation lock 和 digest 校验。

### 11.5 预注入 manifest

在启动 Memory Agent 前，先由运行时扫描 topic headers，并把 manifest 放进 extraction prompt。这样 Memory Agent 不需要浪费第一轮调用 `memory_list`。

manifest 为空时明确写“当前没有 topic 文件”。

### 11.6 Extraction prompt 契约

```text
你现在是记忆提取 Agent。只分析上述 checkpoint 之后的最近消息，更新当前 Workspace 的自动记忆。

你只能使用 memory_list、memory_read、memory_search、memory_upsert、memory_remove。
你有严格的轮数预算。现有 manifest 已提供；先判断是否真的需要保存。需要更新时并行读取所有候选 topic，再集中写入。

必须：
- 用户明确要求记住时保存；明确要求忘记时删除；
- 使用 user / feedback / project / reference 四类；
- 优先更新现有 topic，不创建重复文件；
- feedback/project 保留 Why 与 How to apply；
- 相对日期转绝对日期；
- 只使用最近消息中的信息，不调查代码来验证；
- 没有值得长期保留的信息时不调用写工具。

不得保存：可从代码/Git/项目知识推导的内容、当前任务状态、修复步骤、工具输出、敏感数据、未经确认的推断。
```

### 11.7 完成与反馈

- 从 Internal Run 的成功 `memory_upsert` / `memory_remove` tool outcomes 收集实际 mutation，不信任最终自然语言声称。
- 记录 files changed、token usage、turn count、duration、selector/cache 信息。
- 不在 Main Run 已发 terminal 后继续写 SSE。
- 设置页可显示“最近提取时间、最近修改文件、最近错误”。
- 下一轮可通过非阻塞状态提示显示“上一轮保存了 N 条自动记忆”，但不得把后台失败冒充用户任务失败。

---

## 12. Consolidation 完整链路

Extraction 解决“刚刚学到了什么”，Consolidation 解决“长期积累后是否重复、冲突或过时”。两者都必须存在，但调度不同。

### 12.1 Gate

默认阈值：

```ts
{
  minHours: 24,
  minCompletedSessions: 5,
  scanThrottleMinutes: 10,
}
```

触发顺序从便宜到昂贵：

1. 自动记忆与 consolidation 设置开启。
2. 距离上次成功整理达到 `minHours`。
3. 距离上次成功整理后，当前 Workspace 至少有 `minCompletedSessions` 个被更新的 Session。
4. 获取 Workspace consolidation lock。
5. 启动 Internal Memory Agent。

### 12.2 锁与恢复

`.state/consolidation.json`：

```ts
type ConsolidationState = {
  lastCompletedAt?: string;
  lock?: {
    holderId: string;
    pid: number;
    acquiredAt: string;
  };
  lastError?: string;
};
```

- lock 超过 1 小时视为 stale，但回收前检查 PID/holder。
- 成功后更新 `lastCompletedAt`。
- 失败时恢复到 prior timestamp，使以后可以重试；scan throttle 提供退避。
- 进程崩溃后下次启动可回收 stale lock。

### 12.3 Consolidation 输入

运行时先提供：

- 当前 `MEMORY.md`。
- 所有 topic manifest。
- 最近变更的 topic。
- 达到 gate 的 Session ID 列表。
- 有界的 `search_session_history` 内部只读工具，用于对 DexCode Session journal 做窄关键词检索。

禁止 Memory Agent 直接读取整个 Session JSONL，也不允许 shell grep。历史搜索必须由 SessionRepository 提供 Workspace scope 校验、结果条数和片段上限。

### 12.4 Consolidation 任务

1. 阅读入口索引和相关 topic。
2. 合并同一主题的近重复文件。
3. 删除已被新证据否定的内容。
4. 把相对日期改为绝对日期。
5. 更新 description，使未来 Recall 能准确选择。
6. 删除孤立或失效索引，并缩短过长 hook。
7. 保证索引仍满足 200 行 / 25 KiB。
8. 如果没有变化，不写文件。

### 12.5 与 Extraction 的互斥

- Consolidation 与 Extraction 使用同一 Workspace background queue。
- Consolidation 运行时允许新的 Extraction 请求进入 pending，但不能并行写。
- Main Agent 仍可尝试直接写；digest conflict 会要求重新读取，不能覆盖 Consolidation 的更新。

---

## 13. Store 的安全、原子性与并发语义

### 13.1 路径安全

所有工具只接受相对路径。Store 必须：

1. 拒绝绝对路径、盘符、UNC、NUL、`..`、空段和保留设备名。
2. `resolve(memoryRoot, relativePath)` 后再次做 contained 检查。
3. 拒绝 symlink、junction、reparse point；扫描与写入都不能跟随到根目录外。
4. 只允许 `.md` topic；`.state` 只能由 Store 内部访问。
5. Windows 比较使用规范化分隔符和不区分大小写的 comparable path。
6. `workspaceId` 必须来自已解析的 WorkspaceRuntime，不能接受模型或前端自报的任意 ID。

### 13.2 原子写

单文件写入：

```text
serialize canonical bytes
→ write <target>.<operationId>.tmp
→ fsync file（平台支持时）
→ rename replace target
→ fsync parent（平台支持时）
```

topic + index mutation：

```text
workspace mutation lock
→ validate expected digest
→ write recovery intent
→ atomic write topic/remove topic
→ atomic write MEMORY.md
→ append committed operation
→ clear recovery intent
```

启动时发现 recovery intent：

- 根据 intent 的 before/after digest 判断完成还是回滚索引。
- 不能在不确定时静默猜测；标记为 degraded，并禁止后台写，允许只读与用户修复。

### 13.3 乐观并发

- 更新/删除现有 topic 必须携带 `expectedDigest`。
- digest 不匹配返回结构化 `MEMORY_CONFLICT`，包含最新 digest，不返回未请求的完整正文。
- Main Agent 或 Memory Agent 应重新 `memory_read` 后重试。
- `operationId` 在 Workspace 内幂等；重复请求返回原 mutation outcome。

### 13.4 读取失败策略

- `ENOENT`：空记忆或文件已删，正常退化。
- 单 topic frontmatter 损坏：从 Recall manifest 排除，设置页显示诊断；不阻塞其他文件。
- 索引损坏：注入行为规则和空索引警告；topic Recall 仍可从合法 frontmatter 工作。
- 整个目录不可读：自动记忆退化为 disabled-for-run，Main Run 继续；记录告警。
- 写入失败：工具返回错误，不能伪报成功；后台 checkpoint 不推进。

### 13.5 敏感数据

- Prompt 明确禁止凭证。
- `memory_upsert` 在写入前执行基础 secret scanner；高置信 API key、private key、Bearer token、Cookie 等直接拒绝。
- 不做不可解释的广泛内容审查；只阻断高置信凭证模式并返回可操作错误。
- 诊断与 telemetry 不记录正文、用户 prompt 或 secret match 原文。

---

## 14. Context Engine 集成

### 14.1 类型扩展

```ts
export type ContextSectionSource =
  | 'systemPrompt'
  | 'workspaceCode'
  | 'projectMemory'
  | 'managedMemory';

export type ContextBreakdown = {
  systemPrompt: number;
  workspaceCode: number;
  recentConversation: number;
  toolResults: number;
  projectMemory: number;
  managedMemory: number;
  toolDefinitions: number;
  other: number;
};
```

同步更新：

- `packages/context-engine/index.ts` 的 `emptyBreakdown()`、分配与缩放。
- `packages/shared/types.ts`。
- Web 类型与 `apps/web/src/conversation/context-card.tsx` 标签。
- 所有固定 breakdown fixture。

### 14.2 两种 context strategy

`four_layer`：

- `PreparedManagedMemory.sections` 合入 `systemSections`。
- 每次 `ContextEngine.prepare()` 都重新组装 system message，自动记忆不会被 conversation summary 吞掉。
- manifest 持久化 `managedMemoryRefs`。

`legacy`：

- 同样在 Run 开始执行 `prepareRun()`。
- 自动记忆 section 直接进入 legacy system prompt。
- legacy context manifest 也记录 refs 或在 RunReport 中保存等价证据。

验收要求：切换 `CONTEXT_COMPACTION_STRATEGY` 只能改变对话压缩策略，不能关闭或改变自动记忆的存储、提取和 Recall 语义。

### 14.3 预算优先级

Context 超预算时的顺序：

1. 保留 memory policy 的短规则。
2. 保留截断后的 `MEMORY.md`。
3. 相关 topic 已在 Recall 阶段受 20 KiB 上限约束。
4. 如果仍超预算，按相关度从低到高删除 topic section，并记录被删除 ref。
5. 不能让自动记忆挤掉最新用户请求或破坏 tool-call pairing。

---

## 15. Runtime 生命周期与关闭

### 15.1 Hook 组合

`createCodingAgent()` 内组合内建记忆 hook 与调用者 hook：

```ts
const lifecycle = composeLifecycleHooks(
  managedMemoryLifecycle,
  options.lifecycle,
);
```

要求：

- 任一 post-run hook 失败只进入 `runtimeWarnings`。
- Memory hook 只入队，不 await 完整提取。
- Internal Run 不再次触发 Memory hook。
- 不把记忆逻辑硬编码到 Executor 的 tool loop。

### 15.2 Shutdown

Runtime Server 增加统一 shutdown：

1. 停止接受新的后台提取和整理。
2. 让 HTTP server 停止接受新连接。
3. `await managedMemorySystem.drain({ timeoutMs: 60_000 })`。
4. 超时后 Abort 仍在运行的 Internal Memory Agent。
5. 等待 operation journal flush。
6. 正常退出。

测试与 headless/dev smoke 也必须显式 drain，不能依赖 Node 进程碰巧仍然存活。

---

## 16. 配置、API 与 Web 设置页

### 16.1 配置优先级

建议一个统一模式开关，避免条件散落：

```text
DEXCODE_MANAGED_MEMORY_MODE=off|observe|on
```

- `off`：不注入、不 Recall、不暴露工具、不提取、不整理；保留磁盘文件。
- `observe`：扫描、选择、记录诊断，但不向模型注入且不写磁盘；用于灰度比较。
- `on`：完整链路。

优先级：

1. 后端环境变量强制 `off`。
2. Workspace 设置。
3. 默认 `on`。

Workspace 设置：

```ts
type ManagedMemorySettings = {
  enabled: boolean;
  extractionEnabled: boolean;
  recallEnabled: boolean;
  consolidationEnabled: boolean;
  extractionEveryCompletedRuns: number;
  consolidationMinHours: number;
  consolidationMinSessions: number;
};
```

默认建议：

```ts
{
  enabled: true,
  extractionEnabled: true,
  recallEnabled: true,
  consolidationEnabled: false, // 完成灰度后再默认开启
  extractionEveryCompletedRuns: 1,
  consolidationMinHours: 24,
  consolidationMinSessions: 5,
}
```

### 16.2 HTTP API

新增独立路由：

```text
GET    /api/managed-memory
GET    /api/managed-memory/files
GET    /api/managed-memory/files/:path
DELETE /api/managed-memory/files/:path
DELETE /api/managed-memory
GET    /api/managed-memory/status
PUT    /api/managed-memory/settings
POST   /api/managed-memory/consolidate
POST   /api/managed-memory/rebuild-index
```

要求：

- 所有请求必须带并解析 `workspaceRef`，后端转换为稳定 `workspaceId`。
- general scope 返回 `WORKSPACE_REQUIRED`。
- 读取接口不创建 Session，不影响 lazy materialization。
- GET 可以确保 memory 目录存在，但不能创建 conversation。
- `DELETE /api/managed-memory` 是“清空项目记忆”的唯一管理入口，必须由前端用户明确触发并携带二次确认 token；模型工具不能调用。
- 清空操作先阻止新的 Recall/Extraction/Consolidation 调度，Abort 并排空该 Workspace 已排队的后台记忆任务，再取得 mutation lock；随后删除 `MEMORY.md`、全部 topic、checkpoint、consolidation state 和不再有效的审计派生状态，最后创建空索引。
- 清空必须递增 Workspace memory generation。清空前启动、清空后才返回的旧后台任务因 generation 不匹配而禁止提交，避免记忆刚被用户清空又被旧任务写回来。
- 清空保留 `settings.json`，因此不会擅自改变“启用项目记忆”开关；返回删除文件数、释放字节数和新的 generation，不返回被删除正文。
- 手动 consolidate 返回后台 task 状态，不占用当前 Main Run。
- API 返回相对路径；绝对状态目录只在本机诊断字段且默认不下发。

### 16.3 Web UI

能力中心新增一张一级卡片，用户可从能力中心直接进入记忆页面：

```ts
{
  id: 'memory',
  label: '记忆',
  description: '管理由 Agent 为当前项目自动收集、保留和整理的记忆',
  route: '/settings/memory',
  workspaceRequired: true,
}
```

卡片名称必须是“记忆”，不能叫“自动记忆”或“项目知识”。点击后进入独立的“记忆”页面；页面沿用 DexCode 现有设置页的容器、字号、间距、开关和危险按钮样式，不照搬其他产品的布局。

当前页面只呈现“项目记忆”模块。模块至少包含以下两项：

#### 16.3.1 启用项目记忆

- 行标题固定为“启用项目记忆”。
- 说明文案建议为：“允许 Agent 为当前项目自动收集、更新和使用记忆。”
- 右侧使用现有 Switch 组件，状态来自当前 Workspace 的 `ManagedMemorySettings.enabled`。
- 切换开关调用 `PUT /api/managed-memory/settings`，只修改 `enabled`；保存期间显示 pending 状态并防止重复提交，失败则恢复原状态并显示可操作错误。
- 关闭后立即停止新 Run 的 Recall、记忆工具注入、Extraction 和 Consolidation，但保留磁盘上的项目记忆；已经开始的后台任务必须 Abort 或在提交时因 generation/settings 校验而放弃写入。
- 再次开启后从保留的项目记忆继续工作，不自动重建、不清空、不创建 Conversation。

`extractionEnabled`、`recallEnabled`、`consolidationEnabled` 等细粒度字段保留为后端灰度和诊断配置，不在普通页面拆成多个用户开关。对用户而言，“启用项目记忆”必须是一个语义完整的总开关。

#### 16.3.2 清空项目记忆

- 行标题固定为“清空项目记忆”，说明当前操作会清除 Agent 为这个项目保存的全部记忆。
- 右侧使用现有危险操作按钮，按钮文案为“清空”。
- 点击后必须出现二次确认对话框，明确显示当前项目名称，并说明该操作不可撤销、不会删除对话记录、不会修改手动维护的“项目知识”。
- 确认后调用 `DELETE /api/managed-memory`；执行期间禁用开关和清空按钮，成功后显示清空结果并刷新状态，失败时不能在 UI 中伪报已清空。
- 清空只针对当前稳定 `workspaceId`，后端不得接受前端传入任意目录或跨 Workspace 清理。
- 即使“启用项目记忆”处于关闭状态，用户仍可清空已经保留的项目记忆。

#### 16.3.3 页面状态

- 页面顶部标题为“记忆”，副标题说明这里管理当前项目的记忆行为。
- 页面必须显示当前项目名称或 Workspace 标识，避免用户清错项目。
- 初始加载、保存中、清空中、空记忆、加载失败分别有明确状态。
- 页面读取设置和状态不能创建 Session，也不能触发 Recall、Extraction 或 Consolidation。
- 当前版本不把 topic 文件列表、单条删除、“立即整理”“重建索引”和内部运行诊断放进普通用户页面；这些信息保留在日志、telemetry 和开发诊断接口中，避免把 LLM-managed memory 重新做成手动知识编辑器。

不要把项目记忆页面做成第二个大 textarea，也不要允许用户直接编辑 `MEMORY.md` 或 topic 文件；用户控制面只有启用/关闭和整体清空，记忆正文仍由 LLM 管理。

---

## 17. 可观测性

建议结构化指标：

### Recall

- `managed_memory.recall.started`
- `managed_memory.recall.completed`
- `managed_memory.recall.failed`
- `candidate_count`
- `selected_count`
- `injected_bytes`
- `selector`
- `duration_ms`
- `index_truncated`
- `topic_truncated_count`

### Mutation

- `managed_memory.mutation.committed`
- `managed_memory.mutation.conflict`
- `managed_memory.mutation.rejected`
- `action`
- `actor`
- `duration_ms`

### Extraction

- `managed_memory.extraction.enqueued`
- `managed_memory.extraction.started`
- `managed_memory.extraction.skipped_direct_write`
- `managed_memory.extraction.coalesced`
- `managed_memory.extraction.completed`
- `managed_memory.extraction.failed`
- `new_message_count`
- `turn_count`
- `memories_saved`
- `duration_ms`
- token usage

### Consolidation

- gate skip reason
- sessions considered
- topics before/after
- files updated/removed
- lock acquired/reclaimed/blocked
- duration 与 token usage

日志不得包含：

- topic 正文。
- 用户原始 prompt。
- secret scanner 命中的原文。
- 状态目录之外的任意绝对用户路径。

---

## 18. 代码改动清单

| 文件/目录 | 改动 |
| --- | --- |
| `packages/managed-memory/**` | 新增深模块、Store、格式、Recall、Extraction、Consolidation、工具和测试。 |
| `packages/agent-core/agent-runtime.ts` | 增加 `memory` profile；允许专用内部 runner/tool host；保持 internal hook 不递归。 |
| `packages/agent-core/index.ts` | 并行准备自动记忆；合并 sections/refs；组合 lifecycle；steer 时重新 Recall。 |
| `packages/agent-core/executor.ts` | 接入 memory tool definitions 与执行 adapter；不实现 Recall/Extraction 逻辑。 |
| `packages/agent-core/tool-definitions.ts` | 新增 `MEMORY_TOOL_DEFINITIONS`。 |
| `packages/agent-core/session-contracts.ts` | 增加持久化 managed-memory refs / history search 所需的窄接口。 |
| `packages/context-engine/index.ts` | 支持 `managedMemory` breakdown 与 refs。 |
| `packages/shared/types.ts` | 新增 managed-memory refs、context breakdown 字段、必要 ledger/report 类型。 |
| `packages/session-store/index.ts` | 持久化 refs；提供 Workspace-scoped bounded transcript search；不承载 topic 文件实现。 |
| `packages/session-store/journal-*` | 若 refs 使用新 ledger record，补 codec/reducer/schema/recovery。 |
| `apps/runtime/server.ts` | 为每个 Workspace 创建 ManagedMemorySystem；新增 API；接 shutdown drain。 |
| `packages/capability-registry/index.ts` | 在能力中心增加“记忆”卡片，路由到独立记忆页面。 |
| `apps/web/src/settings/memory-panel.tsx` | 新增“记忆”页面及“启用项目记忆”“清空项目记忆”控制。 |
| `apps/web/src/settings/types.ts` | 新增 API 类型。 |
| `apps/web/src/conversation/context-card.tsx` | 显示“自动记忆” token breakdown。 |
| `apps/web/src/api.ts` | 如有需要，补 DELETE/路径编码辅助。 |
| `package.json` | 将 `packages/managed-memory/*.test.ts` 加入默认 `npm test`。 |

禁止把 Store 实现塞进 `session-store/index.ts`。Session Store 只保存对话证据与提供有界历史读取；自动记忆文件生命周期归 `managed-memory` 模块所有。

---

## 19. 分阶段开发计划

每个阶段都必须形成可验证的纵向能力，不能先铺大量类型和 TODO 再在最后接链路。

### Phase 0：契约冻结与测试夹具

任务：

1. 定义本文术语、四类 taxonomy、文件 schema 和限制常量。
2. 定义 `ManagedMemorySystem` 外部接口与内部 Store/Selector/Runner seam。
3. 增加 scripted model、fixed clock、临时文件系统 fixture。
4. 准备两段真实感对话 fixture：
   - 值得记忆：用户纠正测试策略并给出原因。
   - 不应记忆：本轮修复了某文件中的 bug。
5. 更新默认 test script，确保新包测试不会被漏跑。

完成门槛：

- TypeScript 类型通过。
- 新包至少有一个 contract test 被 `npm test` 实际发现。
- 没有生产 TODO adapter。

### Phase 1：Store、格式与安全

任务：

1. 实现 Workspace path resolver。
2. 实现 frontmatter parse/serialize 与 schema diagnostics。
3. 实现 `MEMORY.md` truncate-for-read 和 validate-for-write。
4. 实现 scan/manifest，限制 200 文件与 30 行 header。
5. 实现 `memory_list/read/search/upsert/remove` Store 方法。
6. 实现 Workspace mutation lock、expectedDigest、operationId 幂等。
7. 实现 topic + index recovery intent、atomic write 和启动恢复。
8. 实现 symlink/junction/path traversal/Windows case guard。
9. 实现 secret scanner。

完成门槛：

- 两个并发 upsert 不丢更新；冲突稳定返回 `MEMORY_CONFLICT`。
- 模拟在 topic 写完、index 写前崩溃，重启后可确定恢复。
- 任何相对路径逃逸、UNC、盘符、symlink/junction 测试均被拒绝。
- Store 测试全部使用真实临时目录。

### Phase 2：主 Agent prompt 与专用工具

任务：

1. 实现统一 memory policy prompt builder。
2. 增加 `MEMORY_TOOL_DEFINITIONS`。
3. 扩展 ToolHost/Executor 执行专用 memory tools。
4. 仅在 Workspace + enabled 时暴露工具。
5. Tool presentation 使用独立 `category: "memory"`，不把状态目录显示成普通源码修改。
6. Main Run tool call/outcome 中记录 actor、workspaceId binding、operationId。

完成门槛：

- 端到端 scripted Main Agent 可以创建 topic + 索引，下一次读取可见。
- general conversation 看不到工具并且无法调用。
- 关闭开关后 prompt、工具和写入全部消失，但文件保留。

### Phase 3：Recall 与 Context 集成

任务：

1. 实现 selector structured output 与白名单过滤。
2. 实现 lexical fallback、Abort、超时和失败降级。
3. 实现 topic 4 KiB/200 行/最多 5 个限制与陈旧性 header。
4. `runTask()` 并行准备 Workspace Context 与 Managed Memory。
5. 新增 `managedMemory` Context source、breakdown 和 UI label。
6. 持久化 `ManagedMemoryContextRef[]`。
7. steer refresh 重新 Recall。
8. 同时验证 `four_layer` 与 `legacy`。

完成门槛：

- 第二个 Session 的相关请求能召回第一个 Session 创建的 topic。
- 不相关 topic 不注入。
- selector 虚构文件名、超时、返回坏 JSON 时 Main Run 仍成功。
- Context manifest 可证明实际注入了哪些 path/digest。
- compaction 后自动记忆 system sections 仍在下一次模型请求中。

### Phase 4：后台 Extraction

任务：

1. 增加 `memory` AgentProfile。
2. 用现有 `runInternalAgent()` 构建 InternalMemoryRunner adapter。
3. 实现 extraction prompt 和 manifest 预注入。
4. 在 Main Agent `onAgentEnd` 接 `enqueueExtraction()`。
5. 实现 direct-write 检测与 skip。
6. 实现每 Session checkpoint。
7. 限制工具、禁止 MCP/Skill/command/workspace write。
8. 从真实 tool outcomes 统计 mutation，不信任自然语言。

完成门槛：

- Main Run terminal 不等待 Memory Agent。
- Main Agent 未写时，Memory Agent 可在后台保存长期信息。
- Main Agent 已直接写时，后台不重复写。
- Internal Run 不出现在用户会话、不递归、不消耗 Main Run 预算。
- Extraction 失败不改变 Main Run terminal。

### Phase 5：多 Session 并发、恢复与 drain

任务：

1. 实现 per-Workspace background queue 与 per-Session latest snapshot coalescing。
2. 实现全局 Memory Agent 并发上限。
3. 持久化 checkpoint 和 operation idempotency。
4. 增加 Runtime Server shutdown coordinator。
5. 测试重启、进程退出、Abort、60 秒软超时。
6. 补后台状态 inspect API。

完成门槛：

- 同一 Workspace 两个 Session 同时结束不会并发覆盖记忆。
- 提取期间再完成一轮，会在当前完成后处理最新 pending。
- 进程退出前能排空；超时能取消且下次重试。
- checkpoint 只在成功或 direct-write skip 后推进。

### Phase 6：Consolidation

任务：

1. 实现时间、会话数量和 scan throttle gate。
2. 实现 consolidation lock、stale reclaim、失败回滚。
3. 为 SessionRepository 增加 Workspace-scoped bounded history search。
4. 实现 consolidation prompt 与内部 Memory Agent 运行。
5. 接入后台队列互斥。
6. 增加手动 consolidate API 与状态。

完成门槛：

- 5 个会话后可合并重复 topic、删除旧索引并保持限制。
- 未达到 gate 时不调用模型。
- 两个并发触发只运行一个 consolidator。
- 失败后不会错误推进 `lastCompletedAt`。

### Phase 7：设置页与用户控制

任务：

1. 在能力中心新增“记忆”卡片，并接入 `/settings/memory` 独立页面。
2. 新增 `memory-panel.tsx`，实现“启用项目记忆”总开关。
3. 实现 `DELETE /api/managed-memory`、二次确认和“清空项目记忆”危险操作。
4. 清空链路补齐后台任务 Abort、mutation lock、generation fence、空索引恢复和结果刷新。
5. 明确区分项目记忆与现有项目知识；页面不提供正文编辑能力。
6. 补 API、React 组件和交互测试。

完成门槛：

- 用户能从能力中心的“记忆”卡片进入页面。
- 用户可以关闭项目记忆且已有文件不被删除，再次开启后可以继续使用。
- 用户可以通过二次确认清空当前项目的全部记忆；旧后台任务不会在清空后重新写回。
- GET 设置页不会创建 Session。
- 页面不复用项目知识 textarea，不暴露内部 topic 编辑器，并保持 DexCode 现有视觉结构。

### Phase 8：灰度、回滚与完整验收

任务：

1. 实现 `off|observe|on` 单一策略 seam。
2. `observe` 与 `on` 用相同历史快照做对比，不能让一个 Session 的记忆写入污染另一组。
3. 记录 Recall 命中、错误、延迟、写入数、重复率和 token 成本。
4. 先启用 Recall + direct write，再启用 Extraction，最后灰度 Consolidation 默认开关。
5. 完成迁移/回滚演练。

完成门槛：

- 切到 `off` 并重启后，系统完全回到无自动记忆行为，已有文件仍可恢复。
- `project-memory.md` 行为与 API 无回归。
- 所有核心链路测试、lint、Web 测试和 dev smoke 通过。

---

## 20. 测试计划

### 20.1 Store 单元/集成测试

- 空目录初始化不创建 Session。
- frontmatter 四类合法值与未知值诊断。
- `MEMORY.md` 200 行和 25 KiB 双重限制。
- 多字节 UTF-8 截断不产生坏字符。
- scan 排除索引、`.state`、隐藏文件、symlink。
- scan 单文件失败不影响其余文件。
- 200 文件上限与 mtime 排序。
- upsert 新建、更新、重复 operationId。
- expectedDigest conflict。
- remove 同步清理索引。
- topic 成功/index 失败的 recovery。
- index 成功/journal 失败的恢复判定。
- Workspace A/B 完全隔离。
- Windows 大小写、分隔符、盘符、UNC、junction。
- secret scanner 拒绝高置信凭证。

### 20.2 Recall 测试

- 0 candidate 不调用 selector。
- 选择最多 5 个。
- 虚构 filename 被过滤。
- already surfaced + same digest 去重。
- changed digest 可重新召回。
- topic 200 行 / 4 KiB 截断。
- 总 topic 注入不超过 20 KiB。
- 旧记忆带年龄警告，新记忆不带噪声警告。
- selector Abort、timeout、坏 JSON、provider failure。
- lexical fallback 可用且不会越权选文件。
- “忽略记忆”不注入正文。

### 20.3 Main Agent 工具测试

- 工具只在 Workspace scope 可见。
- tool schema 拒绝额外字段。
- Main Agent 可立即记住/忘记。
- 工具结果形成 paired tool message。
- memory mutation 不计入源码 `filesModified`，但进入独立 memory mutation evidence。
- 关闭后直接调用返回 disabled/unknown，而不是继续写。

### 20.4 Extraction 测试

- 只对 Main + completed + Workspace 触发。
- aborted/failed/limited/general/internal 不触发。
- onAgentEnd 入队不延迟 terminal。
- Main direct write 后 skip。
- 只处理 checkpoint 之后消息。
- checkpoint 缺失消息时安全 fallback。
- 成功推进 checkpoint；失败不推进。
- 5 turn hard cap。
- 外部 MCP、Skill、command、workspace write 全部不可用。
- 内部 Agent 不写 Session transcript。
- hook 异常只产生 warning。

### 20.5 并发与生命周期测试

- 同一 Workspace 两 Session 同时 enqueue。
- 同一 Session 多次 enqueue 只保留最新 pending。
- 不同 Workspace 可受控并行。
- Main write 与后台 write 冲突时不丢数据。
- shutdown drain 成功。
- drain timeout Abort，重启后重试。
- stale consolidation lock 回收。
- 活跃 consolidation lock 不被抢占。

### 20.6 Context 集成测试

- 项目知识与自动记忆同时存在，两个 breakdown 独立。
- `four_layer` 每次 model call 都包含 memory policy/index/selected topics。
- `legacy` 同样召回。
- compaction 不摘要 system memory sections。
- overflow recovery 不丢 active request 和 memory refs。
- steer 后 selected topics 随新 directive 改变。
- ContextManifest/RunReport refs 与实际请求一致。

### 20.7 端到端场景

#### 场景 A：纠正被自动记住

1. Session A：用户说“不要 mock 数据库，因为上次迁移事故……”。
2. Main Agent 未直接写。
3. terminal 立即返回。
4. 后台 Extraction 创建 `feedback_testing.md` 和索引。
5. Session B：用户要求新增迁移测试。
6. Recall 选中该 topic。
7. Agent 采用真实数据库，并在行动前核验当前测试设施。

#### 场景 B：代码事实不进入记忆

1. 用户让 Agent 修复 `executor.ts` 中的某个 bug。
2. Extraction 看到文件、函数、修复步骤。
3. 没有用户偏好或不可推导背景。
4. Memory Agent 不写任何 topic。

#### 场景 C：直接忘记

1. 用户说“忘掉我之前关于单 PR 的偏好”。
2. Main Agent 搜索并读取相关 topic。
3. 调用 `memory_remove`。
4. topic 与索引指针同时删除。
5. 后台 Extraction 检测 direct mutation 并 skip。

#### 场景 D：冲突与恢复

1. 两个 Session 从同一 digest 读取同一 topic。
2. Session A 先更新。
3. Session B 写入得到 `MEMORY_CONFLICT`。
4. B 重新读取并合并，不覆盖 A。
5. operation journal 可证明两个结果。

---

## 21. 验收标准

只有同时满足以下条件，才能宣称“完整项目级自动记忆链路已完成”：

1. 每个 Workspace 使用稳定 `workspaceId` 隔离自动记忆；general scope 无法访问。
2. 现有项目知识的文件、API、UI 和语义保持不变。
3. Main Agent 可直接使用专用工具创建、更新、搜索、读取和删除 topic。
4. `MEMORY.md` 只作为受限索引，topic 使用严格 frontmatter。
5. 每个新 Run 能按 query 选择并注入最多 5 个相关 topic。
6. Recall 有读取/会话预算、陈旧性提醒、去重、Abort 和失败降级。
7. Main Run 完成后后台 Extraction 非阻塞运行；直接写入时不会重复提取。
8. Memory Agent 复用 AgentRuntime，使用 `profile: memory`、`origin: internal`、`persistence: none`、最多 5 轮和严格工具策略。
9. 多 Session 同 Workspace 的后台任务串行且可合并，不会覆盖彼此更新。
10. checkpoint、operationId、expectedDigest、atomic write 和 recovery 能处理重试与崩溃。
11. 进程退出前 drain；超时 Abort 后下次可重试。
12. 达到阈值后 Consolidation 能合并、纠错、删除和重建索引，并有互斥锁。
13. `four_layer` 与 `legacy` 都保持相同记忆语义。
14. Context evidence 能指出本 Run 实际使用的 topic path、digest、mtime 和截断状态。
15. 能力中心存在“记忆”卡片并可进入独立页面；页面明确提供“启用项目记忆”总开关和“清空项目记忆”危险操作。
16. 关闭项目记忆会停止 Recall、工具注入和后台写入但保留文件；清空仅作用于当前 Workspace，经过二次确认且不会被旧后台任务写回。
17. 日志与 telemetry 不泄漏记忆正文或敏感数据。
18. 以下命令全部通过：

```powershell
npm run lint
npm test
npm run test:web
npm run test:dev
git diff --check
```

---

## 22. 回滚策略

### 22.1 运行时回滚

设置：

```powershell
$env:DEXCODE_MANAGED_MEMORY_MODE='off'
npm run dev
```

重启后：

- 不加载记忆 prompt。
- 不暴露 `memory_*` 工具。
- 不运行 Recall、Extraction、Consolidation。
- 不删除 `managed-memory` 目录。
- 项目知识与普通 Agent Runtime 继续工作。

### 22.2 数据回滚

- 自动记忆文件是普通 Markdown，可直接备份。
- Store schema 升级必须带 `version` 和向后只读能力。
- 任何不可逆迁移先复制到 `.state/backups/<timestamp>/`，并记录 migration operation。
- 不用 Git 管理运行时记忆，也不把删除寄希望于 Git 恢复。

### 22.3 代码回滚

自动记忆通过一个 `ManagedMemorySystem` seam 接入。删除该 adapter 或切换为 disabled adapter 后，复杂度不应重新散落到 Executor、Session Store 或前端。

---

## 23. 明确不做的事情

本期不实现：

- 跨 Workspace 的全局用户画像。
- 团队共享或云同步记忆。
- embedding/vector database。
- 把所有 Session 全文长期复制进记忆目录。
- 自动向项目知识写入内容。
- 用记忆替代 ADR、CONTEXT.md、README、Issue tracker 或 Git。
- 允许 Memory Agent 任意执行命令或调用外部 MCP。
- 为了演示而使用硬编码记忆、假 selector 或内存-only 持久化。

这些能力未来可以建立在当前深模块接口上，但不能改变本期的 Workspace 隔离、文件可读性、安全写入和可审计语义。

---

## 24. 开发执行顺序摘要

```text
Store/格式/安全
  → 主 Agent prompt + memory tools
  → Recall + Context evidence
  → onAgentEnd 后台 Extraction
  → 多 Session 队列 + checkpoint + drain
  → Consolidation
  → 设置页与诊断
  → observe/on 灰度与完整验收
```

不要颠倒为“先做 UI、先做向量检索、最后补持久化与生命周期”。最短可用纵向路径是：**真实文件 Store → 主 Agent 可直接记忆 → 下一 Session 可召回 → 后台补提取**。随后再补并发恢复、长期整理和用户控制，直到满足第 21 节全部验收标准。
