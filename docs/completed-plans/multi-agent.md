# DexCode Multi-Agent V1 开发计划

> 文档状态：已实施  
> 实施结果：`packages/agent-manager`、Child journal、Agent Inbox、四个 orchestration tools、Agent activity stream、Web Agent Drawer、预算和停止语义均已落地。实际实现默认开启 Multi-Agent，并在后续事故修复中加入后台通知、无进展熔断和会话级停止。正文中的“当前基线”指计划编写时；现状以 [`../architecture.md`](../architecture.md) 为准。

## 结论

DexCode 已具备实现 Multi-Agent V1 的主要基础，不需要新增 Agent Loop、Executor、ModelClient 或 ToolHost 体系。

推荐演进路线：

```text
现有 AgentRuntime
        │
        ├── Main Run（继续使用 Session persistence）
        ├── Child Run（新增 child persistence）
        └── Internal Run（保持 persistence:none）
                 ▲
                 │
            AgentManager
     lifecycle / identity / concurrency
     persistence / cancellation / result
```

真正需要新增的是一个“深模块”式 `AgentManager`：对外只暴露生命周期原语，对内隐藏并发、持久化、恢复和状态转换。Executor 只依赖一个 orchestration port，不反向依赖具体 Manager。

本计划起草阶段只进行了只读审计；后续已经按计划完成实现和验证。

---

## 一、当前基线分析

### 可以直接复用

1. **AgentRuntime 已经是统一执行入口**

   `packages/agent-core/agent-runtime.ts` 已定义：

   - `AgentRunIdentity`
   - `parentRunId`
   - profile / origin
   - Run budget
   - AbortSignal
   - ToolPolicy
   - isolated / managed context
   - lifecycle events
   - `runAgent()`
   - `runInternalAgent()`
   - `persistence: 'child'`

   其中 `child` 在计划基线中是显式拒绝的预留策略，对应入口可以作为 Multi-Agent 持久化扩展点。

2. **Executor 已覆盖完整 ReAct 语义**

   `packages/agent-core/executor.ts` 已负责：

   - 模型与工具迭代
   - tool call/result 配对
   - commit-before-effect
   - ToolPolicy 双重校验
   - MCP、Skill、Memory、Context Tool
   - Abort、重试、turn/attempt budget
   - 文件变更和 usage 统计

   Child Run 必须继续经过该 Executor。

3. **现有内部 Agent 已证明可以复用同一 Runtime**

   `packages/agent-core/index.ts` 已让 Managed Memory 通过同一个 Runtime 启动内部 Agent。这证明 in-process 多 Run 本身可行。

4. **Context Engine 已有安全的消息分段和工具批次处理**

   `packages/context-engine/index.ts` 已具备：

   - conversation segment
   - closed tool batch
   - context compaction
   - artifact externalization
   - summary cache
   - immutable model-input projection

   fork 应扩展这里，而不是在 AgentManager 中对 messages 做简单 `slice()`。

5. **Tool Gateway 已有 fail-closed 权限体系**

   `packages/tool-gateway/index.ts` 可继续处理 Child 的文件、命令和 MCP 调用。P0 只需要给 Child 注入非交互审批策略。

6. **JSONL、reducer、recovery、replay 模式可以复用**

   Session Store 和 Run Protocol 已具备追加日志、恢复、幂等及 bounded replay 的实现经验，可用于 Child journal 和 activity stream。

### 现有架构冲突

1. **Session 只允许一个 active Run**

   `packages/session-store/index.ts` 和 `packages/session-store/journal-reducer.ts` 都严格维护单一 `activeTaskId`。

   因此并发 Child Run 绝不能作为普通 `run_started` 写入主 Session ledger，否则会破坏：

   - 主对话恢复
   - Queue
   - Run terminal
   - Conversation projection
   - Session 删除约束

2. **当前 Run Protocol 是单 Run 状态机**

   `packages/run-protocol/contracts.ts` 的 envelope 由一个 `runId` 和连续 `seq` 驱动；Web 也只维护一个 active Run。

   并行 Child 不能伪装成 Main Run 的 tool/message event。

3. **Context Engine 的持久化作用域绑定 Session active Run**

   Child 需要独立 context manifest、summary 和 artifact 生命周期，不能直接复用主 Run 的 activeTaskId 校验。

4. **`createCodingAgent()` 隐藏了 Child 所需的装配逻辑**

   计划基线中的 system sections、Managed Memory、ToolHost、Context Engine 都在主任务路径中组装，不能直接被 AgentManager 复用。

   应抽出 Child Run factory，而不是让 AgentManager复制这段逻辑。

5. **Managed Memory recall 以 sessionId 为主要上下文范围**

   `packages/managed-memory/contracts.ts` 需要增加独立 `contextOwnerId`，否则 Main 和多个 Child 之间可能互相影响 recall 去重。

6. **SkillRegistry 可能包含可变激活状态**

   Child 不应通过共享 SkillRegistry 改变 Main 的激活状态。P0 默认禁用 Child Skill 激活；P1 提供 agent-scoped registry view。

---

## 二、目标模块结构

### 新增模块

建议新增 `packages/agent-manager`：

```text
packages/agent-manager/
├─ contracts.ts
├─ agent-manager.ts
├─ agent-store.ts
├─ agent-journal-types.ts
├─ agent-journal-reducer.ts
├─ agent-definitions.ts
├─ agent-projection.ts
├─ errors.ts
└─ *.test.ts
```

职责边界：

- `AgentManager`
  - identity
  - lifecycle
  - concurrency admission
  - parent/child relationship
  - cancellation
  - wait/followup
  - runtime handle

- `AgentStore`
  - Session-scoped Agent journal
  - conversation and Run persistence
  - restart recovery
  - idempotency
  - tree projection

- `AgentDefinitionRegistry`
  - definition validation
  - immutable policy snapshot
  - built-in and后续文件定义加载

### 修改模块

- `packages/agent-core`
  - 扩展 Agent identity/profile/origin
  - 支持 `persistence:'child'`
  - 增加 orchestration port 和四个工具
  - 抽取 Child Run factory

- `packages/context-engine`
  - 增加 context owner
  - 增加 fork projector
  - 支持 Agent context artifacts

- `packages/session-store`
  - 在 Session 目录下管理独立 Agent journal
  - Session 删除前增加 Child lifecycle gate
  - 不改变主 ledger 单 active Run 不变量

- `packages/managed-memory`
  - 增加 `child-agent` actor
  - recall 使用独立 context owner
  - 保持 Child 自动 extraction 关闭

- `packages/run-protocol`
  - 增加 Session-scoped Agent Activity Protocol

- `packages/conversation-view`
  - 增加 Agent tree snapshot
  - 增加 Transcript 内联 Agent activity projection
  - 将底层 orchestration tool event 聚合为 Agent lifecycle view

- `apps/runtime`
  - WorkspaceRuntime 装配 AgentManager
  - Agent activity stream、详情查询和停止接口
  - shutdown/session deletion 收口

- `apps/web`
  - 保持现有 Transcript-first 主布局，不增加永久 Agent sidebar
  - 顶栏增加按需出现的 Agent 状态入口和 overlay Drawer
  - Transcript 内联 Agent / Agent Group Activity Card
  - 独立 Agent tree/activity reducer，不把 Child 塞入现有 `activeRun`
  - Agent transcript 只读 Drawer，复用现有 Transcript 组件

---

## 三、关键数据结构

```ts
type AgentId = string;
type AgentRunId = string;

type AgentStatus =
  | 'creating'
  | 'running'
  | 'stopping'
  | 'idle';

type AgentRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'limited';

interface AgentRecord {
  agentId: AgentId;
  sessionId: string;
  rootAgentId: AgentId;
  parentAgentId: AgentId | null;
  createdByRunId: string;

  name: string;
  task: string;
  contextMode: 'fresh' | 'fork';

  definitionName: string;
  definitionDigest: string;
  definitionSnapshot: AgentDefinition;

  status: AgentStatus;
  currentRunId?: AgentRunId;
  lastRunId?: AgentRunId;

  createdAt: string;
  updatedAt: string;
}

interface AgentRunRecord {
  agentRunId: AgentRunId;
  agentId: AgentId;
  invokedByRunId: string;
  trigger: 'spawn' | 'followup';

  status: AgentRunStatus;
  input: string;
  startedAt: string;
  completedAt?: string;

  usage?: AgentUsage;
  result?: AgentRunResult;
}
```

仅存在于内存中的部分：

```ts
interface AgentHandle {
  record: AgentRecord;
  currentPromise?: Promise<AgentRunResult>;
  abortController?: AbortController;
}
```

`Promise` 和 `AbortController` 不持久化。

### Agent identity 与 Agent Run

必须保持以下关系：

```text
Session
└─ rootAgentId
   └─ child agentId（稳定）
      ├─ agentRunId-1：spawn 首次执行
      ├─ agentRunId-2：第一次 followup
      └─ agentRunId-3：中断后的继续
```

约束：

- `agentId` 表示持续存在的身份和 conversation。
- `agentRunId` 表示一次具体执行，每次 followup 都新建。
- AgentRuntime 的 `runId` 直接使用 `agentRunId`。
- `parentAgentId` 表示树关系。
- `invokedByRunId` 表示哪个 Main Run 发起本次执行。
- `parentRunId` 不能代替 `parentAgentId`。
- 内部 Memory Run 不进入用户可见 Agent Tree。

---

## 四、AgentDefinition

```ts
interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;

  toolPolicy: ToolPolicy;
  defaultContextMode: 'fresh' | 'fork';
  allowedContextModes: Array<'fresh' | 'fork'>;

  budget: {
    maxModelTurns: number;
    maxModelAttempts?: number;
    maxRetriesPerTurn?: number;
    maxOutputTokens?: number;
    maxResultBytes?: number;
  };

  model?: string;

  memoryPolicy: {
    read: boolean;
    write: boolean;
    automaticExtraction: false;
  };

  isolationPolicy: {
    default: 'shared' | 'worktree';
    allowed: Array<'shared' | 'worktree'>;
  };
}
```

P0：

- 提供内置只读 `researcher`、`reviewer`。
- 通用 writer 不默认注册。
- spawn 时保存完整 definition snapshot 和 digest。
- 后续文件配置发生变化，不自动扩大既有 Agent 权限。
- followup 继续使用创建时的 policy snapshot。

P1：

- 加载 Markdown + 严格 YAML frontmatter。
- 无效定义返回可见 diagnostics，不能静默忽略。
- workspace 定义可覆盖同名用户定义。
- 对名称、路径、未知字段、预算和 ToolPolicy 做严格校验。

---

## 五、Tool schema 与语义

| Tool | 核心参数 | 返回 |
|---|---|---|
| `spawn_agent` | `task`, `agent`, `context_mode?`, `name?`, `isolation?` | `agent_id`, `agent_run_id`, `status` |
| `wait_agent` | `agent_ids[]`, `mode:any/all`, `timeout_ms?` | 已完成结果、仍运行列表、是否 timeout |
| `followup_agent` | `agent_id`, `task` | 新 `agent_run_id` 和 running 状态 |
| `stop_agent` | `agent_id`, `reason?` | stopped、already_idle 或 not_found |

### `spawn_agent`

- 默认异步。
- definition、权限、容量校验通过后，先持久化 `agent_created` 和 `agent_run_started`，再启动 Runtime。
- operationId 使用 `callerRunId + toolCallId`，避免恢复或重试产生重复 Child。
- fork 来源必须在调用时生成 immutable snapshot。
- 返回后 Main 可以继续推理。

### `wait_agent`

P0 同时支持单个和多个 Agent：

```ts
{
  agent_ids: string[];
  mode?: 'any' | 'all';   // default: all
  timeout_ms?: number;    // 0..60000
}
```

语义：

- 已完成立即返回。
- timeout 是正常结果，不是工具异常。
- Main Run 被中止时只取消本次 wait，不停止 Child。
- wait 在调用时锁定每个 Agent 当前的 `agentRunId`，不等待未来 followup。
- 返回结果必须限制体积；完整记录由 Agent Store 和详情 API 保存。

### `followup_agent`

- 仅允许访问同一 Session tree 中的 Agent。
- Agent 正在运行时返回 `agent_busy`。
- 对 idle、failed、interrupted、completed 的最后 Run 均允许 followup。
- 先原子追加 user message，再创建新 Agent Run。
- 使用原 definition snapshot、context seed 和 conversation history。

### `stop_agent`

- 只中止目标 Agent 当前 Run。
- `running → stopping → idle`。
- 当前 Run 终态为 `interrupted`。
- 不删除 Agent、conversation 或结果。
- 重复 stop 返回 `already_idle`。
- 中止后允许 followup。

---

## 六、AgentManager 生命周期

### Spawn

```text
validate caller/session/depth
→ resolve immutable AgentDefinition
→ check agent/concurrency/write capacity
→ persist Agent identity
→ persist first Agent Run
→ create AbortController
→ call existing AgentRuntime.runAgent()
→ commit messages/tools/result
→ Agent becomes idle
```

### Followup

```text
lock agent
→ ensure no active Run
→ append followup user message
→ create new AgentRunId
→ start same Runtime with retained context
→ commit terminal
```

### Stop

```text
abort current Run
→ preserve committed transcript
→ terminal = interrupted
→ clear runtime-only handle
→ identity remains idle/resumable
```

### Restart recovery

```text
load agents.jsonl
→ find Run without terminal
→ append recovery terminal(interrupted)
→ clear currentRunId
→ Agent becomes idle
```

不自动重跑，不伪造失败答案。

---

## 七、Persistence 设计

建议在现有 Session 目录下增加：

```text
sessions/<sessionId>/
├─ journal.jsonl
├─ meta.json
├─ agents.jsonl
└─ agent-context/
   └─ <agentId>/
```

`agents.jsonl` 使用独立 header、commit、revision 和 reducer，核心记录：

```text
agent_tree_initialized
agent_created
agent_run_started
agent_message_committed
agent_tool_started
agent_tool_finished
agent_context_committed
agent_stop_requested
agent_run_terminal
agent_recovered
```

关键原则：

- 不将 Child messages 写入 `Session.messages`。
- 不修改 Session 主 ledger 的单 active Run 约束。
- Agent journal 只在第一次 spawn 时物化。
- 读取没有 Agent 的旧 Session 不创建文件。
- Session 删除会自然删除其 Agent journal，但删除前必须先停止全部 active Child。
- journal append 使用单 Session 锁和 operationId 幂等。
- 崩溃发生在 `agent_created` 后、主 Tool result 前时，不重复 spawn；恢复后仍可根据 operationId 找到原 Agent。

---

## 八、并发、权限与错误语义

P0 默认限制：

```text
maxConcurrentAgents = 4
maxAgentsPerSession = 8
maxDepth = 1
maxConcurrentSharedWriters = 1
```

实现原则：

- 达到容量后返回 `capacity_exceeded`，P0 不增加后台调度队列。
- Child 不暴露 orchestration tools，因此无法递归 spawn。
- 数据模型仍保存 `rootAgentId`、`parentAgentId`，未来无需重做 identity。
- 多个只读 Child 可以并行。
- 共享 workspace 同时只允许一个具备写文件或执行命令能力的 Child。
- AgentManager 的并发限制与 Managed Memory 内部并发暂时独立；记录为资源风险，不在 P0 引入全局 scheduler。

非交互权限结果统一为：

```ts
{
  status: 'blocked';
  code: 'approval_required' | 'blocked_by_policy';
  tool: string;
  reason: string;
}
```

- ToolPolicy 明确拒绝：`blocked_by_policy`
- Tool Gateway 判断需要用户批准：`approval_required`
- 不创建 approval UI，不悬挂 Promise。
- Child 的阻断结果作为普通 tool result 返回，让模型可以调整方案。
- 硬安全检查仍由 Tool Gateway 执行，AgentDefinition 不能绕过。

---

## 九、Context fresh / fork

### Fresh

初始输入仅包含：

```text
DexCode core system
+ AgentDefinition system prompt
+ 当前 workspace 摘要
+ 允许读取的 Project/Managed Memory
+ definition 允许的 Skill 信息
+ task
```

不继承 Main conversation。

### Fork

```text
fresh 基础
+ Main 当前模型请求的 immutable context snapshot
  中最近若干完整 conversation segments
+ child task
```

建议默认：

- 最近 4 个完整 user-led segments。
- 同时受 Child context window 的 25% seed budget 限制。
- 永远不拆 assistant tool call / tool result。
- 不包含正在调用 `spawn_agent` 的未闭合 assistant tool batch。
- 如果 Main 已 compaction，优先从该轮实际 prepared context 投影，而不是重新遍历全部原始消息。
- fork 只复制一次；之后 Parent 与 Child 完全独立。

Context Engine 增加：

```ts
type ContextOwner =
  | { kind: 'session'; sessionId: string }
  | { kind: 'agent'; sessionId: string; agentId: string };
```

Child 的 manifest、summary、artifact 按 `agentId` 隔离。fork seed 建议单独保存为 immutable record，后续 conversation 只追加 Child 自己的消息。

---

## 十、Memory、Skill、MCP 集成

### Managed Memory

- Child 默认允许读取 Project Knowledge。
- Managed Memory recall 使用 `contextOwnerId = agent:<agentId>`。
- actor 增加 `child-agent`，并记录 agentId。
- researcher/reviewer 默认禁止 memory mutation tools。
- P0 不为每个 Child 自动触发 extraction。
- consolidation 和 extraction 继续使用现有 Internal Agent 路径。
- Memory 不承担 Agent 通信、结果传输或 mailbox 职责。

### Skill

- P0 Child 默认不允许动态 activate/deactivate Skill。
- P1 提供 agent-scoped SkillRegistry view：
  - 共享只读 definition catalog
  - 激活状态按 Agent 隔离
  - ToolPolicy 决定可见 Skill
- Child 不得改变 Main 的 Skill 状态。

### MCP

- 复用现有连接和 Tool Gateway。
- AgentDefinition 控制 MCP 是否可见。
- 需要交互审批的 MCP 调用按 P0 规则返回 `approval_required`。

---

## 十一、Run Protocol 与 Web Projection

现有 Run envelope 保持不变。新增 Session-scoped Agent Activity envelope：

```ts
interface AgentActivityEnvelope {
  version: 1;
  sessionId: string;
  seq: number;
  at: string;
  event: AgentActivityEvent;
}
```

canonical events：

```text
agent_created
agent_run_started
agent_status_changed
agent_run_finished
agent_recovered
agent_resync_required
```

规则：

- `agent_created`、started、finished、recovered 不可丢弃。
- tool/activity progress 可以 coalesce。
- 不向 Main conversation 流式注入 Child token delta。
- 同调用 Run 通过前台等待取得 Child 结果；后台完成则由 completion inbox 在后续独立 Main Run 中交付。
- `wait_agent` 是 Main 获取结果的正式途径。
- `spawn_agent`、`wait_agent`、`followup_agent`、`stop_agent` 不投影为普通 Tool Card。
- presentation layer 按稳定 `agentId` 聚合 lifecycle；followup 更新原 Agent Card，不创建第二张卡。
- 同一 Main assistant tool batch 中创建的多个 Agent 共享一个 `delegationGroupId`，可投影成 Agent Group Card；这只是展示分组，不引入固定并行编排模式。

运行时增加独立的 Session activity stream，解决 Child 在 Main Run terminal 后仍可能继续运行的问题。重连超出 replay window 时返回完整 Agent tree snapshot。

`ConversationViewSnapshot` 增加：

```ts
agents: {
  revision: number;
  rootAgentId?: string;
  nodes: AgentTreeNode[];
}
```

`ConversationItem` 增加内联 activity item：

```ts
type AgentActivityItem = {
  id: string;
  kind: 'agent_activity';
  sourceRunId: string;
  sourceMessageId?: string;
  delegationGroupId?: string;
  agentIds: string[];
};
```

该 item 在 Main 首次 delegation 的 Transcript 位置创建，后续状态变化原位更新，不追加 orchestration 噪音。

### 11.1 主布局保持 Transcript-first

主页面继续保持当前两栏结构：

```text
┌──────────┬──────────────────────────────────────┐
│ 左侧栏   │  当前会话标题              ● 就绪   │
│          ├──────────────────────────────────────┤
│ 会话     │                                      │
│          │              Transcript              │
│ 能力中心 │                                      │
│          │              Composer                │
└──────────┴──────────────────────────────────────┘
```

不新增永久右侧 Agent 面板，避免压缩 Transcript。左侧能力中心也不增加运行时 Agents 入口；Agent Definition 管理未来可以作为配置能力单独设计，但不与当前 Agent 实例混合。

### 11.2 顶栏状态入口与临时 Drawer

没有 Child Agent 时完全不显示入口。存在 Child 后，标题栏显示轻量状态：

```text
这是一个什么项目？   ● 运行中   Agents 2/3
```

其中 `2/3` 表示当前运行 2 个、Session 内共有 3 个 Child Agent；没有正在运行的 Child 时显示总数或“全部完成”，但入口仍保留。

点击后打开右侧 overlay Drawer，而不是永久 sidebar：

```text
                           ┌──────────────────────────┐
                           │ Agents                × │
                           │ ● Main                   │
                           │ ├─ ✓ auth-research       │
                           │ │  Researcher · 14s      │
                           │ ├─ ● api-worker          │
                           │ │  Editing auth.ts       │
                           │ └─ ○ reviewer            │
                           │    Idle                  │
                           └──────────────────────────┘
```

Drawer 展示完整 Agent Tree 和运行摘要，关闭后不占主界面宽度。Child 全部结束后入口继续保留，以便查看结果和后续运行；切换到从未创建 Child 的 Session 时隐藏。

### 11.3 Transcript 内联 Agent Activity Card

Agent activity 使用现有 Tool Card 的视觉语言，但层级更高。用户看到的是 Agent 生命周期，而不是底层 primitive：

```text
┌──────────────────────────────────────────────────┐
│ ◉ 子 Agent                              2 个任务 │
│ ● auth-researcher                                │
│   调查登录认证流程                     运行中 12s │
│ ✓ frontend-scout                                 │
│   检查前端登录调用                     完成   8s │
│                                      展开详情 ⌄ │
└──────────────────────────────────────────────────┘
```

展示规则：

- `spawn_agent` 创建或加入 Agent Activity Card。
- `wait_agent` 没有独立 UI，仅通过 running/completed 状态变化体现。
- `followup_agent` 在同一 Agent Card 内增加 Run timeline，不新建 Agent Card。
- `stop_agent` 更新同一卡片为 stopping/interrupted，并提供明确状态反馈。
- 原始 tool call、agentId、runId 和 raw event 仅在深层诊断视图中出现。

同一 Agent 的多次 Run：

```text
┌─────────────────────────────────────────────┐
│ ◉ auth-worker                     ✓ 已完成  │
│ ① 调查认证问题                    ✓ 12s     │
│ ② 修复 refresh token              ✓ 21s     │
│ 修改  auth.ts · token.ts                    │
│                                   查看详情⌄ │
└─────────────────────────────────────────────┘
```

一次明显的并行 delegation 优先投影为 Agent Group Card：

```text
┌─────────────────────────────────────────────────────┐
│ ◉ 并行调查                                   2 Agents│
│ ✓ frontend-scout    前端登录流程              8s    │
│ ● backend-scout     后端认证流程             14s…   │
│ ████████████████░░░░                                │
└─────────────────────────────────────────────────────┘
```

分组依据是相同 `delegationGroupId`，不是新增 orchestration workflow。Group 完成后展示总 Agents、总 tokens 和 wall-clock duration。

### 11.4 分层详情与 Agent Transcript

默认卡片只展示：

- Agent 名称和角色
- 当前任务
- running/completed/interrupted 等用户状态
- duration 和简短结果

第一层展开显示：

- Agent 名称、角色、父 Agent
- 当前任务、上下文来源
- 当前/最近 Run
- 工具使用摘要
- 修改文件摘要
- duration、tokens
- result/error 摘要
- shared workspace / 独立工作区等 isolation 摘要

其中技术字段转换为用户语言，例如 `fork` 显示为“继承上下文”，`fresh` 显示为“独立上下文”，`worktree` 显示为“独立工作区”。agentId、runId、parentRunId、ToolPolicy 和 raw events 只放在更深的诊断区。

点击“查看 Agent 对话”打开只读 Drawer，按需加载完整 transcript，并复用 Main Transcript 的消息、文本和 Tool Card 组件。V1 不在该 Drawer 提供 Composer；用户仍只与 Main 交互：

```text
User ↔ Main ↔ Child
```

### 11.5 Stop 与恢复状态

运行中的 Agent Card 和 runtime Drawer 都可以提供停止按钮：

```text
● backend-worker   修改 API 层   运行中 32s   ■ 停止
```

停止后原位变为“已停止”。服务重启恢复出的 interrupted Run 显示“上次运行被中断 · 可继续任务”，不伪装成普通失败或完成。

Web 使用独立 `agentTree`/`agentActivity` reducer，不修改现有 `activeRun` reducer；主 Transcript 仍然是唯一主界面。

---

## 十二、分阶段 Milestone

### M0 — Contracts 与开关

内容：

- AgentId、AgentRunId、Definition、状态机、错误码。
- 四个工具 schema。
- `AgentOrchestrationPort`。
- `MULTI_AGENT_ENABLED` feature flag；实际实现默认开启，显式设为 `false` 或 `off` 时关闭。
- 不接入 Runtime。

验收：

- schema validation
- 状态枚举穷尽测试
- ToolPolicy contract tests
- 旧测试零变化

### M1 — Session-scoped Agent Store

内容：

- `agents.jsonl`
- reducer、projection、operationId
- Agent/Run/message/tool/terminal persistence
- restart recovery
- lazy materialization

验收：

- 并发 append 严格排序
- torn tail 修复
- 重启后 running 只转换一次 interrupted
- completed/failed/interrupted conversation 可恢复
- 旧 Session 加载不产生 Agent 文件

### M2 — Reusable Child Run Factory

内容：

- 从 `createCodingAgent()` 抽取可复用的 run environment builder。
- AgentRuntime 正式支持 `persistence:'child'`。
- 增加 `profile:'child'`、`origin:'orchestrated'`。
- 注入 child persistence hooks。
- 保持主 `runTask()` 行为不变。

验收：

- Main、Internal、Child 三类 Run 使用同一 Runtime。
- Child 消息和工具证据只写 Agent Store。
- persistence failure fail-closed。
- Main 回归测试不变。

### M3 — AgentManager P0

内容：

- `spawn/wait/followup/stop/list`
- Session tree
- capacity/depth/write lease
- runtime handles
- abort semantics
- immutable definition snapshot
- 非交互权限适配器

验收：

- 并行两个只读 Child。
- `wait any/all`、timeout、completed immediate return。
- followup 保留原 conversation 并产生新 Run。
- stop 后可以 followup。
- 同 Agent 并发 followup 返回 `agent_busy`。
- 第二个 shared writer 被拒绝。

### M4 — Multi-Agent Tool Vertical Slice

内容：

- Executor 注入 orchestration port。
- 四个工具进入 tool definitions。
- 调用上下文包含 caller session、agent、run、toolCallId 和 fork snapshot。
- WorkspaceRuntime 装配 AgentManager。
- Session 删除、Runtime shutdown、服务退出收口。
- Agent list/detail/stop 只读或控制 API。

P0 完成门槛：

- Main 动态 spawn A、spawn B、继续推理、wait A、followup A、stop B。
- Main Stop 不影响 Child。
- Session 删除先停止 Child。
- 服务重启后 active Child 为 interrupted，并可 followup。
- 需要审批的 Child 工具不会挂起。
- feature flag 关闭时行为与当前版本一致。

### M5 — P1 Context 与 Definition

内容：

- fresh/fork projector
- ContextOwner
- Agent context manifest/artifact
- Markdown AgentDefinition loader
- agent-scoped Skill view
- Managed Memory context owner 和 child actor

验收：

- fork 不产生 orphan tool result。
- fork 不继承当前未闭合 tool batch。
- Parent/Child 后续消息互不变化。
- compaction 后 fork 仍包含有效 summary。
- definition 更新不会扩大旧 Agent 权限。
- Main/Child memory recall 不互相抑制。

### M6 — P1 Protocol 与 Web Observability

内容：

- Agent Activity Protocol validation/replay。
- Agent tree projection。
- Transcript Agent lifecycle projection 和 `delegationGroupId` 聚合。
- Session activity SSE。
- 顶栏按需 Agent 状态入口和 overlay Drawer。
- Transcript 内联 Agent / Agent Group Activity Card。
- 只读 Agent transcript Drawer，复用现有 Transcript 组件。
- stop、interrupted、followup Run timeline 的原位状态更新。

验收：

- 并行事件乱序到达时 reducer 仍确定。
- terminal event 不丢失。
- replay window 超出后可 resync。
- Child 在 Main Run 结束后完成，UI 仍更新。
- Child 状态不污染 Main `activeRun`。
- 没有 Child 的 Session 不显示顶栏入口或空面板。
- `wait_agent` 不产生独立 Tool Card。
- followup 不创建重复 Agent Card。
- overlay 开关不改变 Transcript 宽度和滚动位置。
- Agent transcript Drawer 不提供直接向 Child 输入的 Composer。

### M7 — P2 Worktree Isolation

内容：

- `shared | worktree`
- Git 可用性校验
- 独立 workspace root 和现有 ToolHost 实例
- worktree path、branch、modified files、diff 持久化
- followup 继续使用原 worktree

验收：

- 非 Git workspace 返回 `isolation_unavailable`。
- worktree 缺失时显式返回 `isolation_missing`，不静默退回 shared。
- 不自动 merge。
- 不自动删除含修改的 worktree。
- shared 与 worktree Agent 的文件效果互不污染。

---

## 十三、测试策略

测试分层：

1. **纯状态机测试**
   - Agent/Run transitions
   - wait any/all
   - stop idempotency
   - depth/capacity

2. **Journal contract tests**
   - append/replay/recovery
   - operationId
   - revision conflict
   - torn write
   - session deletion

3. **Runtime integration**
   - fake model + fake ToolHost
   - spawn/followup/stop
   - tool commit ordering
   - abort during model/tool execution

4. **Context tests**
   - complete segment
   - multi-tool batch
   - compaction fork
   - immutable snapshots
   - repeated followup

5. **Permission tests**
   - readonly success
   - policy denial
   - approval-required denial
   - hard guard
   - shared writer lease

6. **Protocol/Web tests**
   - validation
   - replay/resync
   - Agent tree/activity reducer
   - background completion
   - detail projection
   - orchestration tools are suppressed from ordinary Tool Cards
   - followup updates the stable Agent Card
   - same-batch spawns form one Agent Group Card
   - header entry visibility and overlay behavior
   - read-only Agent transcript Drawer

7. **端到端测试**
   - Main 动态组合四个原语
   - 服务重启恢复
   - Session 删除级联
   - Main Stop 不级联
   - 旧 Session/旧 Web 客户端兼容

---

## 十四、迁移与兼容策略

- 不修改现有 Session journal version 1 的语义。
- 新增 Agent journal，旧 Session 无需迁移。
- `ConversationViewSnapshot.agents` 作为可选字段上线，Web 缺失时按空树处理。
- 新增的 `agent_activity` ConversationItem 采用可选投影；旧 Web 客户端可以忽略，旧 Session 不生成该 item。
- 现有 `RunEventEnvelope version:2` 不增加并发 Child 语义。
- Multi-Agent tools 仅在 feature flag 和 AgentManager 都可用时暴露。
- 主 Agent、Managed Memory、Queue、Steer、approval 路径保持原状。
- 第一阶段仅在新 Session 启用；稳定后再允许旧 Session lazy 初始化 root Agent。
- 不改变现有 ToolHost、ModelClient、MCP connection ownership。

---

## 十五、主要风险与控制

| 风险 | 控制 |
|---|---|
| 主 Run 与 Child 创建之间崩溃 | toolCallId operationId；Agent 先持久化再执行 |
| 并发 Child 破坏 Session ledger | 独立 Agent journal |
| Child 完成晚于 Main Run | 独立 Session activity stream |
| fork 产生非法工具消息 | Context Engine 完整 segment/batch projector |
| 多个 Child 写同一文件 | P0 单 shared writer lease |
| 后台 approval 永久等待 | 非交互 fail-closed |
| followup 配置发生漂移 | 保存 immutable definition snapshot |
| Child 结果撑爆 Main context | output/result byte cap |
| Runtime 与 Manager 循环依赖 | AgentRuntime 定义 port，Manager 实现 port |
| Memory/Skill 状态互相污染 | 独立 context owner 与 scoped registry |
| 服务退出时工具仍在执行 | abort + bounded drain + restart recovery |
| Agent 数量持续增长 | 每 Session 上限、UI 只加载摘要、详情按需读取 |

---

## 十六、明确不进入 V1

```text
固定 Single / Parallel / Chain workflow engine
process-per-agent
第二套 ReAct loop / Executor / ModelClient / ToolHost
Agent 间直接通信
mailbox / broadcast
peer-to-peer collaboration
复杂 DAG scheduler
任意深度递归 Agent
remote Agent
多进程 daemon
自动规划审批协议
自动 merge / conflict resolution
终端复用型 teammate UI
自动恢复并重跑 interrupted Run
```

最终推荐交付边界：

```text
P0 = M0 ～ M4
P1 = M5 ～ M6
P2 = M7
```

其中 M4 完成后，DexCode 就已经具备真正可用的动态编排、持久 Child identity、followup、独立恢复和安全停止能力；P1 再补齐高质量 context fork 与 Web 可观测性，不需要为了 UI 或隔离能力推迟核心生命周期上线。
