# DexCode Queue 与 Steer 开发计划

> 文档状态：待实施  
> 设计基线：`main@30bf245`  
> 适用范围：DexCode 本地单进程 Runtime、Web 客户端、Agent Core 与 JSON Session Repository  
> 默认产品语义：运行期间提交的新消息默认进入 Queue；用户可将某条 Queue 消息转换为当前 Run 的 Steer

## 1. 文档目的

本计划为 DexCode 增加两类运行中消息能力：

- **Queue**：消息属于 Session，等待当前 Run 结束后启动一个新的 Run。
- **Steer**：消息属于当前 active Run，在安全边界进入当前 Run，改变下一次模型请求的方向。

本功能不是简单增加一个 HTTP 路由。它需要同时解决以下问题：

- active Run 如何接收运行中命令；
- Queue 消息如何持久化、删除、排序和恢复；
- “调整方向”与 Run terminal 同时发生时如何避免丢消息；
- Steer 在什么时刻进入 canonical history；
- 当前工具调用、审批、上下文准备、预算和 abort 如何与 Steer 协作；
- 当前 SSE 连接如何承载由 Queue 自动启动的后续 Run；
- Web 如何展示后端确认过的 Queue 状态，而不是维护一份容易漂移的前端假队列。

完成后，DexCode 应具有可审计、可恢复、幂等并且不会破坏现有 Run 不变量的运行中消息链路。

## 2. 已确定的产品语义

### 2.1 术语

**Session**：同一个对话的持久化容器，包含 canonical messages、Run ledger、RunReport 和 Queue records。

**Run**：由一条初始用户消息启动的一次 Agent 执行。一个 Run 恰好产生一个 terminal state 和一个 durable `RunReport`。

**Model Turn**：一次模型请求、完整 assistant response、该 response 声明的全部工具调用及其结果。

**Queue Item**：尚未进入 canonical history 的持久化用户消息。它具有稳定 `itemId`、顺序、状态和幂等键。

**Queue / nextRun**：当前 Run terminal 后，Queue Item 成为新 Run 的初始用户消息。

**Steer**：目标为当前 active Run 的 Queue Item。它在安全边界被消费，成为当前 Run 中新的用户消息，并触发下一次模型请求。

**安全边界**：当前模型流已经完整归约，assistant message 已持久化，当前 assistant message 声明的工具批次已经全部结算，下一次模型请求尚未开始的时刻。

### 2.2 默认行为

1. Session idle 时提交消息，正常启动新 Run。
2. Session running 时提交消息，默认创建 `nextRun` Queue Item。
3. Queue Item 在当前 Run 结束前保持可见，可删除，可执行“调整方向”。
4. “调整方向”只在原目标 Run 仍处于 `accepting_commands` 状态时成功。
5. 转换成功后，该消息成为目标 Run 的 Steer；转换失败时仍留在 Queue，不得丢失。
6. Steer 不打断正在进行的模型流，不终止正在执行的工具，不替代审批回答。
7. Steer 在下一个安全边界按 FIFO 每次消费一条。
8. `nextRun` 在当前 Run terminal 后按 FIFO 每次启动一个新 Run。
9. Stop 只停止 active Run，并暂停自动消费 Queue；Queue Item 保留。
10. Runtime 意外退出后 Queue 保留，但重启后不在无人观察的情况下自动执行；用户重新打开 Session 后再恢复 drain。

### 2.3 状态行为矩阵

| Session/Run 状态 | 普通发送 | “调整方向” | 删除 Queue Item | Stop |
|---|---|---|---|---|
| `idle` | 启动新 Run | 不适用 | 允许 | 不适用 |
| `running` | 默认进入 `nextRun` | 可转换为当前 Run 的 Steer | 允许 | 停止当前 Run，暂停 Queue |
| `waiting_confirm` | 允许进入 `nextRun` | 可绑定当前 Run；批准完成且工具批 settlement 后消费，不得代替审批 | 允许 | abort 当前 Run 和未决审批，暂停 Queue |
| `closing` | 进入 `nextRun` | 转换失败并保持 Queue | 允许 | 等价于停止尚未 terminal 的 Run |
| `aborted/failed/limited` | 后续手动提交或恢复 drain | 不适用 | 允许 | 不适用 |

## 3. 当前基线与缺口

### 3.1 已有能力

当前主分支已经具备以下基础：

- `packages/agent-core/executor.ts` 提供单 Agent ReAct loop、真实流式模型请求、turn/attempt/retry budget 和 abort。
- assistant message 在工具执行前持久化，工具结果按调用顺序结算并进入 canonical history。
- `packages/session-store/index.ts` 提供 append-only ledger、Session revision、单 Session 单 active Run、原子 JSON 保存和 interrupted Run recovery。
- `packages/context-engine` 在每次模型请求前准备上下文，并记录 manifest、usage 和 compaction 证据。
- `apps/runtime/server.ts` 提供 conversation run SSE、Stop 命令、有界 writer 和断连 abort。
- `packages/conversation-view` 从 durable Session facts 投影 Web conversation snapshot。
- Web 已有运行状态、SSE reducer、停止按钮、审批卡片和 Session 重新加载能力。

### 3.2 当前缺口

当前链路不支持真正的 Queue 或 Steer：

- Web 在 `running/waiting` 时拒绝 `submit()`，运行中输入不会发往后端。
- Runtime 的 active map 只保存 `AbortController`，没有 run handle、命令门或 Queue ownership。
- Stop 是唯一运行中命令。
- `runTask()` 是一个等待完成的 Promise，没有运行中 dispatch seam。
- executor 在无工具响应后直接返回 `completed`，在工具批完成后直接进入下一轮，没有查询 Steer 的安全边界。
- Session ledger 没有 queue enqueue、retarget、consume、cancel 或 reorder records。
- conversation projection 不知道 pending Queue Item。
- SSE 只覆盖当前启动请求，没有明确的后续 Run 自动 drain 协议。
- 当前 `activeRequest`、项目上下文和 skill selection 基于 Run 初始 prompt；消费 Steer 后不会刷新 directive-sensitive context。

## 4. 范围

### 4.1 本次必须完成

- 运行期间默认 Queue。
- Queue Item 持久化、幂等创建、删除、查询和恢复。
- Queue Item 转换为当前 Run 的 Steer。
- Steer 安全边界消费。
- Queue terminal 后自动启动下一 Run。
- Stop 后保留并暂停 Queue。
- 运行状态、Queue 状态和 Steer 消费的 semantic SSE events。
- conversation snapshot 投影 pending Queue。
- Web Queue 卡片、“调整方向”、删除和明确状态反馈。
- 默认 follow-up behavior 设置为 `queue`，并允许配置为 `steer`。
- 上下文准备使用最新有效 directive。
- 并发、幂等、abort、恢复、审批隔离和 workspace scope 测试。

### 4.2 紧随核心功能完成

- Queue 拖动排序。
- Queue Item 编辑；编辑应产生新 revision，不得原地修改已消费消息。
- 更完整的运行中消息附件类型。

### 4.3 本次明确不做

- 中断或重启正在进行的 provider stream 来实现“即时” Steer。
- 强杀正在执行的单个工具调用来应用 Steer。
- 使用 Steer 自动批准、拒绝或替代普通对话中的用户回答/command approval。
- 多进程或多机器 writer fencing。
- Runtime 重启后在没有客户端重新连接时自动执行残留 Queue。
- 把 Queue Item 在消费前写入 canonical `session.messages`。
- 为该功能引入第二套 Agent loop、第二套 Session truth 或纯前端 Queue。

## 5. 核心不变量

以下不变量优先级高于具体类名、路由或 UI 结构。

1. 一个 Run 恰好产生一个 terminal state、一个 terminal semantic event 和一个 durable `RunReport`。
2. 一个 Session 同时最多一个 active Run。
3. Queue Item 消费前不得出现在 canonical messages 或模型输入中。
4. Queue mutation 必须先 durable commit，再返回成功响应或发送 semantic event。
5. Steer 必须绑定明确的 `targetRunId`；不得被另一个 Run 误消费。
6. assistant message 必须在其工具 effect 前 durable commit。
7. 当前 assistant message 声明的工具批次必须全部 settlement 后，Steer 才能进入模型上下文。
8. Queue Item 从创建到 terminal disposition 始终使用同一个 `itemId`。
9. 创建、转换、取消、排序和消费必须幂等。
10. “调整方向”与 Run closing 的竞态只能得到两个结果：成功成为目标 Run 的 Steer，或仍然是 `nextRun` Queue；不得出现第三种丢失状态。
11. Stop、abort、provider failure、tool failure、context failure 和 SSE disconnect 均不得静默删除 Queue Item。
12. 未消费 Steer 在目标 Run 非正常结束时退回 `nextRun` 并进入 paused Queue。
13. approval answer、Stop 和 Steer 是三类独立命令，不得根据文本内容互相猜测。
14. semantic Queue events 不可因 backpressure 丢弃；文本/reasoning delta 仍可按现有规则合并。
15. 所有 Queue 操作必须验证 Session scope、workspace ownership、target Run 和 revision。
16. secret、完整敏感工具输出和 provider wire payload 不得进入 Queue records。

## 6. 目标架构

### 6.1 总体链路

```text
Web composer / Queue card
          |
          v
HTTP adapter -----------------------------------+
          |                                      |
          v                                      v
ConversationRunCoordinator                 SSE projection
          |
          +---- active Run handle
          |
          +---- SessionRepository queue mutations
          |
          +---- server-owned nextRun drain
          |
          v
CodingAgent.runTask
          |
          v
ReAct executor -- safe boundary --> RunCommandSource
          |                              |
          |                              v
          +---------------------- consumed Steer
          |
          v
ContextEngine.prepare(latestDirective)
          |
          v
ModelClient / Tool Gateway
```

### 6.2 `ConversationRunCoordinator` Module

新增一个深模块 `ConversationRunCoordinator`。它拥有以下复杂性：

- Session 与 active Run 的关联；
- active Run command gate；
- Queue mutation 与幂等；
- Queue 到 Steer 的原子转换；
- Run terminal 后的 `nextRun` drain；
- Stop、disconnect、failure 和 restart 后的 Queue 策略；
- semantic event fan-out；
- 同一 Session 的串行化。

HTTP adapter、Web 和 executor 都不得各自复制这些规则。

建议接口：

```ts
export interface ConversationRunCoordinator {
  start(input: StartConversationRunInput, sink: CodingEventSink): Promise<RunChainResult>;

  submitDuringRun(input: SubmitDuringRunInput): Promise<SubmitDuringRunResult>;

  mutateQueue(command: QueueCommand): Promise<QueueCommandResult>;

  stop(input: StopConversationRunInput): Promise<StopConversationRunResult>;

  snapshot(sessionId: string): Promise<ConversationRuntimeSnapshot>;
}
```

`submitDuringRun` 的 `delivery` 必须由 caller 明确传入，后端不能依赖当前 UI 设置进行猜测：

```ts
type SubmitDuringRunInput = {
  sessionId: string;
  content: string;
  delivery: 'next_run' | 'steer';
  operationId: string;
  expectedRunId?: string;
  expectedSessionRevision?: number;
};
```

Queue mutation 使用 discriminated union，避免扩张成多个语义重复的方法：

```ts
type QueueCommand =
  | {
      type: 'promote_to_steer';
      sessionId: string;
      itemId: string;
      expectedRunId: string;
      operationId: string;
      expectedSessionRevision?: number;
    }
  | {
      type: 'cancel';
      sessionId: string;
      itemId: string;
      operationId: string;
      expectedSessionRevision?: number;
    }
  | {
      type: 'reorder';
      sessionId: string;
      orderedItemIds: string[];
      operationId: string;
      expectedSessionRevision: number;
    };
```

### 6.3 Active Run Handle

Coordinator 内部维护 active run handle，而不是只保存 `AbortController`：

```ts
type ActiveConversationRun = {
  sessionId: string;
  runId: string;
  phase: 'accepting_commands' | 'waiting_confirm' | 'closing' | 'stopping' | 'terminal';
  abortController: AbortController;
  commandSignal: RunCommandSignal;
  finished: Promise<RunReport>;
};
```

关键规则：

- `accepting_commands` 和 `waiting_confirm` 都允许 Queue Item 绑定或转换为该 Run 的 Steer。
- `waiting_confirm` 只开放 Steer 的 durable acceptance gate；approval 未决时不得消费，必须等待批准完成且当前工具批全部 settlement 后的安全边界。
- executor 决定自然结束前，Coordinator 先把 phase 原子切换为 `closing`。
- phase 进入 `closing` 后，新消息只能成为 `nextRun`。
- `stopping` 不再消费 Steer。
- `terminal` 后 handle 从 active map 移除，但 durable Run facts 保留。

### 6.4 Run Command Seam

executor 不直接访问 HTTP、Web 或 JSON 文件。它只依赖运行命令 seam：

```ts
export interface RunCommandSource {
  atSafeBoundary(input: {
    sessionId: string;
    runId: string;
    remainingModelTurns: number;
    wouldNaturallyComplete: boolean;
  }): Promise<
    | { action: 'continue'; steer: UserMessage; itemId: string; directive: string }
    | { action: 'proceed' }
    | { action: 'finish' }
    | { action: 'stop' }
  >;
}
```

这个 seam 隐藏以下实现：

- 从 ledger projection 查找目标 Run 的最早 Steer；
- 检查 budget；
- 原子消费 Queue Item 并提交 user message；
- 在工具批次结束且没有 Steer 时保持正常 loop；
- 仅在 Run 原本将自然结束且没有 Steer 时关闭 command gate；
- 在 Stop 或 Run 不匹配时返回确定结果。

## 7. 持久化模型

### 7.1 Queue Item

Queue Item 是从 ledger 归约得到的状态，不再维护另一份可漂移的独立数组作为 durable truth。

```ts
export type QueueItemView = {
  itemId: string;
  sessionId: string;
  content: string;
  delivery: 'next_run' | 'steer';
  status: 'queued' | 'consumed' | 'cancelled';
  targetRunId?: string;
  createdAt: string;
  updatedAt: string;
  position: number;
  revision: number;
};
```

消费和取消后的 Item 可以保留在 ledger 中用于审计，但 conversation snapshot 默认只返回 pending items。

### 7.2 新增 Ledger Records

```ts
type QueueLedgerRecord =
  | {
      type: 'queue_enqueued';
      seq: number;
      at: string;
      operationId: string;
      itemId: string;
      message: UserMessage;
      delivery: 'next_run' | 'steer';
      targetRunId?: string;
      position: number;
    }
  | {
      type: 'queue_retargeted';
      seq: number;
      at: string;
      operationId: string;
      itemId: string;
      from: 'next_run';
      to: 'steer';
      targetRunId: string;
    }
  | {
      type: 'queue_requeued';
      seq: number;
      at: string;
      operationId: string;
      itemId: string;
      fromRunId: string;
      reason: 'run_aborted' | 'run_failed' | 'run_limited' | 'budget_exhausted' | 'recovery';
    }
  | {
      type: 'queue_consumed';
      seq: number;
      at: string;
      operationId: string;
      itemId: string;
      delivery: 'next_run' | 'steer';
      runId: string;
    }
  | {
      type: 'queue_cancelled';
      seq: number;
      at: string;
      operationId: string;
      itemId: string;
      reason: 'user_deleted' | 'session_deleted';
    }
  | {
      type: 'queue_reordered';
      seq: number;
      at: string;
      operationId: string;
      orderedItemIds: string[];
    };
```

### 7.3 原子提交要求

以下操作必须在一次 `withSessionLock()` 和一次原子 JSON 替换中完成：

**创建 Queue Item**

- 验证 Session scope；
- 检查 `operationId` 是否已经执行；
- 分配 `itemId` 和 position；
- 追加 `queue_enqueued`；
- 增加 Session revision；
- 返回 durable projection。

**消费 Steer**

- 验证 `activeTaskId === targetRunId`；
- 验证 Run command gate 仍接受命令；
- 验证 Item pending 且 delivery 为 `steer`；
- 追加 canonical user message record；
- 追加 `queue_consumed`；
- 增加 Session revision；
- 返回被消费的消息和新 revision。

**从 Queue 启动新 Run**

- 验证 Session 没有 active Run；
- 领取最早 `nextRun` Item；
- 原子追加 `run_started`、canonical user message 和 `queue_consumed`；
- 设置 `activeTaskId`；
- 增加 Session revision；
- 返回新 Run 的输入。

不得先标记 consumed 再另行调用 `beginRun()`，否则进程在两步之间退出会丢失消息。

### 7.4 幂等

每个用户发起的 mutation 都必须携带稳定 `operationId`。重复请求返回第一次已经提交的结果：

- 重复 enqueue 不创建第二个 Item；
- 重复 promote 返回相同的 retarget outcome；
- 重复 cancel 返回 `already_cancelled`；
- 已消费 Item 的 cancel 返回 `already_consumed`；
- 重复 reorder 不产生额外状态变化。

不能只依赖 HTTP connection 或前端按钮 disabled 实现幂等。

## 8. Queue 与 Steer 状态机

### 8.1 Queue Item 状态

```text
                         promote 成功
  queued(next_run) ----------------------------+
       |                                       |
       | delete                                v
       +-------------------------------> queued(steer,targetRunId)
       |                                       |
       | 当前 Run terminal                     | safe boundary
       v                                       v
  consumed(next_run,newRunId)             consumed(steer,targetRunId)
       |
       v
  new Run starts

  queued(steer,targetRunId)
       |
       | target Run abort/fail/limited before consumption
       v
  queued(next_run,paused)
```

### 8.2 Active Run 命令门

```text
accepting_commands
    |       |
    |       +-- approval requested --> waiting_confirm
    |                                  |
    |                                  +-- enqueue/promote steer --> bound to current Run, pending
    |                                  |
    |                                  +-- resolved --> accepting_commands
    |
    +-- Stop ------------------------> stopping --> terminal
    |
    +-- safe boundary + pending steer --> consume one --> accepting_commands
    |
    +-- tool boundary + no steer ------> proceed ------> accepting_commands
    |
    +-- natural completion + no steer -> closing ------> terminal
```

`closing` 是解决 promote/terminal 竞态的关键状态。它必须由 Coordinator 的 per-Session mutex 保护，并在执行 `finishRun()` 前设置。

## 9. Executor 改造

### 9.1 安全边界位置

当前 executor 需要在两个位置统一进入 `atSafeBoundary()`：

1. assistant response 没有 tool calls、原本准备 natural completion 时；
2. assistant response 的全部 tool calls 已 settlement、原本准备下一次 loop iteration 时。

伪代码：

```ts
while (modelTurnCount < maxTurns) {
  const response = await collectModelTurn(...);

  await commitAssistant(response);

  if (response.toolCalls.length > 0) {
    await settleEntireToolBatch(response.toolCalls);
  }

  const decision = await commandSource.atSafeBoundary({
    sessionId,
    runId,
    remainingModelTurns: maxTurns - modelTurnCount,
    wouldNaturallyComplete: response.toolCalls.length === 0,
  });

  if (decision.action === 'continue') {
    workingMessages.push(decision.steer);
    loopMessages.push(decision.steer);
    currentDirective = decision.directive;
    await refreshDirectiveContext(currentDirective);
    continue;
  }

  if (decision.action === 'proceed') continue;

  if (decision.action === 'stop') return aborted(...);

  if (response.toolCalls.length === 0) {
    return completed(...);
  }
}
```

### 9.2 工具批次语义

v1 固定采用以下规则：

- 不取消已经开始的工具；
- 不因为 Steer 跳过同一 assistant message 中尚未执行的工具调用；
- 当前工具批次全部产生 paired tool result 后才消费 Steer；
- 用户若要阻止危险 effect，应使用已有审批拒绝或 Stop；
- 后续可以单独设计“取消未开始工具”的 typed ToolOutcome，但不与本功能混合实施。

这能保留 assistant/tool pairing、commit-before-effect 和 exactly-one ToolOutcome。

### 9.3 Budget

- Steer 属于当前 Run，不重置 `modelTurnCount`、`modelAttemptCount`、retry 或 token usage。
- 在剩余 model turn 为 0 时不得消费 Steer。
- budget exhausted 时把未消费 Steer 原子退回 `nextRun`，当前 Run 以 `limited` terminal。
- `nextRun` 启动新 Run 后获得新的 Run budget。
- `RunReport.finalAnswer` 只记录当前 Run 最后一次有效 assistant content；较早的中间回答仍保留在 ledger。

### 9.4 事件顺序

消费 Steer 时，semantic 顺序固定为：

```text
queue_item_updated(status=consumed, delivery=steer)
user_message_committed(runId, itemId)
context_refresh_started
context_refresh_completed | context_refresh_failed
model attempt progress...
```

持久化顺序必须先于 event。SSE 断连不影响 durable facts。

## 10. 上下文与指令刷新

Steer 可能改变目标文件、技能或任务方向，因此只把文本追加到 `workingMessages` 不足以构成完整 Steer。

### 10.1 Stable 与 Directive-Sensitive Context

将当前 Run context 拆成两类：

**Stable sections**

- system instructions；
- workspace identity 与 root；
- project memory；
- 安全与工具规则；
- provider-independent runtime information。

**Directive-sensitive sections**

- 当前 active directive；
- 根据 directive 选择的文件/snippets；
- 根据 directive 选择的 skills block；
- directive-specific context manifest data。

### 10.2 Steer 消费后的处理

1. durable commit Steer user message；
2. `currentDirective = steer.content`；
3. 刷新 directive-sensitive context；
4. 下一次 `ContextEngine.prepare()` 使用最新 directive 和完整 canonical messages；
5. 生成新的 context manifest，并记录它对应的 turn/attempt；
6. context refresh 失败时发送 typed semantic failure，不静默假装已刷新。

如果刷新失败但旧上下文仍可安全使用，可以继续模型请求，但必须：

- 保留 Steer user message；
- 在 event 和 RunReport warning 中记录 fallback；
- 不覆盖上一次有效 context manifest；
- 不把 refresh failure 误报为 Steer 消费失败。

## 11. Runtime 与 HTTP Contracts

### 11.1 Active Run Registry

将当前：

```ts
Map<runId, AbortController>
```

替换为由 Coordinator 管理的双索引：

```ts
activeByRunId: Map<string, ActiveConversationRun>
activeBySessionId: Map<string, ActiveConversationRun>
```

所有插入、phase transition 和移除都经过 Coordinator。HTTP server 不直接修改 map。

### 11.2 路由

保留：

```text
POST /api/conversation-runs
POST /api/conversation-runs/:runId/commands   { action: "stop" }
```

新增：

```text
POST   /api/conversations/:sessionId/queued-messages
POST   /api/conversations/:sessionId/queued-messages/:itemId/commands
DELETE /api/conversations/:sessionId/queued-messages/:itemId
PATCH  /api/conversations/:sessionId/queued-messages/order
```

创建 body：

```json
{
  "content": "新的用户指令",
  "delivery": "next_run",
  "operationId": "uuid",
  "expectedRunId": "optional-active-run-id",
  "expectedSessionRevision": 42
}
```

Queue command body：

```json
{
  "action": "promote_to_steer",
  "operationId": "uuid",
  "expectedRunId": "active-run-id",
  "expectedSessionRevision": 43
}
```

### 11.3 HTTP Outcomes

成功结果必须返回 authoritative Queue Item 和最新 Session revision。

建议 outcome：

```ts
type QueueMutationOutcome =
  | { outcome: 'queued'; item: QueueItemView; sessionRevision: number }
  | { outcome: 'steered'; item: QueueItemView; targetRunId: string; sessionRevision: number }
  | { outcome: 'remained_queued'; item: QueueItemView; reason: 'run_changed' | 'run_closing'; sessionRevision: number }
  | { outcome: 'cancelled'; itemId: string; sessionRevision: number }
  | { outcome: 'already_consumed'; itemId: string; runId: string; sessionRevision: number };
```

错误分类：

- `400`：空消息、非法 delivery、重复/缺失排序 ID；
- `404`：Session 或 Queue Item 在当前 scope 下不可见；
- `409`：revision conflict、Run mismatch、Item 状态不允许该操作；
- `410`：可选；明确表示 Item 已经 terminal 且不再可操作；
- `503`：Runtime 正在关闭，mutation 未提交。

`run_changed` 不应作为消息丢失错误。后端保留 Queue 并返回 `remained_queued`，Web 给出温和提示。

## 12. SSE 与 Run Chain

### 12.1 Server-Owned Drain

Queue 的自动执行由 Coordinator 拥有，浏览器不得在收到 terminal 后自行猜测并启动队首消息。

第一阶段保留现有 SSE 传输方式，但一次已建立的 conversation activity stream 可以覆盖连续的 Run chain：

```text
run A started
run A events
run A terminal
queue item consumed as nextRun
run B started
run B events
run B terminal
session idle
stream end
```

每个 event 必须携带正确 `sessionId`、`runId`，Queue event 还必须携带 `itemId`。

### 12.2 新增 Semantic Events

```ts
type QueueEvent =
  | { type: 'queue_item_added'; sessionId: string; item: QueueItemView; sessionRevision: number }
  | { type: 'queue_item_updated'; sessionId: string; item: QueueItemView; sessionRevision: number }
  | { type: 'queue_item_removed'; sessionId: string; itemId: string; reason: string; sessionRevision: number }
  | { type: 'queue_reordered'; sessionId: string; orderedItemIds: string[]; sessionRevision: number }
  | { type: 'run_started'; sessionId: string; runId: string; sourceItemId?: string }
  | { type: 'run_chain_paused'; sessionId: string; reason: 'user_stop' | 'disconnect' | 'failure' | 'recovery' };
```

这些事件属于 semantic backlog，不允许 coalesce 或 drop。

### 12.3 Disconnect

保持当前“HTTP/SSE disconnect abort active Run”的产品策略，但补充 Queue 语义：

- abort active Run；
- command gate 进入 `stopping`；
- 未消费 Steer 退回 `nextRun`；
- 已有 `nextRun` 保留；
- Queue chain 标记 paused；
- 连接关闭后不启动下一 Run；
- 用户重新打开 Session 时 snapshot 展示 Queue，并允许恢复执行。

## 13. Conversation Projection

`projectConversation()` 增加 pending Queue projection：

```ts
type ConversationViewSnapshot = {
  ref: string;
  title: string;
  state: ConversationState;
  activeRun?: {
    runId: string;
    phase: 'running' | 'waiting_confirm' | 'closing' | 'stopping';
  };
  queuedItems: QueueItemView[];
  queuePaused: boolean;
  updatedAt: string;
  items: ConversationItem[];
  contextUsage: ContextUsageView;
  revision: number;
};
```

Projection 规则：

- canonical conversation timeline 只显示已经消费的 user messages；
- pending Queue 使用独立 `queuedItems`；
- consumed Queue Item 通过 canonical message 显示，不在 pending 区重复出现；
- 重启恢复时，指向不存在 active Run 的 Steer 被投影为 paused `nextRun`；
- Queue Item 不参与 conversation title 和 latest user preview，直到被消费；
- Queue mutation 更新 `updatedAt`，使 sidebar 能反映活动，但不得误报新 assistant answer。

## 14. Web 交互计划

### 14.1 Composer

- `running` 时 textarea 保持可编辑。
- 默认 follow-up behavior 为 `queue`。
- `Enter` 按当前设置发送；`Shift+Enter` 换行。
- `waiting_confirm` 时遵循 `steer` 设置；成功绑定后提示“将在批准完成且工具结算后调整方向”。
- Stop 按钮继续独立存在，不与发送按钮复用语义。
- 提交期间只锁定当前 operation，不能锁死整个 composer。

### 14.2 Queue Card

每个 pending Item 展示：

- 文本预览；
- Queue/Steer 状态；
- “调整方向”；
- 删除；
- 正在提交/冲突/已消费状态；
- 后续阶段增加拖动手柄和编辑。

“调整方向”按钮行为：

1. 捕获当前 `activeRunId` 和 Session revision；
2. 发送 `promote_to_steer`；
3. 后端返回 `steered` 后更新为 Steer 状态；
4. 返回 `remained_queued` 时保留卡片并提示“当前运行已进入结束阶段，将在下一轮处理”；
5. 不使用乐观删除，避免 mutation 失败后卡片闪烁或丢失。

### 14.3 本地状态

Web reducer 增加：

```ts
type QueueAction =
  | { type: 'queue_snapshot'; items: QueueItemView[]; revision: number; paused: boolean }
  | { type: 'queue_upsert'; item: QueueItemView; revision: number }
  | { type: 'queue_remove'; itemId: string; revision: number }
  | { type: 'queue_reorder'; orderedItemIds: string[]; revision: number }
  | { type: 'run_started'; runId: string; sourceItemId?: string }
  | { type: 'run_chain_paused'; reason: string };
```

Reducer 必须拒绝旧 revision event 覆盖新 snapshot。

### 14.4 设置

增加：

```ts
type FollowUpBehavior = 'queue' | 'steer';
```

规则：

- 默认 `queue`；
- 该设置只决定 Web 在 active Run 时提交的显式 `delivery`；
- 后端永远依据请求中的 delivery 和当前 Run 状态处理；
- `waiting_confirm` 可显式发送 `steer`，后端将其绑定当前 Run，但只在 approval resolved 且工具批 settlement 后消费；
- 设置变更不修改已经存在的 Queue Item。

## 15. Approval、Stop 与 Queue

### 15.1 Approval

- approval request 进入 `waiting_confirm`；
- 普通发送仍可 Queue；
- 显式 Steer 和 promote 可绑定当前 Run，并保持 pending；
- approval answer 只能走现有 confirm route；
- approval resolved 后 Run 返回 `accepting_commands`，继续完成当前工具批；
- 当前工具批全部 settlement 后，executor 才在安全边界消费一条 pending Steer；
- 用户拒绝 approval 后，当前工具产生 denied ToolOutcome，再到安全边界；
- Queue 消息不会被解释为批准、拒绝或普通对话中的用户回答。

### 15.2 Stop

Stop 顺序：

1. Coordinator 将 phase 改为 `stopping`；
2. 关闭 Steer acceptance gate；
3. abort signal 传播到 model/retry/approval/tool/MCP/process；
4. 未消费 Steer 原子 requeue 为 `nextRun`；
5. 当前 Run durable terminal 为 `aborted`；
6. Queue chain 标记 paused；
7. 不自动启动下一 Run；
8. Web 保留 Queue 卡片并显示“已暂停”。

Stop 请求重复执行必须幂等。

## 16. Recovery

Session load/recovery 时执行 Queue projection：

1. 归约全部 queue records；
2. 删除 consumed/cancelled Item；
3. 找出指向当前 active Run 的 pending Steer；
4. 如果 active Run 被标记 interrupted，则追加 recovery terminal；
5. 把这些 pending Steer 追加 `queue_requeued(reason=recovery)`；
6. 保留所有 `nextRun` 顺序；
7. 标记 Queue paused；
8. 返回 conversation snapshot；
9. 只有用户显式恢复后才启动队首消息。

恢复必须幂等：重复打开同一 Session 不得反复追加 requeue records。

## 17. 并发与竞态

### 17.1 Per-Session Serialisation

Coordinator 和 Session Repository 使用同一个 Session 级串行化原则：

- 同一 Session 的 start、promote、cancel、reorder、safe-boundary consume、finish 和 stop 串行；
- 不同 Session 可以并发；
- 不持有 Session lock 等待 model、tool、SSE drain 或用户审批；
- lock 内只做验证、归约、append 和原子 save。

### 17.2 必测竞态

1. promote 与 natural completion 同时发生；
2. promote 与 Stop 同时发生；
3. cancel 与 safe-boundary consume 同时发生；
4. reorder 与消费队首同时发生；
5. 两个浏览器重复 enqueue 同一个 operationId；
6. 两个浏览器分别 enqueue 不同消息；
7. SSE disconnect 与 Queue 自动启动同时发生；
8. approval resolve 与 Stop 同时发生；
9. Runtime 在 queue durable commit 后、HTTP response 前退出；
10. Runtime 在 `beginRunFromQueue` commit 后、模型请求前退出。

每个竞态测试必须断言 durable ledger 和最终 projection，而不只断言 HTTP status。

## 18. 文件级改造清单

### 18.1 Shared contracts

`packages/shared/types.ts`

- 增加 Queue delivery、Queue Item、Queue ledger records；
- 扩展 `SessionLedgerRecord`；
- 增加 Queue/Coding semantic events；
- 为 RunReport 增加可选 context refresh warning；
- 避免把 Web-only loading state写入 durable types。

### 18.2 Agent Core

`packages/agent-core/session-contracts.ts`

- 增加原子 enqueue、retarget、cancel、reorder、consumeSteer、beginRunFromQueue、requeueSteer methods；
- 明确每个 method 的 revision、幂等和错误语义。

`packages/agent-core/executor.ts`

- 增加 `RunCommandSource`；
- 在两个安全边界调用 `atSafeBoundary()`；
- 消费 Steer 后更新 `workingMessages`、`loopMessages` 和 `currentDirective`；
- budget exhausted 时不消费；
- 保持当前工具批完整 settlement。

`packages/agent-core/index.ts`

- 组装 directive refresh hooks；
- 将 latest directive 传给 ContextEngine；
- 保持 exactly-one finishRun；
- 暴露 Coordinator 需要的 Run lifecycle result。

建议新增：

```text
packages/agent-core/run-commands.ts
packages/agent-core/conversation-run-coordinator.ts
packages/agent-core/queue-reducer.ts
```

### 18.3 Session Store

`packages/session-store/index.ts`

- 实现 queue ledger mutations；
- 所有 Queue mutations 使用现有 `withSessionLock()`；
- 实现 operationId idempotent lookup；
- 实现 Queue projection；
- 实现 consume Steer 与 canonical user message 的单次原子保存；
- 实现 beginRunFromQueue 原子保存；
- recovery 时 requeue 未消费 Steer；
- 不改变旧 Session 没有 Queue records 时的读取行为。

`packages/session-store/session-store.test.ts`

- 增加 Queue conformance、幂等、revision、recovery、竞态和旧数据兼容测试。

### 18.4 Conversation View

`packages/conversation-view/contracts.ts`

- snapshot 增加 active Run、queuedItems、queuePaused 和 revision。

`packages/conversation-view/projection.ts`

- 从 ledger 归约 Queue；
- pending Item 与 canonical timeline 分离；
- consumed Item 不重复展示；
- recovery 后 Steer 显示为 paused Queue。

### 18.5 Runtime

`apps/runtime/server.ts`

- active map 替换为 Coordinator；
- 新增 Queue routes；
- Stop 委托 Coordinator；
- 让现有 SSE sink 接收 Queue semantic events 和连续 Run；
- scope、runId、revision、operationId validation；
- disconnect 时 pause Queue chain。

建议把 HTTP parsing 留在 `server.ts`，把状态机移入 Coordinator，避免 server 继续膨胀。

### 18.6 Web

`apps/web/src/api.ts`

- 增加 enqueue、promote、cancel、reorder clients；
- 每次 mutation 生成 operationId；
- 返回 typed outcome。

`apps/web/src/types.ts`

- 增加 Queue view/event/action types。

`apps/web/src/conversation/conversation-page.tsx`

- running 时允许提交；
- 根据 follow-up setting 选择 delivery；
- 渲染 Queue 区域；
- 支持“调整方向”、删除、paused 状态；
- reducer 使用 revision 防止旧 event 回滚。

建议新增：

```text
apps/web/src/conversation/queued-message-card.tsx
apps/web/src/conversation/queue-reducer.ts
apps/web/src/conversation/queue-reducer.test.ts
```

`apps/web/src/settings/`

- 增加 Follow-up behavior 设置；
- 默认 Queue；
- 设置只影响未来提交。

## 19. 分阶段实施计划

### Q0：冻结 contracts 与基线

目标：先固定词汇、状态和不变量，不改变生产行为。

任务：

- 添加本计划；
- 记录 `main@30bf245` 的定向测试基线；
- 定义 Queue contracts、typed outcomes 和错误分类；
- 定义 ledger record schema 和 reducer 输入输出；
- 为现有 Session fixture 增加 version-compatible parsing tests。

验证：

- 现有 typecheck/lint/test 不退化；
- 新 contracts 没有引入未使用的生产分支；
- 文档和类型使用相同术语。

提交建议：`docs(agent): define queue and steer lifecycle`

### Q1：Durable Queue 与 Projection

目标：先实现不执行模型的持久化 Queue vertical slice。

任务：

- 实现 pure `queue-reducer`；
- 实现 enqueue/cancel/retarget/reorder ledger append；
- 实现 operationId 幂等；
- 扩展 conversation snapshot；
- 增加 HTTP Queue routes；
- 暂时不允许 executor 消费 Steer，也不自动启动 nextRun。

验证：

- enqueue 后刷新页面仍存在；
- cancel 后刷新不再出现；
- duplicate operationId 不重复；
- cross-workspace 操作被拒绝；
- 旧 Session 正常打开。

提交建议：`feat(session): add durable conversation queue`

### Q2：Active Run Handle 与 Steer

目标：完成当前 Run 安全边界 Steer。

任务：

- 实现 Coordinator 和 active run phase；
- 实现 `RunCommandSource`；
- executor 增加安全边界；
- 实现 promote、consume 和 requeue；
- 添加 latest directive 和 context refresh；
- 增加 Queue semantic SSE events。

验证：

- 模型流期间提交 Steer，不截断当前流；
- 工具运行期间提交 Steer，工具先 settlement；
- 安全边界只消费一条；
- steer user message 在下一次模型请求前 durable；
- promote/closing 竞态不丢消息；
- budget exhausted 自动 requeue。

提交建议：`feat(agent): add safe-boundary steering`

### Q3：nextRun 自动 Drain

目标：Queue Item 在当前 Run terminal 后自动启动独立 Run。

任务：

- 实现 `beginRunFromQueue()`；
- Coordinator 驱动 Run chain；
- 每个 Queue Item 单独生成 runId、budget 和 RunReport；
- SSE 发送多个 Run 的 semantic events；
- failure/limited 后暂停还是继续的策略固定为暂停，等待用户确认恢复；
- normal completion 后继续 FIFO drain。

验证：

- Run A terminal 后 Run B 才开始；
- Run A/B 各自恰好一个 RunReport；
- Queue Item 只进入一次 canonical history；
- Run B 失败后后续 Queue 保留且 paused；
- disconnect 不会启动 Run B。

提交建议：`feat(runtime): drain queued messages into new runs`

### Q4：Web Queue 交互

目标：交付完整可用的用户路径。

任务：

- running composer 默认 Queue；
- Queue card；
- “调整方向”；
- 删除；
- authoritative mutation outcome；
- revision-aware reducer；
- paused Queue 恢复提示；
- Follow-up behavior 设置。

验证：

- running/waiting/closing/idle UI 状态；
- promote success 和 remained_queued；
- 快速双击不重复；
- 刷新恢复；
- mobile/窄宽度下 Queue card 可操作；
- keyboard submit 与 Shift+Enter 正确。

提交建议：`feat(web): add queued follow-up and steer controls`

### Q5：Stop、Recovery 与 Fault Tests

目标：补齐非 happy path，满足生产不变量。

任务：

- Stop requeue 未消费 Steer；
- disconnect pause；
- interrupted Run recovery；
- enqueue response 前进程退出模拟；
- beginRunFromQueue 后进程退出模拟；
- approval 与 Stop/Queue 竞态；
- slow consumer/backpressure Queue event tests；
- Session revision conflict tests。

验证：

- 所有 durable facts 可从 ledger 重建；
- 无 pending Item 静默丢失；
- exactly-one terminal 保持；
- semantic event 顺序与 ledger 顺序一致。

提交建议：`test(agent): harden queue steer recovery and races`

### Q6：排序、编辑与文档收口

目标：补齐队列管理体验和维护文档。

任务：

- 拖动排序及 `queue_reordered`；
- 可选 Queue Item 编辑；
- 更新系统设计、HTTP/event 文档和 README；
- 编写 implementation report，记录偏差、验证结果和保留限制；
- 清理临时 compatibility paths。

提交建议：`feat(web): complete queued message management`

## 20. 测试计划

### 20.1 Queue Reducer 单元测试

- enqueue nextRun；
- enqueue steer with targetRunId；
- retarget nextRun -> steer；
- retarget 已 consumed/cancelled Item；
- cancel pending Item；
- duplicate operationId；
- reorder 全量 ID 校验；
- consume 后不再 pending；
- requeue steer -> nextRun；
- recovery projection 幂等；
- malformed record order 被拒绝或返回 typed corruption error。

### 20.2 Session Repository Contract Tests

- Queue mutation revision 单调递增；
- Queue 消费前不进入 `messages`；
- consumeSteer 原子追加 user message + queue_consumed；
- beginRunFromQueue 原子设置 activeTaskId + user message + consume；
- duplicate finish/consume 不产生第二份记录；
- simultaneous promote/finish 只有一个确定胜者；
- cross-session/cross-workspace itemId 不可访问；
- reopen 保持顺序和状态；
- interrupted active Run requeue Steer。

### 20.3 Executor Tests

- no-tool natural response + no steer -> completed；
- no-tool natural response + steer -> 同 Run 下一模型请求；
- tool batch + steer -> 所有 tool results 后注入；
- 多条 Steer one-at-a-time；
- Steer 顺序稳定；
- provider error 不消费 Steer；
- abort 不消费 Steer；
- turn budget exhausted requeue；
- context refresh 使用最新 directive；
- context refresh failure 有 typed warning；
- assistant commit-before-tool-effect 既有测试继续通过。

### 20.4 Coordinator Integration Tests

- active registry 双索引一致；
- Run phase transition；
- promote/closing race；
- stop/promote race；
- cancel/consume race；
- normal terminal 自动 nextRun；
- failed/limited/aborted terminal pause；
- disconnect abort + pause；
- wait confirmation 接收 direct Steer/promote，但只在 approval 和工具 settlement 后消费；
- operationId retry；
- different Sessions 并发不互相阻塞。

### 20.5 HTTP/SSE Tests

- Queue routes validation；
- scope enforcement；
- typed outcomes 与 status code；
- semantic Queue event 不丢失；
- Run chain event runId 正确；
- slow consumer 下 delta 可合并，Queue event 保留；
- original request disconnect 后 active Run abort；
- duplicate HTTP retry 返回同一 Item。

### 20.6 Web Tests

- running 时 Enter 创建 Queue；
- idle 时 Enter 启动普通 Run；
- setting=steer 时 active 发送 Steer；
- waiting_confirm 的 steer 设置保持 Steer，并展示延迟到工具结算后的提示；
- Queue card promote/delete；
- `remained_queued` 不移除卡片；
- revision 防旧 event 回滚；
- Run B started 后对应 Queue card 消失并出现 canonical user message；
- Stop 后 Queue 保留并显示 paused；
- reload snapshot 恢复；
- narrow viewport 和 keyboard accessibility。

## 21. 可观测性

新增结构化指标：

- `queue.enqueue.count`，按 delivery 分类；
- `queue.promote.count`，按 outcome 分类；
- `queue.cancel.count`；
- `queue.pending.count`；
- `queue.wait_ms`，从 enqueue 到 consume；
- `steer.safe_boundary_wait_ms`；
- `steer.requeued.count`，按 reason 分类；
- `run_chain.length`；
- `run_chain.paused.count`，按 reason 分类；
- `queue.idempotent_replay.count`；
- `queue.revision_conflict.count`。

日志必须包含 `sessionId`、`runId`、`itemId`、`operationId` 和 outcome，但不记录完整用户内容。

## 22. 兼容与迁移

- Session schema 采用可选 Queue records，旧 Session 无需离线迁移。
- Queue projection 对缺少 Queue records 的 Session 返回空数组。
- `RunReport.version` 暂不升级；只添加可选 warning 时保持向后兼容。
- 现有 `/api/conversation-runs` idle 启动行为保持不变。
- 现有 Stop route 保持路径不变，内部改为 Coordinator adapter。
- 现有 approval routes 保持不变。
- Web 和 Runtime 应在同一提交阶段切换新增 event types，避免类型和运行时不一致。
- 生成的 `apps/web/dist` 只在最终 Web build 验证阶段更新，避免每个中间切片制造无关 diff。

## 23. 完整验证 Gate

定向测试通过后执行一次完整验证：

```powershell
npm run typecheck
npm run lint
npm test
npm run build:web
```

另外执行生产路径烟测：

1. 启动一个包含可控长工具的 Run；
2. 运行期间提交两条 Queue；
3. 将第一条转换为 Steer；
4. 验证当前工具先结束，再消费 Steer；
5. 验证当前 Run terminal 后第二条启动新 Run；
6. 再次运行并 Stop，验证 Queue 保留 paused；
7. 重启 Runtime，验证 Queue snapshot 恢复但不自动执行；
8. 手动恢复并验证 exactly-once 消费；
9. 检查 Session JSON ledger、RunReports 和 conversation projection 一致。

## 24. 验收标准

功能只有同时满足以下条件才算完成：

1. 用户能在 active Run 期间继续输入并提交消息。
2. 默认提交产生 durable Queue Item。
3. 刷新页面后 pending Queue 仍存在。
4. “调整方向”能够把 Queue Item 绑定到当前 active Run。
5. Run 已 closing 时“调整方向”不会丢消息，而是保持 Queue。
6. Steer 不截断当前模型流或工具 effect。
7. Steer 在工具 settlement 后、下一模型请求前进入 canonical history。
8. 消费后的 Steer 能影响最新 directive 和上下文准备。
9. 当前 Run 与 Queue 启动的新 Run 各自有独立且 exactly-one RunReport。
10. Stop 后 active Run aborted、Queue paused 且消息保留。
11. approval 输入不会与 Queue/Steer 混淆；approval pending 时接收的 Steer 只在批准完成且工具 settlement 后消费。
12. 重复请求不会产生重复 Queue Item 或重复消费。
13. Runtime recovery 能重建 Queue，并把孤立 Steer 安全退回 nextRun。
14. semantic Queue events 在 backpressure 下不丢失。
15. workspace scope 和 Session ownership 无旁路。
16. 所有新增高风险竞态具有自动化测试。
17. 完整 typecheck、lint、test 和 Web build 通过。
18. 实施报告记录实际设计偏差、测试结果和剩余限制。

## 25. 实施顺序约束

开发时必须遵守以下顺序：

1. 先完成 ledger schema、pure reducer 和 repository 原子操作；
2. 再实现 executor safe boundary；
3. 再实现 Coordinator 和 HTTP adapter；
4. 最后开放 Web 运行中输入。

不得先用前端数组或 Runtime 内存数组模拟 Queue，再以后补持久化。那会形成第二份 truth，并使刷新、Stop、恢复和竞态测试全部失真。

如果实施中发现当前代码与本计划冲突，优先保持第 5 节不变量。类名和文件布局可以调整，但 Queue/Steer 的 Run 归属、持久化顺序、安全边界、幂等和恢复语义不得隐式削弱。
