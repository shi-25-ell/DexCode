---
name: code-review
description: Review code changes for correctness, regressions, security risks, maintainability issues, and missing tests. 用于代码审查、review、检查 diff、合并前质量检查、查找缺陷、回归风险、安全问题、可维护性问题和测试缺口。
allowed-tools: read_file search_in_workspace run_command
---

# Code Review

Use this skill when the user asks for review or quality inspection.

## Workflow

1. Inspect the relevant changed or requested files.
2. Prioritize concrete bugs, regressions, security risks, and missing tests.
3. Lead with findings ordered by severity.
4. Include file and line references when possible.
5. Keep summaries secondary to findings.

Do not modify files during review unless the user explicitly asks for fixes.
