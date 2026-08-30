# DexCode

一个基于 Web 的 AI 编程助手，通过聊天界面让 AI Agent 自主读写工作区文件、执行命令，实时流式输出执行过程。

## 功能

- **聊天驱动**：向 AI 下达自然语言编码指令，Agent 自主规划并执行（ReAct 循环，最多 20 轮）
- **智能文件编辑**：Agent 优先用 `patch_file` 做局部修改，仅在新建或整文件重写时使用 `write_file`；支持 `search_in_workspace` 先定位再修改
- **文件管理**：浏览、编辑、创建、重命名、删除工作区文件
- **实时流式输出**：通过 Server-Sent Events 显示 Agent 执行进度
- **会话管理**：多会话独立隔离，支持切换历史会话并还原完整对话
- **MCP 兼容**：内置 MCP server（JSON-RPC 2.0），可作为标准 MCP 工具服务被外部客户端接入
- **Mock 模式**：未配置 LLM 凭据时自动降级，不影响文件管理功能

## 环境要求

- Node.js 22+（使用 `--experimental-strip-types` 直接运行 TypeScript，无需编译）

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置 LLM（见下方"LLM 配置"章节）
cp .env.example .env
# 编辑 .env 填入你的 API Key

# 3. 启动
npm run dev
```

访问 http://localhost:3000

默认端口为 3000，可通过 `PORT` 环境变量修改。

## 界面操作

### 工作区加载

顶部栏左侧为工作区路径输入框，支持：

- **路径补全**：输入前缀后自动下拉显示匹配的子目录（最多 10 条）；点击补全项自动展开下一层
- **Tab 键**：填入下拉第一项并展开下一层
- **历史记录**：点击空输入框弹出最近加载过的路径（localStorage 保存，最多 10 条）
- **加载**：点击"加载"按钮或按 Enter 切换工作区，同时新建一个空白会话

### 聊天

- **发送**：在输入框按 Enter 发送
- **换行**：Shift+Enter 换行
- Agent 执行过程中输入框自动禁用，工具调用以可折叠卡片展示

### 会话切换

点击顶部"会话 #XXXXXX"徽章，弹出本工作区所有历史会话列表，每条显示：

- 会话 ID 缩写和最后活跃时间
- 最后一条用户消息预览（最多 60 字）
- 任务数量

点击任意历史会话，聊天区域还原该会话的完整对话记录，后续新任务在该会话下继续执行。

会话之间**完全隔离**，切换会话不影响当前工作区文件树。

### 文件树

- 点击文件在编辑器中打开，内容直接可编辑，失焦后自动保存
- 右键文件/目录弹出上下文菜单（重命名、删除）
- 顶部"新建"按钮可新建文件或目录
- 拖动三列面板间的分隔线可调整宽度

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
| `WORKSPACE_DIR` | 否 | 启动时默认加载的工作区目录 |
| `PORT` | 否 | HTTP 服务端口，默认 `3000` |

**向后兼容**：`DOUBAO_API_KEY` / `DOUBAO_MODEL` / `DOUBAO_BASE_URL` 变量在未设置 `LLM_*` 时仍然生效。

### Mock 模式

不配置任何 Key 时自动进入 Mock 模式，文件管理功能完全正常，AI 对话返回占位响应。

`GET /api/meta` 可以查看当前 LLM 状态：

```json
{ "llmEnabled": false, "provider": "mock" }
```

## 项目结构

```
├── server.ts                    # 入口：加载 .env，启动服务
├── apps/
│   ├── runtime/server.ts        # HTTP 服务器 + API 路由
│   └── web/                     # 前端（原生 TypeScript）
├── packages/
│   ├── agent-core/              # Agent 流程（ReAct 循环，最多 20 轮）
│   ├── mcp-server/              # MCP server（JSON-RPC 2.0，工具/资源/提示词注册）
│   ├── llm-client/              # LLM 客户端抽象层
│   │   ├── types.ts             # ModelClient 接口定义
│   │   ├── openai.ts            # OpenAI-compatible 实现
│   │   ├── mock.ts              # Mock 实现
│   │   └── index.ts             # 工厂函数 createModelClient()
│   ├── tool-gateway/            # 工具调用（读写文件、执行命令，按需磁盘读取，MCP 注册）
│   ├── workspace-manager/       # 工作区文件树管理（运行时可切换根目录）
│   ├── session-store/           # 会话持久化（JSON 文件，支持列举/切换）
│   ├── context-builder/         # 构建 LLM 上下文（按相关性选文件）
│   └── shared/                  # 公共类型和工具函数
├── workspaces/
│   └── demo-project/            # 默认工作区（可通过 WORKSPACE_DIR 覆盖）
└── mydocs/                      # 项目内部设计文档
```

## API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/meta` | GET | 应用信息、LLM 状态 |
| `/api/session` | GET | 当前会话信息 |
| `/api/session` | POST | 新建会话 |
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

# 前端编译（修改 app.ts 后需执行）
npm run build:web

# 启动（热重载需手动重启）
npm run dev
```
