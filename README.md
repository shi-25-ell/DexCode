# DexCode

DexCode 是一个面向本地工作区的 Web 编程 Agent。用户通过对话提出任务，Runtime 负责准备上下文、调用模型、执行受控工具、持久化运行事实，并把实时状态投影到 Web 时间线。

## 当前能力

- **编程闭环**：基于 ReAct 循环读取代码、搜索内容、修改文件和执行命令。
- **Multi-Agent**：主 Agent 可以启动、等待、继续或停止持久化子 Agent；子 Agent 有独立上下文、预算、权限和运行状态。
- **可恢复会话**：Session 使用 append-only JSONL journal 保存消息、工具调用、上下文、Queue/Steer 和终态报告。
- **Queue 与 Steer**：运行期间的新消息可以排入下一 Run，也可以在安全边界调整当前 Run 的方向。
- **上下文治理**：每次模型调用前执行预算检查，可外置大型工具结果、归档历史中段、压缩旧工具结果并生成结构化摘要。
- **项目知识与自动记忆**：用户维护的 `DEXCODE.md` 与 Agent 自动维护的 Managed Memory 相互独立。
- **统一批准模式**：支持逐次批准、自动文件修改和完全访问三种模式；命令白名单继续作为细粒度策略存在。
- **Skill 与 MCP**：Skill 按需读取和激活；外部 MCP 工具经过统一发现、展示、批准和取消链路。
- **对话式 Web UI**：React 单页应用提供项目选择、会话历史、流式时间线、Tool Card、上下文状态、Agent Drawer 和能力设置页。

DexCode 当前只维护 Windows 本地文件系统和进程执行语义。

## 快速开始

环境要求：Windows 10/11、Node.js 22 或更高版本。完整的必需环境与条件依赖见 [`docs/guides/runtime-requirements.md`](docs/guides/runtime-requirements.md)。

```powershell
npm install
Copy-Item .env.example .env
# 编辑 .env，至少设置 LLM_API_KEY 和 LLM_MODEL
npm run build:web
npm start
```

生产入口默认是 [http://localhost:3000](http://localhost:3000)，可以通过 `PORT` 修改。

开发模式同时启动 Runtime 和 Vite：

```powershell
npm run dev
```

Vite 默认监听 5173，并把 API 请求代理到 Runtime。也可以分别运行：

```powershell
npm run dev:runtime
npm run dev:web
```

未配置模型凭据时，Runtime 使用 Mock Model；工作区和设置 API 仍可使用，聊天只返回占位结果。

## 配置

主要环境变量如下，完整示例见 `.env.example`。

| 变量 | 说明 |
|---|---|
| `LLM_API_KEY` | OpenAI-compatible API 密钥 |
| `LLM_MODEL` | 模型标识 |
| `LLM_BASE_URL` | API base URL；不填时使用 OpenAI-compatible 默认地址 |
| `LLM_PROVIDER` | 可选 provider 标识，用于适配 provider 参数 |
| `LLM_MAX_OUTPUT_TOKENS` | 模型真实支持的单次输出上限 |
| `LLM_CONTEXT_WINDOW` | 模型上下文窗口，用于可信的上下文预算显示 |
| `PORT` | Runtime 端口，默认 3000 |
| `WEB_PORT` | Vite 端口，默认 5173 |
| `WORKSPACE_DIR` | 可选默认工作区 |
| `DEX_COMMAND_SHELL` | `powershell` 或可用的 Git Bash |
| `DEX_DISABLED_CAPABILITIES` | 从产品外壳移除指定能力入口 |
| `MULTI_AGENT_ENABLED` | Multi-Agent 开关；缺省开启，设为 `false` 或 `off` 可关闭 |
| `DEXCODE_MANAGED_MEMORY_MODE` | Managed Memory 运行模式 |

Runtime 会根据模型请求动态组装工具集合。工具是否可见还取决于工作区、批准模式、Skill、Managed Memory、Multi-Agent 和 Agent ToolPolicy。

## Web 使用方式

1. 在侧栏输入项目绝对路径并加载工作区；该路径只决定当前请求的 workspace scope。
2. 新建会话最初只是客户端草稿；首次发送非空消息时才创建 Session 和 Run。
3. Run 进行中可以停止，也可以把后续消息设为 Queue 或 Steer。
4. Tool Card 默认展示名称、目标、状态和摘要，原始输出按需展开。
5. 当会话存在子 Agent 时，标题栏的 Agent 入口会打开 Agent Drawer，展示状态和独立 transcript。
6. 能力中心提供 MCP、Skill、批准模式、项目知识、自动记忆和子 Agent 配置。

## 项目结构

```text
├─ server.ts                     # 加载环境变量并启动 Runtime
├─ apps/
│  ├─ runtime/server.ts          # HTTP API、依赖装配与 SSE projection
│  └─ web/                       # React + Vite 单页应用
├─ packages/
│  ├─ agent-core/                # Main/Child Run、Executor、Queue/Steer 协调
│  ├─ agent-manager/             # 子 Agent 生命周期、持久化与通知
│  ├─ capability-registry/       # 产品能力入口注册
│  ├─ context-builder/           # 工作区文件与项目知识召回
│  ├─ context-engine/            # 每次模型调用前的四层上下文治理
│  ├─ conversation-view/         # durable facts 到展示模型的投影
│  ├─ llm-client/                # OpenAI-compatible streaming 与事件归一
│  ├─ managed-memory/            # 项目级自动记忆
│  ├─ mcp-client/                # 外部 MCP 客户端与配置
│  ├─ mcp-server/                # 内置 MCP server
│  ├─ run-protocol/              # SSE 事件协议、回放与校验
│  ├─ session-store/             # JSONL Session journal、reducer 与 sidecar
│  ├─ skill-system/              # Skill 发现、导入、读取和激活
│  ├─ template-generator/        # 项目骨架模板服务
│  ├─ tool-gateway/              # 本地工具、批准、命令和统一结果
│  ├─ workspace-manager/         # 工作区解析和文件边界
│  └─ shared/                    # 共享协议类型
├─ docs/                         # 当前文档、完成计划与记录
└─ workspaces/                   # Runtime 状态和默认工作区
```

## 主要 API

新 Web 客户端优先使用 conversation/run 接口；`/api/session/**` 和 `/api/agent/chat` 仍保留兼容用途。

| 范围 | 主要端点 |
|---|---|
| 元数据与能力 | `GET /api/meta`、`GET /api/capabilities` |
| 工作区 | `POST /api/workspaces/resolve`、`GET /api/workspaces/recent` |
| 会话 | `GET /api/conversations`、`GET /api/conversations/:ref/view`、`PATCH/DELETE /api/conversations/:ref` |
| Run | `POST /api/conversation-runs`、`GET /api/conversation-runs/:runRef/events`、`POST /api/conversation-runs/:runRef/commands` |
| Queue/Steer | `/api/conversations/:ref/queued-messages/**` |
| 子 Agent | `/api/session/:id/agents/**`、`/api/agent-definitions/**` |
| 项目知识与记忆 | `/api/project-knowledge`、`/api/managed-memory/**` |
| Skill | `/api/skills`、`/api/skills/reload`、`/api/skills/import/**`、`/api/skills/:name` |
| 工具与批准 | `/api/tools/**`、`/api/approval-mode`、`/api/command-whitelist/**`、`/api/agent/approval` |
| 外部 MCP | `/api/external-mcp/servers`、`/api/external-mcp/tools` |
| 内置 MCP | `GET/POST /mcp`、`/api/mcp/**` |
| 模板服务 | `/api/templates/**`、`POST /api/scaffold/generate` |

## 验证命令

```powershell
npm run lint
npm test
npm run test:web
npm run build:web
npm run test:dev
```

文档入口见 [`docs/README.md`](docs/README.md)，当前架构见 [`docs/architecture.md`](docs/architecture.md)。
