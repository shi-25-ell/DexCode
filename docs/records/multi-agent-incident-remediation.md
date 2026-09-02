# Multi-Agent 失控事件修复记录

> 记录状态：修复与受控复跑已完成
> 本记录保存事件、修复和验证证据；当前 Multi-Agent 架构见 [`../architecture.md`](../architecture.md)。

## 1. 修复结论

目标会话 `session-e4661603-47a9-4271-8aed-04da5522ed61` 暴露的失控链路已经按后端状态机、通知交付、预算、会话级停止和前端权威状态五个层次修复。

最终结果：

- 原始复杂任务已在受控监控下完成，三个并行设计方案均产出完整结果，并完成 Depth、Locality、Seam 三轴比较和明确推荐。
- Child 的失败、受限、中断和完成均按终态处理；同一调用 Main Run 不会重复取得同一终态结果。
- 后台完成结果不再插入正在生成的 Main Run，而是进入新的持久化 Main Run，避免长请求期间的通知被模型忽略或错误合并。
- 前端在“Main 已结束、仅 Child 后台运行”时仍展示会话级停止按钮；真实点击后 Main、Child、待处理通知和自动唤醒均被停止。
- 停止闸门持久化，停止后的 16 秒连续采样中没有自动 Run 或 Child 复活。

## 2. 事件复盘

失控不是单点错误，而是以下条件串联后的结果：

1. 原始 Main Run 在 Child 仍运行时结束，后续工作依赖后台完成通知。
2. Child 使用隐式 120 秒模型请求超时，复杂源码任务在约 130–144 秒处失败；失败结果被笼统展示为“未完成”。
3. 通知 Main Run 反复调用 `wait_agent`。目标 Run 早已终态，但相同终态被反复当作新进展返回。
4. 通知链没有每 Run 操作预算、连续无 revision 进展检测或自动 Run 链上限。
5. 停止 API 只认识一个 Run ID；前端按钮又依赖本地 SSE 和本地活动 Run。当 Main 输出来自后台通知链或只剩 Child 运行时，按钮可能消失或命中过期 Run。
6. Child 结束后会生成新通知；旧停止流程没有先持久化会话停止闸门，因此停止过程中仍可能产生下一次 Main 唤醒。

失控记录中的量化证据：通知 Run 共执行 96 个模型轮次，累计约 1130 万 token，调用 `wait_agent` 85 次、`spawn_agent` 14 次、`followup_agent` 6 次。85 次等待没有一次超时，其中 84 次返回已经终态的结果。因此，主因不是等待时间过长，而是终态重复交付和缺少无进展熔断。

## 3. 已落地的后端修复

### 3.1 终态与一次性交付

- `completed`、`failed`、`interrupted`、`limited` 都是明确终态。
- Agent Manager 按调用 Main Run 保存已观察的 Child Run；重复读取返回 `status: no_change`、`code: already_observed`，不再重放结果。
- Agent Tree revision 用于判断编排操作是否产生真实状态进展。
- 终态先写入 Agent journal，再产生完成通知，恢复过程不会把终态覆盖回运行态。

### 3.2 后台通知使用独立 Main Run

- 每次最多合并 4 条当前待处理通知，不再局限于一个 delegation group。
- 通知只在新的持久化 Main Run 开始时消费；不会在另一个 Main Run 的模型请求之间作为临时 steer 注入。
- 通知提示明确声明所列 Run 均已终态，禁止再次 wait 或声称仍在运行。
- 连续自动通知 Main Run 最多 4 个；达到上限后保留未消费通知并停止自动扩张。

这项修复是在原任务受控复跑中新增发现的。旧实现确实把两个完成通知追加进活动 Run，但模型连续忽略了它们，最后错误声称“仍在等待”。独立 Run 消除了“消息已经持久化但当前生成过程未可靠吸收”的竞态。

### 3.3 编排预算与熔断

- 每个 Main Run 最多 32 次编排操作。
- 连续 3 次操作没有 Agent Tree revision 进展时打开熔断。
- 执行器收到熔断结果后以 `limited / orchestration_stalled` 结束，不再让模型消耗剩余轮次继续调用编排工具。
- 同时运行 Child 上限为 4；每个 Main Run 最多创建 8 个 Child 身份；一个会话最多保留 64 个历史身份。
- “每 Main Run 8 个”替代了“整个会话终身 8 个”。目标会话修复前已经保留 8 个历史身份，终身限制会让任何安全重试都无法开始；独立的 64 条历史上限仍防止无限增长。

### 3.4 Child 长任务预算

内置 Child Definition 当前默认值：

| 预算 | 值 |
| --- | ---: |
| 模型轮次 | 64 |
| 模型尝试 | 80 |
| 单次模型请求超时 | 300 秒 |
| Run 总时长 | 900 秒 |
| Run 总 token | 1,500,000 |
| 最终结果 | 64 KiB |

历史会话中持久化的内置 Definition 在 follow-up 时会继承当前安全预算，避免继续使用旧的 120 秒隐式超时。执行器同时新增总 token 检查，并把耗尽原因区分为模型请求超时、总时长、总 token、模型轮次和输出长度。

### 3.5 会话级停止

新增 `POST /api/conversations/:sessionId/commands` 的 `stop_all`：

1. 持久化 `agent_session_halted`。
2. 取消延迟通知唤醒。
3. 停止当前 Main Run chain。
4. 中止并等待全部 Child Run 落终态。
5. 消费停止期间产生的待处理通知。
6. 返回 Main 和 Agent Tree 的权威快照。

该命令按 Session ID 定位控制域，不依赖前端持有的 Run ID。新的显式用户 Run 会记录 `agent_session_resumed`；后台通知无权解除停止闸门。

## 4. 已落地的前端修复

- 停止按钮由本地流、后端 `activeRun` 和 Agent Tree 中任一 `running/stopping` Child 共同决定。
- Agent Tree 在 Main 或 Child 活动期间持续轮询，避免 SSE 断开后页面失明。
- 按钮文案改为“停止全部运行”；点击后立即中止本地 SSE，再调用会话级 `stop_all`。
- 后端响应返回后，前端用权威 Agent Tree 执行 replace，并刷新会话、Agent 和会话列表查询。
- 停止期间输入框禁用，按钮显示“正在停止”；失败会保留具体错误，不静默当作成功。
- `total_token_limit` 和 `orchestration_stalled` 有独立终态文案。

React 状态只保留必要的异步状态；按钮可见性、后台活跃状态和轮询条件均从服务器快照与现有状态派生，避免再增加一套容易漂移的镜像状态。

## 5. 验证记录

### 5.1 原复杂任务受控复跑

复跑前没有直接复现失控，而是先完成单元测试、预算、熔断、会话级停止和前端按钮修复。独立监控器每 5 秒采样 Main、运行 Child、身份总数、待处理通知、Agent Tree revision 和 token；阈值为运行 Child 超过 4、历史身份超过基线 4 个或 Main Run 异常增长时立即 `stop_all`。

受控复跑数据：

| Child | 耗时 | token | 结果 |
| --- | ---: | ---: | --- |
| design-common-path-v2 | 124 秒 | 168,592 | completed |
| design-min-interface-v2 | 210 秒 | 617,588 | completed |
| design-flexible-extension-v2 | 238 秒 | 912,844 | completed |
| 旧 min-interface 的一次 follow-up | 169 秒 | 203,342 | completed |
| 旧 flexible-extension 的一次 follow-up | 160 秒 | 204,420 | completed |

三个新 Child 真正并行启动。运行 Child 峰值为 4，Agent 身份从历史基线 8 增至 11 后保持不变，没有继续增殖。所有五个实际 Child Run 均自然完成，没有再出现 120 秒请求超时。

主任务最终输出完整三案比较：Depth 上 A 最深，Locality 上 A/B 接近，Seam 上 B 最严谨；明确推荐 B（flexible-extension）为主干，并吸收 C 的 `buildSkillsBlock` 收编和 A 的死面清理。最终综合 Run 自然完成，输出 4,611 字符。

### 5.2 独立通知 Run 真实集成

修复通知竞态后，执行了一个只有 1 个 Child 的低风险真实用例：

- 用户 Main Run 创建 `notify-test-child` 后自然结束，没有调用 wait/follow-up。
- Child 只读 `package.json`，3 秒自然完成，4,626 token，返回 `FRESH_NOTIFY_CHILD_OK name=dexcode`。
- Child 终态后 435 ms 启动新的 Main Run，origin 明确为该通知 ID。
- 新 Main Run 合并结果并输出 `FRESH_NOTIFICATION_DELIVERED`，自然结束。
- 全程只有 1 个 Child、1 个通知 Main Run，没有重复结果或额外派生。

### 5.3 前端停止真实集成

停止回归专门覆盖原故障形态：Main Run 已自然结束，但一个 Child 仍在后台运行。

- 此时页面仍能找到且点击“停止全部运行”。
- 点击后 Child 在 15 秒处以 `interrupted / user_abort` 落终态。
- 后端立即返回 `activeRun=null`、运行 Child 0、待处理通知 0、`halted=true`。
- 之后每 5 秒采样一次，共 4 次；四次 revision 均为 686，没有 Main、Child 或通知复活。
- 停止后按钮消失，页面与权威快照一致。

### 5.4 自动化与静态检查

- 后端测试：158/158 通过。
- Web 测试：68/68 通过。
- TypeScript/ESLint：通过。
- Web 生产构建：通过。
- 宽屏浏览器：无 console error/warning；空闲时不显示停止按钮，Main 或仅 Child 活动时显示，停止后隐藏。

## 6. 保留的保护边界

- 系统仍允许 Main 自由组合 spawn、wait、follow-up 和后台执行，不把开放编排改成固定工作流。
- 保护机制约束的是无进展、并发、单 Run 创建量、历史身份量、通知链长度和资源预算，而不是具体任务形态。
- 自动通知链达到上限时会停止自动处理并保留状态，等待显式用户 Run；不会静默丢失结果，也不会自行无限重启。
- 会话停止是持久控制状态。需要继续时必须由新的用户消息显式恢复，这一取舍优先保证紧急停止的可靠性。

## 7. 分步提交

- `e0163e7`：保存事件证据与修复计划。
- `4c5fe85`：终态一次性交付、编排熔断、会话级停止和后端测试。
- `4bac5dc`：前端权威状态、会话级停止按钮和 Web 测试。
- `cad4cd3`：长任务预算续租、每 Main Run 身份容量和历史上限。
- `c5ce03d`：完成通知改为独立 Main Run，并跨 delegation group 有界合批。

## 8. 等待期恢复与 Child 上下文压缩补充修复

### 8.1 新发现的等待期竞态

后续真实复跑发现，后台 Agent 通知已经能启动新的 Main Run，但页面仍可能把权威快照中的活动 Run 当成一次无法恢复的中断：

1. 页面轮询得到 `state: running/waiting` 与 `activeRun` 时，旧的 hydrate 逻辑无条件生成“上次运行已中断”错误卡片。
2. Agent 完成通知创建的 Main Run 没有原始浏览器请求作为订阅者；页面虽然能轮询到它，却没有接入它的 V2 事件流。
3. 等待期间提交的 Steer 已进入持久化队列，但页面收不到 `user_message_committed`，只能等最终快照刷新后才看到消息。

修复后，带有权威 `activeRun` 的运行中快照只恢复活动 Run 骨架，不再伪造中断；只有运行中快照缺少 `activeRun` 时才展示真实的恢复失败。Runtime 为现存 V2 Run 增加按 Run ID 订阅与 replay 接口，Web 检测到“后端有活动 Run、本地没有流”时自动接入，并继续使用同一套事件 reducer 处理消息、工具、终态和重连去重。后台通知 Run 不再因为浏览器连接关闭而被停止。

### 8.2 Child 复用共享上下文引擎

Child 原先显式使用 `isolated` 上下文策略，绕过 Main 的四层上下文整理。现在 Child 与 Main 共用同一个 Context Engine 和策略实现，但以独立的 `ContextOwner` 运行：

- Main owner 为 Session；Child owner 为 Session + Agent ID。
- manifest、provider usage、摘要与 artifact 生命周期都携带 owner，缓存只在同一 owner 内复用。
- Session Repository 允许可信的 Child 上下文记录与活动 Main Run 并发追加，同时校验 Session 与 owner 一致性。
- Conversation projection 排除 Agent-owned 上下文卡片与用量，避免给现有 Transcript 增加适配压力。
- follow-up 继续使用同一 Agent owner，因此可以复用该 Child 已有的摘要与归档结果。

该实现没有复制第二套 ReAct 或压缩循环，也没有改变 Main 的压缩策略。

### 8.3 真实宽屏回归

回归会话：`session-1b5e4806-c19b-4f30-bd05-b70e7e34ea39`。

- 用户 Main Run `33d63681-934b-47da-9801-925d93ebc5ef` 真正并行创建 3 个 Child，没有身份增殖。
- 三个 Child 运行期间，以 Steer 发送“这是等待期间的回归测试消息……”。消息发送后立即出现在 Transcript；在 50,313 ms 安全边界等待后提交，Main 在 Child 仍运行时确认收到并继续等待。
- 三个 Child 全部自然完成后，通知触发新的后台 Main Run `3f5ed0e9-52f4-46a5-bd36-dfdfdea8d2b5`。页面自动接入其流并完整显示最终综合，没有出现“上次运行已中断”或恢复错误。
- 回归产生 35 次 Agent-owned context prepare、35 次对应 provider usage；三个 owner 均保持隔离。其中 10 次实际触发 `large_tool_results` 层，把大型工具结果外置为 artifact 后继续运行。
- 任务完成后刷新页面，等待期消息、确认回复和最终综合都能从持久化记录恢复。
- 页面正常刷新会提前中止 Agent activity stream，避免把浏览器主动关闭连接记录成 `network error` 告警。
- 浏览器 console 最终为 0 条 error/warning。只读命令适配失败与未配置 MCP 的连接失败保留在各自工具/服务诊断中，没有被错误升级成会话恢复失败。

### 8.4 最终自动化验证

- 后端测试：160/160 通过。
- Web 测试：72/72 通过。
- TypeScript 检查：通过。
- Web 生产构建：通过。

### 8.5 本轮提交

- `209db09`：恢复活动 Run 骨架并接入后台 Main Run 事件流。
- `efc1747`：Child 接入 owner 隔离的共享上下文压缩机制。
- `c2af3df`：页面卸载时主动终止 Agent activity stream，消除正常刷新告警。

## 9. Child 后台运行时的新消息路由补充修复

### 9.1 根因

后续会话 `session-6eed93c2-b8c7-4fe9-a07a-e62407e409f3` 暴露了另一个状态混淆：前端用同一个 `sessionHasActiveWork` 同时决定“是否展示会话级停止按钮”和“输入是否应进入 Queue/Steer”。这个值把活动 Main Run 与后台 Child Run 合并计算，因此 Main 已结束、只剩 Child 运行时，输入仍被错误标记为后续消息。

这两个判断的语义不同：

- 只要 Main 或任一 Child 仍在运行，就应保留“停止全部运行”。
- 只有 Main Run 仍在运行时，新输入才可以选择 Queue/Steer。
- Main 已结束而 Child 在后台运行时，新输入必须直接创建新的用户 Main Run；此时不展示“后续消息”和“调整当前方向”。

修复将 `mainHasActiveWork` 与 `sessionHasActiveWork` 分开派生。提交路由和后续消息设置只读取前者，会话级停止和轮询继续读取后者，没有增加另一份镜像状态。

### 9.2 六个 Agent 的来源

该会话的 Agent journal 只有六次 `agent_created`，关系是明确的两批各三个：

1. 原始用户 Main Run `143c7b9c-4186-4fbe-92b6-41552bd7075e` 创建第一批三个设计 Agent，随后在 Child 仍运行时自然结束。
2. Main 结束后的“你好”被前端错误写成 `next_run` Queue item，并在 `03:24:46` 启动新的用户 Main Run `71d94877-c8ae-484f-b2b4-c227e36ea805`。
3. 新 Main Run 从未完成的历史任务继续推理，又创建了第二批三个设计 Agent。

没有 Child 创建 Child，也没有一次工具调用同时创建六个 Agent。第二批属于模型在额外用户 Run 中重新规划原任务的选择，但触发这个额外 Run 的消息路由是产品缺陷。修复后的真实回归中，后台 Child 运行时创建的新 Main Run 遵循当前用户指令，没有重复创建 Agent。

### 9.3 前台等待转为后台执行的原因

行为变化来自运行时工具契约更新，不是模型从自动记忆中自行学会：提交 `8f6ad60` 将 Child 完成改为后台自动交付，并在 `spawn_agent` 结果中明确要求 Main 不要立即轮询或阻塞等待。该 Workspace 的托管记忆当时只有空索引标题，没有保存任何后台编排策略；对应请求中的 managed memory 也只有约 10 至 11 tokens。

因此，模型从前台等待转为后台 Child 是对新工具反馈的正常响应。后台模式本身保留，不需要回退；本轮只修复它暴露出的前端消息路由边界。

### 9.4 真实宽屏回归

回归会话：`session-41cad1f3-7bb7-4692-a88b-9e5a86635805`。

- 原始 Main Run 创建一个只读 Child 后自然结束；在 Child 仍为 `Agents 1/1` 时，页面没有活动 Main Run。
- 此时“停止全部运行”保留，发送按钮为普通“发送”，“后续消息/调整当前方向”不可见。
- 在该状态下发送第二条消息后 150 ms 内，消息已出现在 Transcript，并创建 `origin: user` 的新 Main Run；原 Child 仍为 `1/1`。
- Session journal 没有为第二条消息写入 `queue_enqueued` 或 `queue_consumed`；新 Main Run 只回复当前消息，没有创建第二个 Agent。
- 全程浏览器 console 为 0 条 error/warning，页面没有中断恢复卡或 Queue 区域闪现。
- 测试结束后通过会话级停止终止回归 Child，Agent Tree 收敛为全部结束。

### 9.5 验证与提交

- 回归测试先复现 `true`（错误进入 Queue），修复后转为 `false`（创建新 Main Run）。
- 后端测试：160/160 通过。
- Web 测试：73/73 通过。
- TypeScript 检查：通过。
- Web 生产构建：通过。
- `9c166d4`：拆分 Main 活动与会话活动语义，修复 Child-only 期间的新消息路由。

## 10. 前台显式等待与后台执行的双模式协议

### 10.1 模式选择

`spawn_agent` 与 `followup_agent` 现在只负责异步启动一个 Child Run，不再把启动本身定义为后台模式。工具结果中的 `background: true` 已改为中性的 `asynchronous: true`，由 Main 根据当前任务依赖关系选择后续动作：

- 当前用户请求依赖 Child 结果时，调用 `wait_agent(block=true)`，形成前台同步点。
- 当前 Main 可以独立完成时，不调用阻塞等待并自然结束；Child 继续后台运行，结果由后续 Main Run 自动接收。

工具说明同时保留禁止紧密轮询的约束。前台等待使用一次有界阻塞调用，后台执行不调用 wait；模型无需通过短周期 wait 模拟两种模式。

### 10.2 Steer 可唤醒的前台等待

前台 `wait_agent(block=true)` 现在同时等待 Child 进展与当前 Main Run 的持久 Steer。Coordinator 在 Steer 成功写入 Queue 后唤醒该 Run 的等待器；Executor 只取消当前 wait 的派生信号，并返回 `steer_pending`。Main Run 的主取消信号和 Child Run 信号都不受影响。

等待让出后，原有安全边界消费持久 Steer，执行下一次模型请求。模型处理用户消息后可以继续等待同一 Child、给同一 Child 派发 follow-up，或按新指令改变计划。这样不需要等长 timeout 返回，也不会让 Steer 排在持续 wait 的结果之后。

### 10.3 Child Run 级交付与 follow-up

前台 wait 直接取得某个 Child Run 的终态时，会消费该 Run 对应的待处理完成通知，避免同一结果随后又触发一次自动 Main Run。去重键仍是唯一 `agentRunId`，不是 `agentId`：

- 同一 Child 的初始 Run 完成后交付一次。
- Main 对该 Child 调用 `followup_agent` 会创建新的 `agentRunId`。
- follow-up Run 完成后生成独立通知，可以再次前台 wait 交付或后台自动交付。

回归测试明确断言同一 Child 的初始请求与 follow-up 请求产生两个不同 Run、两条通知，并各自恰好消费一次。去重不会吞掉对同一 Child 的后续任务结果。

### 10.4 真实宽屏回归

前台会话：`session-48fe21e7-0645-451c-9a5f-7db1a5f8184f`。

- Main Run `10f30e62-568b-47a0-b7a8-8adda88c320c` 创建 Child `agent-1b177c2e-fc7e-4b5f-8d6e-4c26ec434fc6`，随后真实调用 `wait_agent(block=true, mode=all, timeout_ms=60000)`。
- 页面保持“当前运行”和“后续消息/调整当前方向”，用户显式选择 Steer 后发送测试消息。
- Steer 入队后 14 ms，wait 返回 `steer_pending`；入队后 19 ms，Steer 已被同一 Main Run 消费。消息立即显示在 Transcript，Main 回复“Steer 已即时收到”，并重新等待同一 Child。
- Main、Child 均未被 Steer 停止，也没有创建新 Child。该 Child 后续因自身长任务 token 上限结束，属于独立资源限制，不影响等待让出行为。

后台会话：`session-401faa58-c7f4-45cb-8866-212d9936487b`。

- 原 Main 创建一个 Child 后不调用 wait，自然结束；页面保持 `Agents 1/1` 与“停止全部运行”，恢复普通“发送”，不显示后续消息选择器。
- Child 仍运行时提交新消息，250 ms 内消息已显示；页面没有 Queue 区域或中断恢复卡。
- 新消息启动独立用户 Main Run，并返回“普通新 Main 已收到”，没有等待、停止或重复创建 Child。
- 两个会话的浏览器控制台均无 error/warning；测试结束后通过会话级停止清理后台 Child。

### 10.5 自动化验证

- 后端测试：162/162 通过。
- Web 测试：73/73 通过。
- TypeScript 检查：通过。
- Web 生产构建：通过。
- `5a99be7`：实现可被 Steer 唤醒的前台等待、中性异步启动协议与 Child Run 级通知去重。
