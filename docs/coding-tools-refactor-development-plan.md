# DexCode 编程工具补齐与重构开发计划

## 1. 文档状态

- 状态：待评审、待实施
- 当前基线分支：本地 `multi-agent`
- 远程操作：禁止 push，除非用户后续明确授权
- 适配平台：Windows 优先；PowerShell 是默认 shell，Bash 是可选能力

本文只固化已经讨论确认的工具目标、兼容边界、实施顺序和验收标准，不在本轮修改工具实现。正式实施前需要重新核对分支、HEAD、工作区状态和相关工具链源码，避免基线变化导致计划与源码错位。

## 2. 已确认决策

本次改造以以下七项决定为准：

1. 新增并补齐 `find`、`ls`：`find` 按 glob 递归查找路径，`ls` 只列出一个目录的直接子项；保留 `list_workspace`，但将它改为类似 `ls -R` 的递归项目结构概览，不再返回扁平的文件及内容集合。
2. 使用正式的 `grep` 完全替换 `search_in_workspace`，按磁盘真实内容执行搜索；旧工具名不保留 alias 或 legacy adapter。
3. 重构 `run_command` 的内部执行方式，保留其外部工具身份、参数和后台任务协议；Windows 默认提供真正的 PowerShell 语义，并在启动时探测可选 Bash。
4. 保留 `patch_file` 工具名和外围调用链，模型可见参数升级为结构化编辑语义；除精确目标编辑外，增加带命中数断言的 `replace_all`。
5. 删除 `read_lints`、`ask_user`、`diff_file`；同时取消 `list_versions`、`create_snapshot`、`restore_snapshot` 的全部工具注册并停止维护其工具契约。六个旧工具都要清理定义、执行、批准、展示、策略、测试、文档和历史兼容入口，不能留下仍可调用的旁路。快照底层实现与历史数据留到后续专项中物理删除。
6. 对新增、替换、重构和删除工具执行前后端完整链路适配，逐层验证工具分类、批次展示、批准、事件协议、会话回放、工具卡、设置页和日志；不能把“后端可以调用”当作完成。
7. 同步修改所有受影响的现行文档；历史文档不得继续把已经删除或已经改变的能力描述成当前事实。

本计划中的工具名称是稳定的公开标识。内部类名、模块边界和实现文件可以重构，但不能为了实现方便额外制造一组近义工具。

## 3. 目标工具面

改造后的核心编程工具关系如下：

| 工具 | 面向模型的职责 | 是否递归 | 是否读取文件内容 | 是否有副作用 |
|---|---|---:|---:|---:|
| `find` | 按 glob 查找路径 | 是 | 否 | 否 |
| `ls` | 查看一个目录的直接子项 | 否 | 否 | 否 |
| `list_workspace` | 查看整个工作区的递归树形概览 | 是 | 否 | 否 |
| `read_file` | 读取确定文件的内容 | 不适用 | 是 | 否 |
| `grep` | 按正则或字面量搜索磁盘文件内容 | 是 | 只返回匹配行及可选上下文 | 否 |
| `run_command` | 在当前选定 shell 中运行命令或脚本 | 不适用 | 不适用 | 视命令而定 |
| `patch_file` | 对已有文件进行可验证、原子化的结构化修改 | 不适用 | 仅为编辑校验读取 | 是 |
| `write_file` | 创建文件或整体覆盖文件 | 不适用 | 否 | 是 |
| `read_command_output` | 读取后台命令的增量或最终输出 | 不适用 | 不适用 | 否 |
| `stop_command` | 停止后台命令及其进程树 | 不适用 | 不适用 | 是 |

完成后只注册上表 10 个第一方本地编程工具。六个下线工具和被替换的旧搜索名字均不计入目标工具面；Skill、外部 MCP、上下文、Memory 和 Agent 编排工具不属于本计划范围。

边界必须清楚：

- `ls` 解决“这个目录下有什么”。
- `find` 解决“符合这个路径模式的文件在哪里”。
- `list_workspace` 解决“整个项目大体长什么样”。
- `grep` 解决“某个正则或字面量模式出现在哪些文件、哪些行”。
- 任何目录工具都不顺带返回文件正文，正文统一由 `read_file` 获取。

## 4. 兼容性原则

### 4.1 `run_command` 的稳定契约

`run_command` 必须保持以下外部契约：

- 工具名仍为 `run_command`。
- 输入字段仍为 `command`、`timeout_ms`、`run_in_background`，不增加模型必须理解的 `shell` 参数。
- 同步完成、超时转后台、显式后台执行的返回形态保持兼容。
- `taskId` 继续由 `read_command_output`、`stop_command` 消费。
- 既有批准卡、白名单、日志、SSE、会话回放和 UI 展示仍以 `run_command` 为统一身份。
- 进程树停止、输出上限、后台任务回收等现有生命周期保证不能在 shell 重构中退化。

Shell 选择属于 Runtime 配置，不属于每一次工具调用的参数。Windows 默认选择 PowerShell；如果启动探测发现 Bash，用户可以在 Runtime 配置中选择 Bash。模型可见描述由当前实际选择生成，不能笼统地声称支持一个当前不可用的 shell。

不根据命令文本猜测 shell，也不在失败后把同一条命令静默换一种 shell 重试。这样的自动回退会让引用、变量、管道和退出码语义不可预测。

### 4.2 `patch_file` 的稳定契约

`patch_file` 的“接口不变”解释为以下外围契约保持稳定：

- 工具名仍为 `patch_file`。
- 它仍然是工作区内文件修改工具，沿用原有批准 effect、工具调用事件、UI 展示和审计身份。
- 文件路径仍使用工作区相对路径，并继续经过越界校验。
- 成功仍表示修改已经落盘；失败不得留下部分写入。

参数语义需要有意识地升级，否则无法实现已经确认的结构化编辑能力。模型可见 schema 改为判别式联合，不再宣传自由格式 `patch` 字符串：

```ts
type PatchFileInput =
  | {
      path: string;
      mode: 'targeted';
      edits: Array<{
        old_text: string;
        new_text: string;
      }>;
    }
  | {
      path: string;
      mode: 'replace_all';
      old_text: string;
      new_text: string;
      expected_occurrences: number;
    };
```

为避免现有后端调用者在同一版本升级中突然失效，执行边界暂时接受旧 `{ path, patch }`，但只通过独立的 legacy adapter 转换和执行：

- 旧参数不再出现在模型 schema、提示词、示例和常规文档中。
- legacy adapter 不得污染新的编辑核心。
- 旧调用必须产生可检索的弃用日志或指标，便于确认真实调用量。
- 完成仓库内调用者迁移并确认一个发布周期无旧调用后，另开变更删除 adapter。

如果实施前确认仓库不存在任何外部或持久化旧调用，用户可以再决定是否把 legacy adapter 从本次范围中移除；不能在未核对消费者前直接假设安全。

### 4.3 `grep` 的替换边界

`grep` 是对原内容搜索能力的完整替换，不是兼容别名：

- 新的公开工具名为 `grep`。
- 模型 schema、Executor、Tool Gateway、MCP、Policy、UI、日志和文档全部改用 `grep`。
- 旧工具名从 registry 和所有执行分支移除，不保留转发 alias，也不接受旧参数适配。
- 旧会话、旧 tool call 或直接 HTTP/MCP 请求使用旧名字时，明确返回 `unknown/unsupported tool`。
- `grep` 直接搜索磁盘上的当前文件，不依赖 Workspace 内存树中的 `content` 字段。
- Agent 与 MCP 使用同一份 `grep` schema、默认值、结果限制和错误语义。

### 4.4 单一工具契约来源

当前 Agent 工具定义、Tool Gateway/MCP schema 和实际执行存在重复声明及语义漂移。本次不继续分别维护多份字符串和 schema。应建立一个权威 registry，至少统一提供：

- 工具名和模型可见描述。
- JSON Schema 或等价的输入校验器。
- approval effect 和只读/写入分类。
- Agent、MCP、Skill/子 Agent 能力投影。
- UI 展示所需的稳定元数据。

Agent executor 和 Tool Gateway 可以有不同 transport adapter，但同名工具不能再出现一个入口支持参数、另一个入口不支持，或同名返回完全不同数据形态的情况。

### 4.5 前后端完整链路适配

本次不是纯内部重构：新增 `find`、`ls`、`grep`，替换一个旧搜索工具，改变 `list_workspace` 和 `patch_file` 的参数/结果语义，并下线六个工具。因此每项变更都必须沿实际数据流逐层检查：

```text
权威工具 registry / schema
        -> Agent 可见工具与 ToolPolicy
        -> Executor / Tool Gateway / approval effect
        -> RunEvent / Session ledger / SSE / terminal snapshot
        -> conversation-view projection / tool presentation
        -> 前端实时状态 / 历史回放 / 工具卡 / 批次卡
        -> 设置页 / 测试 preset / 工具日志 / 错误与 fallback
```

不能只搜索后端注册名，也不能只以 TypeScript 编译通过作为适配完成。实施时先读取当前实现，再按具体语义调整所有硬编码集合、switch、union、label、icon、summary、target 提取和输出策略。

当前前端/展示链路已经存在按工具名和语义分类的逻辑，至少要重新核对：

- `packages/conversation-view/tool-presentation.ts` 中的工具名称、category、target、成功摘要、raw output 和 file diff 策略。
- `packages/conversation-view/tool-batching.ts` 中 inspection/modification/command 的工具集合、批次边界和批次摘要。
- `packages/shared/types.ts`、`apps/web/src/types.ts` 中 `ToolPresentation`、category、`ToolBatchType` 和序列化类型。
- `packages/run-protocol` 中实时 `tool_started/tool_progress/tool_finished`、ledger `tool_completed` 和 terminal snapshot 的一致性。
- `apps/web/src/conversation` 中单工具卡、批次卡、Run activity、实时 presentation、批准卡和历史回放。
- `apps/web/src/settings/tools-panel.tsx` 中工具列表、启用状态、测试参数 preset 和结果展示。
- Tool Gateway 的工具日志、fallback、批准摘要、fingerprint 和 safe display/output truncation。

目标分类必须由工具语义决定，并通过测试固定，不能仅根据名称前缀猜测。当前目标至少满足：

| 工具 | 展示语义 | 建议批次语义 | 关键展示内容 |
|---|---|---|---|
| `read_file` | read | inspection | 路径、行数、截断 |
| `find` | search/read | inspection | pattern、path、命中数、截断 |
| `ls` | read | inspection | 目录、条目数、截断 |
| `list_workspace` | read | inspection | 根目录、节点数、截断原因 |
| `grep` | search | inspection | pattern、path/glob、匹配数、截断 |
| `write_file` | file mutation | modification | 路径、created/updated、diff |
| `patch_file` | file mutation | modification | path、mode、编辑/替换数、diff |
| `run_command` | command | command | shell、脚本摘要、状态、批准 |
| `read_command_output` | command control/read | 根据现有交互单独验证 | task ID、增量/最终状态 |
| `stop_command` | command control | 根据现有交互单独验证 | task ID、停止结果 |

上表中的 category 名称可以服从当前稳定协议，但语义映射和批次行为必须满足表意。尤其需要处理：

- `grep` 取代旧搜索名后进入 inspection 批次，批次摘要按新参数 `pattern/path/glob` 计算。
- `find`、`ls`、`list_workspace` 不应因为没有文件正文而落入 `other`。
- `patch_file` 展示和批准摘要从旧 `patch` 字符串改为判别式 mode；`replace_all` 不得泄露过量原文，但要显示 expected/actual occurrences。
- 下线工具从实时分类集合、设置 preset 和新调用展示中移除。
- 已持久化的历史事件仍可能包含旧 tool name 或 `snapshot` 等旧 category。取消执行注册不等于破坏历史阅读；回放必须使用兼容的 legacy/generic presentation，绝不能重新执行旧工具。
- 实时事件、刷新后的 Session replay 和 terminal snapshot 对同一次工具调用必须得到相同 category、名称、摘要、状态和批次归属。
- 批次归类变化不能吞掉 approval 卡、assistant boundary、失败详情、文件 diff 或命令后台状态。

如果展示层必须维护映射，优先从共享工具元数据生成，而不是在后端、conversation-view 和 Web 各自复制名单。无法统一生成的历史兼容逻辑应明确隔离并用 replay fixture 固定。

## 5. `find` 设计

### 5.1 输入

```ts
interface FindInput {
  pattern: string;
  path?: string;
  limit?: number;
}
```

- `pattern`：glob 路径模式，例如 `**/*.test.ts`、`packages/**/index.ts`。
- `path`：相对工作区根目录的起始目录，默认工作区根目录。
- `limit`：可选结果上限；服务端仍需有不可突破的硬上限。

### 5.2 语义

- 递归查找文件和目录路径，不读取文件正文。
- 结果路径相对工作区根目录，统一使用 `/` 分隔，避免把 Windows 反斜杠泄露给模型。
- 默认尊重 `.gitignore`；是否同时尊重全局 ignore、隐藏文件和 `.git` 目录必须用测试固定，不能依赖底层库偶然行为。
- 排序稳定，同一工作区内容在不同调用中产生相同顺序。
- 返回命中数量、截断状态和路径列表；达到结果数或字节上限时明确标记 `truncated`，不能伪装成完整结果。
- `pattern` 非法、起始目录不存在、路径越界时返回结构化错误。
- 支持取消信号，避免大仓库扫描成为不可中断任务。

### 5.3 实现策略

优先实现一个跨平台 Node/TypeScript 文件遍历后端，而不是把 `fd`、PowerShell `Get-ChildItem` 或 Bash `find` 作为正确性前提。可以在后续增加经过能力探测的快速后端，但所有后端必须通过同一组契约测试。

## 6. `ls` 设计

### 6.1 输入

```ts
interface LsInput {
  path?: string;
  limit?: number;
}
```

### 6.2 语义

- 只列出目标目录的直接子项，不递归。
- 包含普通隐藏项，例如 `.github`、`.env.example`；`.git` 等内部目录是否显示按统一 ignore 规则处理。
- 目录项以结构化 `type: 'directory'` 表达；文本渲染时可附加 `/`，不能仅靠字符串后缀让调用者猜类型。
- 目录优先、名称大小写不敏感排序；相同名称仍要有确定的次级排序。
- 不返回文件内容、文件摘要或递归子节点。
- 返回目标目录、条目、总数和截断状态。
- 默认上限、硬上限和输出字节上限必须固定在契约测试中。

建议返回结构：

```ts
interface LsResult {
  path: string;
  entries: Array<{
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink';
  }>;
  total: number;
  truncated: boolean;
}
```

## 7. `list_workspace` 设计

`list_workspace` 保留，但重新定位为工作区结构总览。它不是 `find('*')` 的别名，也不是携带正文的文件快照。

### 7.1 输入与兼容

模型侧继续允许无参数调用。若现有 MCP 路由已经支持 `depth`，不能继续让 Agent 与 MCP 同名异义；实施时应统一为同一 schema。建议的统一输入为：

```ts
interface ListWorkspaceInput {
  depth?: number;
}
```

- 无参数表示递归到服务端允许的默认最大深度，语义接近 `ls -R`。
- `depth` 只用于调用者缩小输出，不允许突破服务端深度、节点数和字节硬上限。
- 如果最终决定严格保持无参数，MCP 侧现有 `depth` 也必须移除；不能保留双重契约。

### 7.2 返回

```ts
interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  children?: WorkspaceTreeNode[];
}

interface ListWorkspaceResult {
  root: WorkspaceTreeNode;
  node_count: number;
  truncated: boolean;
  truncation_reason?: 'depth' | 'node_limit' | 'byte_limit';
}
```

约束：

- 返回真正的树，不再用扁平 `{ path, content }[]` 表示目录。
- 任何节点都不携带文件正文。
- 排序、ignore、隐藏文件、符号链接策略与 `ls`、`find` 共用同一个目录遍历内核。
- 遇到 junction/symlink 不递归跟随到工作区外；目录环必须被检测并终止。
- 大项目被截断时，应尽量保留较高层结构并明确截断位置，而不是简单返回前 N 个深层路径。

## 8. `grep` 设计

`grep` 是只读的文件内容搜索工具。它必须搜索当前磁盘内容，不能复用 `list_workspace` 的结构树，也不能要求文件先被 `read_file`、`write_file` 或编辑器加载进内存。

### 8.1 输入契约

```ts
interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}
```

- `pattern`：必填。默认按正则表达式解释。
- `path`：可选的文件或目录，默认当前工作区根目录。
- `glob`：可选文件过滤，例如 `*.ts`、`**/*.spec.ts`。
- `ignoreCase`：是否忽略大小写，默认 `false`。
- `literal`：是否把 `pattern` 作为普通文本而非正则，默认 `false`。
- `context`：每个命中前后显示的行数，默认 `0`；负数按 `0` 处理。
- `limit`：最大匹配数，默认 `100`；小于 `1` 时按 `1` 处理。

Schema 必须拒绝未知字段，并由 Agent、MCP、测试面板和直接 Tool Gateway 调用共同使用。不能继续出现 Agent 少参数、MCP 多参数的同名契约漂移。

### 8.2 `ripgrep` 能力管理

搜索后端使用 `ripgrep`，通过受控的 `ensureRg()` 管理，不经过 PowerShell、Bash 或 `run_command`：

1. 优先检查 DexCode 的托管工具目录：Windows 为 `rg.exe`。
2. 托管目录不存在时检查系统 PATH 中的 `rg`/`rg.exe`。
3. 在线模式下仍不可用时，下载当前操作系统与 CPU 架构对应的发行包，解压到托管工具目录，再返回绝对可执行路径。
4. 离线模式不下载，返回明确的“未安装且离线”错误和人工安装建议。
5. 下载、解压和最终替换使用唯一临时目录与原子发布；并发首次调用共享同一个 in-flight 安装任务，不能互相覆盖。
6. Windows 至少覆盖 x64 和 arm64 发行包；安装完成后执行版本探测，确认下载结果能够启动。
7. 网络失败、资产不存在、解压失败、杀毒软件拦截和无写权限必须分别产生可诊断错误，不能回退到内存树搜索。

`rg` 路径解析结果可以在 Runtime 生命周期内缓存；配置或托管工具目录变化后通过明确的能力重载刷新，不能每个匹配行重复探测。

### 8.3 进程参数与路径语义

执行时直接 spawn `rg`，参数数组固定从以下基础参数构造：

```text
--json --line-number --color=never --hidden
```

可选参数映射：

```text
ignoreCase=true  -> --ignore-case
literal=true     -> --fixed-strings
glob=<value>     -> --glob <value>
```

最终参数使用 `--` 隔开选项与用户输入：

```text
-- <pattern> <resolved-search-path>
```

约束：

- `path` 按工作区相对路径解析并进行 realpath/reparse-point 边界检查；允许指向单个文件或目录。
- 路径不存在时在启动进程前返回 `Path not found`，不能把错误伪装成“没有匹配”。
- `--hidden` 允许搜索隐藏文件，但仍使用 `ripgrep` 的 ignore 规则，默认尊重 `.gitignore`、`.ignore` 和相关排除配置。
- 不启用 `--no-ignore`，也不默认搜索 `.git` 内部对象。
- 通过 argv 传参，不拼接 shell 字符串，因此 pattern、glob 和路径中的空格或 shell 元字符不会被二次解释。
- 工作目录固定为当前 workspace；搜索路径不得越过 workspace。

### 8.4 流式执行与取消

- 逐行读取 `rg --json` 的 stdout，只处理 `type: "match"` 事件。
- 每个 match 记录绝对文件路径、行号和匹配行；达到有效 `limit` 后立即停止子进程并标记 `matchLimitReached`。
- `AbortSignal` 已取消时不启动进程；运行中取消时停止子进程、关闭 readline 并返回 `Operation aborted`。
- 正常退出码 `0` 表示有匹配；退出码 `1` 表示无匹配，不作为异常；其他退出码返回 stderr 或明确的退出码错误。
- 因达到 limit 主动停止时，不能把被终止的退出码误报为搜索失败。
- stdout、stderr、close、error、abort 只能结算一次，所有监听器在结束时清理。
- Windows 停止时必须确保 `rg.exe` 不残留；如普通 kill 不能可靠结束，复用受控的进程树终止能力。

### 8.5 上下文与输出

无上下文时直接使用 JSON match 事件携带的行文本。`context > 0` 时，在搜索结束后按需读取命中文件，并以绝对路径为 key 缓存行数组：

- 读取文本统一把 CRLF 和 CR 转换为内存中的 LF，仅用于展示，不写回文件。
- 命中行格式为 `relative/path.ts:42: text`。
- 上下文行格式为 `relative/path.ts-41- text`，与命中行可明确区分。
- 搜索目录时，输出路径相对于该搜索目录并统一使用 `/`；搜索单文件时显示文件 basename。
- 文件在搜索后被删除或无法读取时，保留命中位置并显示 `(unable to read file)`，不能导致整次搜索失败。
- 无匹配时返回明确的 `No matches found`。

结果必须同时受到三层限制：

1. 默认最多 `100` 个 match，可由 `limit` 调整。
2. 最终文本最多 `50KB`，从头保留并明确标记字节截断。
3. 每一条匹配或上下文行最多 `500` 个字符，超出时截断并标记 `linesTruncated`。

结果 details 至少包含：

```ts
interface GrepDetails {
  matchLimitReached?: number;
  truncation?: {
    truncated: boolean;
    maxBytes: number;
  };
  linesTruncated?: boolean;
}
```

达到任何限制时，结果尾部给出可操作提示，例如提高 `limit`、缩小 `path`、收紧 `glob` 或细化 `pattern`。UI 默认折叠到前 15 行，但展开只影响展示，不重新执行搜索。

### 8.6 替换旧内容搜索路径

实施时删除原内存搜索实现及全部适配代码：

- Workspace service 中基于 `listFiles()` 和 `file.content` 的搜索函数与结果类型。
- Agent executor 的旧工具函数、Host 方法、MCP schema、effect 和 registry 记录。
- Internal readonly policy、Agent definition、Skill capability、测试面板 preset、fallback 和 UI 标签中的旧名字。
- 所有 fixture、mock、snapshot、测试和文档中的旧调用。

迁移完成后，全仓库活跃代码只能存在公开工具名 `grep`。本计划允许在迁移说明中保留旧名字；生产代码、测试、配置、提示词和现行文档必须零命中旧标识。

## 9. `run_command` 重构设计

### 9.1 目标结构

```text
run_command public contract
        |
        v
CommandPolicy / ApprovalPolicy
        |
        v
ResolvedShellRuntime
  |- PowerShell backend
  `- Bash backend (optional)
        |
        v
BackgroundCommandManager
        |
        +-- read_command_output
        `-- stop_command
```

`run_command` 只负责稳定工具协议；shell 发现、脚本编码、进程启动和退出码解释收敛到 shell runtime；后台任务生命周期继续由现有 manager 负责。

### 9.2 启动探测

Runtime 启动时探测一次并形成不可变 capability snapshot，启动日志和能力接口都要能看到探测结果。

PowerShell 顺序：

1. 用户显式配置的绝对路径。
2. PATH 中的 `pwsh.exe`。
3. PATH 中的 `powershell.exe`。

Bash 按以下 Windows 探测顺序解析：

1. 用户显式配置的绝对路径。
2. `%ProgramFiles%\Git\bin\bash.exe`。
3. `%ProgramFiles(x86)%\Git\bin\bash.exe`。
4. PATH 中的 `bash.exe`。

探测必须验证候选是可执行文件，并记录来源、版本和失败原因。首期不把 WSL `bash.exe` 当作 Git Bash 的等价替代，因为 WSL 的路径、环境变量和进程树语义不同；需要支持 WSL 时应作为单独 backend 设计。

### 9.3 Shell 选择与模型描述

- Windows 默认 `powershell`。
- Bash 只有探测成功后才可在 Runtime 设置中选择。
- 用户选择的 shell 不可用时启动失败或明确降级并告警，不能悄悄改变命令语义。
- 模型描述必须写明当前实际 shell、工作目录、可使用的管道/重定向/变量语法，以及后台执行字段。
- PowerShell 描述应明确使用 PowerShell cmdlet 和语法，不再让模型误以为 `run_command` 是单一可执行文件启动器。
- Bash 描述只在 Bash 已选择且可用时出现。

### 9.4 脚本执行

- PowerShell backend 使用真正的 PowerShell 解析器执行完整脚本，支持 `;`、管道、`&&`、变量、重定向和子表达式。
- Bash backend 使用真正的 Bash 解析器执行脚本。
- 优先通过 stdin 或临时脚本文件传递脚本，避免把复杂内容再次拼接进 `-Command`/`-c` 字符串而产生二次转义。
- 明确设置 UTF-8 输入输出；保留 stdout、stderr 和退出码，不把 stderr 出现文本等同于命令失败。
- 工作目录必须固定为当前 workspace 或经过校验的指定目录。
- 临时脚本应位于专用临时目录，执行结束后清理；后台任务要等进程真正结束后再清理。
- 保留现有前台超时转后台、显式后台、任务 ID、输出读取、停止进程树和任务回收行为。

### 9.5 安全与批准

现有“只要包含 `; && | ` $` 等元字符就拒绝”的策略必须移除，因为它与真正 shell 的能力目标冲突。替代方案分三层：

1. **Hard Guard**：工作区越界、明确高危破坏命令等无论批准模式如何都拒绝。
2. **只读分类**：只对可以可靠解析和证明的简单命令提供只读豁免；包含复合语句、管道、重定向、动态求值或未知命令时不判定为只读。
3. **普通批准**：不能证明安全不等于禁止，应按当前批准模式请求批准或执行。

白名单 fingerprint 必须绑定 shell 类型、规范化工作目录和原始脚本文本。不能继续用会改变引号、空白或换行语义的简单字符串折叠来生成执行文本。批准后的实际脚本必须与批准展示内容完全一致。

### 9.6 错误与降级

错误结果至少区分：

- shell 未安装或所选 shell 不可用。
- 命令/脚本语法错误。
- 可执行文件或 cmdlet 不存在。
- 被 Hard Guard 拒绝。
- 等待用户批准。
- 前台超时并转入后台。
- 进程被停止。
- 非零退出码。

通用失败信息不得再建议调用已经删除的工具，也不得把所有失败都描述成“检查命令拼写”。返回 shell、退出码、task ID 和可操作的下一步即可。

## 10. `patch_file` 重构设计

### 10.1 `targeted` 模式

`targeted` 用于一次提交多个精确局部编辑：

```json
{
  "path": "src/a.ts",
  "mode": "targeted",
  "edits": [
    { "old_text": "const oldName = 1;", "new_text": "const newName = 1;" }
  ]
}
```

规则：

- 每个 `old_text` 必须在原始文件中精确命中一次。
- 零次或多次命中都失败，并返回实际命中数和必要的诊断，不猜测“最像”的位置。
- 所有 edits 以同一份原始文件为坐标计算，禁止前一个 edit 改变后一个 edit 的匹配基础。
- edits 之间不能重叠；重叠在写盘前整体失败。
- 允许 `new_text` 为空以执行精确删除。
- 禁止 `old_text` 为空。
- 所有校验成功后一次性写入，任一校验失败则文件保持原样。

### 10.2 `replace_all` 模式

```json
{
  "path": "a.ts",
  "mode": "replace_all",
  "old_text": "foo",
  "new_text": "bar",
  "expected_occurrences": 17
}
```

规则：

- 进行字面量替换，不默认解释为正则表达式。
- 写盘前统计不重叠的精确命中。
- 实际命中数必须等于 `expected_occurrences`；不相等时整体失败。
- `expected_occurrences` 必须是正整数；如果模型预期零次，应该先搜索而不是发起无意义写入。
- `old_text` 与 `new_text` 相同时拒绝，避免产生虚假成功事件。
- 返回实际替换数，并生成真实 unified diff。

命中数断言是该模式的安全边界。它既支持大量同词替换，也能阻止代码在模型依据已经过期时误改更多或更少位置。

### 10.3 文件保持与并发

- 保留 UTF-8 BOM 状态。
- 保留原文件 EOL 风格，不因编辑把 CRLF 全文件改成 LF。
- 不对未修改区域做 trim、格式化或编码重写。
- 同一文件的修改进入 per-file mutation queue，避免两个并发 patch 都基于旧内容通过检查后相互覆盖。
- 校验、diff 生成和原子替换处于同一个串行临界区。
- 落盘使用同目录临时文件加原子替换，失败时不得留下半文件。
- 成功结果返回路径、模式、编辑/替换数、前后内容摘要和 unified diff；不返回整个工作区树，也不默认返回完整文件正文。

### 10.4 删除旧模糊语义

新的编辑核心不得保留以下行为：

- 对缩进、空白或相似行进行 fuzzy 猜测。
- 多次命中时静默修改第一次出现。
- 混合解析多种未经声明的 patch 文本格式。
- 逐块写盘导致前半成功、后半失败。
- 用伪 diff 或整文件内容代替精确修改结果。

legacy adapter 若暂时保留，只负责兼容旧请求，不能成为模型继续使用模糊语义的理由；其行为和退出安排必须由独立测试约束。

## 11. 删除旧工具与取消快照工具注册

### 11.1 删除原则

- 普通用户选择继续使用对话协议完成，不再通过一个工具调用制造额外的等待状态。
- 工具执行批准仍属于批准系统，不能因为删除用户询问工具而删掉 approval hook、确认卡或等待批准状态。
- 静态检查由项目自身命令完成，例如当前 DexCode 的 `npm run lint`、`npm run typecheck` 和测试命令；不保留一个只覆盖部分语言、结果又不可靠的伪通用入口。
- 命令失败 fallback 不再自动推荐某个固定语言检查器。
- 文件修改结果由 `patch_file`/`write_file` 的操作级 diff 展示；版本库差异可以通过项目自身版本控制命令检查，不再保留依赖 DexCode 快照、又不具备可靠 diff 语义的独立文件比较工具。
- `list_versions`、`create_snapshot`、`restore_snapshot` 从模型、MCP、本地 Tool Gateway、Policy、测试面板和 UI 工具列表中全部取消注册，不保留 alias、legacy adapter 或隐藏执行入口。
- 取消注册后不再维护三项快照工具的 schema、描述、fallback、批准语义或兼容性；历史 tool call 明确返回 `unknown/unsupported tool`。
- 本次不删除 Workspace service 中的快照方法、`versions.json`、快照目录或用户已有快照数据，也不提供数据迁移。它们进入冻结状态，等待后续“完全删除快照功能”的专项变更。
- 任何 Agent、MCP 或旧 HTTP 工具入口都不能再创建或恢复快照；如果产品 UI 仍有非工具快照入口，应明确标记为待下线且不得为其新增能力。

### 11.2 全局清理面

实施时至少检查并处理：

- `packages/agent-core/tool-definitions.ts` 中的工具定义、参数类型和描述。
- executor 中的工具函数表、分支、hook 和结果类型。
- `packages/tool-gateway` 的 schema、host 接口、effect、route、实现文件和测试，包括删除 `diff-file.ts` 及其专用类型，并移除三项快照工具的 wrapper 和 dispatch case。
- `ToolPolicy`、只读子 Agent 工具集合、Skill capability 映射和 capability registry。
- `tool-fallback`、系统提示词、错误消息和推荐下一步。
- conversation view、批准卡、工具调用摘要、会话回放和前端图标/标签。
- MCP 暴露、HTTP 接口、序列化数据和任何兼容别名。
- 单元测试、集成测试、fixture、snapshot 和 mock。
- README、系统设计、开发计划、项目总结及其他文档。

完成后，对六个下线工具标识和被 `grep` 替换的旧内容搜索标识执行全仓库检索。生产源码中的模型 schema、registry、Executor、MCP、Policy、UI 工具列表、测试、配置、提示词和现行使用文档必须零命中。本开发计划的“删除/迁移记录”属于唯一允许保留的文档说明。底层冻结实现暂时使用 camelCase 内部方法名，不得再映射为 snake_case 工具名。

## 12. Approval、Policy 与子 Agent 能力

工具新增或删除不能只修改模型 schema。`ToolPolicy` 必须同时约束“模型看得到什么”和“实际允许执行什么”。

目标分类：

- 只读：`find`、`ls`、`list_workspace`、`read_file`、`grep`、`read_command_output`。
- 文件修改：`patch_file`、`write_file`。
- 进程副作用：`run_command`、`stop_command`。

只读子 Agent/内部只读 track 可以获得 `read_file`、`find`、`ls`、`list_workspace`、`grep`，但不能通过一个被错误分类的 `run_command` 绕过限制。命令即使静态判断为只读，也仍是进程能力；是否授予应由具体 Agent policy 显式决定。

新增工具、删除工具和 schema 迁移后必须验证：

- 模型可见列表与 executor 可执行列表一致。
- MCP/HTTP 暴露与 policy 一致。
- approval effect 与实际副作用一致。
- 被删除工具无法通过旧会话 replay、旧 tool call 或直接 HTTP 请求重新进入执行分支。

## 13. 模块改造建议

建议形成以下高内聚模块，具体文件名可在实施时按仓库现状调整：

```text
packages/tool-gateway/
  tool-registry.ts              # 权威工具 schema、描述和 effect
  directory-walker.ts           # ignore、排序、路径和 symlink 公共内核
  find.ts
  ls.ts
  list-workspace.ts
  managed-tools/
    ensure-rg.ts                # rg 探测、下载、安装和缓存
  grep.ts                       # schema、rg 执行、解析、上下文和截断
  shell/
    shell-resolver.ts
    shell-runtime.ts
    powershell-runtime.ts
    bash-runtime.ts
  run-command.ts                # 稳定 public contract adapter
  command-policy.ts
  patch-file.ts                 # 稳定 public contract adapter
  structured-edit.ts            # targeted / replace_all 核心
  legacy-patch-adapter.ts       # 临时兼容层
```

边界要求：

- 目录遍历规则只实现一次，三个目录工具只选择不同的查询和投影。
- `grep` 只依赖磁盘和托管 `rg`，不依赖 Workspace tree 中缓存的文件正文。
- 托管工具安装器只负责发现和安装 `rg`，不解释搜索参数或格式化搜索结果。
- Shell resolver 只负责发现与选择，不执行命令。
- Shell runtime 只负责忠实启动，不决定批准。
- Command policy 只做禁止/批准/只读分类，不偷偷改写脚本。
- Structured edit 只处理内存中的严格编辑和 diff，不知道模型或 UI。
- Workspace host 负责路径解析、权限和原子落盘。
- Tool registry 是模型、MCP、policy 和展示层共同的契约来源。

## 14. 分阶段实施

### 阶段 0：基线与契约锁定

1. 重新确认分支、HEAD、工作区和现有未提交修改。
2. 对当前工具列表、schema、effect、host 方法、RunEvent、ledger、conversation projection、前端分类/批次/工具卡、设置 preset、日志和文档引用建立端到端检索清单。
3. 为 `run_command` 现有输入、返回、后台任务和批准事件补充 characterization tests。
4. 为 `patch_file` 外围工具身份、批准事件和旧参数调用补充 characterization tests。
5. 记录 Agent 与 MCP 对 `list_workspace` 及旧内容搜索工具的当前差异，先锁定目标契约再改代码。

退出条件：关键兼容面有自动化测试保护，且没有依赖记忆猜测隐藏消费者。

### 阶段 1：统一目录遍历与新增工具

1. 实现共享 directory walker、ignore、排序、路径规范化、symlink 和上限策略。
2. 实现 `ls` 并加入权威 registry、executor、MCP、policy、UI 和测试。
3. 实现 `find` 并完成同样接线。
4. 把 `list_workspace` 改为递归结构树，删除文件正文和扁平投影。
5. 统一 Agent 与 MCP 的同名 schema 和结果。

退出条件：三个工具在 Windows 上通过同一套契约测试，大仓库输出可控且不存在路径越界。

### 阶段 2：用 `grep` 替换旧内容搜索

1. 实现 `ensureRg()` 的托管目录、PATH、离线和 Windows 下载路径。
2. 实现唯一 `grep` schema，并接入 registry、Executor、MCP、Policy、UI 和测试面板。
3. 实现 direct-spawn、`--json` 流式解析、limit 终止、AbortSignal 和退出码语义。
4. 实现 glob、literal、ignoreCase、context、三层截断和可操作提示。
5. 删除基于 Workspace 内存树的旧搜索实现、旧公开名字及所有 fallback/fixture/mock。
6. 用 transport parity tests 证明 Agent、MCP 和直接 Host 调用具有相同默认值和输出语义。

退出条件：`grep` 在 Windows 真实磁盘项目上可搜索未加载、未编辑的已有文件；旧工具名在所有活跃入口中不可见、不可调用。

### 阶段 3：重构命令运行时

1. 抽出并锁定现有后台任务 manager 的行为测试。
2. 实现 PowerShell/Bash resolver 和启动 capability snapshot。
3. 实现 PowerShell backend，接回现有 `run_command` public adapter。
4. 实现可选 Git Bash backend 和 Runtime shell 选择。
5. 把命令安全策略从元字符拒绝改为 dialect-aware Hard Guard、只读分类和批准。
6. 动态生成模型描述和错误建议，移除错误 fallback。
7. 验证前台、超时转后台、显式后台、输出读取和停止进程树。

退出条件：PowerShell 管道、复合命令、变量和重定向可用；Bash 可用性与探测结果一致；现有 `run_command` 消费者不需要改调用参数。

### 阶段 4：重构结构化编辑

1. 实现 `targeted` 与 `replace_all` 的纯内存编辑核心和表驱动测试。
2. 实现 BOM/EOL 保持、真实 diff 和原子写入。
3. 加入 per-file mutation queue 和并发测试。
4. 切换模型 schema 与描述到新判别式参数。
5. 加入隔离的 legacy adapter，迁移仓库内旧调用者并记录弃用使用量。
6. 更新 UI 工具摘要，突出 mode、目标路径和实际替换数。

退出条件：任何命中歧义、计数不符、重叠编辑或写入失败都保持原文件不变；成功 diff 与磁盘结果一致。

### 阶段 5：删除旧工具并收紧 Policy

1. 从权威 registry 删除 `read_lints`、`ask_user`、`diff_file` 和三项快照工具，并确认旧内容搜索身份已经由 `grep` 完整替换。
2. 按定义、执行、host、MCP、policy、UI、fallback、测试顺序清理六个下线工具的所有公开路径。
3. 区分普通对话与批准交互，避免误删 approval 基础设施。
4. 更新只读子 Agent/Skill 能力清单。
5. 保留但冻结 Workspace service 快照内部实现和已有数据，不再把它们接回任何工具入口。
6. 使用全仓库检索验证无活跃工具引用、无字符串别名、无旧 schema 入口。

退出条件：六个下线工具和被替换的旧搜索名字都明确返回 unknown/unsupported tool，不能触发隐藏执行；批准链路仍通过测试；已有快照数据未被删除或改写。

### 阶段 6：前后端展示与协议适配

1. 为目标 10 个工具建立“registry -> execution -> effect -> event -> presentation -> batch -> Web”适配矩阵，逐项标记代码位置和测试。
2. 更新共享 ToolPresentation/category 元数据、工具 descriptor、target/summary 和 safe output 策略。
3. 更新 inspection/modification/command 批次映射和摘要，覆盖 `find`、`ls`、`list_workspace`、`grep`、新版 `patch_file` 及命令控制工具。
4. 从实时展示和设置页移除六个下线工具及旧搜索名字，同时为已有历史事件保留只读 legacy/generic renderer。
5. 更新 Tool Gateway 批准摘要、fingerprint、工具日志和错误/fallback，使新参数与用户看到的内容一致。
6. 更新前端工具卡、批次卡、Run activity、设置测试 preset、类型和相关 CSS/图标；不存在的工具不能留下空白卡或错误分类。
7. 用同一组 fixture 对比实时事件、terminal snapshot 和 Session replay，验证 category、summary、status、approval、diff 和批次边界一致。

退出条件：目标 10 个工具都有明确展示和批次行为；七个旧名字不能产生新调用，但历史记录仍可安全阅读；前后端不存在硬编码名单漂移。

### 阶段 7：文档迁移与总体验收

1. 更新 README 的工具表、命令示例和限制说明。
2. 更新系统设计、核心实现方案和工具链文档。
3. 更新批准模式计划中的工具分类、Hard Guard 和 shell 描述。
4. 更新 Agent Runtime、Multi-Agent、Memory、Skill、Queue/Steer 等依赖工具集合的文档。
5. 对历史项目总结增加“现状变更”说明，避免篡改当时事实，同时不把旧行为描述成当前能力。
6. 执行类型检查、单元测试、Web 测试、构建和 Windows 手工验收。

退出条件：代码、测试、模型描述、UI 和文档使用同一组工具语义。

## 15. 测试矩阵

### 15.1 目录工具

- 空目录、单层目录、深层目录、大量文件。
- 隐藏文件、`.gitignore`、被忽略目录和 `.git`。
- Unicode、空格、大小写相近名称、长路径。
- Windows junction、symlink、环和指向工作区外的链接。
- glob 合法/非法、无结果、达到 limit、达到字节上限、取消。
- `ls` 不递归，`find` 按模式递归，`list_workspace` 返回树且无正文。
- Agent、MCP 和直接 host 调用返回一致语义。

### 15.2 `grep`

- `pattern` 的正则默认、`literal=true` 字面量和非法正则错误。
- `ignoreCase` 开关、Unicode、大写/小写混合和多次同一行命中。
- `path` 指向工作区根、子目录、单文件、不存在路径和越界路径。
- `glob` 的单层/递归模式、无匹配、隐藏文件和 `.gitignore` 排除。
- 默认 100 matches、自定义 limit、limit 小于 1、主动停止后的退出码处理。
- 无 context、前后 context、文件边界、重叠上下文和搜索后文件消失。
- 50KB 总输出截断、500 字符单行截断和 details/提示准确性。
- stdout JSON 分片、非法事件、stderr、退出码 0/1/其他、spawn error。
- 调用前取消、运行中取消、达到 limit、Windows 进程退出和无残留进程。
- 托管 `rg.exe`、PATH `rg.exe`、离线缺失、并发首次安装、下载/解压/版本探测失败。
- 未经 `read_file` 或编辑的磁盘既有文件可以被搜索；Workspace 内存树内容不影响结果。
- Agent、MCP、直接 Host 和测试面板使用同一 schema 与默认值。
- 旧工具名在 registry、Policy、Executor、MCP、UI、fallback 和历史 replay 中均不能执行。

### 15.3 命令工具

- `pwsh.exe`、`powershell.exe` 的优先级和显式配置。
- Git Bash 标准安装目录、PATH、未安装、配置路径无效。
- PowerShell 的 `;`、管道、`&&`、变量、重定向、引号、Unicode。
- Bash 的管道、变量、重定向、引号、Unicode。
- stdout/stderr 分离、非零退出、语法错误、可执行文件不存在。
- 前台完成、前台超时转后台、显式后台、增量输出、最终输出、停止进程树。
- Hard Guard 拒绝、只读命令自动允许、复合未知命令进入批准、批准 fingerprint 防换参。
- Runtime 重启后的 shell 探测、模型描述和实际 backend 一致。
- 不发生跨 shell 静默 fallback。

### 15.4 结构化编辑

- targeted 单次命中、零次、多次、多个不重叠 edits、重叠 edits。
- replace_all 命中 1 次、多次、计数偏大、计数偏小、相邻命中。
- `old_text` 为空、相同替换、空 `new_text`、Unicode、多行文本。
- CRLF、LF、UTF-8 BOM、末尾无换行。
- 只改变目标区域，diff 可回放且与最终文件一致。
- 并发修改同一文件、并发修改不同文件、写盘中断。
- 工作区越界、文件不存在、目录路径、只读文件。
- 新 schema、legacy schema、弃用日志和旧调用迁移。

### 15.5 删除与回归

- 模型工具列表不含已删除能力。
- Executor、MCP、HTTP 对六个下线工具和被替换的旧搜索名字均不能执行。
- 三项快照工具不能通过旧会话 replay、直接 dispatch、测试面板或兼容 alias 触发底层快照方法。
- 取消注册过程不删除、覆盖或迁移已有 `versions.json` 和快照目录。
- 普通模型文本提问仍能暂停并等待用户回复。
- 文件/命令批准、会话回放和等待确认状态不受影响。
- fallback 不引用不存在的能力。
- ToolPolicy 的模型可见过滤和执行过滤同时生效。

### 15.6 前后端协议、展示与批次

- 目标 10 个工具逐项验证 descriptor、category、中文名称、target、summary、raw output 和 truncated。
- `find`、`ls`、`list_workspace`、`grep`、`read_file` 进入正确 inspection 批次，摘要不会引用旧工具名或旧参数。
- `write_file`、两种 mode 的 `patch_file` 进入 modification 批次，文件数、操作数、additions/deletions 与实际 diff 一致。
- `run_command` 的批准、前台、后台、失败和停止状态不因批次合并丢失；`read_command_output`、`stop_command` 的是否批处理按确认后的语义固定。
- assistant message、approval、context、Run 切换和不可见 boundary 对各类批次的切分/透明规则符合产品语义。
- 新 `patch_file` 参数在批准卡、工具卡、日志和 replay 中正确展示 mode、path、expected/actual occurrences，不再读取旧 `patch` 字段。
- 六个下线工具和旧搜索名字不出现在新工具列表、设置 preset、descriptor 活跃映射或批次集合中。
- 包含旧名字和旧 `snapshot` category 的历史 ledger 可以渲染为 legacy/generic 卡片，不进入执行路径、不崩溃、不污染当前工具列表。
- 同一 fixture 经实时 RunEvent、terminal snapshot 和 Session replay 投影后，工具顺序、状态、category、summary、approval、diff 和批次成员一致。
- 工具失败、拒绝、取消、结果截断和未知工具均有可读展示，不出现空白卡、错误图标、无限展开或未转义原始输出。
- Tool Gateway registry、前端工具设置页和测试 preset 使用同一目标工具集合；新增/删除工具后不存在孤立开关或不可调用测试按钮。
- Web 单元测试、conversation-view 测试、run-protocol 测试和前端构建共同覆盖该矩阵，不能只更新 snapshot 让测试通过。

### 15.7 仓库级命令

```powershell
npm run lint
npm run typecheck
npm run typecheck:test
npm test
npm run test:web
npm run build:web
```

若仓库在实施期间调整脚本，以当时 `package.json` 为准，但不能只运行最小单测后跳过全量类型检查和构建。

## 16. 文档迁移清单

实施时先通过 `rg` 重新生成真实引用清单。当前已知至少需要复核：

- `README.md`
- `docs/系统设计文档.md`
- `docs/核心实现方案.md`
- `docs/Agent Web 应用技术方案.md`
- `docs/approval-mode-development-plan.md`
- `docs/dexcode-agent-runtime-development-plan.md`
- `docs/agent-streaming-presentation-development-plan.md`
- `docs/managed-project-memory-development-plan.md`
- `docs/multi-agent-plan.md`
- `docs/steer-queue-development-plan.md`
- `docs/web-ui-refactor-development-design.md`
- `docs/core-refactor-implementation-report.md`
- `docs/其他板块/skill系统设计文档.md`
- `docs/其他板块/会话管理与工具管理项目总结.md`
- `docs/其他板块/工具链优化项目总结.md`
- `docs/其他板块/架构与多智能体.md`

每份文档至少核对：工具总数、名称、`grep` 参数与限制、只读分类、批准行为、shell 语法、错误 fallback、子 Agent 能力和返回格式。不能只做字符串替换而保留已经失效的架构结论。

## 17. 验收标准

### 17.1 功能验收

1. `find` 可以在 Windows 工作区按 glob 稳定查找路径，尊重统一 ignore 规则并明确截断。
2. `ls` 只返回一个目录的直接子项，包含必要隐藏项，不读取正文。
3. `list_workspace` 返回递归树形项目概览，不再返回扁平文件正文集合。
4. `grep` 使用托管或 PATH 中的 `rg` 搜索真实磁盘内容，完整支持 pattern、path、glob、ignoreCase、literal、context 和 limit。
5. `grep` 默认限制为 100 个 match、50KB 总输出和 500 字符单行，达到限制或取消时能可靠停止 Windows 子进程。
6. 旧内容搜索工具名在所有活跃入口中不可见、不可调用，也没有 alias 或 legacy adapter。
7. `run_command` 保持原工具参数与后台任务协议，默认执行真实 PowerShell 脚本。
8. Bash 按规定顺序在启动时探测，只在可用并被选择时向模型声明。
9. Shell 元字符不再被一刀切拒绝；Hard Guard、只读判断和批准三者边界清楚。
10. `patch_file` 支持严格 targeted 编辑和带 `expected_occurrences` 的 `replace_all`，所有修改原子化。
11. 新编辑保持 BOM/EOL，返回真实 diff，歧义或计数不符时不写盘。
12. 六个下线工具在所有活跃入口中不可见、不可调用、不可通过旧路径绕过；被替换的旧搜索名字同样不可执行。
13. 取消快照工具注册不会删除或修改已有快照数据，底层功能保持冻结并等待后续专项删除。

### 17.2 一致性验收

1. Agent、MCP、Tool Gateway、Policy、UI 和文档来自同一工具契约或通过自动测试证明一致。
2. 模型描述与当前实际 shell、参数和返回行为一致。
3. 只读子 Agent 能看见并执行新的目录读取工具与 `grep`，但不能获得未授权的进程或写入能力。
4. 历史会话中的未知旧工具调用失败可解释，不造成 Runtime 崩溃。
5. 全仓库文档不再把旧行为当作当前事实。
6. 目标 10 个工具在后端 registry、Run 协议、conversation-view、前端类型、展示映射、批次映射、设置页和日志中均有一致适配。
7. 实时展示、terminal snapshot 和刷新后的历史回放对同一工具序列产生相同的顺序、状态、category、summary、diff、approval 和批次归属。
8. 六个下线工具和旧搜索名字不能发起新调用；包含它们的历史记录仍能安全展示，执行下线与历史可读性互不混淆。

### 17.3 质量验收

1. 新增核心语义均有单元测试，跨模块生命周期有集成测试。
2. `npm run lint`、`npm test`、`npm run test:web` 和 `npm run build:web` 全部通过。
3. 在 Windows 上完成人工 smoke test：`grep`、PowerShell、可选 Git Bash、后台输出/停止、目录树和批量替换。
4. Git diff 中不包含无关格式化、用户文件覆盖或未经批准的架构扩张。

## 18. 风险与控制

| 风险 | 控制措施 |
|---|---|
| 真 shell 放开元字符后扩大命令能力 | Hard Guard、dialect-aware 分类、批准 fingerprint、原始脚本绑定 |
| PowerShell 与 Bash 语法被模型混用 | Runtime 显式选择、动态工具描述、禁止猜测和静默 fallback |
| `patch_file` schema 升级破坏旧消费者 | 先盘点调用者、隔离 legacy adapter、弃用指标、契约测试 |
| 大仓库树输出挤占上下文 | 深度/节点/字节上限、结构优先截断、明确 `truncated` |
| 三个目录工具规则漂移 | 共用 directory walker 和契约测试 |
| `rg.exe` 缺失或托管安装失败 | 托管目录/PATH 双路径、离线明确失败、原子安装、版本探测 |
| 搜索结果过多或上下文膨胀 | match、总字节、单行三层限制，达到限制立即停止进程 |
| 旧搜索名残留形成双入口 | registry 与执行分支同时删除、全仓检索、旧调用拒绝测试 |
| 删除用户询问能力误伤批准系统 | 把普通对话与 approval hook 分开测试和清理 |
| 删除静态检查入口后失去质量检查 | 使用项目原生命令和明确的 package scripts，不伪装成通用工具 |
| 取消快照工具注册时误删用户快照 | 本次只断开工具入口，不删除目录、索引或 Workspace 内部方法 |
| 冻结的快照实现被其他路径重新暴露 | capability/route 检索、底层调用监测、旧 tool call 拒绝测试 |
| 同名 Agent/MCP 工具继续异义 | 权威 registry，加 transport parity tests |
| 后端工具变更后前端硬编码名单未同步 | 建立 10 个目标工具的端到端适配矩阵，覆盖 presentation、batch、settings 和 replay |
| 删除展示 category 导致历史会话无法回放 | 执行注册与历史 renderer 分离，保留隔离的 legacy/generic 展示契约 |
| 批次归类吞掉批准、失败或 diff | 使用实时/terminal/replay 共用 fixture 验证边界和成员信息 |
| 并发 patch 覆盖 | per-file mutation queue、临界区内重读校验与原子写入 |

## 19. 实施边界

本次范围不包括：

- 把 WSL 作为 Git Bash 的透明替代。
- 实现任意 shell 自动识别或失败后跨 shell 重试。
- 新建一个单独的 `powershell` 或 `bash` 模型工具来绕开 `run_command`。
- 把 `find`、`ls` 交给系统命令直接执行。
- 在 `rg` 不可用时回退到旧的 Workspace 内存树内容搜索。
- 在目录工具中返回文件正文。
- 恢复模糊匹配 patch 或取消替换次数断言。
- 用新的用户选择工具替代已经决定采用的普通对话机制。
- 为所有编程语言制造一个固定的伪通用 lint 命令。
- 物理删除快照目录、`versions.json`、Workspace 快照方法或已有快照数据；这些留给后续完整删除快照功能的专项变更。
- 为已取消注册的三项快照工具继续提供兼容 alias、迁移 adapter 或新功能维护。

若实施中发现必须突破上述边界，先补充证据并与用户重新确认，不在编码过程中自行扩大范围。

## 20. 实施执行提示

后续依据本文实施时，必须遵守以下提示：

> 这次工具改造包含新增、替换、语义重构和取消注册，不是只改后端实现。开始编码前，先从当前源码重新生成完整工具与消费者清单，建立目标 10 个工具以及七个旧名字的端到端适配矩阵。对每个工具逐层核对模型 schema、ToolPolicy、Executor、Tool Gateway、approval effect、日志、RunEvent、Session ledger、SSE、terminal snapshot、conversation-view projection、前端类型、工具展示、批次归类、批准卡、设置页测试 preset、实时状态和历史回放。任何按工具名硬编码的集合、switch、union、label、icon、summary、target 提取、输出截断或 fallback 都必须根据新语义重新判断，不能机械改名。新增工具必须在前后端完整可见且展示正确；下线工具必须不能发起新调用，但历史记录仍要安全可读；改变参数或返回结构的工具必须同步修改批准 fingerprint、展示摘要、批次统计和 replay fixture。只有后端执行、实时展示、刷新后回放、批次边界、批准流程、设置页和文档全部一致，并通过对应的协议、conversation-view、Web 与全仓测试，才算完成。

实施者不得假定本文列出的前端文件名和分类集合在编码时仍完全相同。由于仓库可能存在并行修改，每次编辑前都要重新检查分支、HEAD、工作区 diff 和实际消费者；保留无关用户改动，不覆盖正在进行的前端工作。

## 21. 上下文内部工具展示约束

`read_artifact` 属于上下文管理内部工具。它可以继续参与模型上下文协议、结果回填和持久化，但不得创建前端 Tool Card，也不得进入实时或历史执行流程批次。实时事件投影与刷新后的 Session ledger 投影都必须过滤该工具，并以契约测试覆盖这两个入口。
