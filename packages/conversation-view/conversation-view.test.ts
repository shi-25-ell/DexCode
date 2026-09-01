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
  assert.equal(file.toolName, 'patch_file');
  assert.deepEqual(file.fileChange && {
    path: file.fileChange.path,
    kind: file.fileChange.kind,
    additions: file.fileChange.additions,
    deletions: file.fileChange.deletions,
    truncated: file.fileChange.truncated,
  }, { path: 'src/app.ts', kind: 'modified', additions: 2, deletions: 1, truncated: false });
  assert.match(file.fileChange?.diff ?? '', /^--- a\/src\/app\.ts/m);
  assert.match(file.fileChange?.diff ?? '', /^\+\+\+ b\/src\/app\.ts/m);
  assert.equal(file.rawOutput, undefined);
});

test('tool presentation identifies Agent orchestration and unknown tools', () => {
  const waiting = presentTool({
    callRef: 'call-wait',
    tool: 'wait_agent',
    args: { agent_ids: ['agent-a', 'agent-b', 'agent-c'], mode: 'all', timeout_ms: 60_000 },
    result: { timed_out: true },
  });
  assert.equal(waiting.name, '等待子 Agent');
  assert.equal(waiting.target, '3 个 Agent · 最长 60 秒');

  const followup = presentTool({ callRef: 'call-followup', tool: 'followup_agent', args: { agent_id: 'agent-a', task: '继续' }, result: { status: 'running' } });
  assert.equal(followup.name, '继续子 Agent');
  assert.equal(followup.target, undefined);

  const unknown = presentTool({ callRef: 'call-unknown', tool: 'custom_future_tool', result: { ok: true } });
  assert.equal(unknown.name, '调用工具');
  assert.equal(unknown.target, 'custom_future_tool');
});

test('tool presentation distinguishes invalid arguments, policy blocks, approval denial, and execution failure', () => {
  const invalid = presentTool({ callRef: 'invalid', tool: 'read_file', result: { ok: false, status: 'invalid_arguments', error: { code: 'INVALID_ARGUMENTS', message: '$.offset must be >= 1' } } });
  const blocked = presentTool({ callRef: 'blocked', tool: 'write_file', result: { ok: false, status: 'blocked', error: { code: 'BLOCKED_BY_POLICY', message: 'outside workspace' } } });
  const denied = presentTool({ callRef: 'denied', tool: 'write_file', result: { ok: false, status: 'denied', error: { code: 'APPROVAL_DENIED', message: 'user denied' } } });
  const failed = presentTool({ callRef: 'failed', tool: 'read_file', result: { ok: false, status: 'failed', error: { code: 'NOT_FOUND', message: 'missing file' } } });
  assert.deepEqual([invalid.status, blocked.status, denied.status, failed.status], ['invalid', 'blocked', 'denied', 'failed']);
  assert.match(invalid.summary, /参数错误/);
  assert.match(blocked.summary, /已阻止/);
  assert.equal(denied.summary, '已拒绝执行');
  assert.equal(failed.summary, 'missing file');
});

test('file presentation creates exact non-contiguous hunks and marks new files', () => {
  const modified = presentTool({
    callRef: 'call-multi-hunk',
    tool: 'write_file',
    args: { path: 'src/multi.ts' },
    result: { ok: true, workspaceTree: 'must not be displayed' },
    fileDiff: {
      path: 'src/multi.ts',
      before: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'].join('\n'),
      after: ['one', 'TWO', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'FOURTEEN', 'fifteen'].join('\n'),
    },
  });
  assert.equal(modified.fileChange?.additions, 2);
  assert.equal(modified.fileChange?.deletions, 2);
  assert.equal((modified.fileChange?.diff.match(/^@@/gm) ?? []).length, 2);
  assert.doesNotMatch(modified.fileChange?.diff ?? '', /workspaceTree/);

  const created = presentTool({
    callRef: 'call-created',
    tool: 'write_file',
    args: { path: 'src/new.ts' },
    result: { ok: true },
    fileDiff: { path: 'src/new.ts', before: null, after: 'first\nsecond' },
  });
  assert.equal(created.fileChange?.kind, 'created');
  assert.equal(created.fileChange?.additions, 2);
  assert.equal(created.fileChange?.deletions, 0);
  assert.match(created.fileChange?.diff ?? '', /^--- \/dev\/null/m);

  const bounded = presentTool({
    callRef: 'call-bounded',
    tool: 'write_file',
    args: { path: 'src/large.ts' },
    result: { ok: true },
    fileDiff: {
      path: 'src/large.ts',
      before: Array.from({ length: 120 }, (_, index) => `before-${index}-${'x'.repeat(600)}`).join('\n'),
      after: Array.from({ length: 120 }, (_, index) => `after-${index}-${'y'.repeat(600)}`).join('\n'),
    },
  });
  assert.equal(bounded.fileChange?.truncated, true);
  assert.match(bounded.fileChange?.diff ?? '', /unified diff 已截断/);
  assert.ok((bounded.fileChange?.diff.length ?? 0) < 65_000);
});

test('memory upsert presentation contains the committed markdown instead of internal ids', () => {
  const memory = presentTool({
    callRef: 'call-memory',
    tool: 'memory_upsert',
    args: {
      path: 'project.md',
      name: 'Project',
      description: 'Current project facts',
      type: 'project',
      body: '# Build\n\nUse npm test.',
      operationId: 'operation-secret',
    },
    result: {
      ok: true,
      mutationCommitted: true,
      operationId: 'operation-secret',
      digest: 'sha256-secret',
      indexDigest: 'sha256-index-secret',
    },
  });
  assert.equal(memory.name, '更新记忆');
  assert.equal(memory.target, 'project.md');
  assert.equal(memory.rawOutput, '---\nname: Project\ndescription: Current project facts\ntype: project\n---\n\n# Build\n\nUse npm test.\n');
  assert.doesNotMatch(memory.rawOutput ?? '', /operation-secret|sha256-secret/);
});

test('memory removal remains visible without exposing mutation ids as expandable output', () => {
  const memory = presentTool({
    callRef: 'call-memory-remove',
    tool: 'memory_remove',
    args: { path: 'obsolete.md', operationId: 'operation-secret' },
    result: { ok: true, mutationCommitted: true, operationId: 'operation-secret', indexDigest: 'sha256-index-secret' },
  });
  assert.equal(memory.name, '删除记忆');
  assert.equal(memory.target, 'obsolete.md');
  assert.equal(memory.summary, '项目记忆已删除');
  assert.equal(memory.rawOutput, undefined);
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
      { seq: 2, at: now, runId: 'task-secret', type: 'tool_started', callId: 'call-secret', tool: 'read_file', input: { path: 'src/app.ts' } },
      { seq: 3, at: now, runId: 'task-secret', type: 'tool_completed', callId: 'call-secret', presentation: presentTool({ callRef: 'call-secret', tool: 'read_file', args: { path: 'src/app.ts' }, result: { content: 'a\nb' } }) },
    ],
  };
  const listItem = projectConversationListItem(session);
  const snapshot = projectConversation(session);
  assert.equal(listItem.title, '第一个问题决定标题');
  assert.equal(snapshot.items[1]?.kind, 'tool_batch');
  assert.doesNotMatch(JSON.stringify({ title: listItem.title, items: snapshot.items.map((item) => item.kind === 'tool_batch' ? item.batch.members.map((tool) => tool.name) : item) }), /session-|task-|call-secret|read_file/);
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
      seq: 1, at: now, runId: 'run-legacy', type: 'tool_started', callId: 'call-legacy', tool: 'read_file', input: { path: 'src/app.ts' },
    }, {
      seq: 2,
      at: now,
      runId: 'run-legacy',
      type: 'tool_completed',
      callId: 'call-legacy',
      presentation: {
        callRef: 'call-legacy',
        toolName: 'read_file',
        category: 'read',
        name: '读取文件',
        status: 'succeeded',
        summary: '读取完成',
        rawOutput: JSON.stringify({ path: 'src/app.ts', content: '可读正文' }),
      },
    }],
  };
  const tool = projectConversation(session).items[0];
  assert.equal(tool?.kind, 'tool_batch');
  if (tool?.kind === 'tool_batch') assert.equal(tool.batch.members[0]?.rawOutput, '可读正文');
});

test('projection rebuilds legacy memory mutation cards from their tool inputs', () => {
  const now = new Date().toISOString();
  const session: Session = {
    sessionId: 'session-legacy-memory-output',
    scope: { kind: 'workspace', workspaceId: 'workspace-test' },
    createdAt: now,
    updatedAt: now,
    messages: [],
    taskSummaries: [],
    activeTaskId: null,
    ledger: [
      {
        seq: 1,
        at: now,
        runId: 'run-memory',
        type: 'tool_started',
        callId: 'call-memory',
        tool: 'memory_upsert',
        input: { path: 'project.md', name: 'Project', description: 'Facts', type: 'project', body: '# Build\n\nUse npm test.' },
      },
      {
        seq: 2,
        at: now,
        runId: 'run-memory',
        type: 'tool_completed',
        callId: 'call-memory',
        presentation: {
          callRef: 'call-memory',
          toolName: 'memory_upsert',
          category: 'memory',
          name: '更新记忆',
          target: 'project.md',
          status: 'succeeded',
          summary: '项目记忆已更新',
          rawOutput: 'operationId: old-operation-id\n\ndigest: old-digest',
        },
      },
    ],
  };
  const tool = projectConversation(session).items[0];
  assert.equal(tool?.kind, 'tool');
  if (tool?.kind === 'tool') {
    assert.match(tool.tool.rawOutput ?? '', /^---\nname: Project/m);
    assert.doesNotMatch(tool.tool.rawOutput ?? '', /old-operation-id|old-digest/);
  }
});

test('tool output renders common content and command streams instead of JSON envelopes', () => {
  assert.equal(safeDisplayOutput({ path: 'src/app.ts', content: '第一行\n第二行' }).text, '第一行\n第二行');
  assert.equal(safeDisplayOutput({ content: [{ type: 'text', text: 'MCP 第一段' }, { type: 'text', text: 'MCP 第二段' }] }).text, 'MCP 第一段\n\nMCP 第二段');
  assert.equal(safeDisplayOutput({ status: 'succeeded', stdout: '测试通过', stderr: '一条警告' }).text, '测试通过\n\n标准错误\n一条警告');
  assert.doesNotMatch(safeDisplayOutput({ content: 'token=secret-value' }).text ?? '', /secret-value/);
});

test('projection restores Context Cards and provider-calibrated request usage from the ledger', () => {
  const now = new Date().toISOString();
  const breakdown = { systemPrompt: 100, workspaceCode: 200, recentConversation: 300, toolResults: 100, projectMemory: 50, managedMemory: 0, toolDefinitions: 150, other: 100 };
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
      { seq: 2, at: now, runId: 'run-context', type: 'context_compaction_completed', presentation: { operationRef: 'context-cheap', status: 'completed', beforeTokens: 4_500, afterTokens: 4_000, breakdown, archivedMessages: 12 } },
      { seq: 3, at: now, runId: 'run-context', type: 'context_compaction_started', operationRef: 'context-op' },
      { seq: 4, at: now, runId: 'run-context', type: 'context_compaction_completed', presentation: { operationRef: 'context-op', status: 'completed', beforeTokens: 4_000, afterTokens: 1_000, breakdown, summarizedMessages: 12 }, summaryRecordId: 'summary-1' },
      { seq: 5, at: now, runId: 'run-context', type: 'context_usage_observed', manifestId: 'manifest-1', usage: { usedTokens: 1_100, contextWindowTokens: 10_000, hardLimitTokens: 8_000, percentage: 11, source: 'provider', timing: 'last_request', asOfTurn: 2, asOfAttempt: 2, breakdown, breakdownEstimated: true } },
      { seq: 6, at: now, runId: 'agent-run-context', type: 'context_compaction_started', operationRef: 'child-context-op', contextOwner: { kind: 'agent', sessionId: 'session-context-view', agentId: 'agent-a' } },
      { seq: 7, at: now, runId: 'agent-run-context', type: 'context_compaction_completed', presentation: { operationRef: 'child-context-op', status: 'completed', beforeTokens: 8_000, afterTokens: 2_000, breakdown, summarizedMessages: 20 }, summaryRecordId: 'child-summary', contextOwner: { kind: 'agent', sessionId: 'session-context-view', agentId: 'agent-a' } },
      { seq: 8, at: now, runId: 'agent-run-context', type: 'context_usage_observed', manifestId: 'child-manifest', usage: { usedTokens: 2_000, contextWindowTokens: 10_000, percentage: 20, source: 'provider', timing: 'last_request', breakdown, breakdownEstimated: true }, contextOwner: { kind: 'agent', sessionId: 'session-context-view', agentId: 'agent-a' } },
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

test('projection marks only the explicit final assistant message and upgrades completed legacy ledgers', () => {
  const now = new Date().toISOString();
  const report = (runId: string, finalAnswer: string, finalMessageId?: string) => ({
    version: 1 as const,
    runId,
    status: 'completed' as const,
    terminationReason: 'natural_completion',
    finalAnswer,
    ...(finalMessageId ? { finalMessageId } : {}),
    startedAt: now,
    completedAt: now,
    modelTurnCount: 2,
    modelAttemptCount: 2,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, unknown: 0 },
    toolsUsed: [],
    filesModified: [],
  });
  const session = (runId: string, finalMessageId?: string): Session => ({
    sessionId: `session-${runId}`,
    scope: { kind: 'general' },
    createdAt: now,
    updatedAt: now,
    messages: [],
    taskSummaries: [],
    activeTaskId: null,
    ledger: [
      { seq: 1, at: now, runId, type: 'message', messageId: 'intermediate', turn: 1, message: { role: 'assistant', content: '先调用工具' } },
      { seq: 2, at: now, runId, type: 'message', messageId: 'final', turn: 2, message: { role: 'assistant', content: '最终回答' } },
      { seq: 3, at: now, runId, type: 'run_terminal', report: report(runId, '最终回答', finalMessageId) },
    ],
  });

  const explicit = projectConversation(session('run-v2', 'final')).items;
  assert.equal(explicit[0]?.kind === 'assistant' ? explicit[0].final : undefined, undefined);
  assert.equal(explicit[1]?.kind === 'assistant' ? explicit[1].final : undefined, true);

  const legacy = projectConversation(session('run-legacy')).items;
  assert.equal(legacy[0]?.kind === 'assistant' ? legacy[0].final : undefined, undefined);
  assert.equal(legacy[1]?.kind === 'assistant' ? legacy[1].final : undefined, true);
});

test('projection never creates a history card for read_artifact', () => {
  const now = new Date().toISOString();
  const session: Session = {
    sessionId: 'session-artifact',
    scope: { kind: 'general' },
    createdAt: now,
    updatedAt: now,
    messages: [],
    taskSummaries: [],
    activeTaskId: null,
    ledger: [
      { seq: 1, at: now, runId: 'run-artifact', type: 'tool_started', callId: 'artifact-call', tool: 'read_artifact', input: { ref: 'opaque-ref' } },
      { seq: 2, at: now, runId: 'run-artifact', type: 'tool_completed', callId: 'artifact-call', presentation: presentTool({ callRef: 'artifact-call', tool: 'read_artifact', result: { content: 'hidden' } }) },
    ],
  };
  assert.deepEqual(projectConversation(session).items, []);
});

test('projection marks a consumed Steer user message without hiding it', () => {
  const now = new Date().toISOString();
  const runId = 'run-steer-projection';
  const projected = projectConversation({
    sessionId: 'session-steer-projection',
    scope: { kind: 'general' },
    createdAt: now,
    updatedAt: now,
    messages: [],
    taskSummaries: [],
    activeTaskId: null,
    ledger: [
      { seq: 1, at: now, runId, type: 'run_started', context: { scope: { kind: 'general' } }, profile: 'main', origin: 'user' },
      { seq: 2, at: now, runId, type: 'message', message: { role: 'user', content: '原始任务' } },
      { seq: 3, at: now, runId, type: 'message', messageId: 'before-steer', turn: 1, message: { role: 'assistant', content: '先执行一部分' } },
      { seq: 4, at: now, type: 'queue_enqueued', operationId: 'enqueue-steer', itemId: 'queue-1', message: { role: 'user', content: '调整方向' }, delivery: 'steer', targetRunId: runId, position: 0, sessionRevision: 1 },
      { seq: 5, at: now, runId, type: 'message', message: { role: 'user', content: '调整方向' } },
      { seq: 6, at: now, type: 'queue_consumed', operationId: 'consume-steer', itemId: 'queue-1', delivery: 'steer', runId, sessionRevision: 2 },
      { seq: 7, at: now, runId, type: 'message', messageId: 'final', turn: 2, message: { role: 'assistant', content: '最终结果' } },
      { seq: 8, at: now, runId, type: 'run_terminal', report: {
        version: 1,
        runId,
        status: 'completed',
        terminationReason: 'natural_completion',
        finalAnswer: '最终结果',
        finalMessageId: 'final',
        startedAt: now,
        completedAt: now,
        modelTurnCount: 2,
        modelAttemptCount: 2,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, unknown: 0 },
        toolsUsed: [],
        filesModified: [],
      } },
    ],
  }).items;

  assert.deepEqual(projected.filter((item) => item.kind === 'user'), [
    { id: 'message-2', kind: 'user', content: '原始任务' },
    { id: 'message-5', kind: 'user', content: '调整方向', delivery: 'steer' },
  ]);
});
test('presents background command lifecycle distinctly', () => {
  const started = presentTool({ callRef: 'command-1', tool: 'run_command', args: { command: 'npm test' }, result: { status: 'background', taskId: 'task-1' } });
  const running = presentTool({ callRef: 'command-2', tool: 'read_command_output', args: { task_id: 'task-1' }, result: { status: 'background' } });
  assert.equal(started.summary, '命令已转入后台');
  assert.equal(running.summary, '命令仍在后台运行');
});

test('projection anchors spawn and followup Run cards at their own calls', () => {
  const now = new Date().toISOString();
  const session: Session = {
    sessionId: 'session-agent-order',
    scope: { kind: 'workspace', workspaceId: 'workspace-test' },
    createdAt: now,
    updatedAt: now,
    messages: [],
    taskSummaries: [],
    activeTaskId: null,
    ledger: [
      { seq: 1, at: now, runId: 'run-main', type: 'message', message: { role: 'user', content: '调用子 Agent' } },
      { seq: 2, at: now, runId: 'run-main', type: 'message', message: { role: 'assistant', content: '正在委派' }, messageId: 'message-1', turn: 1 },
      { seq: 3, at: now, runId: 'run-main', type: 'tool_started', callId: 'spawn-1', tool: 'spawn_agent', input: { task: '问好' } },
      { seq: 4, at: now, runId: 'run-main', type: 'message', message: { role: 'assistant', content: '首次调用完成' }, messageId: 'message-2', turn: 2 },
      { seq: 5, at: now, runId: 'run-main', type: 'message', message: { role: 'assistant', content: '继续调用同一 Agent' }, messageId: 'message-3', turn: 3 },
      { seq: 6, at: now, runId: 'run-main', type: 'tool_started', callId: 'followup-1', tool: 'followup_agent', input: { agent_id: 'agent-a', task: '再次问好' } },
      { seq: 7, at: now, runId: 'run-main', type: 'message', message: { role: 'assistant', content: '第二次调用完成' }, messageId: 'message-4', turn: 4 },
    ],
  };
  const view = projectConversation(session, { agents: {
    version: 1,
    sessionId: session.sessionId,
    rootAgentId: 'root',
    revision: 1,
    agents: [{ agentId: 'agent-a' }],
    runs: [
      {
        agentRunId: 'agent-run-1', agentId: 'agent-a', invokedByRunId: 'run-main', invokedByTurn: 1,
        invokedByToolCallId: 'spawn-1', delegationGroupId: 'delegation-run-main-1', trigger: 'spawn',
      },
      {
        agentRunId: 'agent-run-2', agentId: 'agent-a', invokedByRunId: 'run-main', invokedByTurn: 3,
        invokedByToolCallId: 'followup-1', delegationGroupId: 'delegation-run-main-3', trigger: 'followup',
      },
    ],
  } });
  assert.deepEqual(view.items.map((item) => item.kind), [
    'user', 'assistant', 'agent_activity', 'assistant', 'assistant', 'agent_activity', 'assistant',
  ]);
  assert.deepEqual(view.items.filter((item) => item.kind === 'agent_activity').map((item) => item.agentRunIds), [
    ['agent-run-1'], ['agent-run-2'],
  ]);
});
