# DexCode

一个基于 Web 的 AI 编程助手，通过聊天界面让 AI Agent 自主读写工作区文件、执行命令，实时流式输出执行过程。

## 功能

- **聊天驱动**：向 AI 下达自然语言编码指令，单 Agent Run 通过 ReAct 循环直接执行，不包含 Orchestrator 或多 Agent 调度
- **智能文件编辑**：Agent 优先用 `patch_file` 做局部修改，仅在新建或整文件重写时使用 `write_file`；支持 `search_in_workspace` 先定位再修改
- **文件管理**：浏览、编辑、创建、重命名、删除工作区文件
- **真实流式输出**：OpenAI-compatible SSE 会被解析为统一的文本、reasoning、tool call 和 terminal 事件，再通过有界 SSE 队列输出
- **可恢复会话**：多会话独立隔离，持久化 Run ledger、终态报告、上下文清单和压缩 checkpoint
- **对话式 Web UI**：浅色单列时间线、可伸缩侧边栏、移动端抽屉和可折叠中文 Tool Card
- **按项目隔离**：项目路径只选择请求 scope，不再修改一个全局活动工作区；首页会话与各项目会话相互隔离
- **延迟物化草稿**：点击“新建会话”不会产生空 Session，首次发送非空消息才原子创建会话与 Run
- **可替换产品外壳**：品牌图标可由构建变量替换，能力入口由服务端注册表驱动，可逐项移除
- **MCP 兼容**：内置 MCP server（JSON-RPC 2.0），可作为标准 MCP 工具服务被外部客户端接入
- **Mock 模式**：未配置 LLM 凭据时自动降级，不影响文件管理功能

## 环境要求

- Windows 10/11
- Node.js 22+（使用 `--experimental-strip-types` 直接运行 TypeScript，无需编译）

DexCode 当前只维护 Windows 本地执行语义；不承诺 Linux、WSL 或 macOS 兼容。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置 LLM（见下方"LLM 配置"章节）
Copy-Item .env.example .env
# 编辑 .env 填入你的 API Key

# 3. 构建并启动生产入口
npm run build:web
npm start
```

访问 http://localhost:3000

默认端口为 3000，可通过 `PORT` 环境变量修改。

## 界面操作

### 工作区加载

侧边栏顶部输入项目绝对路径，点击“加载”或按 Enter。成功后只显示该工作区的历史会话；清空路径并提交可返回无工作区首页。选择工作区不会创建会话，也不会改变其他浏览器标签页的工作区。

### 聊天

- **发送**：在输入框按 Enter 发送
- **换行**：Shift+Enter 换行
- Agent 执行过程中可显式停止，工具、Skill 与 MCP 调用以短小的中文卡片展示
- Tool Card 默认只显示名称、目标、状态和摘要；原始输出需要主动展开
- 文件修改使用工作区相对路径与 `+N -M` 统计
- 输入框下方显示真实模型名和上下文占用；数据不完整时明确显示“上下文未知”

### 会话切换

历史会话位于侧边栏，默认标题来自第一条用户问题，不显示 Session ID。点击“新建会话”只打开客户端草稿；未发送即离开不会写入持久化记录。首次发送后，页面使用 replace navigation 切换到持久会话地址。

### 能力中心与品牌资源

MCP、工具、Skill、白名单、快照、项目知识均从统一 React 外壳进入。入口来自 `CapabilityRegistry`，不是 Sidebar 内的固定数组：

```dotenv
# 逗号分隔；移除注册项后，侧边栏和设置路由同时收口
DEX_DISABLED_CAPABILITIES=snapshots,project-knowledge

# 构建时替换品牌图标；缺省使用 public/brand-icon.svg
VITE_BRAND_ICON_URL=/my-brand.svg
```

桌面侧边栏可拖动宽度或折叠；窄屏使用抽屉。依赖工作区的能力在首页会说明需要先选择项目，不会静默失效。

## LLM 配置

项目支持所有 OpenAI-compatible 接口，通过 `.env` 文件配置。

### LiteLLM（推荐）

[LiteLLM](https://github.com/BerriAI/litellm) 作为统一代理，可以在后端连接任意模型。

```dotenv
LLM_API_KEY=sk-anything
LLM_MODEL=gpt-4o
LLM_BASE_URL=http://localhost:4000
```

### OpenAI

```dotenv
LLM_API_KEY=sk-xxx
LLM_MODEL=gpt-4o
# LLM_BASE_URL 不填，默认 https://api.openai.com/v1
```

### DeepSeek

```dotenv
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-chat
LLM_BASE_URL=https://api.deepseek.com/v1
```

### 豆包（Doubao）

```dotenv
LLM_API_KEY=your_key
LLM_MODEL=your_model_id
LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
LLM_PROVIDER=doubao
```

> `LLM_PROVIDER=doubao` 会自动注入豆包专有参数 `thinking` 和 `reasoning_effort`。

### 环境变量说明

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_API_KEY` | 是 | API 密钥 |
| `LLM_MODEL` | 是 | 模型名称 |
| `LLM_BASE_URL` | 否 | API 地址，默认 `https://api.openai.com/v1` |
| `LLM_PROVIDER` | 否 | Provider 标识，目前仅 `doubao` 有特殊行为 |
| `LLM_TEMPERATURE` | 否 | 温度，默认 `0.7` |
| `LLM_MAX_TOKENS` | 否 | 最大 token 数，默认 `4096` |
| `LLM_TOP_P` | 否 | Top-p 采样，不填则不传给 API |
| `LLM_TIMEOUT` | 否 | 请求超时（毫秒） |
| `LLM_MAX_RETRIES` | 否 | 最大重试次数 |
| `LLM_CONTEXT_WINDOW` | 否 | 模型上下文窗口；未配置时 UI 不伪造使用率 |
| `WORKSPACE_DIR` | 否 | 启动时默认加载的工作区目录 |
| `PORT` | 否 | HTTP 服务端口，默认 `3000` |
| `WEB_PORT` | 否 | Vite 开发服务器端口，默认 `5173`；占用时明确失败 |
| `RUNTIME_ORIGIN` | 否 | Vite 开发代理目标；默认跟随 `PORT` |
| `DEX_DISABLED_CAPABILITIES` | 否 | 要从产品外壳移除的能力 ID，逗号分隔 |
| `VITE_BRAND_ICON_URL` | 否 | 前端构建时使用的品牌图标 URL |

**向后兼容**：`DOUBAO_API_KEY` / `DOUBAO_MODEL` / `DOUBAO_BASE_URL` 变量在未设置 `LLM_*` 时仍然生效。

### Mock 模式

不配置任何 Key 时自动进入 Mock 模式，文件管理功能完全正常，AI 对话返回占位响应。

`GET /api/meta` 返回面向产品的模型和工作区描述，不在普通 UI 暴露 provider wire 字段：

```json
{ "appName": "DexCode", "model": { "displayName": "Mock Model" } }
```

## 项目结构

```
├── server.ts                    # 入口：加载 .env，启动服务
├── apps/
│   ├── runtime/server.ts        # HTTP 服务器 + API 路由
│   └── web/                     # Vite + React + TypeScript 单页应用
├── packages/
│   ├── agent-core/              # 单 Agent Run、ReAct 循环、终态报告与 Session contract
│   ├── capability-registry/     # 可删除的产品能力注册表
│   ├── conversation-view/       # canonical facts 到产品展示模型的投影
│   ├── mcp-server/              # MCP server（JSON-RPC 2.0，工具/资源/提示词注册）
│   ├── llm-client/              # OpenAI-compatible canonical streaming
│   │   ├── types.ts             # ModelEvent、ModelResponse、failure taxonomy
│   │   ├── openai.ts            # OpenAI-compatible SSE transport/parser
│   │   ├── turn-accumulator.ts  # 严格归约并校验完整 Model Turn
│   │   ├── mock.ts              # Mock 实现
│   │   └── index.ts             # 工厂函数 createModelClient()
│   ├── tool-gateway/            # 工具调用（读写文件、执行命令，按需磁盘读取，MCP 注册）
│   ├── workspace-manager/       # 工作区文件树管理（运行时可切换根目录）
│   ├── session-store/           # 原子 JSON 会话仓库、Run ledger 与中断恢复
│   ├── context-builder/         # 当前工作区上下文来源
│   └── shared/                  # 公共类型和工具函数
├── workspaces/
│   └── demo-project/            # 默认工作区（可通过 WORKSPACE_DIR 覆盖）
└── mydocs/                      # 项目内部设计文档
```

## API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/meta` | GET | 产品模型描述与当前请求工作区信息 |
| `/api/capabilities` | GET | 当前启用的产品能力入口 |
| `/api/workspaces/resolve` | POST | 解析项目路径并返回 opaque workspace ref |
| `/api/conversations` | GET | general 或 workspace scope 的产品会话列表 |
| `/api/conversations/:ref/view` | GET | 可直接渲染的历史会话投影 |
| `/api/conversation-runs` | POST | 首次物化或继续会话的 SSE Run 入口 |
| `/api/conversation-runs/:runRef/commands` | POST | 显式停止当前 Run |
| `/api/session` | GET | 当前会话信息 |
| `/api/session` | POST | 准备新会话（首条聊天消息到达时持久化） |
| `/api/sessions` | GET | 历史会话列表（含最后消息预览） |
| `/api/session/switch` | POST | 切换到指定会话 |
| `/api/workspace` | GET | 文件树 |
| `/api/workspace/load` | POST | 切换工作区目录 |
| `/api/fs/suggest` | GET | 路径前缀补全（返回子目录列表） |
| `/api/file/:path` | GET | 读取文件（从磁盘按需读取） |
| `/api/file` | PUT | 写入文件 |
| `/api/folder` | PUT | 创建目录 |
| `/api/item/rename` | POST | 重命名 |
| `/api/item/delete` | POST | 删除 |
| `/api/tool/run` | POST | 执行命令 |
| `/api/agent/chat` | POST | Agent 执行（SSE 流式） |
| `/api/agent/confirm` | POST | 响应 Agent 确认请求 |
| `/mcp` | GET | MCP SSE ready 事件 |
| `/mcp` | POST | MCP JSON-RPC handler（`tools/call`、`resources/read` 等） |
| `/api/mcp/tools` | GET | 列举所有 MCP 工具 |
| `/api/mcp/resources` | GET | 列举所有 MCP 资源 |
| `/api/mcp/tool/:name` | POST | 直接调用指定 MCP 工具 |

## 开发

```bash
# 类型检查
npm run typecheck

# 前端生产编译
npm run build:web

# 前端单元与组件测试
npm run test:web

# 关键链路测试
npm test

# 开发：单命令同时启动 Runtime 与 Vite
npm run dev

# 也可以分别调试两个进程
npm run dev:runtime
npm run dev:web

# 验证单命令开发入口及 API 代理
npm run test:dev
```

详细架构见 [`docs/架构.md`](docs/架构.md)，本轮重构计划和实际结果分别见 [`docs/core-refactor-plan.md`](docs/core-refactor-plan.md) 与 [`docs/core-refactor-implementation-report.md`](docs/core-refactor-implementation-report.md)。
