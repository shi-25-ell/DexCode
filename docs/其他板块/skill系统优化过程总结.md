# Skill 系统优化过程总结
## 1. 优化背景
本次优化前，`dexcode` 已经具备基础 DexCode 闭环。
现有系统中，`context-builder` 负责构建工作区上下文，`agent-core` 负责组织 prompt 和任务执行，`executor` 负责 ReAct 循环，`tool-gateway` 提供文件读写、搜索、命令执行等本地工具。
同时，项目已经支持 MCP、session、task summary、project memory 和 SSE 事件流。
这些能力说明 Agent 已经可以完成基本编码任务，但缺少真正意义上的 Skill 系统。
当时的问题不是“没有几个提示词”，而是没有完整的 Skill 生命周期。
系统还不能稳定回答这些问题：
- 当前有哪些 Skill？
- 哪些 Skill 可以给 Agent 使用？
- Skill 何时被触发？
- Skill 正文何时加载？
- 用户能否禁用误触发的 Skill？
- 外部通用 Skill 能否导入并降级使用？
因此，本次优化的目标是把 Skill 从简单提示词片段升级为 Agent 的专业工作流能力。
## 2. 问题发现
阅读代码和文档后，主要发现四类问题。
第一，系统没有统一的 Skill Registry。
Skill 无法被统一扫描、注册、启用、禁用和读取，也没有来源优先级和使用统计。
第二，系统没有兼容主流工具的 Skill 格式。
如果只定义项目内部格式，后续导入 Claude Code、Codex 风格的外部 Skill 会很别扭。
第三，触发机制容易被误设计成关键词匹配。
关键词触发看似简单，但会导致误触发、漏触发，也不符合主流 AI coding 工具的 Skill 机制。
第四，用户缺少可见性和控制权。
如果 Skill 在后台默默影响模型，用户既不知道它为什么触发，也无法及时禁用或检查。
## 3. 设计校准
优化过程中最关键的判断是：Skill 触发应以 `description` 为核心，而不是以关键词规则为核心。
最终确定的主协议是：
```text
SKILL.md + frontmatter description
```
Skill 是一个目录，核心入口文件是 `SKILL.md`。
`SKILL.md` 的 frontmatter 中，`name` 和 `description` 是最重要的机器可读字段。
隐式触发时，系统只把 Skill 的轻量摘要放进上下文，由模型根据用户任务和 `description` 判断是否使用。
显式触发时，用户可以通过类似 `/test-writing` 或 `$code-review` 的方式直接指定 Skill。
当模型决定使用 Skill 时，必须先调用 `read_skill` 读取完整 `SKILL.md`，再调用 `activate_skill` 正式记录使用。
这就是 progressive disclosure：初始 prompt 只放摘要，真正需要时再加载完整内容。
## 4. 总体架构
本次优化新增了 `packages/skill-system` 作为核心包。
该包主要包含：
- `types.ts`：定义 Skill 数据结构。
- `parser.ts`：解析 `SKILL.md` frontmatter。
- `loader.ts`：扫描 Skill 目录并生成标准定义。
- `registry.ts`：维护 Skill 列表、启用状态、读取和使用记录。
- `router.ts`：识别显式触发并生成 Available Skills prompt block。
- `capability.ts`：推断 Skill 需要的工具能力。
- `importer.ts`：支持外部 Skill 预检查和导入。
- `builtin-skills/`：存放内置 Skill。
整体流程如下：
```text
扫描 Skill 目录
-> 解析 SKILL.md
-> 注册到 Skill Registry
-> 生成 Skill 摘要
-> 注入 Agent system prompt
-> 模型按 description 判断是否读取
-> read_skill 加载完整内容
-> activate_skill 记录使用
-> SSE 和 TaskSummary 展示结果
```
## 5. 具体实现
### 5.1 类型与解析
`types.ts` 定义了 `SkillDefinition`、`SkillSummary`、`SkillUsage`、`SkillReadResult` 和 `SkillActivationResult`。
其中 `SkillDefinition` 保存完整内容，`SkillSummary` 用于轻量展示和 prompt 注入。
`parser.ts` 实现轻量 frontmatter 解析，支持 `name`、`description`、`disable-model-invocation`、`allow-implicit-invocation`、`allowed-tools`、`disallowed-tools`、`paths` 和 `tags`。
如果没有 `description`，系统会从正文第一段推断降级描述。
### 5.2 加载与注册
`loader.ts` 负责从目录中识别 `SKILL.md`，并转换为统一的 `SkillDefinition`。
加载时会做路径边界检查，避免越权读取 Skill 根目录之外的文件。
`registry.ts` 负责管理 Skill 生命周期。
它支持加载内置 Skill、项目级 `.aicoding/skills`、兼容 `.claude/skills` 和 `.agents/skills`。
Registry 还支持启用、禁用、重载、读取、激活、停用和删除项目级 Skill。
同名 Skill 按来源优先级处理：
```text
project > user > imported > builtin
```
优先级较低的同名 Skill 会标记为 `shadowed`，避免多个 Skill 同时生效。
### 5.3 路由与上下文注入
`router.ts` 实现了显式触发识别。
它可以从用户输入中识别 `/skill-name` 和 `$skill-name`。
同时，它会生成 `Available Skills` 区块，注入 system prompt。
该区块要求模型在使用普通工具前先检查 Skill 摘要；如果某个 Skill 的 `description` 与任务匹配，必须先调用 `read_skill`，再根据情况调用 `activate_skill`。
这样，Skill 不会一开始就污染上下文，也不会脱离模型判断。
### 5.4 Agent 与 Executor 集成
`agent-core/index.ts` 增加了 Skill Registry 参数。
任务开始时，Agent 会构建普通 workspace context，再构建 Skill 摘要区块，并把它加入 system prompt。
任务结束时，实际使用过的 Skill 会写入 `TaskSummary.skillsUsed`。
`executor.ts` 新增了 Skill tools：
- `list_skills`
- `read_skill`
- `activate_skill`
- `deactivate_skill`
当模型调用这些工具时，executor 会调用 Registry，并通过 SSE 发送 `type: "skill"` 事件。
例如读取 Skill 会发送 `action: "read"`，激活 Skill 会发送 `action: "activated"`。
这让 Skill 的使用过程可以被前端展示，也方便后续调试。
## 6. 内置 Skill
本次优化加入了四个内置 Skill。
- `test-writing`：用于编写和维护测试。
- `frontend-development`：用于用户界面开发和样式交互优化。
- `code-review`：用于审查正确性、回归风险和测试缺口。
- `debugging-recovery`：用于测试失败、构建失败和运行时错误定位。
这四个 Skill 都以 `SKILL.md` 文件形式存在，而不是写死在代码中。
选择它们的原因是通用性强，并且能自然适配当前的文件读写、搜索和命令执行能力。
## 7. 外部 Skill 导入
为了兼容外部通用 Skill，本次优化新增了导入机制。
`importer.ts` 支持三种导入方式：
- 本地目录路径。
- 工作区内路径。
- 直接粘贴 `SKILL.md` 内容。
导入前会先执行 preview，不直接写入文件。
preview 会生成兼容报告，展示名称、描述、目标位置、隐式触发策略、需要能力、缺失能力、资源目录、脚本目录、风险提示和冲突信息。
真正导入时，系统会把 Skill 写入：
```text
.aicoding/skills/<skill-name>
```
导入完成后自动 reload，让新 Skill 进入 Registry。
外部 Skill 中如果包含 `scripts/`，系统只展示风险提示，不会自动执行。
## 8. 后端与前端
runtime server 中新增了 Skill 管理 API。
主要接口包括：
- `GET /api/skills`
- `GET /api/skills/:name`
- `PATCH /api/skills/:name`
- `DELETE /api/skills/:name`
- `POST /api/skills/reload`
- `POST /api/skills/import/preview`
- `POST /api/skills/import`
前端新增 Skill 管理页面。
用户可以查看 Skill 名称、描述、来源、启用状态、隐式触发策略、读取次数、激活次数、最近使用时间和缺失能力。
用户也可以启用、禁用、删除项目级 Skill，并通过弹窗导入新的 Skill。
这一步解决了 Skill 系统不可见、不可控的问题。
## 9. 优化后效果
优化后，Skill 系统形成了完整闭环。
系统启动时可以加载内置 Skill 和项目级 Skill。
Agent 初始 prompt 中只出现 Skill 摘要，不出现完整 `SKILL.md`。
模型可以根据 `description` 隐式选择 Skill，也可以响应用户的显式触发。
Skill 被读取、激活或停用时，会产生可观察的 SSE 事件。
任务结束后，实际使用过的 Skill 会写入任务摘要。
用户可以在前端管理 Skill，而不是让 Skill 在后台静默生效。
外部 Skill 可以通过预检查和兼容报告进入系统，缺失能力会被标记，而不是直接拒绝整个 Skill。
## 10. 总结
这次优化的核心，是把 Skill 从“提示词片段”升级为“Agent 工作流能力”。
实现上坚持了几个原则：
- 以 `SKILL.md` 为核心格式。
- 以 `description` 作为隐式触发依据。
- 支持 `/skill` 和 `$skill` 显式触发。
- 使用 progressive disclosure 控制上下文。
- 用 Registry 管理 Skill 来源、状态和使用统计。
- 用 Skill tools 完成读取、激活和审计。
- 用 API 和前端提供用户可见性与控制权。
后续还可以继续增强外部 manifest adapter、Skill references 搜索、asset 读取、浏览器测试能力和谨慎的脚本执行能力。
总体来看，本次优化已经让 `dexcode` 拥有了一个接近主流 AI coding 工具思路的 Skill 系统基础。
