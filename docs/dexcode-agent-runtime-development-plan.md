# DexCode Backend Agent Runtime Development Plan

> 目标：在开发 Memory System 之前，先补齐 DexCode 的后端 Agent Runtime 中间层，使当前单 Agent ReAct Loop 能被不同类型的 Agent 复用，并为后续 Memory Extraction Agent、Research Agent、Reviewer Agent、并行 Coding Agent 等真正的 Multi-Agent 能力提供稳定基础。

---

## 1. 背景与当前基线

DexCode 当前已经完成了一个可工作的单 Agent 后端闭环：

```text
Conversation
    ↓
ConversationRunCoordinator
    ↓
CodingAgent.runTask()
    ↓
Executor.runReActLoop()
    ↓
Model ↔ Tool ↔ Model
```

当前已经具备：

- 单 Agent ReAct Loop
- OpenAI-compatible 流式模型调用
- reasoning / text / tool call 增量解析
- Tool calling 与 schema validation
- 文件读写、搜索、命令执行、快照等本地工具
- MCP
- Skill System
- Run budget / retry / abort
- Session 持久化与恢复
- Run ledger / RunReport
- Context Engine 与上下文压缩
- 用户运行过程的 SSE event stream
- Conversation queue / steer / stop

这些能力已经足以作为底层执行引擎。

本阶段**不重新设计 Agent Loop**，也不恢复旧的 Planner、Reviewer、WorkerPool、Orchestrator 等多阶段结构。

当前真正缺少的是：

> 一个位于 `Executor` 上方、`ConversationRunCoordinator` 下方的通用 **Agent Runtime**。

它应该负责描述：

- “这个 Agent 是谁”
- “它看到什么上下文”
- “它可以调用什么工具”
- “它拥有什么预算”
- “它的结果是否进入用户 Session”
- “它与父 Agent / 父 Run 是什么关系”

而具体的：

```text
Model → Tool → Model → Tool → ...
```

仍然由现有 `Executor.runReActLoop()` 负责。

---

# 2. 本阶段目标

完成后，DexCode 应形成如下分层：

```text
                    Product / Conversation Layer
                              │
                  ConversationRunCoordinator
                              │
                              ▼
                       Agent Runtime
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
         Main Agent       Internal Agent     Future Child Agent
            │                 │                 │
            └─────────────────┼─────────────────┘
                              ▼
                     Executor.runReActLoop()
                              │
                              ▼
                  Model / Tools / Context Engine
```

核心目标：

1. 保持现有主 Agent 行为不变。
2. 把“一个 Agent 如何运行”从 `CodingAgent.runTask()` 中进一步抽象出来。
3. 支持无用户 Session 的内部 Agent。
4. 支持独立的工具权限。
5. 支持独立的 system/context。
6. 支持独立的预算与取消。
7. 支持 `parentRunId`，形成最小 Run Tree。
8. 提供明确生命周期事件和扩展点。
9. 为下一阶段 Memory Extraction Agent 提供直接可用的运行基础。
10. 为未来真正 Multi-Agent 保留稳定 seam，但本阶段不实现调度器。

---

# 3. 非目标

本阶段明确**不实现**：

- Memory Extraction
- Memory Retrieval
- Memory Store
- Memory conflict resolution
- Vector DB
- Agent Orchestrator
- Planner Agent
- Reviewer Agent
- Research Agent
- Worker Pool
- Parallel Agent Scheduler
- Git Worktree Agent Isolation
- Agent-to-Agent Message Bus
- Task DAG
- Voting / Consensus
- Reflection Pipeline
- Distributed Execution
- 自动任务拆分
- 自动角色选择

不要因为新增 `parentRunId`、`AgentProfile` 等概念，就提前实现完整 Multi-Agent。

本阶段只做：

> **Agent Runtime execution primitive**

---

# 4. 核心架构原则

## 4.1 Executor 继续是唯一 Agent Loop

`Executor.runReActLoop()` 继续负责：

- 模型调用
- streaming
- tool-call loop
- tool result 回填
- retry
- model turn budget
- abort
- usage accounting
- termination reason

禁止：

```text
AgentRuntime 内重新写一套 loop
```

正确结构：

```text
AgentRuntime
    ↓
Executor.runReActLoop()
```

---

## 4.2 Conversation 与 Agent Runtime 解耦

当前用户主 Run 包含很多产品语义：

- Session
- 用户消息
- queue
- steer
- SSE
- active Run
- conversation transcript
- frontend presentation

这些语义不应该成为所有 Agent 的必需条件。

因此：

```text
ConversationRunCoordinator
```

只负责：

```text
User-facing Run
```

而：

```text
Internal Agent / Child Agent
```

应该可以直接调用：

```text
AgentRuntime.runAgent()
```

而不经过 ConversationRunCoordinator。

---

## 4.3 Agent 是“状态 + 配置 + Loop”

Agent Runtime 至少要统一管理：

```text
Agent State
├── identity
├── profile
├── model
├── messages
├── system/context
├── tools
├── budget
├── cancellation
└── persistence policy
```

不要把这些配置继续散落在：

- `CodingAgent.runTask()`
- `Executor`
- `ContextManager`
- `ConversationRunCoordinator`

之间。

---

# 5. 建议新增的核心 Contract

## 5.1 AgentRunIdentity

```ts
export interface AgentRunIdentity {
  runId: string;

  // Future multi-agent lineage
  parentRunId?: string;

  profile: AgentProfile;

  origin: "user" | "internal";
}
```

`parentRunId` 本阶段只表达 lineage。

不要实现复杂 DAG。

未来允许：

```text
run-main-001
├── run-memory-002
├── run-research-003
└── run-review-004
```

---

## 5.2 AgentProfile

初期只需要：

```ts
export type AgentProfile =
  | "main"
  | "internal";
```

如果代码结构自然，可以允许扩展字符串：

```ts
type AgentProfile =
  | "main"
  | "internal"
  | "memory"
  | "research"
  | "review"
  | "worker";
```

但不要在本阶段实现这些角色对应的业务行为。

Profile 的作用是：

- 标记 Agent 身份
- 决定默认 capability
- 决定默认 lifecycle
- 方便日志与调试
- 为未来 Orchestrator 提供稳定接口

---

## 5.3 AgentRunSpec

建议形成统一入口：

```ts
export interface AgentRunSpec {
  identity?: {
    runId?: string;
    parentRunId?: string;
    profile: AgentProfile;
    origin: "user" | "internal";
  };

  messages: ChatMessage[];

  systemSections?: ContextSection[];

  toolPolicy: ToolPolicy;

  contextPolicy?: AgentContextPolicy;

  persistence: AgentPersistencePolicy;

  budget: {
    maxModelTurns: number;
    maxModelAttempts?: number;
    maxRetriesPerTurn?: number;
    maxOutputTokens?: number;
  };

  signal?: AbortSignal;

  metadata?: Record<string, unknown>;
}
```

字段可以根据现有代码风格调整，但必须保留以下语义：

- profile
- origin
- parentRunId
- messages
- system/context
- tool policy
- persistence policy
- budget
- AbortSignal

---

## 5.4 AgentRunResult

上层业务不要直接依赖 `LoopResult`。

增加稳定的 Runtime 层结果：

```ts
export interface AgentRunResult {
  runId: string;
  parentRunId?: string;

  profile: AgentProfile;
  origin: "user" | "internal";

  status: RunStatus;
  terminationReason: TerminationReason;

  finalContent: string;

  modelTurnCount: number;
  modelAttemptCount: number;

  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    unknown: number;
  };

  toolsUsed: string[];
  filesModified: string[];

  error?: {
    code: string;
    message: string;
  };
}
```

`LoopResult` 继续属于 Executor 内部。

`AgentRunResult` 是 Runtime 层稳定 contract。

---

# 6. AgentRuntime

建议新增：

```text
packages/agent-core/agent-runtime.ts
```

核心入口：

```ts
runAgent(spec: AgentRunSpec): Promise<AgentRunResult>
```

职责：

```text
AgentRunSpec
    ↓
resolve identity
    ↓
resolve model
    ↓
resolve tool visibility
    ↓
resolve context
    ↓
resolve persistence hooks
    ↓
Executor.runReActLoop()
    ↓
normalize result
    ↓
AgentRunResult
```

AgentRuntime 不负责：

- 用户 queue
- steer
- HTTP
- SSE transport
- frontend
- task decomposition
- multi-agent scheduling

---

# 7. Agent State

建议让 Runtime 内部维护明确的运行态：

```ts
interface AgentRuntimeState {
  identity: AgentRunIdentity;

  messages: ChatMessage[];

  systemSections: ContextSection[];

  availableTools: AgentToolDescriptor[];

  budget: ResolvedAgentBudget;

  startedAt: string;
}
```

注意：

> Runtime state 不等于 Session。

Session 是产品持久化实体。

AgentRuntimeState 是一次 Agent execution 的运行状态。

未来一个 Session 内可能出现：

```text
1 Main Run
+
N Internal / Child Runs
```

因此不能继续隐含：

```text
Agent Run == Session Run
```

---

# 8. Tool Policy / Capability Isolation

这是本阶段最重要的基础能力之一。

## 8.1 Tool Policy

建议：

```ts
export interface ToolPolicy {
  allow?: string[];
  deny?: string[];

  allowExternalMcp?: boolean;
  allowSkills?: boolean;
}
```

后续可以扩展：

```ts
executionMode
mutationPolicy
approvalPolicy
```

但本阶段不要过度设计。

---

## 8.2 两层 enforcement

ToolPolicy 必须在两个层面生效。

### 第一层：模型可见工具过滤

```text
All registered tools
      ↓
ToolPolicy
      ↓
Visible tool definitions
      ↓
Model
```

不允许出现：

```text
模型看得到 write_file
→ 调用后才说 forbidden
```

内部只读 Agent 根本不应该看到 `write_file`。

---

### 第二层：执行路径再次校验

即使工具调用通过异常路径进入 Executor：

```text
executeTool(name)
```

也必须重新经过 policy check。

目标：

```text
visibility isolation
+
execution isolation
```

而不是只有 UI 层隐藏。

---

## 8.3 第一个内置内部 Profile

为测试提供：

```text
internal-readonly
```

允许：

```text
read_file
find
ls
list_workspace
grep
```

禁止：

```text
write_file
patch_file
run_command
external MCP
Skill activation
```

这将来正好可以演进为：

```text
memory-extractor profile
```

---

# 9. Tool 生命周期

建议把 Tool 生命周期明确为：

```text
tool_call_requested
        ↓
beforeToolCall
        ↓
policy / approval / validation
        ↓
tool_started
        ↓
execute
        ↓
afterToolCall
        ↓
tool_finished
```

如果当前已有 semantic hooks，可优先复用，而不是创建平行系统。

建议补充两个稳定 seam：

```ts
beforeToolCall?
afterToolCall?
```

它们可以用于：

- capability isolation
- audit
- future child-agent sandbox
- memory write guard
- future worktree routing

不要在 hook 中写业务级 Orchestrator。

---

# 10. Context Pipeline

当前 DexCode 已有 Context Engine。

不要重写。

但 Agent Runtime 应该拥有统一的 context entry：

```text
Agent messages
    ↓
transform / prepare context
    ↓
LLM messages
```

建议至少支持：

```ts
systemSections?: ContextSection[];
contextPolicy?: AgentContextPolicy;
```

调用方可以选择：

```text
inherit main context
```

或者：

```text
fully isolated context
```

---

## 10.1 Main Agent

主 Agent 可以继续构建：

```text
system prompt
workspace summary
project memory
available skills
recent tasks
context compaction
```

---

## 10.2 Internal Agent

内部 Agent 可以只构建：

```text
专用 system prompt
+
必要 transcript
+
必要 project files
```

默认不要自动继承：

- 主 Agent persona
- Available Skills
- Recent Tasks
- 全量 project memory
- 用户 presentation 指令

除非调用方明确指定。

---

# 11. Persistence Policy

建议：

```ts
export type AgentPersistencePolicy =
  | "session"
  | "none"
  | "child";
```

---

## 11.1 session

用于当前主 Agent。

行为保持：

```text
assistant message
tool call
tool result
RunReport
→ Session
```

---

## 11.2 none

用于内部 Agent。

必须保证：

- 不创建用户 Session
- 不进入 parent Session transcript
- 不增加 parent messages
- 不修改 parent activeTaskId
- 不产生普通 conversation history
- 不污染前端 timeline
- 返回 AgentRunResult

允许：

- 独立 usage
- 独立日志
- 独立 diagnostics

---

## 11.3 child

本阶段只保留 contract。

未来用于：

```text
parent run
    ↓
child run trace
```

可以设计成：

```text
Session
└── childRuns/
```

或 SQLite / Run ledger。

本阶段如实现成本较高：

```text
throw UnsupportedPersistencePolicy("child")
```

也可以接受。

关键是：

> 不要未来为了 Multi-Agent 再修改所有 Runtime API。

---

# 12. Agent 生命周期事件

建议统一 Agent 级事件：

```text
agent_start
turn_start
message_start
message_update
message_end
tool_start
tool_update
tool_end
turn_end
agent_end
```

不要求前端全部消费。

Runtime 内应形成稳定的 typed event。

目的：

- UI 可订阅 Main Agent
- Memory subsystem 可订阅 Main Agent terminal
- Future Orchestrator 可订阅 Child Agent
- tracing / testing 更简单
- 减少业务代码依赖 Executor 内部实现细节

---

# 13. Agent Event 与 Product Event 分离

建议明确：

```text
AgentEvent
```

属于：

```text
Agent Runtime
```

而：

```text
RunEventPayload / SSE
```

属于：

```text
Conversation / Product Layer
```

主 Agent：

```text
AgentEvent
    ↓
presentation adapter
    ↓
RunEventPayload
    ↓
SSE
```

内部 Agent：

```text
AgentEvent
    ↓
log / trace / ignore
```

不要让内部 Agent 强制走用户 SSE。

---

# 14. Lifecycle Hooks

建议增加统一 Agent lifecycle：

```ts
export interface AgentLifecycleHooks {
  onAgentStart?(event: AgentStartedEvent): Promise<void>;
  onTurnEnd?(event: AgentTurnEndedEvent): Promise<void>;
  onAgentEnd?(event: AgentEndedEvent): Promise<void>;
}
```

如果已有 semantic hooks，可以整合，不要重复建设。

---

## 14.1 Memory 所需 seam

下一阶段 Memory 至少需要：

```text
Main Agent
    ↓
agent_end
    ↓
Memory Extraction Service
    ↓
AgentRuntime.runAgent({
        origin: "internal",
        profile: "memory",
        ...
    })
```

因此必须支持：

```text
onAgentEnd
```

---

## 14.2 Hook failure isolation

要求：

```text
主 Agent 已成功完成
+
post-run hook 失败
```

不能变成：

```text
主 Run failed
```

正确语义：

```text
Main Run = completed
Extension Hook = failed
```

单独记录 warning / diagnostics。

---

## 14.3 防止递归

必须避免：

```text
Main Agent end
→ Memory Agent
→ Memory Agent end
→ 再启动 Memory Agent
→ ...
```

建议使用：

```ts
origin: "user" | "internal"
```

默认只有：

```text
origin === "user"
```

触发 post-run extension。

---

# 15. Cancellation

Internal / Child Agent 必须支持独立 AbortSignal。

最小语义：

```text
parent signal
     ↓
child signal
```

父 Run abort 时：

```text
child abort
```

但：

```text
child abort
```

不能反向 abort parent。

未来可支持：

```text
detached child
```

本阶段不需要。

---

## 15.1 Cancellation Tree

可以预留：

```ts
deriveChildAbortSignal(parentSignal)
```

或者使用组合 AbortController。

保持简单。

不要引入复杂 cancellation framework。

---

# 16. Budget Isolation

每个 Agent Run 必须拥有独立：

```text
maxModelTurns
maxModelAttempts
maxRetriesPerTurn
token usage
```

例如：

```text
Main Agent:
maxModelTurns = 20

Memory Agent:
maxModelTurns = 5
```

Memory Agent 不允许消耗 Main Agent 的 turn counter。

未来：

```text
parent budget
+
child budgets
```

可以由 Orchestrator 再做总预算约束。

本阶段不做 parent aggregate budget。

---

# 17. Main Agent 迁移

本阶段必须保持现有行为。

理想路径：

```text
ConversationRunCoordinator
        ↓
CodingAgent.runTask()
        ↓
build Main AgentRunSpec
        ↓
AgentRuntime.runAgent()
        ↓
Executor.runReActLoop()
```

即：

```text
CodingAgent.runTask()
```

逐渐从：

```text
自己管理所有运行细节
```

变成：

```text
构造 Main Agent profile
+
负责 Session/product integration
```

---

# 18. CodingAgent.runTask() 应保留的职责

保留：

- Session load
- user message beginRun
- workspace scope validation
- main context composition
- Session persistence adapter
- RunReport
- product event presentation
- beforeFinish
- Conversation-specific semantics

移出：

- 通用 Agent identity
- 通用 tool filtering
- 通用 budget resolution
- 通用 Executor invocation
- 通用 Agent result normalization
- 通用 lifecycle events

---

# 19. ConversationRunCoordinator 保持不变的语义

仍然保证：

```text
一个用户 Session
→ 同时只有一个 user-facing active Run
```

不要为了 Child Agent 改成：

```text
一个 Session 可注册 N 个 active conversation runs
```

未来 Child Agent 不应该注册到：

```text
activeBySessionId
```

Child Agent 属于另一套 Runtime execution lineage。

---

# 20. Run Tree

现在就加入：

```text
runId
parentRunId
profile
origin
```

但不做更复杂结构。

最小 Run Tree：

```text
run-main
├── run-memory
├── run-research
└── run-review
```

未来 Multi-Agent scheduler 可以在此基础上实现：

```text
parent
→ spawn child
→ await child
→ aggregate result
```

无需修改底层 Executor。

---

# 21. Future Multi-Agent Architecture

本阶段完成后，未来真正 Multi-Agent 建议增加在 Runtime **上方**：

```text
                    Orchestrator
                         │
            ┌────────────┼────────────┐
            │            │            │
       Research Agent  Coding Agent  Review Agent
            │            │            │
            └────────────┼────────────┘
                         │
                    AgentRuntime
                         │
                       Executor
```

Orchestrator 未来负责：

- task decomposition
- child creation
- dependency ordering
- serial / parallel scheduling
- result aggregation
- failure policy
- worktree allocation
- merge conflict handling

AgentRuntime 不负责这些。

---

# 22. Future Coding Multi-Agent 的真正难点

不要现在实现，但架构需要避免阻塞这些能力。

未来 Coding Multi-Agent 最大问题不是：

```text
如何调用第二次 LLM
```

而是：

```text
多个 Agent 如何安全操作同一个 repo
```

未来可能采用：

```text
Main Repository
├── Worktree A
├── Worktree B
└── Worktree C
```

每个 child agent：

```text
AgentRuntime
+
isolated workspace
+
isolated tool host
```

完成后：

```text
diff
→ review
→ merge
→ conflict resolution
```

因此现在的 ToolHost / Runtime 不应该把 workspace root 写死到全局单例。

---

# 23. Workspace / ToolHost 可注入性

检查当前 `CodingToolHost` 是否能被不同 Agent instance 独立注入。

目标：

```ts
runAgent({
  toolHost: workspaceAHost
})

runAgent({
  toolHost: workspaceBHost
})
```

而不是：

```text
所有 Agent 永远使用 process-global active workspace
```

如果当前已经通过 workspace-specific service 实现，则保留。

如果存在隐式全局 workspace 状态，本阶段应做最小必要解耦。

---

# 24. Model 可配置性

Runtime 不应假定所有 Agent 使用同一 model。

建议支持：

```ts
modelClient?: ModelClient
```

或者：

```text
modelProfile
```

默认继承主 provider。

未来可以：

```text
Main Agent     → strong model
Memory Agent   → cheap model
Reviewer       → strong reasoning model
Researcher     → cheap/fast model
```

本阶段不需要实现动态 model router。

只需要确保 Runtime contract 不阻塞。

---

# 25. Context Transform Seam

建议形成：

```ts
prepareContext(state, signal)
```

或者复用现有 Context Engine。

关键原则：

```text
Agent Runtime
→ 允许 context 在每次 model turn 前被整理
```

以后可以用于：

- compaction
- memory injection
- child context isolation
- retrieval
- parent-to-child summary
- tool-result pruning

不要把 Memory retrieval 写进 Executor。

---

# 26. ShouldStopAfterTurn Seam

可以考虑提供：

```ts
shouldStopAfterTurn?
```

调用时机：

```text
assistant + tools 完成
→ turn_end
→ shouldStopAfterTurn
→ decide continue / finish
```

未来用途：

- Memory Agent 达到目标后提前停止
- Reviewer 得到结论后停止
- context pressure 下提前退出
- Orchestrator-controlled child termination

当前 Executor 已有自然终止与 budget，保持兼容。

不要让这个 hook 改写 provider terminal reason。

---

# 27. Tool Execution Mode

本阶段不要求新增 parallel tool calling。

继续保持当前 Executor 行为即可。

但 Tool contract 不应假设：

```text
永远 sequential
```

未来如实现 parallel tool execution，应能够在 Executor 内独立完成，而无需修改 AgentRuntime。

---

# 28. 文件组织建议

优先保持简单：

```text
packages/agent-core/
├── executor.ts
├── agent-runtime.ts
├── agent-runtime.test.ts
├── agent-profile.ts           # optional
├── agent-events.ts            # optional
├── conversation-run-coordinator.ts
├── index.ts
└── ...
```

如 `agent-profile.ts` / `agent-events.ts` 内容很少，可以先放进 `agent-runtime.ts`。

不要为了“架构漂亮”拆成十几个文件。

---

# 29. 分阶段实施

## Phase A — Runtime Contracts

新增：

- `AgentRunIdentity`
- `AgentProfile`
- `AgentRunSpec`
- `AgentRunResult`
- `ToolPolicy`
- `AgentPersistencePolicy`
- lifecycle hooks

此阶段不改变 Main Agent 行为。

### Gate

```text
typecheck
existing tests
```

必须通过。

---

## Phase B — Tool Policy

实现：

```text
Tool Registry
→ ToolPolicy
→ visible tools
```

并加入 execution-side enforcement。

增加：

```text
internal-readonly
```

测试 profile。

### Gate

验证：

```text
write_file
```

既不出现在模型 schema，也不能通过直接执行路径绕过。

---

## Phase C — AgentRuntime

新增：

```ts
runAgent(spec)
```

内部复用：

```ts
Executor.runReActLoop()
```

支持：

- identity
- model
- context
- tool policy
- budget
- abort
- persistence
- lifecycle
- result normalization

### Gate

独立 internal Agent 可以完成：

```text
model
→ read_file
→ model
→ natural completion
```

---

## Phase D — Main Agent Adapter

让：

```text
CodingAgent.runTask()
```

内部构造：

```text
Main AgentRunSpec
```

再调用：

```text
AgentRuntime.runAgent()
```

现有用户行为必须保持不变。

### Gate

现有：

```text
ConversationRunCoordinator
→ CodingAgent
→ Executor
```

所有关键测试继续通过。

---

## Phase E — Internal Agent

增加一个最小：

```text
runInternalAgent(...)
```

可作为：

```text
AgentRuntime.runAgent()
```

的薄封装。

默认：

```text
origin = internal
persistence = none
toolPolicy = readonly
```

### Gate

内部 Run：

- 不创建 Session
- 不污染 parent transcript
- 独立 budget
- 独立 abort
- 有独立 runId
- 可携带 parentRunId

---

## Phase F — Lifecycle

加入：

```text
agent_start
turn_end
agent_end
```

等稳定 lifecycle。

Main Agent terminal 后：

```text
post-run hook
```

可以触发内部 Agent。

先使用 mock hook 验证。

不要实现 Memory。

### Gate

```text
Main Run
→ completed
→ hook exactly once
→ Internal Run
→ completed
```

Internal Agent 不再次递归触发同类 hook。

---

# 30. 测试计划

## Test 1 — Main Agent Regression

验证原有：

```text
user
→ model
→ tool
→ model
→ final
```

行为无变化。

---

## Test 2 — Internal Readonly Agent

```text
Internal Agent
→ read_file
→ search
→ final
```

成功。

---

## Test 3 — Tool Visibility Isolation

Internal readonly Agent 请求时：

```text
write_file
patch_file
run_command
```

不应出现在发送给模型的工具定义。

---

## Test 4 — Tool Execution Isolation

即使构造非法调用：

```text
execute("write_file")
```

也必须被 policy 拒绝。

---

## Test 5 — Persistence None

Internal Agent 完成后：

```text
parentSession.messages
```

不变化。

```text
parentSession.ledger
```

不新增普通 child assistant/tool message。

不创建新 conversation Session。

---

## Test 6 — Independent Budget

```text
Main maxTurns = 20
Child maxTurns = 2
```

Child 超过 2 turns：

```text
limited
```

Main budget 不变化。

---

## Test 7 — Abort

Parent AbortSignal abort：

```text
child model stream
child tool execution
```

全部停止。

Child：

```text
status = aborted
```

---

## Test 8 — Custom Context

Internal Agent 只收到：

```text
custom system prompt
+
provided messages
```

不会隐式获得：

- Main Skills
- Recent Tasks
- Main Project Knowledge
- Main persona

---

## Test 9 — ParentRunId

Child result：

```text
runId = child
parentRunId = main
```

保持正确。

---

## Test 10 — Lifecycle Recursion Guard

```text
User Main Run
→ onAgentEnd
→ Internal Agent
```

Internal `agent_end` 不再次触发相同 extension。

---

## Test 11 — Hook Failure Isolation

```text
Main Run completed
post-run hook throws
```

最终：

```text
Main Run status = completed
```

同时记录 extension failure。

---

## Test 12 — Existing Conversation Coordinator

继续保证：

```text
same Session
→ only one active user-facing run
```

Internal child 不进入该互斥表。

---

# 31. Observability

建议内部 Run 至少保留：

```text
runId
parentRunId
profile
origin
status
terminationReason
modelTurnCount
usage
toolsUsed
duration
```

不一定持久化到用户 Session。

可以：

```text
debug logger
```

或：

```text
runtime diagnostics
```

保存。

未来 Multi-Agent 可直接建立：

```text
Run Tree Viewer
```

---

# 32. 安全边界

Internal Agent 不能因为：

```text
persistence = none
```

就绕过：

- Tool policy
- workspace path guard
- command safety
- MCP approval
- AbortSignal
- schema validation

Persistence 与权限是两个不同维度。

---

# 33. 与下一阶段 Memory 的接口

本阶段完成后，Memory 应只需要增加：

```text
MemoryExtractionService
```

流程：

```text
Main Agent Run
      ↓
agent_end
      ↓
MemoryExtractionService
      ↓
AgentRuntime.runAgent({
  profile: "memory",
  origin: "internal",
  parentRunId: mainRunId,
  persistence: "none",
  toolPolicy: memoryToolPolicy,
  budget: {
    maxModelTurns: 5
  }
})
      ↓
Memory Store
```

Memory 不需要重新实现：

- model loop
- tool loop
- retry
- abort
- budgeting
- events

---

# 34. 与未来 Multi-Agent 的接口

未来新增：

```text
AgentOrchestrator
```

它只需要：

```ts
runtime.runAgent(childSpec)
```

例如：

```text
Main Agent
  ↓
delegate
  ↓
Orchestrator
  ├── Research child
  ├── Coding child
  └── Review child
```

Orchestrator 不直接操作：

```text
ModelClient
ToolGateway
Executor internals
```

只操作：

```text
AgentRunSpec
AgentRunResult
```

---

# 35. 最重要的不变量

整个重构必须保持以下不变量。

## Invariant 1

```text
Executor.runReActLoop()
```

仍然是唯一模型-工具闭环。

---

## Invariant 2

Main Agent 行为不因 Runtime 抽象发生产品级变化。

---

## Invariant 3

一个 Session 同时只允许一个 user-facing active Run。

---

## Invariant 4

Internal Agent 不污染用户 transcript。

---

## Invariant 5

Tool Policy 既限制模型可见 schema，也限制真正执行。

---

## Invariant 6

Agent budget、abort、usage 相互独立。

---

## Invariant 7

`parentRunId` 只表达 lineage，不自动产生 orchestration。

---

## Invariant 8

Memory 与 Multi-Agent 都构建在 Runtime 上方，而不是侵入 Executor。

---

# 36. 完成标准

完成本阶段后，应能够证明：

```text
同一个 Executor
```

可以运行两种完全不同的 Agent：

### Main Agent

```text
User-facing
Session-backed
Full coding tools
Main context
SSE presentation
```

### Internal Agent

```text
No user Session
Restricted tools
Custom context
Independent budget
Independent cancellation
parentRunId support
No transcript pollution
```

架构最终应达到：

```text
                   Agent Runtime
                        │
       ┌────────────────┼────────────────┐
       │                │                │
    Main Agent       Memory Agent     Future Child
       │                │                │
       └────────────────┼────────────────┘
                        │
                 Executor / ReAct
```

---

# 37. 开发结束时需要输出的报告

完成后请输出一份实现报告，至少包含：

1. 最终架构图
2. 新增 / 修改文件
3. `AgentRunSpec` contract
4. `AgentRunResult` contract
5. Main Agent 调用路径
6. Internal Agent 调用路径
7. Tool Policy 实现方式
8. Context isolation 实现方式
9. Persistence policy 语义
10. Cancellation 语义
11. Budget isolation 语义
12. Lifecycle event / hook 语义
13. Run Tree / parentRunId 设计
14. 为 Memory 保留的 seam
15. 为 Multi-Agent 保留的 seam
16. 本阶段明确没有实现的 Multi-Agent 功能
17. 回归测试结果
18. 新增测试结果
19. 已知限制
20. 下一阶段建议

---

# 38. 最终设计判断

这次重构不是：

```text
重新实现 Multi-Agent
```

也不是：

```text
为 Memory 写一个特殊 MemoryAgentRunner
```

而是：

> 把 DexCode 从“只能运行一种固定 CodingAgent 的系统”，升级为“拥有一个稳定、可复用、可受限、可组合的 Agent Runtime”。

下一阶段：

```text
Memory Extraction Agent
```

应该成为这个 Runtime 的第一个内部 Agent 使用者。

再下一阶段真正开发 Multi-Agent 时：

```text
Orchestrator
```

只需要在 Agent Runtime 上方增加任务拆分、调度、隔离和聚合，而不需要再次重构底层 Agent Loop。
