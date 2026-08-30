---
name: test-writing
description: Write and maintain tests for code changes. 用于创建、补充或修改测试代码，包括单元测试、测试用例、测试目录、测试运行命令、bug 修复后的验证，以及用户要求添加、更新或运行测试的任务。
allowed-tools: read_file search_in_workspace patch_file write_file run_command
---

# Test Writing

Use this skill when a task changes observable behavior or requires proof through tests.

## Workflow

1. Inspect the existing test framework and naming conventions.
2. Identify the behavior under change before editing tests.
3. Add or update the smallest focused tests that prove the behavior.
4. Run the smallest relevant test command.
5. Fix failures caused by the change.
6. Report the test command and result.

Prefer regression tests for bug fixes. Do not invent a test framework if the project already has one.
