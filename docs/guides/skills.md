# Skill 系统

DexCode Skill 是带 frontmatter 的 `SKILL.md` 及其同目录资源。系统采用渐进式披露：先把短摘要放入模型上下文，只有任务匹配时才读取完整正文并激活。

## 生命周期

1. `SkillRegistry` 扫描内置、用户和当前工作区可用的 Skill。
2. Runtime 只把启用且未被遮蔽的摘要加入 available skills block。
3. 模型通过 `read_skill` 获取完整正文。
4. 确认适用后调用 `activate_skill`；完成或不再适用时可以调用 `deactivate_skill`。
5. 使用记录保存 read/activation 次数和最近使用时间。

Skill 不能只依赖关键词自动执行。显式调用由用户给出 Skill 名称；隐式调用由模型根据摘要和当前任务判断。

## Frontmatter

当前解析的主要字段：

```yaml
---
name: test-writing
description: 为行为变更补充测试
allowImplicitInvocation: true
userInvocable: true
allowedTools:
  - read_file
  - grep
  - patch_file
tags:
  - testing
---
```

还支持 `disableModelInvocation`、`disallowedTools`、`paths` 等字段。工具约束必须同时影响模型可见 schema 和实际执行，不能只依赖提示词。

## 管理界面与 API

能力中心的 Skill 页面支持：

- 查看当前 Skill 和来源；
- 启用或停用；
- 重新扫描；
- 从本机目录、工作区目录或粘贴的 Markdown 导入；
- 在真正导入前查看兼容性、能力缺口、脚本和冲突报告；
- 删除可管理的用户或项目 Skill。

当前 API：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/skills` | 列出 Skill 摘要 |
| GET | `/api/skills/:name` | 读取单个 Skill 信息 |
| PATCH | `/api/skills/:name` | 启用或停用 |
| DELETE | `/api/skills/:name` | 删除可管理 Skill |
| POST | `/api/skills/reload` | 重新扫描 |
| POST | `/api/skills/import/preview` | 预检查导入 |
| POST | `/api/skills/import` | 确认导入 |

不存在独立的 `/test` 或 `/assets` HTTP 端点。Skill 资源由 `read_skill` 返回的根目录信息和受控文件工具按需访问。

## 安全边界

- 内置 Skill 不能通过管理 API 删除；
- 删除操作必须位于系统允许管理的 Skill 根目录；
- 导入会阻止路径逃逸和名称冲突；
- `scripts/` 只会出现在预检查报告中，不会自动执行；
- 缺失能力会显示在报告中，不能被当作已经可用；
- Child Agent 使用独立的 registry view，不能改变 Main Run 的 Skill 激活状态。
