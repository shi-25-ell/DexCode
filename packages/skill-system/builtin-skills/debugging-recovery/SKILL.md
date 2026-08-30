---
name: debugging-recovery
description: Diagnose and recover from failures. 用于调试和恢复失败场景，包括测试失败、构建失败、运行时报错、命令异常、功能表现不符合预期、用户要求 debug 或排查问题的任务。
allowed-tools: read_file search_in_workspace patch_file run_command
---

# Debugging Recovery

Use this skill when something is broken or a command fails unexpectedly.

## Workflow

1. Reproduce or inspect the failure before changing code.
2. Identify the smallest likely failure boundary.
3. Read the relevant code and recent changes.
4. Fix the root cause rather than hiding the symptom.
5. Add or run a regression check when practical.
6. Report the failure, the cause, and the verification result.

Avoid broad rewrites while debugging. Prefer small, reversible changes.
