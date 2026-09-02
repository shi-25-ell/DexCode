# DexCode 文档

本目录只把两类文档视为现行依据：当前架构和当前使用指南。开发计划即使已经完成，也保留在 `completed-plans/` 中作为设计记录，不再承担描述现状的职责。

## 当前文档

- [`architecture.md`](architecture.md)：当前 Runtime、Session、Context、工具、Multi-Agent 和 Web 架构。
- [`guides/runtime-requirements.md`](guides/runtime-requirements.md)：最终用户运行 DexCode 所需的环境与条件依赖。
- [`guides/template-generation.md`](guides/template-generation.md)：当前项目模板 API 和使用边界。
- [`guides/skills.md`](guides/skills.md)：当前 Skill 生命周期、加载范围和 API。
- [仓库 README](../README.md)：安装、配置、主要能力与 API 概览。

当当前文档与完成计划发生冲突时，以当前代码和 `architecture.md` 为准。

## 已完成计划

这些文档记录需求背景、设计取舍和当时的实施顺序。其状态已统一标记为“已实施”；其中的“当前问题”“当前基线”和分支信息均指计划编写时，不代表现在的代码。

- [`completed-plans/core-refactor.md`](completed-plans/core-refactor.md)
- [`completed-plans/web-ui-refactor.md`](completed-plans/web-ui-refactor.md)
- [`completed-plans/approval-mode.md`](completed-plans/approval-mode.md)
- [`completed-plans/agent-streaming-presentation.md`](completed-plans/agent-streaming-presentation.md)
- [`completed-plans/queue-steer.md`](completed-plans/queue-steer.md)
- [`completed-plans/agent-runtime.md`](completed-plans/agent-runtime.md)
- [`completed-plans/context-compaction.md`](completed-plans/context-compaction.md)
- [`completed-plans/managed-memory.md`](completed-plans/managed-memory.md)
- [`completed-plans/multi-agent.md`](completed-plans/multi-agent.md)
- [`completed-plans/coding-tools-refactor.md`](completed-plans/coding-tools-refactor.md)
- [`completed-plans/multi-agent-incident-remediation.md`](completed-plans/multi-agent-incident-remediation.md)

## 实施与事件记录

- [`records/core-refactor-implementation.md`](records/core-refactor-implementation.md)
- [`records/multi-agent-incident-remediation.md`](records/multi-agent-incident-remediation.md)

## 文档维护规则

1. 只有 `architecture.md`、`guides/` 和仓库 README 可以使用“当前实现”“当前支持”等现状表述。
2. 完成计划必须保留顶部状态说明，新增能力不回填成计划编写时已经存在。
3. 文档只引用仓库相对路径，不记录开发者机器上的绝对路径。
4. 文档只记录 DexCode 自身可以从代码、测试或运行结果验证的事实。
5. 删除、移动或重命名文档后，必须检查 Markdown 链接和仓库内路径。
