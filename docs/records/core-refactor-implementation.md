# DexCode Core 重构实施说明

> 记录状态：已完成的阶段实施记录
> 本文只描述 Core 重构当时的交付结果，不代表当前完整能力。JSONL、Context Engine、Managed Memory、Queue/Steer 和 Multi-Agent 均在此后加入；现状以 [`../architecture.md`](../architecture.md) 为准。

## 1. 交付结论

本轮已把 `packages/agent-core` 从 Planner/Orchestrator/Reviewer/Summarizer 驱动的多阶段 demo，重构为单 Agent Run 的真实流式执行链路。生产 provider 只保留 OpenAI/OpenAI-compatible；本地执行只以 Windows 为支持目标。

核心结果：

- 模型响应不再等待整轮完成后一次性返回，text、reasoning 和 tool arguments 均从 provider SSE 增量解析。
- Orchestrator、worker pool、Planner、Reviewer、Review Agent 和 Summarizer 代码及测试已删除。
- chat 和兼容 preview 共用同一 Model stream 与 Executor，不再维护第二套模型循环。
- Run 拥有统一 ID、明确预算、abort、limited/failed/aborted/completed 终态和 durable `RunReport`。
- Session 增加 append-only ledger、revision、active Run 互斥、原子文件替换、幂等终态和重启恢复。
- assistant commit 与 tool-start commit 发生在工具 effect 前。
- Windows 路径边界、junction/symlink、命令进程树取消和 MCP 取消得到加强。
- HTTP SSE 增加有界队列、delta 合并、backpressure 和断连取消。
- 固定 40 条消息截断替换为带 manifest/digest/checkpoint 的 token-budget projection。

详细目标和不变量见 [`../completed-plans/core-refactor.md`](../completed-plans/core-refactor.md)，当前模块说明见 [`../architecture.md`](../architecture.md)。

## 2. Git 提交

所有提交均位于本地 `core-update` 分支，未 push：

| Commit | 内容 |
|---|---|
| `cc77b9e` | 重构计划、范围、不变量和验证 Gate |
| `697a6c0` | OpenAI-compatible canonical stream 与严格 turn accumulator |
| `6782a31` | 删除 Orchestrator/多角色链路，Executor 改为真实 streaming |
| `cd8a9f6` | HTTP/SSE 生命周期与 Run abort 连接，前端适配新事件 |
| `1f7f6f0` | Session ledger、commit barrier、幂等终态和恢复 |
| `45b81f7` | tool schema、Windows 路径/junction guard、命令取消 |
| `7866fec` | context manifest/checkpoint、SSE bounded delivery、MCP transport 取消 |

最终文档同步由后续收口提交完成。

## 3. Model streaming

### 3.1 Canonical protocol

`ModelClient` 只暴露 `streamMessage()`。一次性 `createMessage()` 接口及生产调用已经删除。

Provider wire chunk 被转换为：

- `turn_started`
- `text_delta`
- `reasoning_delta`
- `tool_call_delta`
- `turn_completed`
- `turn_failed`

Agent core 只认识这些 provider-neutral 事件，不读取 `choices[].delta` 等 OpenAI 字段。

### 3.2 Parser 和 accumulator

OpenAI-compatible parser 支持：

- 任意 TCP/SSE chunk 边界；
- UTF-8 字符跨 chunk；
- 多个 `data:` 行；
- `[DONE]`；
- 增量 tool name/arguments；
- usage 与 finish reason；
- HTTP、timeout、abort、network、authentication、rate limit 和 invalid response 归类。

Accumulator 会拒绝缺少 terminal、重复 terminal、非法 tool JSON、重复 call ID 或归约结果与 terminal response 不一致的流。模型断流不会被误报为成功。

## 4. Agent Run

`runTask()` 现在直接进入单一 Executor ReAct loop。旧的关键词 task classification、伪并发 worker、额外 planning/review/summarize model call 已不存在。

Run 记录：

- `runId`
- `modelTurnCount`
- `modelAttemptCount`
- token usage
- tools/files evidence
- `terminationReason`
- typed status：`completed`、`aborted`、`failed`、`limited`

Retry 只发生在 provider 明确标记为 retryable、尚未产生 semantic output 且未超过每轮 retry budget 时；retry wait 可取消。model turn 或 attempt budget 耗尽返回 `limited`，不会伪装为 completed。

完整 assistant message 先写入 Session，随后写入 `tool_started`，再执行工具。执行结果以配对的 tool message 持久化，然后才能进入下一轮模型请求。

## 5. Session durability

Session JSON schema 增加：

- monotonically increasing `revision`
- `ledger`
- `runReports`
- `contextManifests`
- `compactionCheckpoints`

Repository mutation 按 Session 在进程内串行化。保存时先写同目录临时文件，再 rename 到目标文件。JSON 损坏与文件不存在会被区分，避免把损坏数据静默当成空 Session。

`beginRun()` 原子写入 active Run 与 user message；已有 active Run 时拒绝第二个 Run。`finishRun()` 以 `runId` 幂等，重复提交返回已有报告。进程中断后，新的 repository instance 首次加载该 Session 会写入一次 `recovered_interruption` 报告并清除 active Run。

## 6. Context continuity

旧实现按最近 40 条消息截断，可能拆开 assistant tool call 与 tool result。本轮改为：

1. 过滤孤立 tool result，保留完整配对关系。
2. 对 canonical transcript 估算 token 数。
3. 未超 12k 输入预算时完整选择。
4. 超预算时从最近完整 user turn 保留尾部。
5. 为省略内容生成确定性 checkpoint，保存 source digest、strategy version 和 request digest。
6. 原 transcript 保持不变，projection 只决定本次 model request。

这是基础、可审计的 compaction，不包含向量检索或额外摘要模型调用。

## 7. Tool 与 Windows 安全

### 7.1 Schema 与顺序

工具调用在 effect 前检查 required、primitive type、array/object 和 `additionalProperties`。未知或非法调用生成配对错误结果，不进入执行适配器。

高风险命令保留确认/白名单流程。外部 MCP 工具强制要求确认渠道，没有确认渠道时直接拒绝。

### 7.2 文件边界

工作区 mutation 和读取拒绝：

- absolute path；
- Windows drive path；
- UNC path；
- `..` traversal；
- NUL；
- workspace 外 realpath；
- 已存在祖先中的 symlink 或 junction。

这同时覆盖词法逃逸和 Windows reparse-point 逃逸。

### 7.3 进程与 MCP

`run_command` 接收 Run 的 `AbortSignal`。timeout 或 abort 时，Windows 使用 `taskkill /PID <pid> /T /F` 清理整个进程树，并返回 cancelled/timeout 状态。

外部 MCP HTTP 调用使用可组合 abort 与 120 秒 transport timeout。stdio server 使用 `shell: false`、`windowsHide: true`，stdout listener 只注册一次；调用取消时发送 MCP cancelled notification 并清理 pending request。删除 stdio server 配置时会终止对应 child process。

## 8. Runtime 与前端

chat 请求创建单一 `runId` 与 `AbortController`。HTTP response close 会 abort Run。SSE writer：

- 默认最多缓存 256 个事件；
- 合并连续 text/reasoning delta；
- `res.write()` 返回 false 时等待 `drain`；
- 队列受压时优先丢弃 progress；
- semantic backlog 溢出时 abort Run；
- 发送 `[DONE]` 前等待队列排空。

Web 已删除 `plan` 事件分支，支持 reasoning、tool running/settled 和 aborted 状态。模板列表、详情、scaffold 与直接命令 API 不再挂在 CodingAgent facade 上，由 runtime 直接组合相应 service。

## 9. 删除内容

已删除以下生产模块：

- `packages/agent-core/orchestrator.ts`
- `packages/agent-core/worker-pool.ts`
- `packages/agent-core/planner.ts`
- `packages/agent-core/reviewer.ts`
- `packages/agent-core/review-agent.ts`
- `packages/agent-core/summarizer.ts`
- `packages/agent-core/mcp-client.ts`

对应 Orchestrator、worker pool 和 review-agent 测试也已删除；`TaskType`、`SubTask`、`AgentMessage`、`ReviewOutput`、`TaskTrace`、旧 plan SSE type 等耦合类型同步移除。历史设计文档保留原文，但已增加废止声明。

## 10. 验证结果

按效率优先原则，没有设置覆盖率门槛；保留了最能发现架构退化的 10 个定向测试：

- no-tool 真流式完成；
- assistant/tool-start commit-before-effect；
- model turn budget 返回 limited；
- 缺少 model terminal 被拒绝；
- 任意 SSE fragmentation 与增量 tool arguments；
- provider 中断归类 invalid response；
- Session terminal 幂等与 ledger 顺序；
- 重启后 interrupted Run 只恢复一次；
- lexical path traversal；
- Windows junction traversal。

最终执行命令：

```powershell
npm run typecheck
npm run lint
npm test
npm run build:web
```

执行结果以最终提交前的验证记录为准。

另外以 `PORT=33117` 实际启动 runtime，并成功读取 `/api/meta` 与 `/api/session`，随后正常停止服务。

## 11. 与初始计划的偏差和已知限制

以下内容没有伪装成已完成：

1. **Session 仍使用 JSON。** 已实现原子替换、单进程互斥、revision、ledger 和恢复，但没有切换 SQLite，也没有跨进程 lease fencing。当前 Windows 单 server 部署足够；若支持多个 runtime process，应优先迁移 SQLite transaction/CAS。
2. **没有单独暴露 `CodingRunHandle.events()` AsyncIterable。** 当前公共入口仍是 `runTask(..., onEvent)`，runtime 已统一 runId、abort 和 terminal；未来 CLI/TUI 接入前适合再抽 handle，当前 Web 无需承担一次高风险 API 迁移。
3. **Tool Gateway 尚未形成完整的 `ToolPlan`/typed `ToolOutcome` 类层次。** 本轮完成 schema、commit barrier、approval、Windows guard、abort 和配对结果；Skill 状态工具仍由 Executor 分派。若引入不可信插件，必须先完成统一 immutable plan、effectState 与 artifact/redaction contract。
4. **Context token 是字符估算。** checkpoint 是确定性文本摘要，不具备语义压缩质量；优点是便宜、可重复、可追溯。
5. **Preview 不持久化。** `/api/agent/preview` 复用生产 Executor 和 model stream，但作为兼容接口不建立 Session Run，因此不提供 ledger/recovery。
6. **SSE 慢消费者没有独立集成测试。** bounded writer 已实现并通过类型检查，当前测试集中在 model fragmentation、Session 顺序和 Windows 路径高风险行为。

这些限制均不重新引入 Orchestrator、另一套 provider-specific protocol 或 Linux 适配，也不影响本轮目标中的主聊天流式链路。该段只记录当时的后续判断；当前项目后来已经实现 Agent Runtime、JSONL Session、Context Engine 和 Multi-Agent。
