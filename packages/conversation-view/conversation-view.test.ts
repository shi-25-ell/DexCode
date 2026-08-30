import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '../shared/types.ts';
import { projectConversation, projectConversationListItem } from './projection.ts';
import { conversationTitle } from './title.ts';
import { presentTool } from './tool-presentation.ts';
import { safeRawOutput } from './output-policy.ts';

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
