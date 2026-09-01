# Multi-Agent 失控事件修复记录

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

