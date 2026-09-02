DexCode——本地编程智能体

Git 仓库地址
https://github.com/shi-25-ell/DexCode

一、运行方法

运行环境为 Windows 10/11、Node.js 22.13.0 或更高版本。

在 PowerShell 中依次执行：

git clone https://github.com/shi-25-ell/DexCode.git
cd DexCode
npm install
Copy-Item .env.example .env

编辑 .env，将 LLM_API_KEY 和 LLM_MODEL 的占位内容替换为真实配置，并根据所使用的模型服务修改 LLM_BASE_URL。

当前支持提供 OpenAI-compatible Chat Completions 流式接口的模型服务；其他协议可通过兼容网关接入。

继续执行：

npm run build:web
npm start

浏览器访问 http://localhost:3000，输入需要操作的项目绝对路径并加载。

如果只想验证界面和基础功能，可以跳过复制及编辑 .env 的步骤，此时程序使用 Mock Model。

二、特色功能

1. Skill 与 MCP：Skill 按需导入、启用、删除、读取和激活；MCP 支持 HTTP 和本地进程接入。二者均进入统一的工具权限、批准、取消和结果展示链路。

2. 上下文管理：系统会检查每次模型调用的上下文预算，可外置大型结果、归档历史、压缩旧输出并生成摘要。

3. 项目知识：用户可为每个工作区维护 DEXCODE.md，系统会根据当前任务选择相关段落加入上下文，使 Agent 持续遵循项目约定。

4. 记忆系统：专用 Memory Agent 会异步提取值得跨会话保留的信息；后续任务根据相关性选择并注入记忆。记忆按工作区隔离。

5. Multi-Agent：主 Agent 可以创建具有独立上下文、工具权限和预算的子 Agent。子 Agent 支持并行执行、前台等待、后台运行、继续和停止，结果会交还主会话。用户也可以自定义子 Agent。

6. Queue 与 Steer：运行期间仍可接收新消息。用户可以在安全边界调整当前任务方向，也可选择追加消息，不必先停止运行。

7. 批准模式：支持逐次批准、自动文件修改和完全访问三种模式，命令白名单提供动态细粒度策略。

8. 可恢复与安全执行：会话、工具、批准、子 Agent 状态和终止原因都会持久化。重启后可以恢复历史并识别中断任务。文件和命令操作受到工作区边界、批准模式、命令白名单及 Agent 权限约束。

9. 长任务保障：命令可以在后台持续运行，Agent 能继续读取输出或停止进程；模型回答达到单次输出上限时，系统会逐级扩大输出预算并续写，避免把截断结果误判为完成。

10. 对话式 Web UI：React 提供项目选择、会话历史、流式时间线、Tool Card、上下文状态、Agent Drawer 和能力设置页。

三、架构与设计

1. 整体定位：DexCode 面向真实本地项目中的持续任务，强调可干预、可恢复和可审计。

2. 分层架构：系统由 Web 展示层、Runtime 协调层、Agent 执行层等分层组成，各层只负责自己的状态和行为。

3. 执行链路：Runtime 管理会话、运行和权限；AgentRuntime 统一承载主 Agent、子 Agent 与 Memory Agent；Executor 维护 ReAct 循环。ContextEngine 准备模型上下文，ToolGateway 负责工具校验、批准和工作区边界控制。