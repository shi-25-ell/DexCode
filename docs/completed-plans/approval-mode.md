# DexCode 全局批准模式开发计划

## 1. 文档状态

- 状态：已实施
- 当前实现：`packages/tool-gateway/approval-mode-store.ts`、`approval-policy.ts`、`apps/web/src/settings/approval-mode-panel.tsx`
- 默认批准模式：`allowlist`
- 生效策略：全局实时，下一次尚未授权的工具调用使用最新模式

> 本文保留计划编写时的问题分析和实施顺序。文中的“当前”指计划基线；现状以 [`../architecture.md`](../architecture.md) 为准。

## 2. 背景与目标

DexCode 当前只有命令白名单和命令确认，没有统一的批准模式。`run_command` 会进入确认链路，但 `write_file`、`patch_file` 等写操作可以直接执行，外部 MCP 又有独立的确认路径。结果是“批准”只覆盖部分工具，用户无法用一个全局设置表达自己希望的授权强度。

本次改造提供三个全局批准模式：

1. **逐次批准**（内部枚举 `read_only`）：只有确定为只读的操作以及已经加入白名单的命令可以自动执行，其余 agent 副作用需要用户批准。
2. **自动文件修改**（内部枚举 `allowlist`）：保留当前主要体验，工作区内文件修改可自动执行，命令只有命中白名单才自动执行。
3. **完全访问**：agent 操作不再弹出普通批准请求，但 Hard Guard 继续生效。

同时把能力中心的“白名单”入口升级为“批准模式”。新页面顶部管理全局模式，下面完整保留现有的白名单管理功能。

## 3. 非目标

本次开发不处理：

- steer 功能及其消息队列。
- 运行中切换模型。
- snapshot 功能及其下线工作。
- 新的 sandbox、容器或操作系统级隔离。
- 多个 DexCode Runtime 进程之间的分布式配置同步。
- 页面整体视觉重设计。

steer 和模型切换后续适配本次形成的批准 Interface；本次实现不为它们预留额外状态机。

## 4. 核心语义

### 4.1 模式定义

```ts
export type ApprovalMode = 'read_only' | 'allowlist' | 'full_access';
```

| 操作 | 逐次批准 | 自动文件修改 | 完全访问 |
|---|---|---|---|
| 内建读取、搜索、列目录 | 自动允许 | 自动允许 | 自动允许 |
| 明确认定为只读的命令 | 自动允许 | 自动允许 | 自动允许 |
| 命中工作区白名单的命令 | 自动允许 | 自动允许 | 自动允许 |
| 未命中白名单的命令 | 请求批准 | 请求批准 | 自动允许 |
| `write_file`、`patch_file` | 请求批准 | 自动允许 | 自动允许 |
| 未知副作用的外部 MCP 工具 | 请求批准 | 请求批准 | 自动允许 |
| 明确禁止的命令或越界路径 | 拒绝 | 拒绝 | 拒绝 |
| 普通对话中的用户询问 | 保持交互 | 保持交互 | 保持交互 |

白名单在逐次批准和自动文件修改中都生效。两者的主要区别是文件写入和 patch 是否需要逐次批准。完全访问只是跳过普通批准，不绕过以下保护：

- 工作区路径解析与越界检查。
- 禁止的命令语法和 shell 包装器。
- 明确的 Hard Guard。
- 参数格式和工具 schema 校验。
- 必须由用户亲自完成的交互。

### 4.2 全局实时生效

批准模式只有一个 Runtime 级权威值，不按 workspace、Session、Run、track 或 turn 保存副本。

每次工具即将执行并进入授权判断时，读取最新模式：

```ts
const mode = approvalModeStore.getMode();
const decision = approvalPolicy.authorize(subject, mode);
```

生效规则：

1. 已经开始执行的操作不追溯中止。
2. 已经发出的批准请求不因切换模式而自动允许或自动拒绝。
3. 尚未进入授权判断的工具调用立即使用新模式，包括同一 track、同一 turn 中排在后面的工具调用。
4. 新 turn 和新 track 自然使用最新模式。
5. “允许并加入白名单”写入成功后，当前 track 后续匹配命令可以立即命中。

因此不增加 `trackStartMode`、`turnApprovalMode` 或权限升降状态机。

### 4.3 作用范围

批准策略约束 agent 或外部程序发起的工具副作用，不拦截用户在 DexCode 界面中亲自完成的操作。例如，用户在编辑器中点击保存已经表达了直接意图，不应再弹出 agent 批准卡。

调用来源需要显式区分：

```ts
export type ApprovalOrigin = 'agent' | 'mcp_http' | 'user_ui';
```

- `agent`：需要批准时通过对话时间线请求用户决定。
- `mcp_http`：如果策略返回 `ask` 但调用没有交互通道，则返回结构化拒绝，不得静默执行。
- `user_ui`：用户直接操作走现有业务校验，不进入 agent 批准策略。

## 5. 核心不变量

1. **Hard Guard 优先**：先判断是否禁止，再判断是否需要批准；用户批准和完全访问都不能把禁止变成允许。
2. **实时读取**：授权时读取全局 store，不在 workspace host、Run 或 Executor 创建时复制模式。
3. **批准与输入绑定**：批准请求必须绑定工具名、规范化参数和 fingerprint，批准后不得换参执行。
4. **无通道则拒绝**：需要用户批准但没有交互通道时 fail closed。
5. **白名单只豁免命令批准**：命令白名单不自动授权文件写入、MCP 或其他工具类别。
6. **用户直接操作不重复批准**：前端编辑器、设置页等明确用户操作不进入 agent 批准流。
7. **模式持久化成功后才生效**：写盘失败时 HTTP 接口返回失败，内存中的模式保持不变。
8. **配置损坏时不扩大权限**：损坏或非法的全局配置不得回退到完全访问或自动文件修改。
9. **实时与历史一致**：批准卡在实时 SSE 和 Session replay 中具有一致语义。
10. **模式缺失兼容现状**：首次升级且文件不存在时默认 `allowlist`，不突然改变原有工作方式。

## 6. Module 与 Interface 设计

按深 Module 设计，把模式存储、决策矩阵、规则命中和展示原因收拢在批准模块内，Executor 和 HTTP handler 不复制判断逻辑。

建议在 `packages/tool-gateway` 内增加：

```text
packages/tool-gateway/
  approval-policy.ts
  approval-mode-store.ts
  approval-policy.test.ts
  approval-mode-store.test.ts
```

### 6.1 全局模式 Store

```ts
export type ApprovalModeState = {
  version: 1;
  mode: ApprovalMode;
  revision: number;
  updatedAt: string;
};

export interface ApprovalModeStore {
  getMode(): ApprovalMode;
  getState(): ApprovalModeState;
  setMode(mode: ApprovalMode): Promise<ApprovalModeState>;
}
```

Runtime 启动时只创建一个 Store，并把 `getMode` 注入各 workspace 的工具执行路径。建议持久化位置：

```text
workspaces/approval-settings.json
```

持久化要求：

- 临时文件写入后原子 rename。
- 严格校验 `version`、`mode`、`revision`。
- 文件不存在时创建兼容默认值 `allowlist`。
- 文件损坏时进入 `read_only` 并暴露可诊断错误，不静默扩大权限。
- `setMode` 写盘成功后再更新进程内状态。

### 6.2 批准策略

```ts
export type ApprovalEffect = 'read' | 'write' | 'execute' | 'external' | 'interactive';

export type ApprovalSubject = {
  origin: ApprovalOrigin;
  toolName: string;
  effect: ApprovalEffect;
  workspaceRef?: string;
  summary: string;
  normalizedInput: unknown;
  fingerprint: string;
  command?: string;
};

export type ApprovalDecision =
  | { outcome: 'allow'; reason: string; matchedRule?: string }
  | { outcome: 'ask'; reason: string; options: ApprovalOption[] }
  | { outcome: 'deny'; reason: string };

export interface ApprovalPolicy {
  authorize(subject: ApprovalSubject, mode: ApprovalMode): ApprovalDecision;
}
```

`authorize()` 是纯决策 Interface，不自行弹 UI、不执行工具、不写白名单。这样策略矩阵可以通过纯单元测试覆盖，副作用由调用 adapter 处理。

### 6.3 通用批准请求

现有 `CommandConfirmRequest` 扩展为通用 Tool Approval 语义：

```ts
export type ApprovalOption = 'allow_once' | 'allow_whitelist' | 'deny';

export type ToolApprovalRequest = {
  approvalId: string;
  toolName: string;
  effect: ApprovalEffect;
  title: string;
  target?: string;
  reason: string;
  fingerprint: string;
  options: ApprovalOption[];
};
```

- 命令请求提供 `allow_once / allow_whitelist / deny`。
- 写文件、patch、MCP 请求只提供 `allow_once / deny`。
- 决定提交时校验 fingerprint，避免批准对象被替换。
- 兼容期可保留现有 `command_confirm_request` SSE 事件；内部先统一语义，再决定是否升级为版本化 `approval_request`。

## 7. 工具分类与命令判断

### 7.1 内建工具

为 agent 可调用工具维护显式 effect metadata，不通过工具名称猜测：

- `read_file`、workspace tree、搜索、读取 lint 结果：`read`
- `write_file`、`patch_file`：`write`
- `run_command`：先经过命令校验，再判定为只读或 `execute`
- 外部 MCP：只有可靠 metadata 明确只读时才为 `read`，其余为 `external`
- 普通对话中的用户询问不进入工具 effect 分类

未知工具默认按有副作用处理，不默认只读。

### 7.2 只读命令

逐次批准不能把“看起来像检查”的命令自动当成只读。`npm run lint`、`npx eslint`、`npx tsc` 都可能执行仓库控制的脚本、插件或配置代码，应视为普通执行命令，除非用户把精确命令加入白名单。

只读命令识别采用保守 registry 和参数约束，例如文件列举、内容读取、受限的 `rg`、受限的 Git 状态查询。任何以下情况都不能自动归入只读：

- shell wrapper、重定向、管道、命令替换或复合命令。
- 未识别的可执行程序。
- 可加载项目脚本、插件或 hook 的命令形式。
- 参数可能产生写入、网络或进程副作用。

无法证明只读时返回 `ask`，不依赖风险分值猜测。

## 8. 白名单保留与安全收紧

白名单继续按 workspace/project 保存，批准模式则全局保存。全局模式不应把某个项目的命令信任扩散到其他项目。

现有接口继续保留：

```text
GET    /api/command-whitelist
POST   /api/command-whitelist
DELETE /api/command-whitelist/:id
```

需要同步修复以下问题：

1. “允许并加入白名单”默认创建规范化后的精确命令规则。
2. 不再把 `git reset --hard` 自动退化成整个 `git` 命令规则。
3. prefix 匹配必须有 token 边界：只允许完整相等或 `pattern + 空白 + 参数`。
4. `command` 级规则只能由用户在设置页显式创建，并显示高风险提示。
5. 移除或迁移过宽的内置 `npm run` 前缀；项目脚本不属于可信只读命令。
6. 白名单文件损坏时显式报错，不静默恢复成可能更宽的默认规则。
7. 用户已有显式规则必须兼容读取；内置规则与用户规则通过稳定 ID/source 区分。

页面中的完整命令、命令前缀、命令名称三种手工能力继续保留，但规则越宽，提示越明显。

## 9. Runtime 与执行链路改造

### 9.1 当前问题

当前 `packages/agent-core/executor.ts` 只对 `run_command` 注入 `onCommandConfirm`，而 `write_file`、`patch_file` 直接调用 Tool Host。外部 MCP 又从 Executor 的另一条路径调用。因此不能只在现有命令确认函数外层增加三个 if。

### 9.2 目标链路

```text
模型产生 tool call
  -> 规范化工具参数并生成 fingerprint
  -> Hard Guard / 路径检查
  -> 读取当前全局 ApprovalMode
  -> ApprovalPolicy.authorize()
      -> allow: 执行
      -> ask: 发出批准事件并等待绑定决定
      -> deny: 返回结构化工具错误
  -> commit tool result
```

接入点：

- `packages/tool-gateway/index.ts`：内建工具的 effect metadata、Hard Guard 和统一授权执行。
- `packages/agent-core/executor.ts`：把通用批准 hook 和 signal 传入 Tool Gateway；外部 MCP 在调用前进入同一策略。
- `apps/runtime/server.ts`：持有全局 Store、提供 GET/PUT、管理 pending approvals 和 SSE。
- `packages/shared/types.ts`：共享模式、请求、决定和事件类型。

Runtime 不把模式值捕获到 `createExecutor()` 的局部常量；传递的是 getter 或 Store Interface。这样 active track 中的后续授权自然读到新值。

### 9.3 HTTP Interface

新增：

```text
GET /api/approval-mode
  -> { mode, revision, updatedAt, diagnostic? }

PUT /api/approval-mode
  body: { mode }
  -> { mode, revision, updatedAt }
```

要求：

- 这是全局接口，不读取或要求 `workspaceRef`。
- 非法 mode 返回 400。
- 写盘失败返回明确 5xx，前端恢复原选择。
- PUT 幂等；设置为当前值不产生虚假的重复 revision。
- 响应不能包含宿主绝对路径。

## 10. 前端改造

### 10.1 能力中心

把能力标识从 `whitelist` 调整为 `approval`：

```ts
{ id: 'approval', label: '批准模式', route: '/settings/approval', icon: 'shield', workspaceRequired: false }
```

同步修改：

- `packages/capability-registry/index.ts`
- `apps/web/src/types.ts`
- `apps/web/src/settings/settings-page.tsx`
- 相关 registry、路由和响应式测试

旧 `/settings/whitelist` 重定向到 `/settings/approval`，避免已有书签失效。

### 10.2 批准模式页面

将 `WhitelistPanel` 重构为 `ApprovalModePanel`，但白名单功能不删除。

页面顺序：

```text
批准模式
  [逐次批准] [自动文件修改] [完全访问]
  当前模式说明 / 保存状态 / 全局实时提示

为项目配置 命令白名单
  原有新增表单
  原有规则列表
  刷新与删除
```

三种选项文案：

- **逐次批准**：读取和可信只读命令自动执行；写入及其他命令需要批准。
- **自动文件修改**：文件修改自动执行；未在白名单中的命令需要批准。
- **完全访问**：所有 agent 操作自动执行；仅保留系统硬性保护。

交互要求：

1. 初次进入页面从 GET 接口读取真实全局状态，不使用 localStorage 作为权威值。
2. 选择逐次批准或自动文件修改后立即 PUT；保存中禁用重复提交。
3. 进入完全访问前弹出明确确认，说明它会立即影响当前运行任务后续尚未授权的操作。
4. PUT 失败时恢复原选项并显示错误，不做乐观假成功。
5. 页面持续显示“全局设置；对尚未开始执行的操作立即生效”。
6. 完全访问下仍能管理白名单，并提示“当前模式不使用白名单，切回其他模式后继续生效”。
7. 没有 workspace 时模式区域仍可用；白名单区域显示“选择项目后管理命令白名单”。
8. 模式状态不能只依赖颜色，radio、键盘焦点和 aria label 必须完整。

### 10.3 对话批准卡

现有命令批准卡扩展为通用批准卡：

- 文件写入显示相对路径和操作类型，不展示完整文件内容。
- patch 显示相对路径和简短变更摘要。
- 命令显示规范化命令、相对 cwd、风险和白名单选项。
- MCP 显示服务器、产品化工具名和受控参数摘要，不泄漏 secret。
- 已解决卡显示“允许一次 / 已加入白名单 / 已拒绝”。

批准卡必须保持 live/replay 一致，刷新后不能退化为原始 JSON。

## 11. 迁移与兼容

### 11.1 模式迁移

- `approval-settings.json` 不存在：写入或采用 `allowlist`，保持当前体验。
- 文件存在且合法：使用保存值。
- 文件存在但损坏：以 `read_only` 启动并在 HTTP 接口与 UI 中暴露诊断；不得静默恢复 `allowlist`。

### 11.2 白名单迁移

- 工作区现有 `command-whitelist.json` 继续可读。
- 新增版本字段或 source 字段时提供一次兼容转换。
- 不删除用户创建的规则。
- 识别旧内置宽规则并替换为新的保守内置集合；迁移结果必须有测试。

### 11.3 事件兼容

- 现有命令批准事件在迁移期继续被前端识别。
- 新的通用批准事件使用明确版本和稳定字段。
- Session replay 同时兼容旧 command approval 和新 tool approval facts。

## 12. 分步实施与本地 Commit

所有提交只保存在本地 `permission` 分支，禁止 push。

### P1：全局设置与策略

建议 commit：

```text
feat(permissions): add global approval mode policy
```

- 增加模式类型、Store、持久化和 GET/PUT。
- 增加纯 `ApprovalPolicy` 与模式矩阵测试。
- 默认 `allowlist`，损坏配置 fail closed。

完成条件：不接前端也能通过接口切换模式，下一次 `authorize()` 读取最新值。

### P2：工具执行链路

建议 commit：

```text
feat(tools): enforce live approval mode for agent actions
```

- 内建读、写、命令和外部 MCP 进入统一策略。
- 通用批准请求绑定 fingerprint。
- 无批准通道时 fail closed。
- active track 中切换后，下一次尚未授权调用立即生效。

完成条件：三种模式均通过真实 Executor/Tool Gateway 集成测试。

### P3：批准模式页面

建议 commit：

```text
feat(web): replace whitelist capability with approval mode
```

- 能力入口、路由、类型和页面重命名。
- 增加三个模式选项、完全访问确认和保存反馈。
- 完整保留白名单 UI；无 workspace 时仅禁用白名单区域。
- 扩展通用批准卡。

完成条件：桌面和窄屏均可切换模式、管理白名单和处理批准请求。

### P4：白名单收紧与整体验收

建议 commit：

```text
fix(permissions): harden command whitelist matching
```

- 自动加入改为精确命令。
- prefix 增加 token 边界。
- 迁移宽泛内置规则和损坏文件处理。
- 完成全链路回归、构建与手工验证。

完成条件：白名单不再因一次批准意外扩大为整个可执行程序权限。

如果某一步实验失败，只回退该步本地 commit；不得使用破坏其他用户修改的 `git reset --hard`。实施前后都要检查工作树并保留无关改动。

## 13. 测试计划

### 13.1 Policy 单元测试

- 三种模式 × read/write/execute/external/interactive 的完整矩阵。
- Hard Guard 在三种模式下均不可覆盖。
- 只读命令、未知命令和危险命令分类。
- 白名单 exact/prefix/command 匹配及 token 边界。
- 自动建议永远不从完整命令扩大成整个 executable。

### 13.2 Store 与 HTTP Interface 测试

- 缺失文件默认 `allowlist`。
- 合法设置持久化并在重启后恢复。
- 损坏文件 fail closed 为 `read_only` 并带诊断。
- 非法 mode 返回 400。
- 写盘失败不改变进程内模式。
- 相同值 PUT 幂等。

### 13.3 Agent 集成测试

- 逐次批准：read 直接执行，write/patch/普通命令请求批准。
- 自动文件修改：write/patch 直接执行，未命中命令请求批准。
- 完全访问：普通批准被跳过，Hard Guard 仍拒绝非法命令。
- 同一 track 第一次工具后切换模式，第二次工具使用最新值。
- 同一 turn 多个顺序工具中，尚未授权的后续调用使用最新值。
- 已发出批准请求不因模式切换自动完成。
- 批准 fingerprint 不匹配时拒绝执行。
- `allow_whitelist` 后当前 track 的后续匹配命令直接执行。
- 无交互通道的 `mcp_http` ask 结果返回拒绝。

### 13.4 Web 测试

- 能力中心显示“批准模式”，不再显示旧“白名单”入口。
- `/settings/whitelist` 正确重定向。
- 三个模式选项与后端状态一致。
- 完全访问必须确认，失败时回滚 UI。
- 没有 workspace 时可切模式但不能编辑白名单。
- 原有白名单新增、刷新、删除功能保持可用。
- 命令、写文件、patch、MCP 批准卡正确展示和提交。
- 桌面与窄屏均可访问页面和完成操作。

当前根 `npm test` 未包含 `packages/tool-gateway/*.test.ts`。实施时必须更新测试脚本，确保新增 Policy、Store 和 command safety 测试实际被执行，而不是只存在于仓库中。

最终验证命令：

```powershell
npm test
npm run test:web
npm run lint
npm run build:web
git diff --check
git status --short
```

## 14. 手工验收场景

1. 以自动文件修改启动，确认原有文件编辑体验不变。
2. 在 active track 中切到逐次批准，确认下一次写入出现批准卡。
3. 同一 track 切到完全访问，确认下一次尚未授权写入或命令不再弹批准卡。
4. 在逐次批准中批准一个命令并加入白名单，确认同一 track 再次执行时无需批准。
5. 尝试禁止的命令，确认完全访问下仍被 Hard Guard 拒绝。
6. 不加载 workspace 进入批准模式页，确认全局模式可切换，白名单区域正确提示。
7. 加载两个不同 workspace，确认它们共享同一批准模式，但白名单互相隔离。
8. 刷新页面和重启 Runtime，确认模式及白名单持久化正确。
9. 模式切换时保留一个已发出的批准请求，确认它不会被自动执行。
10. 在移动宽度下完成模式切换、完全访问确认和白名单查看。

## 15. 验收标准

以下条件全部满足才算完成：

1. 全局存在且只存在一个批准模式权威状态。
2. active track 中下一次尚未授权的工具调用实时使用最新模式。
3. 逐次批准、自动文件修改和完全访问的行为符合本文矩阵。
4. `write_file`、`patch_file`、`run_command` 和外部 MCP 都进入统一批准策略。
5. 完全访问不绕过 Hard Guard。
6. 命令白名单继续按 workspace 隔离，现有管理功能完整保留。
7. 自动加入白名单不会扩大为整个命令程序权限。
8. 能力中心入口和页面统一显示“批准模式”。
9. 没有 workspace 时仍可修改全局模式。
10. 页面明确提示全局实时生效，完全访问有显著确认和状态提示。
11. 已执行操作和已发出批准请求不被模式切换追溯改变。
12. live SSE 与历史 replay 中的批准卡语义一致。
13. 所有新增测试被根测试命令实际执行。
14. lint、后端测试、Web 测试、生产构建和 diff check 全部通过。
15. 所有开发提交只保存在本地 `permission` 分支，没有 push。

## 16. 风险与控制

### 16.1 只在 Executor 增加条件

风险：文件写入、MCP 或直接工具入口继续绕过批准策略。

控制：把批准决策收敛到 Tool Gateway seam，并给所有执行 origin 写集成测试。

### 16.2 把模式复制到 Run

风险：运行中切换不能实时生效，不同 workspace host 可能持有不同旧值。

控制：注入 Store/getter，在每次授权时读取，不保存 track 或 turn 副本。

### 16.3 只读命令误判

风险：将 lint、构建工具或项目脚本误判为只读，实际执行任意项目代码。

控制：采用保守 registry；无法证明只读就请求批准，用户可用精确白名单减少重复确认。

### 16.4 完全访问被理解为关闭所有保护

风险：高危命令、越界路径或恶意工具参数绕过系统保护。

控制：UI 明确说明完全访问只跳过批准；Policy 测试锁定 Hard Guard 优先级。

### 16.5 全局模式与 workspace 白名单混淆

风险：用户认为白名单也全局共享，或把一个项目的命令信任带到另一个项目。

控制：页面分别标注“全局批准模式”和“为项目配置 命令白名单”；无 workspace 时禁用后者。

### 16.6 前端显示成功但后端保存失败

风险：用户以为已经降权，实际 Runtime 仍处于更宽模式。

控制：前端以服务端响应为准；保存失败回滚选项并持续显示错误。

## 17. 回退原则

- 每个阶段保持独立、本地、可验证的 commit。
- P1-P4 中任何阶段失败时优先 revert 对应 commit，不破坏无关工作。
- 不允许用 `git reset --hard` 或清理整个工作树来处理试错。
- 不 push；需要远程同步时必须重新获得用户明确授权。
- 回退前后都运行最小相关测试，并确认 `git status` 中没有丢失用户修改。
