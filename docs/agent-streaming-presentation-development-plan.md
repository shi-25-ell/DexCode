# DexCode Agent 流式输出与运行状态开发计划

## 1. 文档状态

- 状态：待实施
- 目标：建立可恢复、可校准、可观测的 Agent 流式输出体验
- 实施范围：模型事件归一、Run 生命周期、SSE 协议、会话投影、Web 运行态与测试
- 兼容要求：保留现有 `/api/conversation-runs` 路径、Session ledger、工具批准流程和终止语义
- 页面约束：不进行整体视觉重设计，只增加运行态、思考区和必要的交互结构

## 2. 背景与问题

DexCode 后端已经能产生普通文本、reasoning、工具状态、任务状态和最终结果等事件，但当前 Web 只消费其中一部分。普通 `chunk` 被直接追加到最后一个 assistant 气泡，`reasoning_chunk`、`tool_status`、`skill` 和权威 `result` 没有形成统一的前端状态语义。

这会造成以下问题：

1. 模型请求期间只有宽泛的“运行中”，用户无法区分准备上下文、请求模型、思考、生成回答、准备工具、执行工具和整理结果。
2. reasoning 即使由 provider 返回，也不会进入可见运行态。
3. `chunk` 没有稳定的 Run、message 和 content block 身份，只能依赖“追加到最后一个气泡”的位置猜测。
4. 一次完整模型响应和整个 Agent Run 没有在展示层明确区分；包含工具调用的 assistant 响应可能被误认为最终回答。
5. SSE 背压允许合并或丢弃高频 delta，但 Web 没有使用完整 committed message 或终态快照做权威校准。
6. 流结束后依赖重新查询 Session 才恢复一致状态，终态切换可能出现延迟、闪烁或短暂残缺。
7. 临时进度、长期会话记录和可审计终态没有清晰分层。

本次改造要解决的是完整运行体验和一致性问题，而不是只增加一个 spinner 或直接显示原始 reasoning。

## 3. 目标

### 3.1 产品目标

用户发送消息后，界面应立即并准确地展示当前阶段：

- 正在准备上下文……
- 正在请求模型……
- 正在思考……
- 正在生成回答……
- 正在准备工具……
- 正在执行工具……
- 等待批准……
- 正在重试……
- 正在整理最终结果……

当 provider 返回可展示的 reasoning 时，Web 在当前 Run 内提供可折叠“思考过程”；当 provider 不返回 reasoning 时，阶段提示仍然完整可用。

最终回答必须在原位置从 live draft 平滑转为 committed assistant message，不删除后重新打印，不与 reasoning 混合，也不因丢失部分 delta 而残缺。

### 3.2 工程目标

1. 明确区分 Run、model turn、assistant message、content block 和 tool call。
2. 为所有流事件提供稳定身份、顺序和终止语义。
3. 建立一个深 `RunPresentation` Module，集中处理临时投影、幂等、校准、工具更新和终态清理。
4. 保持 Session ledger 作为已提交历史和恢复证据的权威来源。
5. 让完整 committed message 与 terminal snapshot 成为丢 delta 后的校准来源。
6. 保留 abort、批准、重试、背压、失败和中断恢复的真实语义。
7. 用 Interface 级测试覆盖整个事件状态机，避免 UI 通过位置和字符串猜测状态。

## 4. 非目标

本次开发不处理：

- 整体页面布局、品牌或视觉风格重设计。
- 新模型管理系统或运行中切换模型。
- steer 消息队列。
- 多 Agent 协作界面。
- 将原始 chain-of-thought 作为长期聊天正文保存。
- 为所有 provider 强行伪造 reasoning。
- 修改工具授权矩阵或绕过现有批准策略。
- 用 Web 日志替代 Session ledger、RunReport 或工具终态证据。
- 跨 Runtime 进程的分布式事件恢复。

## 5. 核心语义

### 5.1 四个生命周期层级

```text
Run
  └─ Model Turn 1
       ├─ Assistant Message 1
       │    ├─ reasoning block
       │    ├─ text block
       │    └─ tool call block
       └─ Tool Execution
  └─ Model Turn 2
       └─ Assistant Message 2（最终回答候选）
```

- **Run**：一次用户请求驱动的完整 Agent 执行，可能包含多个 model turn 和工具批次。
- **Model Turn**：一次模型请求及其完整 assistant 响应。
- **Assistant Message**：一个可提交的完整模型消息，可能只包含工具调用，并不等于最终回答。
- **Content Block**：assistant message 内的 text、reasoning 或 tool input 流。
- **Tool Call**：由稳定 `callId` 标识的工具执行生命周期。

只有 `run_finished` 才表示整个 Run 终止。`assistant_message_committed` 只表示一次完整模型响应已经形成。

### 5.2 最终回答判定

1. assistant message 仍在流式生成时只作为 draft。
2. 完整消息提交后，如果包含 tool call，Run 继续，该文本属于执行过程而不是最终回答。
3. 完整消息提交后，如果没有 tool call，它成为 final candidate。
4. Session 和 RunReport 成功提交后才发送 `run_finished(completed)`，并指定 `finalMessageId`。
5. Web 收到终态后将 final candidate 提升为最终回答，并使用权威 snapshot 或 revision 校准。
6. `limited`、`failed`、`aborted` 时保留已经生成的可读正文，但必须标记未正常完成，未结算工具不能显示成功。

### 5.3 临时内容与长期历史

临时运行态包括：

- token delta。
- reasoning draft。
- spinner 和阶段提示。
- 未完成的 tool input。
- 高频 tool progress。
- 展开/折叠状态。

长期历史包括：

- 完整 user/assistant/tool message。
- 工具和批准终态。
- Run 完成、失败、受限或取消记录。
- usage、错误摘要和恢复证据。

临时内容不直接写入 Session ledger。完整消息和语义终态按现有 commit-before-effect、tool settlement 和 run terminal 顺序持久化。

## 6. 核心不变量

1. **稳定身份**：每个事件都能定位到唯一 `runId`；内容事件还必须带 `messageId` 和 `contentIndex`，工具事件必须带 `callId`。
2. **严格顺序**：同一 Run 的事件使用单调递增 `seq`；重复事件幂等，倒序或跳跃必须可检测。
3. **完整消息权威**：delta 只负责即时反馈，`assistant_message_committed` 的完整消息负责校准。
4. **终态持久化优先**：`run_finished(completed)` 只能在 Session、RunReport 和必要工具终态提交成功后发送。
5. **消息结束不等于 Run 结束**：包含 tool call 的 committed assistant message 不能让 Web 切回 idle。
6. **reasoning 与回答分离**：reasoning 不拼进最终 Markdown，也不伪装成 assistant 正文。
7. **无 reasoning 仍可观测**：阶段状态由 Agent 生命周期产生，不依赖 provider 是否输出 reasoning。
8. **批准状态准确**：等待批准时显示 `waiting_approval`，不得显示为 thinking 或 running tool。
9. **工具原位更新**：同一 `callId` 的 queued、running、progress、settled 只更新一张 Tool Card。
10. **丢 delta 可恢复**：任何允许被背压丢弃的内容，必须能由后续完整消息或终态 snapshot 恢复。
11. **取消保留证据**：abort 后保留已提交消息、已完成工具和中断原因，不把未完成工具标记为成功。
12. **安全展示**：阶段 note、错误和工具摘要不得泄露宿主路径、密钥、完整原始工具输出或 provider 原始响应。
13. **有界资源**：服务端队列、重放缓冲、前端 reasoning draft 和 tool progress 都必须有明确上限。

## 7. Module、Interface 与 Seam 设计

### 7.1 总体数据流

```text
Provider Adapter
  -> ModelEvent
  -> Agent Run lifecycle
  -> RunEvent V2
  -> SSE Adapter
  -> RunPresentation Module
  -> ConversationPage render

Session ledger
  -> conversation-view projection
  -> committed conversation snapshot
  -> RunPresentation terminal reconciliation
```

SSE 是 Runtime 与 Web 之间的远程 owned seam。协议类型、顺序、不变量和终止方式属于该 Interface，不应散落在 HTTP handler、React reducer 和具体卡片中。

### 7.2 `RunEvent V2` Interface

建议将浏览器安全的协议契约独立到：

```text
packages/run-protocol/
  contracts.ts
  validation.ts
  legacy-adapter.ts
  contracts.test.ts
```

事件 envelope：

```ts
export type RunEventEnvelope<T extends RunEventPayload = RunEventPayload> = {
  version: 2;
  runId: string;
  seq: number;
  at: string;
  event: T;
};
```

核心 payload：

```ts
export type RunPhase =
  | 'preparing_context'
  | 'requesting_model'
  | 'thinking'
  | 'answering'
  | 'preparing_tool'
  | 'waiting_approval'
  | 'running_tool'
  | 'retrying'
  | 'finalizing';

export type RunEventPayload =
  | { type: 'run_started'; sessionId: string }
  | { type: 'run_phase_changed'; phase: RunPhase; note?: SafeRunNote }
  | { type: 'assistant_message_started'; turn: number; messageId: string }
  | { type: 'assistant_content_delta'; messageId: string; contentIndex: number; kind: 'text' | 'reasoning' | 'tool_input'; delta: string }
  | { type: 'assistant_message_committed'; turn: number; message: CommittedAssistantMessage }
  | { type: 'tool_started'; callId: string; presentation: ToolPresentation }
  | { type: 'tool_progress'; callId: string; presentation: ToolPresentation }
  | { type: 'tool_finished'; callId: string; presentation: ToolPresentation }
  | { type: 'approval_requested'; request: ToolApprovalRequest }
  | { type: 'approval_resolved'; approvalId: string; decision: ApprovalOption }
  | { type: 'run_finished'; terminal: RunTerminal; conversationRevision: number; finalMessageId?: string; conversation: ConversationViewSnapshot };
```

`CommittedAssistantMessage` 必须携带：

- `messageId`、`turn`。
- 完整 content blocks 或规范化 text。
- 完整 tool calls。
- `finishReason`。
- 可用时的 usage。
- 是否发生展示截断；截断不得影响 ledger 中的权威消息。

### 7.3 协议兼容 Adapter

保留 `/api/conversation-runs`。Web 请求显式声明流版本，例如：

```text
X-DexCode-Stream-Version: 2
```

- V2 Web 使用 `RunEventEnvelope`。
- 未声明版本的调用方继续使用现有事件形状。
- `legacy-adapter.ts` 只做确定性转换，不包含 Run 状态判断。
- 兼容路径必须有契约测试；移除旧格式只能作为单独的 breaking change。

两个协议 Adapter 共用同一个 Agent Run 实现，不能复制执行逻辑。

### 7.4 `RunPresentation` 深 Module

建议新增：

```text
apps/web/src/conversation/run-presentation.ts
apps/web/src/conversation/run-presentation.test.ts
```

外部 Interface 保持很小：

```ts
export type RunPresentation = {
  committedItems: ConversationItem[];
  activeRun: ActiveRunView | null;
  status: 'idle' | 'running' | 'waiting' | 'failed';
  lastSeq?: number;
};

export function hydrateRunPresentation(snapshot: ConversationSnapshot): RunPresentation;
export function reduceRunEvent(state: RunPresentation, envelope: RunEventEnvelope): RunPresentation;
```

Module 内部负责：

- seq 校验和幂等。
- assistant draft 的创建、增量更新和完整消息校准。
- reasoning/text/tool input 的 content block 路由。
- tool card 原位更新。
- phase 与页面 status 映射。
- approval 请求和解决。
- final candidate 判定。
- terminal snapshot 原子替换。
- abort、failure、limited 和中断展示。
- 资源上限和截断标记。

`ConversationPage` 只渲染 `RunPresentation`，不再理解事件顺序或 final 判定规则。

### 7.5 Provider reasoning 能力

Model descriptor 增加明确能力信息：

```ts
export type ReasoningCapability = {
  supported: boolean | 'unknown';
  requestMode: 'provider_default' | 'enabled' | 'disabled';
};
```

规则：

- provider 明确支持时，可根据配置请求 reasoning。
- 能力未知时不伪造支持，也不因缺少 reasoning 判定失败。
- 适配器只把 provider 明确提供的 reasoning 字段归一为 reasoning block。
- reasoning 请求失败时按模型错误语义处理，不静默换成另一个模型。
- UI 只有收到 reasoning block 后才显示可展开内容，否则只显示阶段和耗时。

## 8. Agent Core 改造

### 8.1 Run 与 Turn 事件

`runTask()` 开始后发送 `run_started` 和 `preparing_context`。每次模型 attempt 前发送 `requesting_model`，发生 retry 时发送带安全原因的 `retrying`。

每个 model turn 创建稳定 `messageId`：

```text
runId + turn -> messageId
```

收到第一段 reasoning/text/tool input delta 时分别切换到 `thinking`、`answering` 或 `preparing_tool`。完整模型响应通过严格 accumulator 后发送 `assistant_message_committed`。

### 8.2 Commit 顺序

一次包含工具调用的模型响应必须遵守：

```text
assistant_message_committed
  -> ledger assistant commit
  -> tool_started intent commit
  -> tool effect
  -> tool_finished outcome commit
  -> 下一次 model turn
```

如果当前实现要求 ledger assistant commit 先于 UI committed 事件，则先持久化，再发送事件；计划实施时必须选定一个顺序并通过测试固定。推荐顺序是“持久化成功后发送 committed”，避免 UI 展示无法恢复的权威消息。

工具执行前发送 `tool_started`；只有真实 effect 开始后才显示 `running_tool`。工具参数仍在流式形成时使用 `preparing_tool`，不能提前显示“正在执行”。

### 8.3 Run 终止

Executor 返回后：

1. 构建 RunReport。
2. 原子提交 Session terminal state。
3. 重新加载或直接取得本次提交后的 Session revision。
4. 生成权威 `ConversationViewSnapshot`。
5. 发送唯一的 `run_finished`。
6. drain SSE writer 后关闭响应。

`run_finished` 后禁止再发送该 Run 的语义事件。重复 terminal 调用必须由 run settlement 幂等保护吸收。

## 9. Web 产品实现

### 9.1 活动区

当前 Run 在时间线底部显示一个活动区，不写入 committedItems。结构包含：

- 当前阶段与动画指示。
- 阶段耗时。
- 可选的 reasoning 折叠区。
- 当前 assistant text draft。
- 运行中工具卡和批准卡。

活动区不是第二套聊天记录。draft commit 后在原位置转为正式 assistant message，工具卡按 `callId` 继续更新。

### 9.2 Reasoning 展示

默认规则：

- 默认折叠，标题为“思考过程”或“思考了 N 秒”。
- 运行中可以展开查看 provider 提供的 reasoning。
- text 开始后自动折叠，但不强制关闭用户手动展开的当前块。
- Run 结束后从普通会话时间线移除原始 reasoning；仅保留“思考耗时”等非敏感元数据。
- 不提供 reasoning 时不显示空卡片。
- Markdown 使用现有安全渲染路径；不得支持原始 HTML。

如果未来需要持久化 reasoning，必须另行增加显式策略、数据分类、导出行为和清理方案，不在本次默认范围内隐式开启。

### 9.3 Assistant 正文

- text delta 更新当前 `messageId/contentIndex` 对应的 draft。
- Markdown 渲染允许按动画帧或短时间窗口批量刷新，避免每个 token 触发整页重渲染。
- committed message 到达时原子替换 draft，不新增重复气泡。
- 如果 committed message 带 tool call，其 text 作为执行过程段保留或折叠，不能标记为最终回答。
- `run_finished.finalMessageId` 指定最终复制按钮和最终回答边界。
- terminal snapshot 与本地投影不一致时，以 snapshot 为准，并记录开发诊断信息。

### 9.4 状态提示

状态文案由 `RunPhase` 映射，不直接展示后端自由字符串：

| Phase | 默认文案 |
| --- | --- |
| `preparing_context` | 正在准备上下文…… |
| `requesting_model` | 正在请求模型…… |
| `thinking` | 正在思考…… |
| `answering` | 正在生成回答…… |
| `preparing_tool` | 正在准备工具…… |
| `waiting_approval` | 等待批准…… |
| `running_tool` | 正在执行工具…… |
| `retrying` | 正在重试…… |
| `finalizing` | 正在整理最终结果…… |

后端 note 只能提供经过白名单处理的补充信息，例如安全的工具展示名或重试次数，不能替代 phase。

### 9.5 滚动和交互

- 用户位于底部时跟随活动区高度和正文增长。
- 用户主动上滚后停止强制跟随，保留“回到底部”。
- terminal reconciliation 不应把滚动位置突然跳回顶部。
- reasoning 展开不得覆盖停止按钮、批准按钮或输入框。
- 停止按钮在 Run settlement 前保持可用；收到 terminal 后恢复发送按钮。
- 窄屏、键盘、触摸和屏幕阅读器必须能访问 phase、reasoning 和工具状态。

## 10. 背压、性能与资源上限

### 10.1 服务端

- 延续 bounded SSE writer 和 `res.write()` drain。
- 相邻同类 delta 可以合并，但必须保持 messageId、contentIndex 和 kind 一致。
- 只有能被 committed message 或 terminal snapshot 恢复的 delta/progress 才允许丢弃。
- `assistant_message_committed`、tool terminal、approval、error 和 `run_finished` 属于不可丢语义事件。
- semantic backlog 溢出继续 abort，不允许静默丢失终态。

### 10.2 前端

- delta 按 animation frame 或不超过 50ms 的窗口批量进入 React state。
- reasoning 展示缓冲和 tool progress 设定最大字符数；达到上限时标记“展示已截断”，不能无界增长。
- 已完成长工具输出继续使用折叠和受控 raw output 展示。
- terminal snapshot 只做一次原子 hydrate，避免逐项重放导致抖动。
- `RunPresentation` reducer 保持纯函数，禁止在 reducer 中发请求、写 storage 或操作 DOM。

## 11. 断线、刷新与恢复

### 11.1 P0 恢复语义

- 流正常结束时，`run_finished` 自带权威 conversation snapshot，无需等待第二次 GET 才完成界面校准。
- 页面刷新时先加载 committed conversation snapshot。
- Session 存在 active Run 但无法恢复 live draft 时，显示“上次运行已中断”或当前可证明的状态，不能伪造仍在 thinking。
- idempotent replay 返回同样的 terminal snapshot，不重复追加 user/assistant/tool item。

### 11.2 P1 事件续传

增加有界 active-run replay buffer：

- 服务端按 `runId + seq` 保存最近事件窗口。
- Web 保存 `lastSeq`，断线后从 `afterSeq` 继续。
- 缓冲仍可覆盖时重放缺失事件。
- 缓冲已覆盖时发送 active snapshot 或要求客户端重新 hydrate committed snapshot。
- Runtime 重启后不恢复未提交 token delta；Session recovery 将未完成 Run 投影为 interrupted。

续传不得重新执行模型请求或工具副作用。

## 12. 分阶段实施

### 阶段 0：基线与契约冻结

任务：

- 为当前纯正文、多轮工具、reasoning、批准、abort、retry、backpressure 和 terminal 行为补 characterization tests。
- 固定现有 `/api/conversation-runs`、Session materialization 和 idempotent replay 行为。
- 建立带 reasoning、无 reasoning、tool-only assistant、partial text、错误和中断的 Fake Model fixtures。
- 记录当前 Web 的首次可见反馈、最终重复和刷新恢复行为，作为回归基线。

完成标准：后续每项语义变化都有明确测试对照，不依赖人工观察判断。

### 阶段 1：RunEvent V2 与生命周期

任务：

- 新建 `packages/run-protocol`，定义 envelope、payload、validator 和兼容 Adapter。
- Agent Core 生成稳定 run/message/call ID 和递增 seq。
- 增加 run phase、assistant started/delta/committed、tool start/progress/finish 和唯一 terminal。
- Runtime 支持显式流版本选择，保留原 endpoint。
- writer 明确 droppable 与 semantic 事件分类。

完成标准：协议契约测试证明顺序、幂等、终态唯一和背压分类；Web 暂未改造时旧路径仍可使用。

### 阶段 2：RunPresentation 深 Module

任务：

- 新建纯 reducer 和 Interface 级测试。
- 实现 committedItems、activeRun、assistantDraft、toolsByCallId、phase 和 lastSeq。
- 实现完整消息校准、final candidate、terminal snapshot 原子替换。
- 覆盖 duplicate、out-of-order、seq gap、丢 delta、tool-only turn、abort 和 failure。
- 删除 `ConversationPage` 中重复的事件状态判断，只保留渲染和用户操作。

完成标准：给定 snapshot 与事件序列，Module 输出唯一确定的视图；内部实现变化不要求页面测试重写。

### 阶段 3：运行态 UI

任务：

- 增加活动区、phase 指示、耗时和 reasoning 折叠视图。
- assistant draft 与 committed message 原位切换。
- Tool Card 使用 start/progress/finish 原位更新。
- 批准卡与 `waiting_approval` phase 对齐。
- 保留现有页面布局、复制逻辑、自动滚动和响应式结构。

完成标准：用户在任意模型能力下都能看到准确阶段；reasoning 不进入最终回答；纯正文 commit 不闪烁、不重复。

### 阶段 4：终态校准与恢复

任务：

- `run_finished` 携带提交后的 conversation revision 和 snapshot。
- 正常结束不再依赖额外 GET 才获得权威结果。
- 完成 idempotent replay、刷新、中断和不可恢复 draft 的投影。
- 增加 active-run replay buffer 和 afterSeq 续传。
- 验证断线不会重复模型请求、工具副作用或批准决定。

完成标准：人工丢弃任意可丢 delta 后，最终视图仍与 ledger projection 完全一致；刷新和重连不重复消息。

### 阶段 5：Provider 能力与发布收尾

任务：

- Model descriptor 暴露 reasoning capability 和 request mode。
- 验证支持、未知、不支持和 reasoning 错误四种路径。
- 增加 reasoning 展示上限、耗时、截断提示和可访问性。
- 运行完整 lint、单元、集成、Web、构建和浏览器验证。
- 更新架构、协议、故障恢复和运维说明。
- 兼容格式的移除不包含在本阶段；另行评估外部调用方。

完成标准：默认配置不依赖特定 provider；开启 reasoning 不改变工具、ledger、abort 和安全语义。

## 13. 测试计划

### 13.1 协议契约测试

- `run_started` 是 Run 的第一个语义事件。
- seq 单调递增，重复事件幂等。
- delta 只能引用已 started 的 message。
- committed message 与 draft 使用同一 messageId。
- tool progress 只能引用已 started 且未 finished 的 callId。
- approval requested/resolved 正确配对。
- `run_finished` 唯一且为最后一个语义事件。
- legacy 与 V2 Adapter 不改变正文、工具终态和错误含义。
- semantic 事件在背压下不可丢。

### 13.2 Agent Core 集成测试

- 纯正文：started -> delta -> committed -> terminal。
- reasoning -> text：phase 从 thinking 切换到 answering。
- reasoning -> tool -> result -> reasoning -> final：只有最后 terminal 后回到 idle。
- tool-only assistant message 不产生空最终回答。
- 工具参数慢速生成时先 preparing_tool，effect 开始后才 running_tool。
- waiting approval 不继续执行 effect。
- retry 保留 attempt 证据，不重复已完成工具。
- model length、invalid response、timeout、abort 和 infrastructure failure 终止准确。
- Session finish 失败时不得发送 completed terminal。

### 13.3 RunPresentation Interface 测试

- delta 更新 draft 而不是 committedItems。
- committed 完整消息校准缺失或截断 delta。
- committed tool turn 后 activeRun 保持运行。
- finalMessageId 决定最终复制按钮边界。
- duplicate committed/terminal 不重复 item。
- seq gap 触发 resync 标记，不猜测缺失语义。
- terminal snapshot 原子替换本地投影。
- failed/limited/aborted 保留可读部分并显示真实终态。
- reasoning 默认不进入 hydrate 后的长期历史。

### 13.4 Web 测试

- 各 phase 显示正确中文文案。
- provider 无 reasoning 时不出现空思考区。
- reasoning 默认折叠，可通过键盘展开。
- text 开始后活动状态和正文位置稳定。
- tool progress 原位更新，时间线 item 数量不随 tick 增长。
- 等待批准时按钮、停止操作和状态均可访问。
- 用户上滚后不被流式更新强制拉到底部。
- terminal reconciliation 不闪烁、不重复、不破坏复制内容。
- 窄屏、长 Markdown、代码块、表格和长 reasoning 不破版。

### 13.5 恢复与压力测试

- 丢失任意一段 text/reasoning delta 后由 committed message 恢复。
- 慢客户端触发 delta coalescing 时语义终态完整。
- semantic backlog overflow 会 abort 并产生可恢复失败证据。
- SSE 中断后 afterSeq 重放不重复 item。
- replay buffer 覆盖后回退到 snapshot resync。
- Runtime 重启后 active Run 被标记 interrupted。
- 超长 reasoning 和高频 tool progress 不造成无界内存增长。
- 多个 Session 并发时 runId、seq、messageId 和 callId 不串流。

## 14. 主要文件改动清单

| 路径 | 计划改动 |
| --- | --- |
| `packages/run-protocol/` | 新增 V2 事件契约、校验、兼容 Adapter 和测试 |
| `packages/llm-client/types.ts` | 补充 provider reasoning capability 和必要的 content block 语义 |
| `packages/llm-client/openai.ts` | 归一 reasoning/text/tool input，保留完整消息终态 |
| `packages/agent-core/executor.ts` | 生成 message/block/tool 生命周期、phase 和 committed 事件 |
| `packages/agent-core/index.ts` | Run start/finalizing/terminal、Session commit 顺序和 snapshot 组装 |
| `packages/shared/types.ts` | 迁移共用 Run、terminal、message 和能力描述类型 |
| `packages/session-store/index.ts` | revision、terminal 幂等和 interrupted recovery 适配 |
| `packages/conversation-view/` | 权威 committed snapshot、final message 和中断投影 |
| `apps/runtime/server.ts` | SSE 版本协商、seq、backpressure 分类、terminal snapshot 和 replay buffer |
| `apps/web/src/api.ts` | 请求 V2、解析 envelope、afterSeq/resync 支持 |
| `apps/web/src/types.ts` | 浏览器视图类型迁移，删除重复的宽泛 StreamEvent 判断 |
| `apps/web/src/conversation/run-presentation.ts` | 新增深 Module 和纯 reducer |
| `apps/web/src/conversation/conversation-page.tsx` | 改为渲染 RunPresentation，删除事件顺序猜测 |
| `apps/web/src/conversation/run-activity.tsx` | 新增 phase、耗时、reasoning 和 draft 活动区 |
| `apps/web/src/conversation/tool-card.tsx` | 接入 tool start/progress/finish 原位更新 |
| `apps/web/src/styles.css` | 增加活动区和 reasoning 的必要样式，不重做整体页面 |

## 15. 验收门槛

开发完成必须同时满足：

1. Web 不再通过“最后一个 item 是否为 assistant”判断 delta 归属。
2. Run、message、content block 和 tool call 都有稳定身份；同一 Run 事件有可验证顺序。
3. 一次 model message commit 与整个 Run terminal 在协议和 UI 中明确分离。
4. 首个阶段事件在模型网络请求前到达，长时间无 token 时仍有准确反馈。
5. provider 有 reasoning 时可折叠展示；无 reasoning 时产品状态不降级为无反馈。
6. reasoning 不进入最终 Markdown，默认不进入 Session export 和刷新后的长期历史。
7. 纯正文 live draft 到 committed message 的转换无闪烁、无重复、无清空重绘。
8. 多轮工具 Run 只有在唯一 terminal 后回到 idle。
9. 丢失所有可丢 delta 后，terminal snapshot 仍能恢复与 ledger projection 一致的最终视图。
10. abort、failure、limited、批准拒绝和中断刷新均保留真实证据，不伪造成功。
11. SSE semantic 事件不可丢；队列和前端 draft 资源有界。
12. `/api/conversation-runs`、现有 Session 和工具批准行为保持兼容。
13. 页面桌面、窄屏、键盘、触摸、长内容和自动滚动验证通过。
14. `npm run lint`、`npm test`、`npm run test:web`、`npm run build:web` 和 dev smoke 全部通过。

## 16. 推荐提交拆分

1. `test(stream): lock current run and web projection behavior`
2. `feat(protocol): add versioned run event contracts`
3. `refactor(agent): emit message and tool lifecycles`
4. `feat(runtime): sequence events and reconcile terminal snapshots`
5. `feat(web): add run presentation state module`
6. `feat(web): render phases reasoning and assistant drafts`
7. `feat(stream): resume active runs from bounded replay`
8. `test(stream): cover backpressure recovery and browser states`
9. `docs(stream): document protocol recovery and operations`

每个提交必须保持可编译、可测试。协议、Agent 生命周期、前端投影和视觉展示分开提交，避免把错误定位压缩到一个大改动中。
