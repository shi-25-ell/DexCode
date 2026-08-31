import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDetail } from '../types';
import { AgentTranscript } from './agent-activity';

afterEach(cleanup);

describe('AgentTranscript', () => {
  it('reuses Markdown messages and ToolCard in transcript order', () => {
    const detail: AgentDetail = {
      agent: {
        agentId: 'agent-a', sessionId: 'session-a', rootAgentId: 'root', parentAgentId: 'root', createdByRunId: 'main-run',
        name: 'researcher', task: '检查项目', contextMode: 'fork', isolation: 'shared', definitionName: 'researcher',
        status: 'idle', lastRunId: 'agent-run-a', createdAt: '', updatedAt: '',
      },
      runs: [{
        agentRunId: 'agent-run-a', agentId: 'agent-a', invokedByRunId: 'main-run', trigger: 'spawn', status: 'completed', input: '检查项目', startedAt: '',
      }],
      messages: [
        { role: 'user', content: '检查项目' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
        { role: 'tool', tool_call_id: 'call-a', name: 'read_file', content: 'README content' },
        { role: 'assistant', content: '## 发现\n\n- 已完成检查' },
      ],
      tools: [{
        callId: 'call-a', name: 'read_file', status: 'finished', presentation: {
          callRef: 'call-a', toolName: 'read_file', category: 'read', name: '读取文件', target: 'README.md',
          status: 'succeeded', summary: '已读取 10 行', rawOutput: 'README content',
        },
      }],
    };

    render(<AgentTranscript detail={detail} />);

    const task = screen.getByText('检查项目');
    const tool = screen.getByText('读取文件');
    const heading = screen.getByRole('heading', { level: 2, name: '发现' });
    expect(task.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(tool.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.queryByText('## 发现')).not.toBeInTheDocument();
    expect(screen.getAllByText('读取文件')).toHaveLength(1);
  });
});
