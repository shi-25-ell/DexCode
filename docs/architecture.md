# DexCode 当前架构

本文描述当前 `main` 分支的生产实现。历史计划位于 `completed-plans/`；它们说明功能为什么被设计，但不作为现状依据。

## 1. 系统边界

- 支持 Windows 本地文件系统和进程执行。
- 模型层使用 OpenAI-compatible Chat Completions streaming，并归一为 provider-neutral 事件。
- Runtime 是模型、Session、工具、Memory 和 Agent 状态的所有者；Web 只负责请求与展示投影。
- 工作区通过 opaque workspace reference 进入请求，不依赖一个进程级全局活动项目。
- Main Run 与 Child Run 复用同一个 Agent Runtime 和 Executor，但拥有不同的身份、上下文、预算和权限策略。

## 2. 生产链路

```text
Web POST /api/conversation-runs
  -> ConversationRunCoordinator 创建或加入 Run
  -> CodingAgent 准备 Workspace、Project Knowledge、Managed Memory 和 Skill context
  -> SessionRepository 原子提交 user message 与 run_started
  -> AgentRuntime 调用 Executor
       -> Context Engine 为本次模型调用准备请求视图
       -> ModelClient 解析 OpenAI-compatible SSE
       -> Turn Accumulator 归约完整 assistant turn
       -> SessionRepository 提交 assistant message
       -> ToolHost 校验 schema、权限、批准和工作区边界
       -> 提交 tool result
       -> 消费 Steer、继续下一模型轮次或终止
  -> finishRun 幂等提交 RunReport
  -> Run Protocol 投影并缓存 SSE event envelope
  -> Web RunPresentation 更新实时界面
```

`runId` 贯穿模型请求、工具、Session ledger、SSE 和终态。停止或连接关闭会沿 `AbortSignal` 传播到模型请求、重试等待、命令进程和外部 MCP 调用。

## 3. Agent Runtime 与 Executor

`packages/agent-core/agent-runtime.ts` 是可复用的运行原语，负责：

- 校验 Agent identity、profile、budget、tool policy 和 persistence policy；
- 组装 system sections、messages、tools 和生命周期 hook；
- 调用唯一的 ReAct loop；
- 返回结构化 `AgentRunResult`。

`packages/agent-core/executor.ts` 负责：

- model turn、attempt、retry、duration、output 和 total token budget；
- assistant/tool batch 的提交顺序；
- 工具 schema、批准、执行和结果归一；
- 输出长度恢复；
- Steer 安全边界；
- orchestration tool 调用与无进展熔断；
- completed、aborted、failed、limited 终态。

Conversation 层继续拥有用户 Session、Queue/Steer、SSE 和产品展示；Child Agent 不复制这些职责。

## 4. Multi-Agent

`packages/agent-manager` 管理 Session 级子 Agent。功能默认开启，可以通过 `MULTI_AGENT_ENABLED=false` 关闭。

模型侧生命周期工具为：

- `spawn_agent`：异步创建持久化子 Agent 并开始第一条 Run；
- `wait_agent`：默认立即读取状态，`block=true` 时作为前台同步屏障；
- `followup_agent`：在保留其会话和策略快照的前提下启动后续 Run；
- `stop_agent`：中止当前 Child Run，不删除 Agent 身份。

关键约束：

- Agent identity 与 Agent Run 分离；
- Child 状态保存在 Session 范围的 `agents.jsonl`；
- Child 终态和 completion inbox 一起提交；
- 后台完成通过新的 Main Run 交付，不插入正在生成的模型流；
- 默认最多同时运行 4 个 Child；每个 Main Run 最多创建 8 个身份；每个 Session 最多保留 64 个身份；
- Child 默认不能递归创建下一层 Child；
- 同一时刻最多一个共享工作区写入型 Child；
- orchestration 操作受总量和无进展熔断限制。

Web 通过 `/api/session/:id/agents/**` 读取 Agent Tree、详情和事件，并在 Agent Drawer 中展示独立 transcript。

## 5. Session 与持久化

`packages/session-store` 使用 append-only JSONL journal：

```text
workspaces/<scope>/sessions/<shard>/session-<id>.jsonl
workspaces/<scope>/sessions/<shard>/session-<id>.meta.json
workspaces/<scope>/sessions/<shard>/session-<id>/artifacts/
```

- journal 第一行是不可变 header，后续是带 revision 的 commit envelope；
- 一次领域操作产生的多条记录在一个 commit 中追加；
- reducer 从 journal 重建 Session projection；
- sidecar 只服务列表和搜索，可以从 journal 重建，不是 canonical truth；
- 只修复 torn tail，不容忍中段损坏、revision gap 或非法记录；
- 同一 Session 的 writer 在进程内串行化；
- active Run 在重启恢复时生成一次 `recovered_interruption`；
- export 返回 canonical JSONL 原文。

Session journal 保存消息、context manifest、tool lifecycle、Queue/Steer、RunReport 和 compaction checkpoint。大型上下文内容通过 artifact 引用，不内嵌进每一条消息。

## 6. Context

上下文分成三个相互配合的阶段。

### 6.1 Workspace Context

`packages/context-builder` 根据用户请求、当前文件、路径、内容、文件类型和任务复杂度选择工作区文件，并按字符预算压缩文件内容。用户维护的 `DEXCODE.md` 会按当前请求选择相关段落。

### 6.2 Managed Memory

`packages/managed-memory` 是独立的项目级自动记忆：

- recall 在 Main Run 开始时选择相关 topic；
- extraction 在 Run 结束后异步提取跨会话仍有价值的信息；
- consolidation 合并、纠错和清理已有记忆；
- Memory Agent 只能使用 `memory_*` 工具；
- 用户可以关闭、查看、重建索引或清空记忆；
- Managed Memory 不修改 `DEXCODE.md`。

### 6.3 Per-call Context Engine

`packages/context-engine` 在每次模型调用前执行四层治理：

1. 大型工具结果外置为 Artifact；
2. 历史中段按完整对话边界归档；
3. 旧工具结果替换成可恢复引用；
4. 生成结构化对话摘要。

模型也可以调用 `compact_context` 主动触发压缩，并用 `read_artifact` 分页读取外置内容。压缩只改变模型请求视图，不覆盖 canonical transcript。

## 7. 工具、批准和工作区边界

第一方本地编程工具由 `packages/tool-gateway/tool-registry.ts` 统一注册：

```text
find, ls, list_workspace, read_file, grep,
run_command, patch_file, write_file,
read_command_output, stop_command
```

`patch_file` 使用严格、唯一匹配的 structured edit，不执行 fuzzy 猜测。文件修改按目标路径串行化并原子写入。

工具执行依次经过：

```text
registry/schema
  -> Agent ToolPolicy
  -> approval policy
  -> workspace/path guard
  -> durable tool_started
  -> effect
  -> normalized ToolOutcome
  -> durable tool result
```

批准模式包括：

- `read_only`：需要批准的写操作、命令和外部能力逐次确认；
- `allowlist`：工作区文件修改自动执行，命令只有命中白名单时自动执行；
- `full_access`：允许受支持工具自动执行，但 schema、工作区边界和基础安全校验仍然生效。

文件 API 和模型工具只接受工作区相对路径，拒绝 drive、UNC、NUL、`..` 逃逸以及通过现有 symlink/junction 越界。命令 timeout 或 abort 会清理 Windows 进程树。

## 8. Skill 与 MCP

Skill 系统分离元数据、正文读取和激活：

- Runtime 首先向模型暴露可用 Skill 摘要；
- `read_skill` 按需读取完整 `SKILL.md`；
- `activate_skill` 和 `deactivate_skill` 记录当前 Run 的使用状态；
- Skill 可限制允许或禁止的工具；
- 导入先 preview，再显式确认写入；
- Skill 中的脚本不会被自动执行。

外部 MCP 支持 HTTP 和 stdio transport。MCP 工具进入统一工具展示和批准链路，支持 timeout 与取消；stdio 进程不通过 shell 启动。

## 9. Queue 与 Steer

运行中的新消息默认进入 Queue：

- `next_run`：当前 Run 终止后按 FIFO 启动新的 Run；
- `steer`：在 assistant turn 已完整提交、工具批次已结算且下一次模型请求尚未开始的安全边界进入当前 Run。

Queue mutation 使用 `operationId` 保证幂等，并通过 Session revision 拒绝过期排序。前台 `wait_agent(block=true)` 会被 Steer 提前唤醒，但不会取消 Main 或 Child Run。

## 10. 事件协议与展示

`packages/run-protocol` 定义带 `version`、`runId`、`seq` 和时间戳的事件 envelope，并提供有界 replay buffer。客户端断线后可以携带最后序号继续读取；历史过旧时要求重新同步 Session projection。

Runtime 的有界 SSE writer 会合并连续文本和 reasoning delta，遵守 backpressure。慢消费者优先丢弃可重建的 progress；semantic backlog 无法容纳时中止 Run，避免丢失终态事实。

`packages/conversation-view` 从 Session ledger 投影：

- 用户和 assistant 消息；
- Tool Card 与批次；
- context/compaction card；
- Queue/Steer 状态；
- Agent activity；
- terminal result 和 execution history。

实时事件和历史恢复使用同一展示模型，Web 不根据 HTTP 200、字符串内容或原始 JSON 猜测成功状态。

## 11. Web

`apps/web` 是 React + Vite 单页应用：

- `shell/`：项目选择、会话历史、侧栏和能力入口；
- `conversation/`：RunPresentation、时间线、Tool Card、Queue/Steer 和 Agent Drawer；
- `settings/`：MCP、Skill、批准模式、项目知识、Managed Memory 和子 Agent 设置；
- `api.ts`：conversation/run、replay、queue 和 agent API client。

Web 不拥有 canonical Session 或 Agent 状态。刷新后通过 conversation view、Run replay 和 Agent snapshot 恢复。

## 12. 明确保留的边界

- Session 和 Agent journal 只保证单进程 writer 语义，不提供多进程 fencing。
- token 预算依赖模型元数据和字符估算；未知模型应显式配置 context window。
- 模板生成目前是 Runtime API，没有 Web 模板选择界面。
- 内置 `/api/agent/chat`、`/api/agent/preview` 和 `/api/session/**` 仍用于兼容；新 Web 流程以 conversation/run API 为主。
- 本地工具只承诺 Windows 语义；其他平台不在当前支持范围。
