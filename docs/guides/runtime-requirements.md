# 运行环境与依赖

本文只说明普通用户从源码安装并运行 DexCode 前需要准备的环境。端口、功能开关和接口参数不属于运行依赖，统一由 `.env.example` 说明。

## 必需环境

### Windows

DexCode 当前支持 Windows 10/11。本地文件工具、命令进程管理和路径安全规则均按 Windows 语义实现；Linux、WSL 和 macOS 不在当前支持范围内。

### Node.js 与 npm

- Node.js 22 或更高版本；
- 随 Node.js 安装的 npm。

可以先确认版本：

```powershell
node --version
npm --version
```

项目的 JavaScript 和 TypeScript 依赖由 `package.json` 与 `package-lock.json` 管理。进入 DexCode 仓库后执行 `npm install` 即可安装，不需要另行准备 `requirements.txt` 或全局 npm 包。

### 文件与进程权限

运行 DexCode 的用户需要：

- 能够读取 DexCode 程序文件；
- 能够在程序目录安装依赖、生成 Web 构建产物并写入 Runtime 状态；
- 能够读取所加载的工作区；若要让 Agent 修改项目，还需要该工作区的写权限；
- 能够启动 Node.js 子进程。命令工具能否启动其他程序，继续受操作系统权限和 DexCode 批准策略约束。

### 模型服务

DexCode 可以在没有模型凭据时启动，但此时使用 Mock Model，只能验证界面和基础 API。要执行真实 Agent 任务，需要：

- `LLM_API_KEY`；
- `LLM_MODEL`；
- 能够访问 `LLM_BASE_URL` 指向的 OpenAI-compatible 服务。

模型服务可以位于本机网络或远程网络；关键是 Runtime 能够访问该端点。具体变量填写方式见 `.env.example`。

### 浏览器

DexCode 通过 Web UI 使用，需要一个支持现代 JavaScript、CSS 和 Server-Sent Events 的浏览器。项目当前没有声明更细的浏览器版本矩阵，建议使用仍在获得更新的 Edge 或 Chrome。

## 条件依赖

以下依赖只在对应场景下需要，不是 DexCode 的统一前置条件。

### ripgrep

`grep` 工具使用 `rg` 搜索磁盘文件。通常不需要用户预先安装：DexCode 会先查找已托管的副本和 `PATH`，仍未找到时再下载适合当前平台的版本。

如果设置了 `DEXCODE_OFFLINE=1`，DexCode 不会下载工具。此时必须提前把 `rg` 安装到 `PATH`，或把可执行文件放入 DexCode 管理的工具目录，否则只有 `grep` 工具不可用。

### Git Bash

默认命令 shell 是 PowerShell，不要求安装 Git Bash。只有显式设置 `DEX_COMMAND_SHELL=bash` 时，才需要可用的 Git Bash；DexCode 不把 WSL 的 `bash.exe` 当作 Git Bash。

### 外部 MCP Server

DexCode 本身不统一要求 Python、Java、Docker 或额外的 Node.js 命令。某个外部 MCP Server 如果依赖这些环境，需要按照该 Server 自己的说明安装；未配置该 Server 时不影响 DexCode 的基础运行。

## 最小安装检查

满足上述必需条件后，可以执行：

```powershell
npm install
Copy-Item .env.example .env
npm run build:web
npm start
```

如果只需要确认程序能否启动，可以暂不填写模型凭据；如果要实际完成编程任务，应先在 `.env` 中配置模型服务。
