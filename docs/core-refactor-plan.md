# DexCode Core 重构计划

> 实施状态：本计划已在 `core-update` 分支执行。实际完成内容、验证结果和明确保留的限制见 [`core-refactor-implementation-report.md`](core-refactor-implementation-report.md)。

## 1. 目标

本次重构把 DexCode 的 Agent 后端从“通过 SSE 返回整轮结果的 ReAct demo”升级为具有明确协议、取消、持久化、安全和恢复语义的生产链路。

完成后的唯一生产路径为：

```text
Web/API
  -> CodingAgent / CodingRunHandle
  -> AgentHarness
  -> Agent Run state machine
  -> OpenAI-compatible ModelEvent stream
  -> strict turn accumulator
  -> durable assistant commit
  -> unified ToolExecutor
  -> durable ToolOutcome
  -> exactly-one RunReport
```

本计划只约束 DexCode。实现以 Windows 为唯一受支持的本地执行平台，只支持 OpenAI 和 OpenAI-compatible provider。

## 2. 明确范围

### 2.1 必须完成

- OpenAI/OpenAI-compatible canonical streaming protocol。
- 文本、reasoning 和 tool-call 参数的真实增量事件。
- 完整 Model Turn 严格归约和协议校验。
- Run 状态机、预算、retry、abort 和 exactly-one terminal。
- `CodingAgent`、`CodingSession`、`CodingRunHandle` 作为 Web 和未来前端的唯一应用入口。
- semantic event 与 progress event 分离；完整 assistant message 是 durable truth，delta 只表示 progress。
- 有界事件缓冲、文本 delta 合并、慢消费者处理和 terminal 保证。
- 删除现有 Orchestrator、关键词任务分类、伪 worker pool 和强制 review model call。
- 所有本地、Skill、MCP 工具统一经过 `ToolExecutor`/Tool Gateway。
- strict tool schema、ToolPlan、Hard Guard、approval、执行前重校验和 exactly-one ToolOutcome。
- Session append-only Run ledger、revision、单 Session 单 active Run、原子提交和中断恢复。
- 基于完整 Model Turn 和 token budget 的 context projection；基础 compaction 可追溯且不覆盖原 transcript。
- 统一 RunReport、错误分类、usage、tool、permission、changed file 和 command evidence。
- HTTP SSE 断开向 Run 传播 abort；SSE 写入遵守 backpressure。
- 公共接口测试、contract tests、integration tests 和 fault tests。
- README、系统设计文档、API 文档和最终实施说明同步更新。

### 2.2 明确不做

- Anthropic provider 或 Anthropic Messages protocol。
- Linux/WSL/macOS filesystem、process 或 shell 适配。
- 自动 task classification、Orchestrator、多 Agent、subagent 或 worker pool。
- 模型驱动的强制 code review gate。
- 远程 daemon/RPC、多机器 Session 共享。
- 不可信插件 sandbox。
- 高级长期 memory、向量检索或多级 compaction。

### 2.3 不变量

1. 一个已建立的 Run 恰好产生一个 terminal state、一个 terminal event 和一个 durable `RunReport`。
2. 一个 Session 同时最多一个 active Run；不同 Session 可以并发。
3. 完整 assistant message 提交成功前，不执行它声明的任何 tool call。
4. 每个 accepted tool call 恰好产生一个 `ToolOutcome`，包括拒绝、失败、超时和取消。
5. Model delta、tool progress 可合并或丢弃；assistant、ToolOutcome、terminal semantic event 不可丢失或乱序。
6. abort 从 Run 传播到 model、retry wait、context、approval、tool、process、MCP 和 HTTP adapter。
7. 所有工具来源服从同一 Tool Gateway；MCP、Skill、模板或内部调用不能旁路安全策略。
8. Session 保存 canonical facts，不保存 provider wire response 或供某一 provider 使用的 prompt 副本。
9. secret 不进入 event、Session、RunReport、tool evidence、artifact metadata 或错误文本。
10. UI/HTTP adapter 不直接访问 provider transport、Session writer、Tool Gateway 内部状态或 Run lease。

## 3. 公共接口与测试 Seam

以下四个 seam 是测试与实现的稳定边界。优先通过这些接口验证行为，不把内部类、私有调用次数或文件布局当成覆盖目标。

### 3.1 Model seam

```ts
interface Model {
  readonly descriptor: ModelDescriptor;
  stream(request: ModelRequest, options: ModelCallOptions): AsyncIterable<ModelEvent>;
}
```

验证 canonical events、fragmentation、usage、failure、timeout 和 abort。外部 HTTP 是可替换 boundary，Agent 不认识 OpenAI wire shape。

### 3.2 Coding application seam

```ts
interface CodingRunHandle {
  readonly runId: string;
  events(): AsyncIterable<CodingEvent>;
  dispatch(command: CodingRunCommand): Promise<CodingCommandAck>;
  readonly finished: Promise<RunReport>;
}
```

验证真实 streaming、命令关联、取消、terminal、SSE projection 和 slow-consumer 行为。

### 3.3 Session seam

```ts
interface SessionRepository { /* create/open/list/delete */ }
interface RunLease { /* append/settle/finish/heartbeat */ }
```

验证 revision、writer fencing、append ordering、exactly-one terminal、reopen 和 interrupted Run recovery。

### 3.4 Tool seam

```ts
interface ToolExecutor {
  definitions(): readonly ToolDefinition[];
  execute(call: ToolCall, context: ToolExecutionContext): ToolExecution;
}
```

验证 schema、path boundary、approval fingerprint、precondition、abort、output limit、artifact 和 exactly-one outcome。

## 4. 目标目录与 ownership

```text
packages/llm-client/
  api/contracts.ts
  streaming/turn-accumulator.ts
  providers/openai-compatible/
  testing/scripted-model.ts

packages/agent-core/
  app/coding-agent.ts
  agent/agent.ts
  harness/agent-harness.ts
  runtime/contracts.ts
  runtime/run-state-machine.ts
  session/contracts.ts
  context/contracts.ts
  policies/
  events/bounded-event-stream.ts
  testing/
  index.ts

packages/tool-gateway/
  contracts.ts
  registry.ts
  host/plan.ts
  host/hard-guard.ts
  host/approval.ts
  host/execution.ts
  host/settlement.ts
  windows/process-adapter.ts

packages/session-store/
  in-memory-session-repository.ts
  sqlite-session-repository.ts
  migrations/

packages/context-builder/
  context-manager.ts
  transcript-source.ts
  project-source.ts
  skill-source.ts
  summary-compaction.ts

apps/runtime/
  composition.ts
  server.ts
```

Ownership 规则：

- `llm-client` 只拥有 model API、OpenAI-compatible wire mapping、auth、stream parser 和 model failure normalization。
- `agent-core` 只拥有 Run、Session contract、context contract、tool protocol、Harness 和 application facade。
- `tool-gateway` 实现 `ToolExecutor`，拥有 Windows filesystem/process/network/MCP 的风险与执行策略。
- `session-store` 实现 `SessionRepository`，上层不能依赖 row、transaction 或数据库路径。
- `context-builder` 从 Session facts 投影 ModelRequest，不修改 transcript。
- `apps/runtime` 只进行 composition、HTTP parsing、SSE projection 和连接生命周期管理。
- `template-generator` 保持独立，不再作为 Agent facade 的方法。

## 5. 事件与持久化模型

### 5.1 ModelEvent

事件顺序：

```text
turn_started
  part_started
    text_delta | reasoning_delta | tool_call_delta
  part_completed
turn_completed | turn_failed
```

严格规则：

- `turn_started` 和 terminal 各恰好一次。
- terminal 后不得出现事件。
- part index 非负且不能重复。
- delta 类型必须匹配 part 类型。
- tool arguments 在 `part_completed` 时必须能解析为 JSON object。
- `turn_completed.response` 必须与 accumulator 归约结果一致。
- SSE 半行、UTF-8 半字符、多个 `data:` 行和断流均有确定语义。

### 5.2 AgentEvent/CodingEvent

Progress：

- phase change
- model attempt started
- model text/reasoning delta
- tool progress
- context compaction progress

Semantic：

- assistant message committed
- tool started/outcome committed
- model failure committed
- permission requested/resolved
- terminal RunReport

每个事件携带必要的 `runId`、`attemptId`、`callId` 或 `approvalId`。外层不得再次生成不一致的 task ID。

### 5.3 Session ledger

最小 record：

- run_started
- user_message
- assistant_message
- model_failure
- tool_started
- tool_outcome
- context_manifest
- compaction_checkpoint
- run_terminal
- recovery

数据库 mutation 使用 transaction、revision/CAS 和 lease fencing。Run terminal 提交必须幂等：重复 finish 返回已存在报告，不能产生第二份 terminal。

## 6. Tool Gateway 设计

执行顺序固定为：

```text
registry lookup
-> strict schema validation
-> canonical argument normalization
-> immutable ToolPlan
-> Hard Guard
-> risk and permission
-> approval fingerprint validation
-> plan/precondition revalidation
-> execute through Windows adapter
-> cleanup
-> ToolOutcome settlement
```

`ToolOutcome` 至少包含：

- status：`succeeded/rejected/denied/failed/timed_out/output_limit/cancelled/conflict`
- `isError`
- provider-neutral `modelContent`
- `effectState`：`none/committed/partial/unknown`
- `abortObserved`
- artifact refs
- redacted evidence
- infrastructure failure（仅无法确认安全清理等 terminal failure）

Windows process adapter 必须：

- 使用结构化 executable/argv，不自行实现通用 shell parser。
- 明确 cwd、environment allowlist、encoding 和 output byte budget。
- timeout/abort 时终止 Windows process tree。
- stdout/stderr 可以产生 bounded progress，完整超限输出进入 artifact。

路径保护必须同时处理 normalized path、case、drive、UNC、symlink 和 junction；审批后重新读取 filesystem identity/content hash。

## 7. Context 与 compaction

Context source 顺序：

1. system instructions
2. project instructions/memory
3. selected skills
4. latest applicable compaction checkpoint
5. complete transcript turns
6. bounded artifact previews

预算由 model context window、output reserve、tool schema reserve 和 safety margin 共同决定。不得按固定 40 条消息截断，也不得删除 tool result 后保留不配对 assistant tool call。

基础 compaction：

- 只压缩完整旧 turns。
- 保存 source range、source digest、strategy version 和 summary artifact。
- 原 transcript append-only 保留。
- compaction 失败时继续使用未压缩 facts 或返回 typed context failure，不产生半 checkpoint。

## 8. 分阶段实施与提交

### C0：计划、基线与测试配置

- 添加本计划。
- 增加检查测试代码的 `tsconfig.test.json`。
- 记录现有 public HTTP/session/tool 表面。
- 基线：现有 test/typecheck 必须通过。

提交建议：`docs: add core refactor plan and invariants`

### C1：OpenAI-compatible canonical stream

实施切片：

1. final text SSE -> canonical ModelEvent。
2. arbitrary SSE/UTF-8 fragmentation。
3. fragmented tool arguments。
4. usage + finish reason。
5. malformed/duplicate/missing terminal。
6. timeout、abort 和 HTTP failure taxonomy。

迁移 `ModelClient` 后删除一次性 `createMessage()` 生产调用；mock 改为 request-aware `ScriptedModel`。

提交建议：`refactor(model): add canonical OpenAI-compatible stream`

### C2：Agent Run 与真实增量事件

实施切片：

1. no-tool streaming Run。
2. full assistant semantic commit。
3. max turn/attempt limited。
4. retry policy。
5. abort before/mid stream。
6. bounded CodingEvent buffer 和 delta coalescing。

提交建议：`refactor(agent): add run lifecycle and bounded streaming events`

### C3：删除 Orchestrator

- 删除 `orchestrator.ts`、`worker-pool.ts`、`review-agent.ts`、`reviewer.ts`、`planner.ts` 和对应测试。
- 删除 `TaskType/SubTask/AgentMessage/ReviewOutput/TaskTrace` 等旧类型。
- `runTask`/HTTP chat 直接进入统一 CodingAgent Run。
- 前端删除 plan classification、review pass/retry 和 worker metrics 假设。
- summary 由 RunReport/最终 assistant message 生成，不再额外调用模型。

提交建议：`refactor(core): remove orchestrator and legacy review flow`

### C4：Session Harness 与 durability

实施切片：

1. beginRun 原子建立 active Run。
2. assistant commit-before-tool-effect。
3. ToolOutcome settlement ordering。
4. exactly-one finish。
5. concurrent writer conflict。
6. reopen interrupted Run -> recovered terminal。

生产 repository 切换后保留 in-memory conformance adapter。

提交建议：`refactor(session): add durable run ledger and recovery`

### C5：统一 Tool Gateway

实施切片：

1. strict schema/unknown tool rejection。
2. path/symlink/junction Hard Guard。
3. immutable plan + approval fingerprint。
4. precondition conflict。
5. abort/timeout/process-tree cleanup。
6. output spill artifact/redaction。
7. MCP/Skill 工具不能旁路 pipeline。

提交建议：`refactor(tools): unify validation approval execution and settlement`

### C6：Context、连续 Session 与 compaction

实施切片：

1. complete-turn transcript continuity。
2. token budget selection manifest。
3. compact old turns and retain tail。
4. compaction failure leaves transcript intact。
5. close/reopen preserves checkpoint provenance。

提交建议：`refactor(context): add auditable context projection and compaction`

### C7：HTTP、前端与最终收口

- SSE 发送 Model delta、tool progress、permission、terminal。
- 处理 `res.write()` backpressure 和 connection abort。
- 更新前端 reducer，按 run/attempt/part 合并 delta，以 committed assistant 替换临时文本。
- 删除 legacy `/preview` 或令其显式委托同一 CodingAgent path，不保留第二套 loop。
- 模板 API 直接使用 template service。
- 同步 README 和现有设计文档。
- 添加最终实施说明。

提交建议：`refactor(runtime): switch web app to the production core path`

## 9. 验证 Gate

开发期间每个 vertical slice 只运行高相关性的定向测试，允许先实现再补关键行为测试，不要求严格 red-green。为提高效率，不设置统一覆盖率阈值，也不要求每个内部分支都有测试；网络、进程和恢复类测试可以使用足以避免误报的局部超时。最终做一次完整 gate：

```powershell
npm run typecheck
npm run lint
npm test
```

只在能明显提高故障发现率时增加：

- contract test 命令
- integration test 命令
- production-path scan，禁止 `createMessage()`、Orchestrator 和工具旁路重新进入生产代码

最终必须保留的高风险自动化证据：

- real streaming and slow consumer
- malformed/provider disconnect
- abort in model/approval/tool/process
- commit-before-effect
- exactly-one terminal/outcome
- concurrent Session writer/reopen recovery
- Windows path escape and process cleanup
- context pressure/compaction provenance
- frontend close/reopen without corrupting durable truth

## 10. 文档与交付物

最终交付：

1. 本重构计划。
2. 分阶段 Git commits，全部位于 `core-update`，不 push。
3. 更新后的 README、系统设计和 API/event 说明。
4. `docs/core-refactor-implementation-report.md`，记录实际改动、设计偏差、测试命令、结果、已知限制和后续工作。
5. 干净 worktree 和最终 commit 列表。

若实施中发现计划与真实代码冲突，以不变量和公共 seam 为准；任何范围削减、兼容性破坏或无法在 Windows 验证的行为都必须记录在最终说明中，不能用通过 happy-path 测试代替。
