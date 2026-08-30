# DexCode Web UI 重构开发设计

> 状态：已实施并完成桌面、窄屏与流式链路验收
> 日期：2026-08-30  
> 适用范围：`apps/web`、`apps/runtime` 中的 Web 适配层，以及为 UI 提供稳定投影所需的共享模块  
> 参考：OpenCode Web App 的信息层级与交互方式。只能参考产品设计，不复制其代码、包结构、命名或视觉资产。

## 1. 背景与结论

DexCode 当前主页面同时放置对话、编辑器、工作区文件树和 Agent 执行摘要。前端由一个大型原生 TypeScript 文件直接操作 DOM，并直接消费接近底层执行格式的 SSE 事件。这种实现能够验证基本闭环，但无法稳定承载以下产品能力：

- 以对话时间线为唯一主题的主页面；
- 工作区和无工作区两种会话范围；
- 不产生空持久化记录的新会话草稿；
- 多个文本、工具、确认和错误片段交错的流式时间线；
- 刷新后仍能还原相同 Tool Card 的历史会话；
- 模型名称和可信的上下文使用率；
- 不向用户暴露 Session ID、Run ID、工具代码名、原始枚举和 JSON 等底层实现细节。

本次采用“前端定向重构 + Web 接口深化”，不进行全栈重写：

- 保留 Node.js 22、TypeScript、现有 Agent、Session、Tool Gateway、Workspace Manager 和 OpenAI-compatible 流式链路；
- 将 `apps/web` 重构为 Vite + React + TypeScript 单页应用；
- 在 canonical Session/Run facts 与 React renderer 之间增加稳定的“会话展示投影” seam；
- 将 Runtime 的活动工作区从模块级全局状态改为按请求解析；
- 保留现有安全、持久化、abort、ToolOutcome 和 RunReport 语义，不允许 UI 重构绕过这些生产路径。

## 2. 目标与非目标

### 2.1 必须完成

1. 主页面只保留可伸缩侧边栏、流式对话时间线和输入区。
2. 删除主页面的编辑器、工作区文件树和 Agent 执行摘要板块。
3. 使用浅色主题：白底黑字，蓝、绿、紫为主色，红、黄仅表示风险、失败或提醒。
4. 侧边栏顶部输入项目绝对路径；未加载项目时显示首页会话，加载后只显示该工作区会话。
5. 新建会话先成为客户端草稿；只有首次提交非空消息后才创建 durable Session。
6. 历史会话显示用户可理解的标题，默认来自第一个用户问题，不显示 Session ID。
7. Tool Card 使用中文产品名称、目标、结果状态、简短结果、文件变更统计和可折叠原始输出。
8. 历史会话重新打开后，工具、确认、错误和文本的展示与实时流式阶段一致。
9. 输入框下方显示模型展示名称和上下文使用率；数据未知时明确显示未知，不伪造百分比。
10. UI 不直接显示底层标识、代码枚举、provider wire 字段、HTTP 状态或原始 JSON。
11. 多标签页或多个请求不能通过一个全局 `activeRuntime` 相互切换工作区。
12. 为新接口、投影 reducer、草稿物化、Tool Card 和历史恢复建立自动化测试。
13. `MCP`、`工具`、`Skill`、`白名单`、`快照`、`项目知识` 六项能力在当前版本必须保留并可操作；主页面简化不能以删除、停用或延期恢复这些能力为代价。入口由能力注册表驱动，不能在 Sidebar 中写死，后续可以逐项禁用、替换或删除，并同步收口对应路由。

### 2.2 明确不做

- 不引入 Next.js、SSR、微服务或新的后端语言。
- 不在本轮重新实现 Agent ReAct loop、Tool Gateway 或 Session durability。
- 不恢复被删除的编辑器和文件树主面板。
- 不删除或以“新版暂不支持”为由停用 `MCP`、`工具`、`Skill`、`白名单`、`快照`、`项目知识`；入口可以重新设计，但必须保持可发现和可访问。
- 不照搬 OpenCode 的 SolidJS 模块、`@opencode-ai/ui`、CSS token、图标或页面源码。
- 不为了“隐藏”而删除可审计的 canonical facts；底层事实继续持久化，只是不直接成为产品文案。
- 不把调试控制台伪装成普通用户界面。需要保留的诊断信息进入显式“开发者详情”或导出文件。

### 2.3 需求追踪矩阵

本文件中的后续模块、阶段和验收项必须能回溯到完整需求，而不是只解决某一个可见问题：

| 需求来源 | 设计落点 | 主要验收 |
|---|---|---|
| 移除编辑器、文件树、执行摘要，页面只做流式对话 | 第 8、9 节；U3、U4 | 18.1、18.10 |
| 输入框下显示模型名称和上下文使用率 | 第 11 节；U1、U4 | 18.11 |
| Tool Card 中文化、短小、可折叠原始输出 | 第 9、10 节；U1、U4 | 18.7-18.9 |
| 文件修改显示相对路径和 `+N -M` | 10.3；U1、U4 | 18.8 |
| 浅色主题及蓝、绿、紫主色 | 第 12 节；U3 | 18.2 |
| 左侧可伸缩侧边栏、顶部项目路径、scoped history、下方新建入口 | 第 7、8 节；U2、U3 | 18.3-18.5 |
| 新会话仅在真实交互后持久化 | 第 7 节；U2 | 18.4 |
| 无工作区首页会话与工作区会话隔离 | 7.2、7.3；U2 | 18.3、18.12 |
| 实时工具展示和历史恢复一致 | 9.2；U1、U4 | 18.10 |
| 保留 MCP、工具、Skill、白名单、快照、项目知识 | 8.2、13.3；U3、U5 | 18.16 |
| 不暴露 Session ID 和其他底层接口 | 第 3、6、13 节；U0-U5 | 18.5、18.6 |
| 现有后端栈可复用，前端定向重构 | 第 1、5、15、16 节 | 18.13-18.15 |

若实施中某一项无法在此矩阵中找到对应设计、阶段和验收条件，必须先补文档，不能直接用临时 UI 行为决定产品语义。

## 3. 设计原则

### 3.1 Canonical facts 与 Display Model 分离

Session ID、Run ID、Call ID、ledger sequence、工具代码名和 provider 原始结果属于 canonical facts。React renderer 只消费 Display Model，不允许从 canonical facts 临时拼接用户文案。

```text
Session ledger / Run progress / ToolOutcome
                  |
                  v
       ConversationProjection
                  |
                  v
 ConversationViewSnapshot + ConversationViewEvent
                  |
                  v
          React renderer
```

`ConversationProjection` 必须是深模块：其小型接口隐藏标题生成、状态本地化、路径缩短、输出裁剪、diff 统计、事件合并和历史恢复等实现复杂度。删除该模块时，这些复杂度会重新散落到侧边栏、时间线、Tool Card 和错误提示中，因此该 seam 有实际价值。

### 3.2 标识可传递，但不可成为产品文案

底层标识可以作为 opaque reference 存在于请求、URL、React key 和测试夹具中，但必须遵守：

- 不在侧边栏、标题、状态条、Toast、Tool Card、确认弹窗和导出默认文件名中显示；
- 不用截断 ID（例如 `#a3f97c`）作为空标题兜底；
- 不在普通错误中显示 `session-...`、`task-...`、`call_...`；
- 仅显式开发者诊断视图可以在用户主动展开后显示，并提供复制按钮和敏感信息遮盖。

### 3.3 产品语义不能由 renderer 猜测

前端不得通过以下方式推断结果：

- 检查任意 JSON 中是否存在 `ok`；
- 根据工具名是否等于 `write_file` 判断文件已修改；
- 把 `settled` 当作成功；
- 把累计 token usage 当作当前上下文占用；
- 从 raw output 正则提取路径和命令；
- 根据 HTTP 200 推断 Run 已完成。

这些语义必须由拥有事实的模块给出，并通过结构化接口传递。

### 3.4 导航不等于取消

在单页应用内切换会话或新建草稿，不应隐式取消正在运行的会话。只有用户点击“停止”才发出 Run abort 命令。浏览器关闭、网络断开和服务重启继续遵守现有 durable prefix 与恢复语义。

### 3.5 既有核心不变量继续有效

Web 重构不能削弱现有核心链路：

- canonical ModelEvent 在 Agent 内归约，React 不读取 OpenAI 原始 chunk；
- 完整 assistant message 提交成功后才能执行其工具调用；
- 每个 accepted tool call 产生一个 durable ToolOutcome，包括失败、拒绝、超时和取消；
- 一个 Session 同时最多一个 active Run，terminal 提交保持幂等；
- 文件、命令、MCP 和 Skill 继续经过 Tool Gateway 的校验、approval、abort 和 evidence 策略；
- SSE progress 可以合并，semantic event 不可丢失、伪造成功或乱序；
- secret 不进入 Display Model、raw output、错误提示、导出默认内容或浏览器持久化；
- Context projection 继续保留完整 model/tool turn 配对，UI 不自行截取消息构造模型请求。

会话展示投影只是 canonical facts 的只读产品投影，不成为第二份真相，也不写回 provider 或工具结果。

## 4. 当前问题基线

实现前需要保留以下代码事实作为迁移基线：

- `apps/web/app.ts` 同时拥有布局、工作区、文件操作、会话、SSE、工具展示、确认和摘要状态，无法再安全扩展。
- 当前 `tool_status` 只有 `running/settled`；`tool` 事件只有工具代码名、summary 和 detail，不能表达可靠状态和展示目标。
- 执行器把工具结果直接 JSON 序列化到 `detail`。
- 当前前端一次 Run 复用一个 tool DOM node，不能表示多个工具与 assistant 文本交错。
- 历史会话恢复时把 `tool` 消息作为普通 Agent 文本显示，因此会重新暴露原始 JSON。
- Session Store 已支持 `general/workspace` scope 和未物化 Session 过滤，这是应保留的基础。
- Runtime 虽能列出 general Sessions，但聊天生产路径仍依赖全局活动工作区。
- 文件修改前后内容已经被 `FileDiff` 捕获，可以据此生成真实 `+N -M`。
- RunReport 已记录 usage，但它是多次模型调用累计值，不能作为当前上下文占用率。

## 5. 目标技术栈

### 5.1 前端

- Vite
- React
- TypeScript strict mode
- React Router
- TanStack Query：会话列表、工作区信息、模型描述等 server state
- 一个基于 reducer 的 `ConversationStore`：流式事件、时间线、当前 Run 和确认状态
- Tailwind CSS + CSS Variables：布局工具类与产品 design tokens
- Radix Primitives：Collapsible、Dropdown、Dialog、Tooltip
- `react-markdown` + `remark-gfm`：默认禁止 raw HTML
- `eventsource-parser`：解析 POST response body 中的 SSE
- Vitest + React Testing Library
- Playwright：真实导航、流式时间线、侧边栏和草稿物化验收

不使用 TanStack Query 存储 token delta。高频流式状态由 `ConversationStore` 归约，避免把缓存请求库当作事件状态机。

### 5.2 后端

继续使用 Node.js HTTP Runtime。新增或深化以下模块：

```text
packages/conversation-view/
  contracts.ts
  projection.ts
  title.ts
  tool-presentation.ts
  output-policy.ts
  testing/

apps/runtime/
  conversation-routes.ts
  workspace-runtime-resolver.ts
  conversation-sse-adapter.ts
```

最终目录是 ownership 目标，不要求为了目录而机械拆文件。每个模块必须通过其接口提供可观察行为，不能只做一层 pass-through。

## 6. 会话展示投影

### 6.1 会话列表接口

React 侧边栏只接收：

```ts
type ConversationListItem = {
  ref: string;              // opaque，只用于导航和命令，不渲染
  title: string;            // 用户可读标题
  preview?: string;         // 可选的最近用户问题或最终回答摘要
  updatedAt: string;
  state: 'idle' | 'running' | 'waiting' | 'failed';
  archived: boolean;
};
```

禁止向该接口加入 `sessionIdLabel`、`shortId`、`activeTaskId`、`revision`、`ledgerSeq` 等展示字段。

### 6.2 默认标题规则

标题优先级固定为：

1. 用户手动设置的标题；
2. 第一条非空用户消息生成的标题；
3. 对迁移后的异常旧数据使用“恢复的会话”；
4. 未物化草稿不进入历史列表，因此不需要“新会话”历史项。

从第一条问题生成标题时：

- 去除首尾空白并合并连续空白；
- 去除开头的 Markdown 标题符号、列表符号和代码围栏；
- 保留用户原语言，不调用模型生成标题作为首版依赖；
- 使用 `Intl.Segmenter` 按 grapheme 截断，默认最多 36 个可见字符；
- 超长时使用单个省略号 `…`；
- 完整问题可通过 Tooltip 查看；
- 允许不同会话标题重复，用更新时间和预览区分，禁止退回 ID 区分。

Session 首次 `beginRun` 时必须在同一持久化 mutation 中写入默认标题，不能依赖另一个可能不执行的旧 `appendMessages` 路径。

### 6.3 全局底层信息泄漏清单

以下内容不得出现在普通产品 UI：

| 底层信息 | 产品展示 |
|---|---|
| `session-uuid` | 第一条用户问题生成的标题 |
| `task-...` / Run ID | “正在处理”“已完成”等状态 |
| Tool call ID | 不展示；仅内部关联同一张卡 |
| `write_file` / `run_command` | “修改文件” / “执行命令” |
| `planning` / `waiting_confirm` | “正在准备” / “需要确认” |
| `openai-compat` | 模型展示名称；provider 只在设置详情出现 |
| `activeTaskId` / revision / seq | 不展示 |
| HTTP 409/500 | 可行动的中文错误与重试入口 |
| 原始 tool arguments JSON | 目标路径、命令或搜索内容 |
| 原始 tool result JSON | 简短结果；原始输出主动展开 |
| 绝对文件路径 | Tool Card 中使用工作区相对路径 |
| 命令绝对 cwd | 当前项目或工作区相对目录；绝对值只在开发者详情 |
| stack trace | 用户错误摘要；trace 进入受控诊断详情 |
| `sessionMaterialized` 等协议字段 | 不展示，由状态机消费 |

项目路径输入框是例外：它的产品职责就是让用户输入和确认绝对项目地址，因此可以显示用户选择的绝对路径。

## 7. 会话生命周期

### 7.1 状态机

```text
Draft (仅客户端)
  | 首次提交非空消息
  v
Materializing
  | 原子创建 Session + user message + Run
  v
Persisted / Running
  | terminal
  v
Persisted / Idle | Failed | Waiting
```

规则：

1. 点击侧边栏“新建会话”只创建 `DraftConversation`，不得调用 Session Repository。
2. 草稿拥有客户端 `draftRef`，只用于避免 React 状态冲突，不写入服务器历史。
3. 空白提交、输入后删除、未发送即离开都不物化 Session。
4. 首次提交使用 `clientRequestId` 实现幂等；重试同一请求不能创建两个 Sessions。
5. 创建 Session、写入首条 user message、默认标题、`run_started` 和 active Run 必须形成一个可恢复的原子业务操作。
6. 一旦首条用户消息提交成功，即使 provider、context 或工具随后失败，也保留该 Session，因为用户已经发生真实交互。
7. 第一个 SSE semantic event 返回 materialized conversation ref。客户端使用 replace navigation 将 `/new` 替换为持久会话路由，不增加一条无意义浏览器历史。
8. 服务端在物化前失败时不得留下隐藏空 Session 文件；旧空 Session 需要一次性清理或启动时忽略并可回收。

### 7.2 Scope

```ts
type ConversationScope =
  | { kind: 'general' }
  | { kind: 'workspace'; workspaceRef: string };
```

- 未输入项目路径：`general`，显示首页历史会话；不能使用工作区文件和命令工具。
- 成功加载项目：`workspace`，只显示该工作区历史会话。
- `workspaceRef` 是 opaque reference，不显示给用户。
- 输入无效路径时保持原 scope，不清空当前历史和草稿。
- 切换工作区前保留各 scope 的当前导航位置；返回时恢复上次会话或打开新草稿。

### 7.3 多标签页与请求隔离

Runtime 不再依赖模块级 `activeRuntime` 决定请求作用域。每个会话和 Run 通过持久化 scope 解析对应 `WorkspaceRuntime`；加载路径只返回/选择 workspace reference，不改变其他请求的环境。

`WorkspaceRuntimeResolver` 的接口负责：

- 规范化并注册用户路径；
- 由 workspace reference 解析可用工作区；
- 缓存运行时但不暴露缓存实现；
- 工作区不存在或被移动时返回 typed failure；
- 确保 Session scope 与 Run workspace 一致。

## 8. 页面与路由

建议路由：

```text
/                              首页新草稿
/c/:conversationRef            首页历史会话
/w/:workspaceRef/new           工作区新草稿
/w/:workspaceRef/c/:conversationRef
/settings/*                    配置页面
```

opaque reference 可以出现在 URL，但页面不得把 URL 片段显示成标题。若未来需要分享链接，可以在不改 renderer 的情况下替换 route adapter。

桌面布局：

```text
┌──────────────────────┬────────────────────────────────────────┐
│ 项目路径输入框       │ 会话标题 / 状态                        │
│                      ├────────────────────────────────────────┤
│ 当前 scope 历史会话  │                                        │
│ 会话标题             │             对话时间线                 │
│ 会话标题             │                                        │
│                      │  修改文件  src/app.ts  +18 -6          │
│ ＋ 新建会话          │                                        │
│ 核心功能入口（示意） │                                        │
│                      ├────────────────────────────────────────┤
│ 设置 / 收起          │ 输入框                                 │
│                      │ 模型名称 · 上下文 38%                  │
└──────────────────────┴────────────────────────────────────────┘
```

- 展开侧边栏建议宽度 280px，最小 248px，最大 360px；折叠后保留 52px rail。
- 主时间线内容最大宽度建议 880px，输入区与其对齐。
- 输入区 sticky 在主区域底部，不能覆盖最后一条消息。
- 窄屏侧边栏变为 Drawer；主对话仍是唯一内容列。
- 设置、MCP、工具、Skill、白名单、快照和项目知识的入口样式与位置在视觉方案中确定；可选择侧边栏、顶栏、功能面板或组合布局，但不能从新外壳中消失。
- 核心能力入口来自 `CapabilityRegistry`（或等价配置 seam）。Sidebar 只渲染当前启用项；删除能力时应同时移除注册项、路由和相关预取，不允许在组件中维护固定六项数组。

### 8.1 关键用户流程

#### 启动与首页

1. 页面启动时进入 `general` scope，不自动把 DexCode 仓库目录当成用户工作区。
2. 侧边栏项目输入框显示“输入项目绝对路径”，下方显示首页历史会话。
3. 没有历史时显示解释性空状态和新建入口，不显示空 ID、Mock Session 或演示数据。

#### 加载项目

1. 用户输入或从本地路径历史中选择项目地址。
2. Enter 或明确按钮触发解析；成功后侧边栏显示项目名称和该工作区历史。
3. 路径输入框承担“选择项目”职责，不同时承担会话全文搜索；未来增加会话搜索时使用独立入口。
4. 加载失败时保留原 scope 和当前对话，并给出可行动错误。

#### 新建会话

1. 新建图标位于当前 scope 历史列表下方。
2. 点击后立即打开空白流式对话页并聚焦输入框。
3. 未发送离开不产生历史项；首次发送后才替换为持久会话路由。
4. 当前 scope 已有未发送草稿时，再次点击新建只聚焦该草稿，不不断创建客户端空页。

#### 恢复历史会话

1. 点击用户可读标题进入会话。
2. 先加载 durable snapshot，再订阅仍在运行的 progress；不能先清空页面再逐条闪烁重放。
3. 同一会话正在运行时，侧边栏显示轻量状态，但标题和顺序保持稳定。
4. 切换会话不把底层 ref 写进标题，也不把历史 ToolOutcome 还原成 JSON 文本。

### 8.2 核心功能必须持续可用，入口形态另行设计

新 Web 外壳必须持续提供以下六项能力。下表约束功能连续性和迁移方式，不约束最终使用胶囊按钮、图标、列表、菜单还是其他布局：

| 入口 | 现有能力 | 迁移期行为 |
|---|---|---|
| MCP | 配置和管理外部 MCP 服务器 | U3 先链接现有 `/mcp-config.html`，U5 再迁入 React 路由 |
| 工具 | 查看、启停和测试工具 | U3 先链接现有 `/tools.html`，U5 再迁入 React 路由 |
| Skill | 查看、导入、启停 Skill | U3 先链接现有 `/skills.html`，U5 再迁入 React 路由 |
| 白名单 | 管理命令执行白名单 | U3 先链接现有 `/whitelist.html`，U5 再迁入 React 路由 |
| 快照 | 创建、查看和恢复工作区快照 | U3 先链接现有 `/snapshots.html`，U5 再迁入 React 路由 |
| 项目知识 | 查看和编辑项目知识 | U3 先链接现有 `/project-memory.html`，U5 再迁入 React 路由 |

功能约束：

- 六项能力必须能从新 Web 外壳中到达，不能要求用户手输旧页面 URL；
- 按钮形状、颜色、图标、文字显隐、顺序、分组以及位于顶栏、侧边栏或功能面板，均属于可商量的视觉与交互决策；
- 若采用图标或折叠菜单，需要提供 Tooltip、文字标签或其他足以识别功能的可访问名称；
- 桌面展开、桌面折叠和窄屏布局都必须保留访问路径，但三种布局可以采用不同呈现方式；
- 当前所在功能应有可理解的导航反馈；打开与返回不丢失当前 workspace/conversation 导航；
- 当某项能力依赖工作区时，首页仍显示入口，点击后解释“请先选择项目”，不能让按钮消失；
- 权限、配置缺失或后端不可用时显示原因和修复入口，不能静默 disabled；
- React 外壳首次可用时就必须完成这些能力的兼容导航，不能等到 U5 才恢复。

U5 的职责是迁移六个页面的内部实现和产品展示规则，不是决定这些能力是否存在。最终入口方案应先给出视觉草案并经确认，再写入冻结的布局验收标准。

## 9. 对话时间线与流式协议

### 9.1 View Event

前端不直接消费当前宽松的 `AgentEvent` union。SSE adapter 投影为版本化事件：

```ts
type ConversationViewEvent =
  | { version: 1; seq: number; type: 'conversation.materialized'; ref: string }
  | { version: 1; seq: number; type: 'assistant.started'; itemRef: string }
  | { version: 1; seq: number; type: 'assistant.delta'; itemRef: string; text: string }
  | { version: 1; seq: number; type: 'assistant.completed'; itemRef: string }
  | { version: 1; seq: number; type: 'tool.started'; card: ToolCardView }
  | { version: 1; seq: number; type: 'tool.completed'; card: ToolCardView }
  | { version: 1; seq: number; type: 'approval.requested'; card: ApprovalCardView }
  | { version: 1; seq: number; type: 'approval.resolved'; cardRef: string; decision: string }
  | { version: 1; seq: number; type: 'context.updated'; usage: ContextUsageView }
  | { version: 1; seq: number; type: 'run.status'; status: RunStatusView }
  | { version: 1; seq: number; type: 'run.failed'; error: UserFacingError };
```

每条 semantic event 必须有稳定 `seq`。Progress delta 可以合并，但不能跨不同 `itemRef` 合并。未知事件版本必须产生可诊断错误，不能静默 `catch { continue; }`。

### 9.2 同一 reducer 支持实时与历史

`ConversationProjection` 有两个真实 adapter：

1. Live adapter：canonical Run progress/semantic events -> `ConversationViewEvent`；
2. Replay adapter：durable Session ledger -> `ConversationViewSnapshot`。

两者必须产生等价的时间线结构。测试使用同一 canonical fixture，断言实时归约后的 snapshot 与重放 snapshot 相等。这条合同防止“实时是卡片，刷新后变 JSON”。

### 9.3 时间线 item

允许的主要 item：

- User message
- Assistant message
- Reasoning summary（默认折叠）
- Tool Card
- Approval Card
- Error Card
- Run interruption/recovery notice

“Agent 执行摘要”不再作为独立面板。真正需要用户知道的状态进入对应 item；纯调试 timeline 不在默认页面展示。

## 10. Tool Card

### 10.1 接口

```ts
type ToolCardView = {
  ref: string; // opaque，不渲染
  kind: 'file_read' | 'file_change' | 'command' | 'search' | 'external' | 'other';
  label: string;
  target?: string;
  status: 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled';
  summary?: string;
  change?: {
    path: string;
    additions: number;
    deletions: number;
  };
  raw?: {
    text: string;
    truncated: boolean;
    artifactRef?: string;
  };
};
```

`ref` 只用于把 started/completed 归并为同一张卡。renderer 不认识 `write_file`、`patch_file` 或 provider function 名称。

### 10.2 中文名称与目标

内置工具示例：

| Canonical 工具 | UI 名称 | target |
|---|---|---|
| read file | 读取文件 | 工作区相对路径 |
| write/edit/patch file | 修改文件 | 工作区相对路径 |
| run command | 执行命令 | 单行命令，超长省略 |
| search/grep | 搜索代码 | 搜索词和可选目录 |
| list workspace | 浏览目录 | 工作区相对目录 |
| lint/diagnostic | 检查问题 | 文件或工作区 |
| external MCP | 调用外部工具 | 注册时提供的产品名称 |

MCP 工具没有产品名称时使用“外部工具”，不能把 `mcp__server__method` 直接显示给普通用户。代码名可以在开发者详情中查看。

### 10.3 文件变更

折叠态示例：

```text
✓ 修改文件  src/app.ts  +18 -6
  更新会话导航和 Tool Card 投影                         ▸
```

规则：

- additions/deletions 由修改前后内容进行 line diff 得出；
- 新文件：旧内容视为空，显示实际新增行；
- 删除文件：新内容视为空，显示实际删除行；
- 无文本差异时不显示 `+0 -0`；
- 二进制文件显示“二进制文件已更新”；
- 多文件 patch 默认一文件一卡，或显示总数并在展开区列出每个文件；
- 未拿到可靠 diff 时显示“文件已修改”，不得猜测数字。

### 10.4 状态与结果

- `running`：蓝色或紫色轻量 shimmer，不显示成功图标；
- `succeeded`：绿色图标和简短结果；
- `failed`：红色图标、可行动错误摘要；
- `denied`：黄色或中性色，文案“已拒绝执行”；
- `cancelled`：中性色，文案“已取消”；
- 不使用 `settled` 作为产品状态。

状态必须来自 canonical ToolOutcome。不同工具返回的任意 `ok/error/status` 字段先在 Tool Gateway/投影模块归一化，renderer 不做启发式判断。

### 10.5 原始输出策略

- 默认折叠；卡片折叠态最多两行，不被 stdout 撑高；
- 先服务端 redaction，再进入展示投影；
- 单卡内联 raw output 建议上限 64 KiB 或 200 行，以更先达到者为准；
- 超限时保留对理解结果最有价值的头尾片段，并标记“输出已截断”；
- 存在 Artifact Store 时提供“查看完整输出”；不存在时不得声称可以恢复完整内容；
- ANSI 控制符、不可见控制字符和危险 HTML 必须清理；
- stdout/stderr 可分区展示，但普通成功卡只显示一句摘要。

### 10.6 低信号工具的合并

为保持时间线简洁，连续且属于同一 assistant turn 的只读操作可以由投影模块合并，例如：

```text
✓ 已读取 4 个文件                                      ▸
```

约束：

- 只允许合并读取、列目录、glob、grep 等无副作用工具；
- 文件修改、命令、外部 MCP、失败、确认和被拒绝操作必须保持独立卡片；
- 展开后仍能看到每个目标和各自状态；
- 合并发生在 ConversationProjection，不由 React 根据相邻 DOM 猜测；
- 历史 replay 必须产生与 live 阶段相同的分组。

## 11. 模型与上下文使用率

### 11.1 模型展示描述

Runtime 提供产品描述而不是仅返回环境变量：

```ts
type ModelDisplayDescriptor = {
  displayName: string;
  contextWindow?: number;
  providerDisplayName?: string;
};
```

输入框下默认显示 `displayName`。Provider 只在模型选择或设置详情中显示，不把 `openai-compat`、base URL 或环境变量名放在主页面。

### 11.2 上下文口径

```ts
type ContextUsageView = {
  usedTokens?: number;
  limitTokens?: number;
  percentage?: number;
  source: 'provider' | 'estimated' | 'unknown';
  asOfTurn?: number;
};
```

计算规则：

- `usedTokens` 是最近一次模型请求的 input tokens，不是一个 Run 中多次请求的累计值；
- `limitTokens` 来自受验证的 Model Descriptor；
- `percentage = min(100, round(usedTokens / limitTokens * 100))`；
- provider 返回 prompt usage 时优先使用；否则使用与 Context Builder 同源的估算并标记“估算”；
- 运行中尚未得到可信数据时显示“上下文计算中”；
- 无 context window 或 usage 时显示“上下文未知”，不显示 0%；
- Tooltip 可显示 `32,480 / 128,000 tokens · 估算`；主栏只显示 `上下文 25%`。

## 12. 主题与视觉 token

基础 token 建议：

```css
--bg-canvas: #ffffff;
--bg-sidebar: #f7f8fa;
--bg-subtle: #f3f4f6;
--text-primary: #111827;
--text-secondary: #6b7280;
--border-default: #e5e7eb;
--blue: #2563eb;
--green: #16a34a;
--purple: #7c3aed;
--red: #dc2626;
--amber: #d97706;
```

规则：

- 大面积区域保持白色或浅灰，不使用高饱和渐变背景；
- 蓝色表示主要操作和运行，绿色表示成功，紫色表示模型/Agent，红色只表示失败或危险，黄色只表示警告或等待决定；
- 文本颜色必须满足 WCAG AA；状态不能只依赖颜色，必须有图标或文案；
- focus ring、键盘导航、aria label 和折叠态必须可用；
- 尊重 `prefers-reduced-motion`；流式 shimmer 不能成为阅读干扰。

## 13. 错误与确认展示

### 13.1 用户错误

```ts
type UserFacingError = {
  title: string;
  message: string;
  action?: 'retry' | 'reconnect' | 'choose_workspace' | 'open_settings';
  diagnosticsRef?: string;
};
```

映射示例：

- HTTP 401 / provider authentication -> “模型认证失败，请检查模型设置”；
- workspace missing -> “项目目录不可用，请重新选择项目”；
- session scope mismatch -> “该会话不属于当前项目”；
- network disconnect -> “连接已中断，已保留完成的内容”；
- tool denied -> Tool Card 状态，不弹通用失败 Toast；
- stack trace、request ID 和内部错误码进入主动展开的诊断详情。

### 13.2 Approval Card

命令和外部工具确认进入对话时间线。折叠态显示产品原因、风险等级、目标和明确按钮，不显示 confirm ID。命令 cwd 默认显示项目名或相对目录；绝对 cwd 只在开发者详情中显示。

### 13.3 配置页同样遵守产品投影规则

底层信息治理不只针对主对话页。U5 迁移配置页时采用：

| 当前容易泄漏的内容 | 新展示规则 |
|---|---|
| 工具管理页的 `write_file` 等代码名 | 中文产品名称；代码名放高级详情 |
| 工具测试页的参数和结果 JSON | 常用字段表单 + 结构化结果；原始 JSON 主动展开 |
| MCP server 内部名称和 `mcp__...` 方法名 | 用户设置的服务器/工具名称；内部名放高级详情 |
| MCP headers、env | 密钥字段遮盖，默认不回显完整值，不进入 localStorage 明文副本 |
| Skill `rootPath` | 显示 Skill 名称和来源；绝对路径放详情 |
| 白名单 `matchType` 等枚举 | “完整命令”“命令前缀”等产品文案 |
| Snapshot ID | 快照名称、描述和创建时间；ID 不作为列表标题 |
| Session 导出文件名 | 使用安全化会话标题和日期，不使用 Session ID |
| Project memory 存储文件名 | UI 使用“项目知识”，物理路径放详情 |

高级设置可以保留 JSON 编辑能力，因为它对 MCP args/env 等高级场景确有价值，但必须与普通路径分层，带格式校验、secret 提示和明确的恢复默认值方式。

## 14. HTTP 与 SSE 适配建议

具体路由名称可在实现时调整，但行为必须满足：

```text
POST /api/workspaces/resolve
  输入 path
  返回 workspaceRef + displayName + canonicalPath

GET /api/conversations?scope=general|workspace&workspaceRef=...
  返回 ConversationListItem[]

GET /api/conversations/:ref/view
  返回 ConversationViewSnapshot

POST /api/conversation-runs
  输入 scope + optional conversationRef + clientRequestId + prompt
  返回 ConversationViewEvent SSE

POST /api/conversation-runs/:runRef/commands
  stop / approval decision
```

要求：

- HTTP adapter 不重新发明 Session/Run ID；它只传递应用模块生成的 opaque ref；
- 首次提交与继续已有会话使用同一 Run 入口；
- `clientRequestId` 在首次物化和普通消息重试中都保证幂等；
- SSE 每个 semantic event 有 version、seq 和关联 ref；
- SSE parser 支持 UTF-8 半字符、任意 chunk 分割、多 `data:` 行和流末尾校验；
- 断流时 reducer 保留 durable snapshot，不能把半个 Tool Card 标成成功；
- 旧 `/api/agent/chat` 在迁移期只能作为 adapter，达到等价后删除，不长期维护两套生产语义。

## 15. 最终前端目录建议

```text
apps/web/
  index.html
  vite.config.ts
  src/
    app/
      router.tsx
      providers.tsx
    conversation/
      conversation-page.tsx
      conversation-store.ts
      conversation-client.ts
      timeline/
      tool-card/
      approval-card/
      composer/
    sidebar/
      sidebar.tsx
      workspace-picker.tsx
      conversation-list.tsx
      new-conversation-button.tsx
    settings/
    shared/
      design-tokens.css
      error-view.ts
```

ownership：

- `conversation-store` 只归约 view events，不调用 DOM；
- `conversation-client` 是 HTTP/SSE adapter，不生成产品文案；
- `conversation-view` 共享模块拥有 canonical facts 到 Display Model 的语义；
- React renderer 只负责布局、可访问性和用户交互；
- Session Repository、Tool Gateway、Model transport 不得被 React 直接 import 或调用。

## 16. 分阶段实施

### U0：接口基线与测试夹具

- 冻结当前生产行为和本文件中的不变量；
- 建立 canonical Session fixture、混合工具 Run fixture 和失败/确认 fixture；
- 为标题生成、路径展示、错误映射和 raw output policy 写纯函数测试；
- 添加“不显示底层标识”的测试词表。

完成条件：能在不启动浏览器的情况下把 fixture 投影成稳定 snapshot。

### U1：ConversationProjection 与 ToolOutcome 展示语义

- 增加 `packages/conversation-view`；
- 扩充工具 semantic event/ledger，使其包含输入摘要、规范化状态、目标、FileDiff 和受控 evidence；
- 实现 live/replay 等价；
- 增加模型展示描述与上下文使用事件。

完成条件：刷新前后 snapshot 深度相等；Tool Card 不需要解析 raw JSON。

### U2：Scope、工作区解析与草稿物化

- 移除请求路径对全局 `activeRuntime` 的依赖；
- 打通 general conversation Run；
- 实现 `Draft -> Materialized` 幂等操作；
- 默认标题在首次提交中原子写入；
- 清理或忽略旧空 Sessions。

完成条件：两个浏览器标签可在不同工作区运行，不串 scope；未发送草稿不产生历史记录。

### U3：React 外壳与侧边栏

- 建立 Vite/React 工程；
- 完成路由、浅色 token、可伸缩侧边栏、项目路径输入和 scoped history；
- 完成用户标题、更新时间、运行状态和新建草稿；
- 在新外壳的桌面和窄屏布局中保留六项核心功能的访问路径，并先通过兼容路由连接现有页面；具体入口样式和位置由已确认的视觉方案决定；
- 暂时使用只读 fixture 时间线也可以，但不能接回旧 DOM 状态。

完成条件：导航、刷新、前进后退和响应式布局通过 Playwright；六项核心能力均可从新外壳到达现有功能页且能够返回原对话。该条件不预设入口必须位于侧边栏。

### U4：流式时间线、Tool Card 与输入区

- 接入 ConversationViewEvent SSE；
- 实现 assistant delta、Tool Card、Approval Card、Error Card；
- 输入区显示模型和上下文使用率；
- 导航时保持运行订阅，显式停止才 abort；
- Markdown、长输出、滚动跟随和用户手动离开底部行为完成。

完成条件：多工具交错、工具失败、用户拒绝、断流恢复和历史重放通过测试。

### U5：配置页迁移与旧 UI 删除

- 将设置、MCP、工具、Skill、白名单、快照和项目知识纳入统一外壳；
- 将 U3 的六个兼容链接逐项替换为 React 页面，替换期间保持功能可用性和导航连续；入口样式与位置可以按已确认的视觉方案调整；
- 普通配置表单使用产品字段，原始 JSON 只放在“高级设置”；
- 工具测试页不再默认显示完整 JSON；
- 删除旧三栏 HTML、旧 `app.ts`、旧暗色 CSS 和兼容事件处理；
- 更新 README、架构和运行命令。

完成条件：生产入口只加载新 Web App，不存在两套会话状态机；六个入口对应能力全部迁移完成后，才能删除相关旧 HTML/TS 页面。

## 17. 测试策略

### 17.1 Projection contract tests

- 第一条用户问题生成标题，不出现 Session ID；
- live events 与 ledger replay 得到相同 snapshot；
- 一个 call ref 恰好对应一张 Tool Card；
- 多工具与文本交错顺序稳定；
- succeeded/failed/denied/cancelled 不混淆；
- 路径保持工作区相对；
- raw output 被 redaction、裁剪并标记；
- 未知事件版本失败可诊断。

### 17.2 Session lifecycle tests

- 点击新建不写 Session；
- 空提交不物化；
- 首次非空提交只创建一个 Session；
- 同一 `clientRequestId` 重试不重复创建；
- 首次 Run 失败仍保留会话和用户消息；
- general/workspace history 隔离；
- scope mismatch fail closed；
- 两个工作区并发请求不互相切换。

### 17.3 UI tests

- 侧边栏展开、收起和窄屏 Drawer；
- 默认历史标题来自首问，界面不存在 `session-`、`task-`、`call_`；
- 新草稿发送后 URL replace；
- 刷新后 Tool Card 仍是卡片；
- `src/app.ts +18 -6` 展示准确；
- 原始输出默认折叠；
- 模型名称、上下文未知/估算/准确三种状态；
- 键盘发送、Shift+Enter、焦点、aria 和 reduced motion；
- 滚动在用户位于底部时跟随，用户上滚后不强制拉回；
- 桌面展开、桌面折叠和窄屏布局都能访问 MCP、工具、Skill、白名单、快照和项目知识；测试按最终确认的入口方案定位，不绑定临时 DOM 结构；
- U3 兼容路由和 U5 React 路由都验证无 404、无静默禁用，并能返回原会话。

### 17.4 泄漏守卫

对默认渲染结果执行禁用模式断言：

```text
session-
task-
call_
write_file
patch_file
run_command
openai-compat
activeTaskId
"tool_calls"
```

该守卫不能替代语义测试，但可以防止最常见的底层字段重新进入产品文案。显式开发者详情的测试需要单独允许并验证 redaction。

## 18. 验收标准

以下条件全部满足才算完成：

1. 主页面不存在编辑器、文件树和执行摘要。
2. 页面默认为浅色主题，视觉层级符合本文件 token 规则。
3. 未选工作区时能创建并继续 general 会话；选择后只显示对应工作区会话。
4. 点击新建但不发送消息不会创建持久化 Session。
5. 历史会话默认显示第一条用户问题开头，不显示任何形式的 Session ID。
6. 普通 UI 不显示 Run ID、Call ID、工具代码名、原始状态枚举或 JSON。
7. 每次工具调用有独立、短小、中文化的 Tool Card。
8. 文件修改卡可靠显示相对路径和 `+N -M`。
9. Tool Card 能区分成功、失败、拒绝和取消，原始输出默认折叠且有界。
10. 实时流和刷新后的历史会话具有相同 item 顺序和展示语义。
11. 输入框下显示真实模型展示名称；上下文使用率准确标识 provider/估算/未知。
12. 两个不同工作区请求并发时不会串工作区、Session 或工具环境。
13. 生产链路继续经过 Session、Agent 和 Tool Gateway 的既有安全与持久化 seam。
14. 新接口、投影、草稿物化和关键浏览器交互测试通过。
15. 旧三栏生产入口被删除，而不是与新状态机长期并存。
16. MCP、工具、Skill、白名单、快照和项目知识六项能力在桌面和窄屏布局中始终可访问；入口样式和布局以另行确认的视觉方案为准，对应旧页面只能在 React 替代页功能等价后删除。

## 19. 风险与回退

- 最大风险不是 React 页面本身，而是同时改变 UI、会话物化和事件协议。必须按 U0-U5 纵向推进，每一阶段保持 canonical facts 可恢复。
- 迁移期可以用 feature flag 选择旧/新入口，但同一个请求只能进入一套会话状态机；禁止双写 Session。
- Projection 是纯计算模块，应优先完成并用 fixture 锁定，再接浏览器。
- Runtime workspace scope 改造必须在接入新侧边栏前完成，否则多标签行为仍然错误。

## 20. 实施结果与验收记录

本节记录 2026-08-30 在 `ui-update` 分支完成的实现，不替代前文的产品与架构约束。

### 20.1 已落地模块

- `apps/web` 已替换为 Vite + React + TypeScript SPA；旧三栏页面、编辑器、文件树、执行摘要和分散的设置 HTML/TS 已移除。
- `packages/conversation-view` 统一负责首问标题、中文工具名称、状态、目标、输出裁剪、敏感信息遮盖、文件 diff 和 durable ledger replay。
- `packages/capability-registry` 提供能力入口清单。`DEX_DISABLED_CAPABILITIES` 删除注册项后，Sidebar 与设置路由同时不再提供该能力；页面组件不维护固定六项数组。
- `public/brand-icon.svg` 是缺省可替换资源；构建变量 `VITE_BRAND_ICON_URL` 可指向其他图标，加载失败时使用中性占位，不把 DexCode 图形写死在 JSX。
- Runtime 新增 scoped conversation/workspace 接口，请求通过 workspace reference 解析各自 runtime，不再依赖全局 `activeRuntime`。
- 首次发送通过 `materializeRun` 原子写入 Session、首问标题、user message 和 `run_started`；普通后续消息也持久化 `clientRequestId`，重试返回现有结果而不是重复提交。
- Context、provider 或执行基础设施在 Run 开始后失败时仍提交失败终态，保留用户已发生的真实交互和可恢复 ledger。
- Skill、MCP、文件、命令等语义事件在实时流与历史恢复中都投影为同一种 Tool Card；原始 tool message 不进入默认时间线。
- 设置能力已全部迁移到 React 路由，保留 MCP、工具、Skill、白名单、快照和项目知识的真实后端操作。

### 20.2 视觉对照

已确认概念图：[`docs/assets/web-ui-concept-v2.png`](assets/web-ui-concept-v2.png)。实现截图：

- [`docs/assets/web-ui-implementation-desktop.png`](assets/web-ui-implementation-desktop.png)
- [`docs/assets/web-ui-implementation-mobile.png`](assets/web-ui-implementation-mobile.png)

对照结果：

1. 白色主画布、浅灰侧栏、黑色正文和蓝/绿/紫状态层级与概念一致。
2. 桌面侧栏默认 280px，可在 248-360px 间拖动并折叠；390px 视口切换为 Drawer。
3. 会话历史使用首问标题，未显示 Session ID；新会话入口位于历史列表下方。
4. 六项能力保持两列入口布局，来自注册表，并在移动 Drawer 中完整可达。
5. Tool Card 使用小尺寸 16px 图标，中文名称、相对目标、成功状态和简短结果；Skill 与 MCP 具有独立提示。
6. 文件修改卡显示 `src/auth/login.ts +18 −6`，原始输出默认折叠且可交互展开。
7. Composer 固定显示真实模型名与可信上下文状态；本次环境未配置 context window，因此实现截图显示“上下文未知”，没有沿用概念图中的演示百分比。

允许的实现差异：概念图使用 1600×1000 的展示画布并含演示时间戳、头像和模型数据；浏览器验收使用原生 1280×720 桌面视口与 390×844 移动视口，未伪造时间戳、头像或上下文窗口。桌面截图因原生视口高度只同时露出部分卡片，其余内容可在真实时间线滚动查看。首屏没有增加营销文案。

### 20.3 验证证据

- Browser：生产入口 `http://localhost:3000`，页面标题 `DexCode`，DOM 非空，无 error console log。
- 真实流式路径：general 草稿首次发送后使用 replace navigation 进入 durable 会话；侧栏标题为首问而非 ID。
- 历史 replay：canonical fixture 恢复为读取文件、Skill、MCP、修改文件和执行命令五类 Tool Card；普通 DOM 不含 `read_file`、`patch_file`、`run_command`、`activate_skill` 或 `mcp__...`。
- 折叠交互：读取文件卡可展开经过裁剪与遮盖的原始结果，再次点击恢复紧凑态。
- 响应式：390×844 下桌面 resize control 不存在，Drawer 可打开/关闭，历史标题和六项能力均可访问；工具设置页能返回原会话。
- 自动化：`npm test` 25/25，`npm run test:web` 3/3，`npm run lint` 通过，`npm run build:web` 通过。
- 开发入口回归修复：`npm run dev` 使用受控双进程同时启动 Runtime 与 Vite；`test:dev` 在隔离随机端口上验证 `/api/meta` 经代理返回 200。
- 构建稳定性修复：Tailwind 使用 `source(none)` 并只注册 `apps/web/index.html` 与 `apps/web/src`；连续两次生产构建的 10 个产物 SHA-256 完全一致，`dist` 不再因扫描自身而变脏。
- ToolOutcome 缺少可靠字段时应显示保守结果，不根据 JSON 猜测成功。
- 上下文数据缺失时显示未知，不以看似精确的假百分比换取视觉完整。
- 删除旧入口前保留一个可回退提交点；回退不得回滚已经写入的新 canonical Session facts。
- 六个核心功能页采用逐项替换；任一 React 替代页未达到功能等价时，继续保留其兼容链接和旧实现，不进行批量删除。

## 20. 实施约束

- 每次开始实现前确认当前工作树和目标文件，保留无关用户改动。
- 不复制 OpenCode 源码、CSS、图标、测试、命名或目录结构。
- 不以 hard-coded mock Session、假 Tool Card 或固定 token 百分比替代真实生产接口。
- 不允许 renderer 直接访问 Session JSON 文件、provider transport、Tool Gateway 内部状态或全局活动工作区。
- 补充新 contract tests 后，旧浅模块测试若已被新接口覆盖，应替换而不是永久叠加两套测试。
- 每个阶段完成后更新本文件的状态、实际偏差和验证证据。
