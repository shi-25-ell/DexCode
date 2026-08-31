import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '../shared/types.ts';
import { projectConversation, projectConversationListItem } from './projection.ts';
import { conversationTitle } from './title.ts';
import { presentTool } from './tool-presentation.ts';
import { safeDisplayOutput, safeRawOutput } from './output-policy.ts';

test('conversation title uses the first question instead of an internal id', () => {
  assert.equal(conversationTitle('  ## 请帮我重构这个 Web 对话页面  '), '请帮我重构这个 Web 对话页面');
  assert.equal(conversationTitle('a'.repeat(40)), `${'a'.repeat(36)}…`);
});

test('tool presentation localizes Skill, MCP and file changes', () => {
  const skill = presentTool({ callRef: 'call-hidden', tool: 'activate_skill', args: { name: 'frontend-development' }, result: { ok: true } });
  assert.equal(skill.name, '使用 Skill');
  assert.equal(skill.target, 'frontend-development');
  assert.equal(skill.status, 'succeeded');

  const mcp = presentTool({ callRef: 'call-mcp', tool: 'mcp__github__search_code', args: {}, result: { items: [] } });
  assert.equal(mcp.name, '调用 MCP');
  assert.equal(mcp.target, 'github · search_code');

  const file = presentTool({
    callRef: 'call-file',
    tool: 'patch_file',
    args: { path: 'src/app.ts' },
    result: { ok: true },
    fileDiff: { path: 'src/app.ts', before: 'a\nb\nc', after: 'a\nx\ny\nc' },
  });
  assert.deepEqual(file.fileChange, { path: 'src/app.ts', additions: 2, deletions: 1 });
});

test('projection keeps opaque refs out of product titles and restores tool cards', () => {
  const now = new Date().toISOString();
  const session: Session = {
    sessionId: 'session-secret',
    scope: { kind: 'general' },
    createdAt: now,
    updatedAt: now,
    messages: [{ role: 'user', content: '第一个问题决定标题' }],
    taskSummaries: [],
    activeTaskId: null,
    ledger: [
      { seq: 1, at: now, runId: 'task-secret', type: 'message', message: { role: 'user', content: '第一个问题决定标题' } },
      { seq: 2, at: now, runId: 'task-secret', type: 'tool_completed', callId: 'call-secret', presentation: presentTool({ callRef: 'call-secret', tool: 'read_file', args: { path: 'src/app.ts' }, result: { content: 'a\nb' } }) },
    ],
  };
  const listItem = projectConversationListItem(session);
  const snapshot = projectConversation(session);
  assert.equal(listItem.title, '第一个问题决定标题');
  assert.equal(snapshot.items[1]?.kind, 'tool');
  assert.doesNotMatch(JSON.stringify({ title: listItem.title, items: snapshot.items.map((item) => item.kind === 'tool' ? item.tool.name : item) }), /session-|task-|call-secret|read_file/);
});

test('raw output hides structured and inline secrets before reaching Tool Cards', () => {
  const structured = safeRawOutput({ token: 'secret-token', nested: { apiKey: 'secret-key' }, ok: true }).text ?? '';
  const inline = safeRawOutput('Authorization: Bearer secret-value\npassword=plain-secret').text ?? '';
  assert.doesNotMatch(structured, /secret-token|secret-key/);
  assert.doesNotMatch(inline, /secret-value|plain-secret/);
  assert.match(structured, /已隐藏/);
  assert.match(inline, /已隐藏/);
});

test('projection upgrades legacy JSON tool output into readable content', () => {
  const now = new Date().toISOString();
  const session: Session = {
    sessionId: 'session-legacy-output',
    scope: { kind: 'general' },
    createdAt: now,
    updatedAt: now,
    messages: [{ role: 'user', content: '读取文件' }],
    taskSummaries: [],
    activeTaskId: null,
    ledger: [{
      seq: 1,
      at: now,
      runId: 'run-legacy',
      type: 'tool_completed',
      callId: 'call-legacy',
      presentation: {
        callRef: 'call-legacy',
        category: 'read',
        name: '读取文件',
        status: 'succeeded',
        summary: '读取完成',
        rawOutput: JSON.stringify({ path: 'src/app.ts', content: '可读正文' }),
      },
    }],
  };
  const tool = projectConversation(session).items[0];
  assert.equal(tool?.kind, 'tool');
  if (tool?.kind === 'tool') assert.equal(tool.tool.rawOutput, '可读正文');
});

test('tool output renders common content and command streams instead of JSON envelopes', () => {
  assert.equal(safeDisplayOutput({ path: 'src/app.ts', content: '第一行\n第二行' }).text, '第一行\n第二行');
  assert.equal(safeDisplayOutput({ content: [{ type: 'text', text: 'MCP 第一段' }, { type: 'text', text: 'MCP 第二段' }] }).text, 'MCP 第一段\n\nMCP 第二段');
  assert.equal(safeDisplayOutput({ status: 'succeeded', stdout: '测试通过', stderr: '一条警告' }).text, '测试通过\n\n标准错误\n一条警告');
  assert.doesNotMatch(safeDisplayOutput({ content: 'token=secret-value' }).text ?? '', /secret-value/);
});

test('projection restores Context Cards and provider-calibrated request usage from the ledger', () => {
  const now = new Date().toISOString();
  const breakdown = { systemPrompt: 100, workspaceCode: 200, recentConversation: 300, toolResults: 100, projectMemory: 50, toolDefinitions: 150, other: 100 };
  const session: Session = {
    sessionId: 'session-context-view',
    scope: { kind: 'general' },
    createdAt: now,
    updatedAt: now,
    messages: [{ role: 'user', content: 'long task' }],
    taskSummaries: [],
    activeTaskId: null,
    ledger: [
      { seq: 1, at: now, runId: 'run-context', type: 'message', message: { role: 'user', content: 'long task' } },
      { seq: 2, at: now, runId: 'run-context', type: 'context_compaction_started', operationRef: 'context-op' },
      { seq: 3, at: now, runId: 'run-context', type: 'context_compaction_completed', presentation: { operationRef: 'context-op', status: 'completed', beforeTokens: 4_000, afterTokens: 1_000, breakdown, archivedMessages: 12 } },
      { seq: 4, at: now, runId: 'run-context', type: 'context_usage_observed', manifestId: 'manifest-1', usage: { usedTokens: 1_100, contextWindowTokens: 10_000, hardLimitTokens: 8_000, percentage: 11, source: 'provider', timing: 'last_request', asOfTurn: 2, asOfAttempt: 2, breakdown, breakdownEstimated: true } },
    ],
  };
  const view = projectConversation(session);
  assert.equal(view.items.filter((item) => item.kind === 'context').length, 1);
  assert.deepEqual(view.contextUsage, {
    usedTokens: 1_100,
    contextWindowTokens: 10_000,
    hardLimitTokens: 8_000,
    percentage: 11,
    source: 'provider',
    timing: 'last_request',
    asOfTurn: 2,
    asOfAttempt: 2,
    breakdown,
    breakdownEstimated: true,
  });
});

test('projection restores generic approval cards and their resolved state', () => {
  const now = new Date().toISOString();
  const session: Session = {
    sessionId: 'session-approval-view',
    scope: { kind: 'workspace', workspaceId: 'workspace-test' },
    createdAt: now,
    updatedAt: now,
    messages: [{ role: 'user', content: '修改文件' }],
    taskSummaries: [],
    activeTaskId: null,
    ledger: [
      {
        seq: 1,
        at: now,
        runId: 'run-approval',
        type: 'approval_requested',
        approvalId: 'approval-1',
        request: {
          version: 1,
          approvalId: 'approval-1',
          toolName: 'write_file',
          effect: 'write',
          title: '批准文件修改',
          target: 'src/app.ts',
          reason: '逐次批准需要批准此副作用',
          fingerprint: 'fingerprint-1',
          options: ['allow_once', 'deny'],
        },
      },
      { seq: 2, at: now, runId: 'run-approval', type: 'approval_resolved', approvalId: 'approval-1', decision: 'allow_once' },
    ],
  };
  assert.deepEqual(projectConversation(session).items, [{
    id: 'approval-approval-1',
    kind: 'approval',
    approvalRef: 'approval-1',
    approvalKind: 'tool',
    toolName: 'write_file',
    effect: 'write',
    title: '批准文件修改',
    target: 'src/app.ts',
    reason: '逐次批准需要批准此副作用',
    fingerprint: 'fingerprint-1',
    options: ['allow_once', 'deny'],
    resolved: 'allow_once',
  }]);
});
