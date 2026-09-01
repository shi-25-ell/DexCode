# Skill 系统设计方案

## 1. 背景与目标

当前 `dexcode` 已经具备一个基础 DexCode 闭环：

- `context-builder` 负责构建工作区上下文。
- `agent-core` 负责组织 system prompt、会话历史和任务执行。
- `executor` 负责 ReAct 循环和工具调用。
- `tool-gateway` 提供读写文件、搜索、命令执行、版本快照等本地工具。
- `mcp-server` 与 `mcp-client` 支持本地 MCP 暴露和外部 MCP 工具接入。
- `session-store` 负责会话、任务摘要和项目记忆。

现有系统有工具系统和 MCP 能力，但还没有真正意义上的 Skill 系统。我们要实现的 Skill 系统不应是玩具级 prompt 片段管理，而应尽量接近 Claude Code、OpenAI Codex 等主流 AI coding 软件的 Skill 机制。

## 2. 核心结论

本项目的 Skill 系统采用以下核心路线：

```text
主协议：SKILL.md + frontmatter description
触发核心：description 驱动的模型选择
上下文策略：progressive disclosure
用户控制：前端可见、可禁用、可查看触发记录
兼容方向：优先兼容 Claude Code / Codex 风格的通用 Skill
```

需要特别明确：我们不把 Skill 设计成关键词触发器，也不把规则召回或 embedding 检索作为第一版核心机制。系统把 Skill 的 `name`、`description` 和路径放入上下文，模型先根据任务和 `description` 判断是否匹配；若匹配，则先调用 `read_skill` 读取完整内容，再调用 `activate_skill` 记录使用。规则、路径、policy、预算裁剪可以作为工程增强，但不能替代 `description`。

## 3. 设计原则

### 3.1 兼容主流 Skill 格式

Skill 系统应优先兼容 Anthropic Claude Code、OpenAI Codex 等主流 Agent Skills 的通用形态：

- Skill 是一个目录。
- `SKILL.md` 是核心入口文件。
- `SKILL.md` frontmatter 中的 `name` 和 `description` 是最重要的机器可读字段。
- `description` 是隐式触发的核心依据。
- Skill 可以包含 `references/`、`scripts/`、`assets/`、`templates/` 等辅助资源。
- Agent 初始只看到 Skill 的轻量元信息，真正使用时再加载完整内容。

可兼容的扩展字段包括：

- `disable-model-invocation`
- `allow_implicit_invocation`
- `allowed-tools`
- `disallowed-tools`
- `paths`
- `tags`
- `filePatterns`
- `requiredCapabilities`
- `optionalCapabilities`

这些字段只能用于可见性、权限、排序、过滤、能力分析和前端展示，不应成为核心触发协议。

### 3.2 Description 驱动的模型选择

市场上通用 Skill 的触发主要有两种：

- 隐式触发：模型根据用户请求与 Skill 的 `description` 判断是否使用。
- 显式触发：用户通过 `/skill-name`、`$skill-name` 或类似形式直接指定。

我们的系统也采用这一机制：

```text
扫描 Skill
-> 解析 SKILL.md frontmatter
-> 将 name、description、path、invocation policy 放入 Skill 摘要列表
-> 注入 system prompt
-> Agent 根据用户任务和 description 判断是否隐式触发
-> 用户也可以显式触发
-> 触发后加载完整 SKILL.md
-> 后续按需读取 references/scripts/assets
```

### 3.3 Progressive Disclosure

Skill 内容必须渐进式加载：

- 初始上下文只注入 Skill 摘要列表。
- 只有当 Skill 被选择或模型请求时，才读取完整 `SKILL.md`。
- references、scripts、assets 不应自动全量注入，只能按需读取。
- 每次任务要有 Skill 上下文预算，避免 Skill 数量过多污染 prompt。

### 3.4 用户可控与可观察

Skill 系统不仅要服务 Agent，也要让用户理解和控制它。

用户应当能在前端看到：

- 当前系统中有哪些 Skill。
- 每个 Skill 的名称、描述、来源和启用状态。
- 该 Skill 是否允许隐式触发。
- 该 Skill 需要哪些工具能力。
- 是否存在缺失能力。
- 最近一次使用时间和累计使用次数。

用户应当能在前端操作：

- 启用或禁用某个 Skill。
- 查看完整 `SKILL.md`。
- 重新加载 Skill。
- 查看一次对话中触发了哪些 Skill。

对话过程中，如果 Agent 使用了 Skill，前端应该展示一个明确事件，例如：

```text
已启用 Skill：test-writing
```

这样可以避免 Skill 在后台“悄悄影响模型”，也便于调试误触发和漏触发。

### 3.5 能力降级可用

导入外部通用 Skill 时，Skill 系统应尽量加载和使用它。若某些工具、脚本运行环境或 MCP 能力不支持，应标记为缺失能力，而不是拒绝整个 Skill。

```text
外部 Skill 目录
-> 格式探测
-> adapter 归一化
-> 能力分析
-> 注册到 Skill Registry
-> Agent 按统一接口使用
```

## 4. Skill 文件结构

### 4.1 推荐结构

```text
skill-name/
  SKILL.md
  skill.json                 # 可选
  references/                # 可选
  scripts/                   # 可选
  assets/                    # 可选
  templates/                 # 可选
```

### 4.2 `SKILL.md` 示例

```markdown
---
name: test-writing
description: Write and maintain tests for code changes. Use when implementing behavior, fixing bugs, changing APIs, or when the user asks to add, update, or run tests.
---

# Test Writing

## When to Use

Use this skill when a task changes observable behavior or requires proof through tests.

## Workflow

1. Inspect the existing test framework.
2. Identify the behavior under change.
3. Add or update focused tests.
4. Run the smallest relevant test command.
5. Fix failures caused by the change.
6. Report evidence.
```

### 4.3 可选 Manifest

为了兼容外部 Skill，我们可以支持多种 manifest：

- `skill.json`
- `manifest.json`
- `.skill/manifest.json`
- `agents/openai.yaml`

内部统一归一化为 `SkillManifest`：

```ts
type SkillManifest = {
  name: string;
  description: string;
  version?: string;
  source: "builtin" | "project" | "user" | "imported";
  rootPath: string;
  skillFilePath: string;
  enabled: boolean;
  allowImplicitInvocation: boolean;
  userInvocable: boolean;
  tags: string[];
  filePatterns: string[];
  allowedTools: string[];
  disallowedTools: string[];
  requiredCapabilities: string[];
  optionalCapabilities: string[];
  missingCapabilities: string[];
};
```

如果外部 Skill 没有 manifest，只要存在 `SKILL.md`，也应该可以导入。系统从 frontmatter 和正文前几段推断元信息。

## 5. 总体架构

新增核心包：

```text
packages/skill-system/
  index.ts
  types.ts
  parser.ts
  loader.ts
  registry.ts
  router.ts
  context.ts
  capability.ts
  usage.ts
  builtin.ts
  builtin-skills/
```

### 5.1 Skill Parser

职责：

- 读取 `SKILL.md`。
- 解析 YAML frontmatter。
- 提取 `name`、`description`、`disable-model-invocation`、`allowed-tools` 等字段。
- 在缺少 `description` 时使用正文第一段作为降级描述。
- 保留原始 markdown 内容供 `read_skill` 使用。

第一版可以实现轻量 YAML 解析，只支持常见标量、字符串数组和布尔值。后续再增强完整 YAML 支持。

### 5.2 Skill Loader

职责：

- 扫描 Skill 根目录。
- 识别 `SKILL.md`。
- 读取可选 manifest。
- 校验目录边界，防止越权读取。
- 生成标准 `SkillDefinition`。

Skill 来源：

- 内置：`packages/skill-system/builtin-skills`
- 项目级：`<workspace>/.aicoding/skills`
- 兼容 Claude：`<workspace>/.claude/skills`
- 兼容 Codex：`<workspace>/.agents/skills`
- 用户级：后续可扩展为用户配置目录
- 导入：用户通过 API 导入的外部 Skill

### 5.3 Skill Registry

职责：

- 维护 Skill 列表。
- 支持启用、禁用、重载。
- 处理同名 Skill。
- 提供轻量摘要给 Agent。
- 提供完整 Skill 内容读取接口。
- 记录使用次数、最近使用时间、失败信息。

优先级建议：

```text
project > user > imported > builtin
```

同名 Skill 不直接合并。若出现冲突，前端应展示冲突信息。第一版可以采用优先级最高者生效，其余标记为 `shadowed`。

### 5.4 Skill Router

职责：

- 识别用户显式触发的 Skill，例如 `/test-writing`、`$frontend-development`。
- 按启用状态和 policy 过滤不可用 Skill。
- 构建可注入的 Skill 摘要列表。
- 将摘要交给模型，由模型根据 `description` 决定是否调用 `read_skill` 或 `activate_skill`。

Router 不应变成关键词触发器。规则只用于：

- 显式触发识别。
- 禁用 Skill 过滤。
- `allowImplicitInvocation=false` 过滤。
- `paths` 或 `filePatterns` 过滤。
- Skill 摘要预算裁剪。

未来如果 Skill 数量很大，可以增加 embedding 检索和 LLM rerank，但这不是第一版目标。

### 5.5 Skill Context Provider

职责：

- 为 `agent-core` 生成 Skill 摘要区块。
- 控制 Skill 摘要数量和字符预算。
- 在 Skill 被激活后提供完整 `SKILL.md` 内容。
- 支持按需读取 references、assets、templates。

注入格式建议：

```text
## Available Skills

Before using ordinary tools, check this list. If any skill description directly matches the user task, call read_skill first. After reading it, call activate_skill if it applies. Do not use disabled skills.

- test-writing: Write and maintain tests for code changes. Use when...
- frontend-development: Build or modify user-facing UI...
- code-review: Review code changes for correctness...
- debugging-recovery: Diagnose and recover from failures...
```

### 5.6 Skill Tools

在 `executor` 中新增 Skill 相关工具定义：

- `list_skills`
- `read_skill`
- `activate_skill`
- `deactivate_skill`
- `search_skill_references`
- `get_skill_asset`
- `run_skill_script`

第一版建议实现：

- `list_skills`：列出可用 Skill 摘要。
- `read_skill`：读取完整 `SKILL.md`。
- `activate_skill`：显式激活 Skill，并记录到当前任务。
- `deactivate_skill`：停止使用某个 Skill。

第二版再实现：

- `search_skill_references`
- `get_skill_asset`

第三版谨慎实现：

- `run_skill_script`

### 5.7 Capability Analyzer

职责：

- 分析 Skill 需要哪些能力。
- 判断当前系统是否支持。
- 给导入结果生成兼容报告。

能力映射：

```text
read file       -> read_file
write file      -> write_file / patch_file
search          -> grep / find
shell/bash      -> run_command
ask user        -> 普通对话
mcp tool        -> externalMcpRegistry
browser testing -> 未来 Browser MCP 或 Playwright 工具
```

若能力缺失，Skill 仍可启用，但应显示 `missingCapabilities`。

### 5.8 Skill Usage Tracker

职责：

- 记录当前任务激活了哪些 Skill。
- 记录触发方式：`implicit` 或 `explicit`。
- 记录 Skill 被读取、激活、停用的时间。
- 记录触发原因。
- 写入 `TaskSummary.skillsUsed`。
- 通过 SSE 通知前端。

建议结构：

```ts
type SkillUsage = {
  name: string;
  trigger: "implicit" | "explicit";
  action: "activated" | "read" | "deactivated";
  reason?: string;
  at: string;
};
```

## 6. 与当前系统的集成点

### 6.1 `agent-core`

`createCodingAgent` 增加可选参数 `skillSystem`。

任务开始时：

1. 构建普通 workspace context。
2. 从 skill system 获取启用且可隐式触发的 Skill 摘要。
3. 识别用户显式触发 Skill。
4. 将 Skill 摘要和显式触发信息注入 system prompt。
5. 执行 ReAct loop。
6. 汇总 usedSkills 到 TaskSummary。

### 6.2 `executor`

`executor` 新增 Skill tools，并将 Skill tools 与本地工具、外部 MCP 工具一起暴露给模型。

模型需要完整 Skill 时，调用：

```text
read_skill({ name: "test-writing" })
```

模型决定正式使用 Skill 时，调用：

```text
activate_skill({ name: "test-writing", reason: "The task changes behavior and asks for tests." })
```

这既符合 progressive disclosure，也能让前端展示 Skill 触发事件。

### 6.3 `shared/types.ts`

扩展任务摘要：

```ts
type TaskSummary = {
  ...
  skillsUsed?: string[];
};
```

新增 Skill 相关 SSE 事件：

```ts
type SkillEvent = {
  type: "skill";
  skill: string;
  action: "listed" | "activated" | "read" | "deactivated";
  trigger?: "implicit" | "explicit";
  reason?: string;
  summary?: string;
};
```

`AgentEvent` 增加 `SkillEvent`。

### 6.4 `session-store`

记录每次任务使用过的 Skill，便于后续：

- 会话回放。
- 调试 Agent 行为。
- 统计 Skill 效果。
- 在任务摘要中说明使用了哪些 Skill。

### 6.5 `apps/runtime/server.ts`

新增 API：

```text
GET    /api/skills
GET    /api/skills/:name
PATCH  /api/skills/:name
POST   /api/skills/reload
POST   /api/skills/import
POST   /api/skills/:name/test
GET    /api/skills/:name/assets/:path
```

第一版至少实现：

- `GET /api/skills`
- `GET /api/skills/:name`
- `PATCH /api/skills/:name`
- `POST /api/skills/reload`

`PATCH /api/skills/:name` 支持：

```json
{
  "enabled": false
}
```

## 7. 前端设计

### 7.1 Skill 管理入口

在当前工具管理面板附近增加 Skill 管理区，或者新增一个独立页面：

```text
Skills
  4 enabled / 4 total

  [enabled] test-writing        builtin    implicit allowed
  [enabled] frontend-development builtin    implicit allowed
  [enabled] code-review          builtin    implicit allowed
  [enabled] debugging-recovery   builtin    implicit allowed
```

每个 Skill 项展示：

- 名称。
- 简短描述。
- 来源：内置、项目、用户、导入。
- 启用状态。
- 是否允许自动触发。
- 最近使用时间。
- 使用次数。
- 缺失能力提示。

### 7.2 Skill 详情面板

点击 Skill 后展示：

- 完整 `description`。
- `SKILL.md` 预览。
- 支持文件列表。
- required / optional capabilities。
- missing capabilities。
- 最近使用记录。

第一版只读展示即可，后续再支持编辑。

### 7.3 启用与禁用

用户可以手动禁用某个 Skill。禁用后：

- 不出现在 Agent 的可用 Skill 摘要中。
- 不能被隐式触发。
- 如果用户显式调用，应提示该 Skill 已禁用。

禁用状态应持久化。第一版可存储在项目工作区配置中，例如：

```text
workspaces/<projectId>/skill-config.json
```

后续再支持用户级配置。

### 7.4 对话中的 Skill 触发展示

当前聊天区域已经支持工具调用折叠展示。Skill 事件可以类似展示，但视觉上应与普通工具区分。

建议展示：

```text
Skill activated: test-writing
Reason: The task asks to add behavior and verify it with tests.
```

如果只是读取 Skill：

```text
Skill loaded: frontend-development
```

如果 Skill 被禁用或能力缺失：

```text
Skill unavailable: webapp-testing
Missing capability: browser automation
```

### 7.5 用户体验原则

- Skill 不要隐藏影响过程。
- Skill 不要打断对话，除非存在风险或缺失能力。
- Skill 展示应简洁，不要把完整 `SKILL.md` 塞进聊天流。
- 管理面板负责详情，聊天流只展示触发和关键原因。

## 8. 内置 Skill 设计

首批内置四个 Skill：

### 8.1 `test-writing`

功能：

- 编写和维护测试。
- 在修改行为、修复 bug、变更 API、用户要求测试时触发。
- 要求 Agent 先识别项目测试框架，再写最小相关测试，最后运行最小验证命令。

description 建议：

```text
Write and maintain tests for code changes. Use when implementing behavior, fixing bugs, changing APIs, or when the user asks to add, update, or run tests.
```

适配工具：

- `read_file`
- `find`
- `grep`
- `patch_file`
- `write_file`
- `run_command`

### 8.2 `frontend-development`

功能：

- 开发或修改用户界面。
- 关注组件结构、响应式布局、可访问性、状态管理、视觉一致性。
- 避免生成空洞的 landing page 或过度装饰的 AI 风格界面。

description 建议：

```text
Build or modify user-facing frontend interfaces. Use when creating UI, changing layout, styling components, improving responsive behavior, or polishing frontend interactions.
```

适配工具：

- `read_file`
- `find`
- `grep`
- `patch_file`
- `write_file`
- `run_command`

后续如接入浏览器能力，可增强为运行时截图验证。

### 8.3 `code-review`

功能：

- 审查代码变更的正确性、回归风险、安全性、可维护性和测试缺口。
- 当用户要求 review、检查 diff、合并前检查时触发。
- 输出应以问题为先，包含文件和位置。

description 建议：

```text
Review code changes for correctness, regressions, security risks, maintainability issues, and missing tests. Use when the user asks for a review, diff inspection, or pre-merge quality check.
```

适配工具：

- `read_file`
- `find`
- `grep`
- `run_command`

原则上 review skill 默认不修改文件，除非用户明确要求修复。

### 8.4 `debugging-recovery`

功能：

- 处理测试失败、构建失败、运行时错误和异常行为。
- 要求 Agent 按复现、定位、缩小范围、修复根因、添加防回归验证的顺序工作。
- 防止盲目改动和反复试错。

description 建议：

```text
Diagnose and recover from failures. Use when tests fail, builds break, runtime errors appear, commands fail unexpectedly, or the user asks to debug broken behavior.
```

适配工具：

- `read_file`
- `find`
- `grep`
- `patch_file`
- `run_command`

## 9. 安全与权限

Skill 本身应被视为不可信输入，特别是外部导入 Skill。

安全策略：

- Skill loader 只能读取 Skill 目录内部文件。
- 禁止通过 `../` 越界读取。
- `scripts/` 不自动执行。
- `run_skill_script` 必须经过能力声明和用户确认。
- Skill 不能绕过现有 `tool-gateway` 权限。
- 外部 Skill 导入时生成兼容和风险报告。

高风险 Skill 可以声明：

```yaml
policy:
  allow_implicit_invocation: false
```

或兼容 Claude 风格：

```yaml
disable-model-invocation: true
```

## 10. 详细开发计划

### 阶段 0：准备与边界确认

目标：确认当前系统集成边界，避免后续实现时反复返工。

任务：

1. 阅读并确认 `agent-core`、`executor`、`tool-gateway`、`session-store` 的接口。
2. 明确 Skill 系统不修改 LLM provider 协议，只通过 prompt 和 tools 集成。
3. 明确第一版不实现 embedding 检索。
4. 明确第一版不自动执行 Skill 脚本。
5. 明确内置 Skill 使用 `SKILL.md` 文件，而不是硬编码字符串。

交付物：

- Skill 类型草案。
- 模块边界说明。

验收：

- 能清楚说明 Skill 系统如何接入一次 `runTask`。

### 阶段 1：Skill 类型、解析与内置 Skill

目标：让系统能从文件中读取标准 Skill。

任务：

1. 新建 `packages/skill-system`。
2. 创建 `types.ts`，定义 `SkillDefinition`、`SkillManifest`、`SkillSummary`、`SkillUsage`。
3. 创建 `parser.ts`，解析 `SKILL.md` frontmatter。
4. 支持 `name`、`description`、`disable-model-invocation`、`allowed-tools`、`disallowed-tools`。
5. 创建 `builtin-skills/`。
6. 添加四个内置 Skill 的 `SKILL.md`。
7. 创建 `builtin.ts`，返回内置 Skill 根目录或内置定义。
8. 添加 parser 的最小单元测试或开发期验证脚本。

交付物：

- 可被读取的四个内置 Skill。
- 解析后的 SkillDefinition。

验收：

- 系统能列出四个内置 Skill。
- 每个 Skill 都有 name、description、source、enabled、allowImplicitInvocation。

### 阶段 2：Registry 与配置持久化

目标：让 Skill 可以启用、禁用、重载，并保存用户选择。

任务：

1. 创建 `registry.ts`。
2. 实现 `loadAll()`。
3. 实现 `listSummaries()`。
4. 实现 `getSkill(name)`。
5. 实现 `readSkill(name)`。
6. 实现 `setEnabled(name, enabled)`。
7. 实现 `reload()`。
8. 增加 `skill-config.json` 持久化启用状态。
9. 处理同名 Skill 冲突和 shadowed 状态。

交付物：

- SkillRegistry。
- skill-config 持久化。

验收：

- 禁用一个 Skill 后，重新启动仍保持禁用。
- 禁用 Skill 不出现在可隐式触发摘要列表中。

### 阶段 3：SkillRouter 与 Agent 触发闭环

目标：完成 Skill 系统最核心的运行闭环，让 SkillRouter 真正控制 Skill 的可见性、显式触发、隐式候选注入、读取、激活和使用记录。

这一阶段是 Skill 系统从“可管理的文件列表”变成“能影响 Agent 行为的工作流系统”的关键阶段。阶段 1 和阶段 2 只是让 Skill 能被解析、注册和禁用；阶段 3 才真正决定一次对话中哪些 Skill 会进入模型视野，以及模型如何加载并使用它们。

SkillRouter 在这一阶段要完成的核心职责：

1. **可见性控制**
   - 只向 Agent 暴露已启用的 Skill。
   - 不向 Agent 暴露被用户禁用的 Skill。
   - 对 `allowImplicitInvocation=false` 或 `disable-model-invocation=true` 的 Skill，只允许显式触发，不进入隐式候选摘要。
   - 对 shadowed Skill 不进入候选，除非用户显式指定完整来源。

2. **显式触发识别**
   - 从用户输入中识别 `/skill-name`。
   - 从用户输入中识别 `$skill-name`。
   - 支持带参数的显式触发，例如 `/code-review src/app.ts`。
   - 显式触发优先级高于隐式选择。
   - 如果用户显式触发了已禁用 Skill，应返回清晰提示，而不是静默忽略。

3. **隐式候选构建**
   - 从 Registry 获取所有 enabled 且 allowImplicitInvocation=true 的 Skill。
   - 提取每个 Skill 的 `name`、`description`、source、policy、missingCapabilities。
   - 按上下文预算裁剪候选摘要。
   - 第一版不做关键词强触发，只做轻量排序与过滤。
   - 最终由模型根据 `description` 判断是否需要调用 Skill。

4. **上下文注入**
   - 将隐式候选 Skill 摘要注入 system prompt 的 `Available Skills` 区块。
   - 将显式触发 Skill 作为更强约束注入 system prompt。
   - 明确告诉模型：如果要使用某个 Skill，必须先调用 `read_skill`，再调用 `activate_skill`。
   - 禁止模型使用未列出的 Skill。

5. **Progressive Disclosure 控制**
   - 初始 prompt 只包含 Skill 摘要，不包含完整 `SKILL.md`。
   - 模型调用 `read_skill` 后，才返回完整 `SKILL.md`。
   - SkillRouter 记录该 Skill 已被读取。
   - 模型调用 `activate_skill` 后，该 Skill 才算真正用于本次任务。

6. **触发事件与审计**
   - Skill 被读取时发送 `SkillEvent(action="read")`。
   - Skill 被激活时发送 `SkillEvent(action="activated")`。
   - 事件中包含 trigger 类型：`implicit` 或 `explicit`。
   - 事件中包含 reason，便于用户理解为什么触发。
   - 当前任务结束后写入 `TaskSummary.skillsUsed`。

推荐运行流程：

```text
userPrompt
-> SkillRouter.parseExplicitInvocations(userPrompt)
-> SkillRegistry.listEnabledSkills()
-> SkillRouter.buildImplicitCandidates()
-> SkillContextProvider.buildAvailableSkillsBlock()
-> agent-core buildSystemPrompt()
-> executor exposes read_skill / activate_skill / deactivate_skill
-> model decides based on description
-> read_skill returns full SKILL.md
-> activate_skill records usage and emits SkillEvent
-> task summary includes skillsUsed
```

任务：

1. 创建或完善 `router.ts`。
2. 实现 `parseExplicitInvocations(prompt)`。
3. 实现 `buildImplicitCandidates(context)`。
4. 实现 `buildSkillPromptBlock(candidates, explicitInvocations)`。
5. 修改 `createCodingAgent`，增加 `skillSystem` 参数。
6. 在 `buildSystemPrompt` 中加入 Available Skills 区块。
7. 在 system prompt 中加入显式 Skill 调用说明。
8. 修改 `executor`，新增 `list_skills`。
9. 修改 `executor`，新增 `read_skill`。
10. 修改 `executor`，新增 `activate_skill`。
11. 修改 `executor`，新增 `deactivate_skill`。
12. 实现 Skill usage tracker。
13. 记录当前任务 `skillsUsed`。
14. 在工具调用时发送 `SkillEvent`。
15. 确保禁用 Skill 不会进入隐式候选。
16. 确保显式触发禁用 Skill 时有错误提示。
17. 确保 `read_skill` 不能读取 Registry 之外的文件。

交付物：

- SkillRouter。
- Available Skills prompt block。
- Skill tools：`list_skills`、`read_skill`、`activate_skill`、`deactivate_skill`。
- Skill usage tracker。
- Skill SSE 事件。
- Agent 触发 Skill 的完整闭环。

验收：

- 用户输入 `/test-writing 帮我给这个函数补测试`，Agent 会读取 `test-writing`。
- 用户输入“帮我 review 这次修改”，Agent 有机会根据 `description` 读取 `code-review`。
- `TaskSummary.skillsUsed` 包含实际使用的 Skill。
- 用户禁用 `code-review` 后，“帮我 review”不会把 `code-review` 注入隐式候选。
- 用户显式输入 `/code-review` 但该 Skill 已禁用时，系统提示该 Skill 已禁用。
- Agent 读取 Skill 时，前端能收到 `SkillEvent(action="read")`。
- Agent 激活 Skill 时，前端能收到 `SkillEvent(action="activated")`。
- 初始 prompt 中只出现 Skill 摘要，不出现完整 `SKILL.md`。
- 模型必须通过 `read_skill` 才能获得完整 Skill 内容。
- 隐式触发的根本依据仍然是 `description`，而不是关键词规则。

### 阶段 4：后端 API

目标：让前端和外部系统可以管理 Skill。

任务：

1. 增加 `GET /api/skills`。
2. 增加 `GET /api/skills/:name`。
3. 增加 `PATCH /api/skills/:name`。
4. 增加 `POST /api/skills/reload`。
5. 返回字段包含 enabled、source、description、allowImplicitInvocation、usage、missingCapabilities。
6. 处理禁用 Skill 的显式调用提示。
7. 添加基本错误处理。

交付物：

- Skill 管理 API。

验收：

- 前端或 curl 能列出 Skill。
- 能禁用和重新启用 Skill。
- 能查看完整 Skill 内容。

### 阶段 5：前端 Skill 管理面板

目标：用户能看到并控制系统中的 Skill。

任务：

1. 在前端增加 Skill 管理区或独立页面入口。
2. 实现 Skill 列表渲染。
3. 实现启用/禁用开关。
4. 实现 Skill 详情弹窗或详情区域。
5. 展示来源、描述、隐式触发策略、使用次数、最近使用时间。
6. 展示 missingCapabilities。
7. 支持 reload。

交付物：

- Skill 管理 UI。

验收：

- 用户可以在前端禁用 `frontend-development`。
- 禁用后 Agent 可用 Skill 摘要不包含该 Skill。
- 重新启用后恢复。

### 阶段 6：对话流 Skill 事件展示

目标：用户能在对话过程中看到 Skill 触发。

任务：

1. 前端监听 `type: "skill"` SSE 事件。
2. 展示 `activated`、`read`、`deactivated`。
3. 展示触发方式：implicit / explicit。
4. 展示 reason。
5. 与普通 tool 调用区分视觉样式。
6. 避免重复事件刷屏。

交付物：

- 聊天流 Skill 事件展示。

验收：

- Agent 激活 `test-writing` 时，聊天流出现 Skill activated。
- 事件中能看到触发原因。

### 阶段 7：外部 Skill 导入与兼容报告

目标：让用户可以通过前端导入外部通用 Skill，并在真正导入前看到兼容报告。导入后，外部 Skill 应进入当前项目的 Skill Registry，能够像内置 Skill 一样被展示、启用、禁用、读取和触发。

这一阶段的重点不是简单“复制一个文件夹”，而是让用户知道：

- 系统是否识别了这个 Skill。
- 它采用了哪种格式。
- 它会被保存到哪里。
- 它是否允许隐式触发。
- 它需要哪些能力。
- 当前系统缺少哪些能力。
- 是否存在脚本、外部命令或潜在风险。

#### 7.1 用户使用方式

在前端 `Skill 管理` 面板中新增 **导入 Skill** 按钮。

点击后打开导入弹窗，提供三种导入方式：

1. **输入本地目录路径**

   用户输入一个本机目录路径，目录中应包含 `SKILL.md`。

   示例：

   ```text
   D:\external-skills\test-writing
   C:\Users\me\Downloads\some-skill
   ```

   适用场景：

   - 用户从 GitHub 或其他地方下载了一个 Skill 目录。
   - 用户希望导入外部已有 Skill，但不想手动复制到 workspace。

   注意：

   - 后端只做读取和复制，不执行脚本。
   - 导入时复制到当前 workspace 的 `.aicoding/skills/<skill-name>`。
   - 如果目录不在当前 workspace 内，可能涉及文件系统读取权限；桌面环境下应通过后端权限策略处理。

2. **输入项目内路径**

   用户输入相对于当前 workspace 的路径。

   示例：

   ```text
   .aicoding/skills/my-skill
   .claude/skills/my-skill
   .agents/skills/my-skill
   ```

   适用场景：

   - 用户已经把 Skill 放进项目。
   - 用户希望系统扫描并注册现有 Skill。

   这种方式可以不复制文件，只进行识别和注册。

3. **粘贴 `SKILL.md` 内容**

   用户直接粘贴 markdown 内容，例如：

   ```markdown
   ---
   name: my-skill
   description: Use when...
   ---

   # My Skill
   ```

   系统根据 frontmatter 中的 `name` 创建：

   ```text
   <workspace>/.aicoding/skills/<skill-name>/SKILL.md
   ```

   如果没有 `name`，前端要求用户填写 Skill 名称。

   适用场景：

   - 用户从网页或文档里复制了一个 Skill。
   - 用户想快速创建自定义 Skill。

#### 7.2 前端导入流程

推荐流程：

```text
Skill 管理
-> 点击“导入 Skill”
-> 选择导入方式
-> 填写路径或粘贴内容
-> 点击“预检查”
-> 显示兼容报告
-> 用户确认导入
-> 后端写入或注册
-> reload skills
-> 新 Skill 出现在列表中
```

前端弹窗应包含：

- 导入方式选择。
- 路径输入框或 `SKILL.md` 粘贴区。
- Skill 名称输入框，仅在粘贴内容无法推断名称时显示。
- `预检查` 按钮。
- 兼容报告区域。
- `确认导入` 按钮。
- `取消` 按钮。

兼容报告展示字段：

```text
识别结果：成功 / 失败
格式：SKILL.md / skill.json / manifest.json / agents/openai.yaml
名称：my-skill
描述：...
来源：外部目录 / 项目路径 / 粘贴内容
目标位置：.aicoding/skills/my-skill
允许隐式触发：是 / 否
用户可显式调用：是 / 否
需要能力：read_file, patch_file, run_command
缺失能力：browser automation
发现资源：references, assets, templates
发现脚本：scripts/build.js
风险提示：包含 scripts/，不会自动执行
冲突提示：已存在同名 Skill
```

#### 7.3 API 设计

新增 API：

```text
POST /api/skills/import/preview
POST /api/skills/import
```

`POST /api/skills/import/preview`

只做分析，不写入文件。

请求示例：

```json
{
  "mode": "local_path",
  "path": "D:\\external-skills\\my-skill"
}
```

```json
{
  "mode": "workspace_path",
  "path": ".claude/skills/my-skill"
}
```

```json
{
  "mode": "inline_markdown",
  "name": "my-skill",
  "content": "---\nname: my-skill\ndescription: Use when...\n---\n\n# My Skill"
}
```

返回示例：

```json
{
  "ok": true,
  "report": {
    "recognized": true,
    "format": "SKILL.md",
    "name": "my-skill",
    "description": "Use when...",
    "sourceMode": "local_path",
    "targetPath": ".aicoding/skills/my-skill",
    "allowImplicitInvocation": true,
    "userInvocable": true,
    "requiredCapabilities": ["read_file"],
    "optionalCapabilities": ["patch_file", "run_command"],
    "missingCapabilities": [],
    "resources": ["references"],
    "scripts": ["scripts/build.js"],
    "warnings": ["scripts will not be executed automatically"],
    "conflicts": []
  }
}
```

`POST /api/skills/import`

在 preview 通过后真正导入。

请求可以复用 preview 参数，并增加用户确认字段：

```json
{
  "mode": "local_path",
  "path": "D:\\external-skills\\my-skill",
  "confirm": true
}
```

返回：

```json
{
  "ok": true,
  "skill": "my-skill",
  "targetPath": ".aicoding/skills/my-skill",
  "skills": []
}
```

导入完成后，后端自动调用 `skillRegistry.reload()`。

#### 7.4 后端实现任务

1. 支持项目级 `.aicoding/skills`。
2. 支持兼容 `.claude/skills` 和 `.agents/skills`。
3. 支持 `skill.json`、`manifest.json`、`.skill/manifest.json`、`agents/openai.yaml`。
4. 实现 manifest adapter，将外部 manifest 归一化为内部 `SkillDefinition`。
5. 实现 import preview，不写入文件。
6. 实现 import confirm，复制目录或创建 `SKILL.md`。
7. 实现 capability analyzer。
8. 生成 `missingCapabilities`。
9. 检测 `references/`、`scripts/`、`assets/`、`templates/`。
10. 检测同名 Skill 冲突。
11. 导入完成后自动 reload。
12. 支持导入后的启用、禁用和重载。

#### 7.5 前端实现任务

1. 在 Skill 管理卡片中增加 `导入 Skill` 按钮。
2. 实现导入弹窗。
3. 实现三种导入方式的表单。
4. 调用 `/api/skills/import/preview`。
5. 展示兼容报告。
6. 报告失败时明确失败原因。
7. 报告成功后允许确认导入。
8. 调用 `/api/skills/import`。
9. 导入成功后刷新 Skill 列表。
10. 导入成功后显示 toast。

#### 7.6 安全策略

- Preview 和 import 都不能执行脚本。
- 复制目录时只复制 Skill 目录内部内容。
- 禁止通过 `../` 越界写入目标目录。
- 如果导入目标已存在，默认不覆盖。
- 覆盖已有 Skill 必须额外确认。
- 外部目录导入应遵守当前运行环境的文件系统权限。
- `scripts/` 只作为资源展示，不自动运行。

#### 7.7 交付物

- 外部 Skill preview API。
- 外部 Skill import API。
- 兼容报告结构。
- Skill 导入弹窗。
- 导入后的自动 reload。
- 导入后的 Skill 管理展示。

#### 7.8 验收标准

- 只有 `SKILL.md` 的外部 Skill 可以被识别。
- 粘贴 `SKILL.md` 内容可以创建项目级 Skill。
- 项目内 `.claude/skills/my-skill` 可以被识别。
- 缺少工具能力的 Skill 仍能出现在列表中，但有缺失能力提示。
- 包含 `scripts/` 的 Skill 会显示风险提示，但不会执行脚本。
- 同名 Skill 冲突会在 preview 报告中提示。
- 用户确认导入后，新 Skill 出现在 Skill 管理面板中。
- 新 Skill 可以被禁用、启用、读取和触发。

### 阶段 8：高级能力

目标：增强 Skill 的实际执行能力。

任务：

1. 实现 `search_skill_references`。
2. 实现 `get_skill_asset`。
3. 谨慎实现 `run_skill_script`。
4. 支持 Skill 与 MCP server 绑定。
5. 支持高风险 Skill 的确认流程。
6. 支持浏览器测试类 Skill 的运行时验证能力。
7. 在 Skill 数量很大时考虑 embedding 检索和 LLM rerank。

交付物：

- 更完整的 Skill 生态能力。

验收：

- Agent 能按需读取 references。
- 高风险脚本不会自动执行。
- 大规模 Skill 库有可扩展路由方案。

## 11. 第一版验收标准

第一版完成后应满足：

- 系统启动时能加载四个内置 Skill。
- 前端能展示当前所有 Skill。
- 用户能在前端禁用和启用 Skill。
- Agent system prompt 中包含 Skill 摘要，而不是完整 Skill 正文。
- 用户显式指定 `/test-writing` 时，Agent 能读取并使用该 Skill。
- 用户提出“帮我写测试”“帮我 review”时，Agent 能根据 description 隐式选择相关 Skill。
- 对话流中能显示 Skill 被读取或激活。
- TaskSummary 记录本次任务使用的 Skill。
- Skill 读取遵守 progressive disclosure。
- 禁用后的 Skill 不会被隐式触发。

## 12. 结论

本 Skill 系统的核心是为 Agent 增加可发现、可选择、可加载、可控制、可观察、可审计的专业工作流能力。

设计上应坚持：

- 以 `SKILL.md` 为核心。
- 以 `description` 为隐式触发依据。
- 支持显式触发。
- 使用 progressive disclosure 控制上下文。
- 前端提供 Skill 列表、启用/禁用和触发展示。
- 兼容外部通用 Skill。
- 内置 Skill 采用主流格式，但内容经过本项目筛选和改写。

这样实现后，Skill 系统既能服务当前 `dexcode` 项目的能力边界，也为后续接入更完整的 MCP、浏览器测试、脚本执行、外部 Skill 导入和大规模 Skill 路由留下空间。
