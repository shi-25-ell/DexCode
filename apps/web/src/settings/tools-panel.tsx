import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { apiJson } from '../api';
import { JsonResult, PanelHeader, SettingsDialog, SettingsFeedback, Toggle } from './settings-shared';
import type { ToolInfo, ToolLogEntry } from './types';

const TEST_PRESETS: Record<string, Record<string, unknown>> = {
  read_file: { path: 'package.json' },
  search_in_workspace: { query: 'function' },
  read_lints: {},
  diff_file: { path: 'package.json' },
  list_workspace: {},
  list_versions: {},
};

export function ToolsPanel({ workspaceRef }: { workspaceRef: string }) {
  const client = useQueryClient();
  const [testTool, setTestTool] = useState<ToolInfo | null>(null);
  const [argsText, setArgsText] = useState('{}');
  const [testResult, setTestResult] = useState<unknown>();
  const [testError, setTestError] = useState('');
  const [logsTool, setLogsTool] = useState<ToolInfo | null>(null);
  const query = useQuery({ queryKey: ['tools', workspaceRef], queryFn: () => apiJson<{ tools: ToolInfo[] }>('/api/tools', { workspaceRef }) });
  const logs = useQuery({ queryKey: ['tool-logs', workspaceRef, logsTool?.name], queryFn: () => apiJson<{ logs: ToolLogEntry[] }>(`/api/tools/${encodeURIComponent(logsTool!.name)}/logs?limit=20`, { workspaceRef }), enabled: Boolean(logsTool) });
  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => apiJson(`/api/tools/${encodeURIComponent(name)}`, { method: 'PATCH', workspaceRef, body: JSON.stringify({ enabled }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['tools', workspaceRef] }),
  });
  const test = useMutation({
    mutationFn: async () => {
      let args: Record<string, unknown>;
      try { args = JSON.parse(argsText) as Record<string, unknown>; } catch (error) { throw new Error(`参数格式错误：${error instanceof Error ? error.message : '不是有效 JSON'}`); }
      return apiJson<{ result: unknown }>(`/api/tools/${encodeURIComponent(testTool!.name)}/test`, { method: 'POST', workspaceRef, body: JSON.stringify(args) });
    },
    onSuccess: async (result) => { setTestResult(result.result); setTestError(''); await client.invalidateQueries({ queryKey: ['tools', workspaceRef] }); },
    onError: (error) => setTestError(error instanceof Error ? error.message : '测试失败'),
  });
  const openTest = (tool: ToolInfo) => { setTestTool(tool); setArgsText(JSON.stringify(TEST_PRESETS[tool.name] ?? {}, null, 2)); setTestResult(undefined); setTestError(''); };
  return <><PanelHeader title="工具" description="查看、启停和测试 Agent 工具；调用记录用于排查执行问题。" onRefresh={() => void query.refetch()} /><SettingsFeedback loading={query.isLoading} error={query.error} empty={!query.isLoading && query.data?.tools.length === 0 ? '暂无工具' : undefined} /><div className="settings-list">{query.data?.tools.map((tool) => <article className="settings-row" key={tool.name}><div className="settings-row-main"><div className="settings-row-title"><strong>{tool.displayName}</strong><span>{tool.source === 'local' ? '内置' : '外部'}</span></div><p>{tool.description}</p><div className="settings-meta">调用 {tool.callCount} 次 · 成功 {tool.successCount} 次 · 平均 {tool.avgDurationMs}ms{tool.lastCalledAt ? ` · 最近 ${new Date(tool.lastCalledAt).toLocaleString('zh-CN')}` : ''}</div><details><summary>高级详情</summary><code>{tool.name}</code></details></div><div className="settings-row-actions">{tool.source === 'local' ? <button className="secondary-button" onClick={() => openTest(tool)}><FlaskConical size={14} />测试</button> : null}<button className="secondary-button" onClick={() => setLogsTool(tool)}><ScrollText size={14} />日志</button><Toggle enabled={tool.enabled} label={tool.displayName} disabled={toggle.isPending} onChange={() => toggle.mutate({ name: tool.name, enabled: !tool.enabled })} /></div></article>)}</div>
    {testTool ? <SettingsDialog title={`测试：${testTool.displayName}`} onClose={() => setTestTool(null)}><p className="dialog-hint">测试会真实调用当前项目中的工具。写入、命令和恢复类操作可能改变工作区，请确认参数。</p><label className="settings-field"><span>高级参数（JSON）</span><textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} rows={9} spellCheck={false} /></label>{testError ? <p className="dialog-error">{testError}</p> : null}{testResult !== undefined ? <div className="structured-result"><strong>工具已返回结果</strong><JsonResult value={testResult} /></div> : null}<footer className="dialog-actions"><button className="secondary-button" onClick={() => setTestTool(null)}>关闭</button><button className="primary-button" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? '运行中…' : '运行测试'}</button></footer></SettingsDialog> : null}
    {logsTool ? <SettingsDialog title={`${logsTool.displayName}调用日志`} onClose={() => setLogsTool(null)} wide><SettingsFeedback loading={logs.isLoading} error={logs.error} empty={!logs.isLoading && logs.data?.logs.length === 0 ? '暂无调用记录' : undefined} /><div className="tool-log-list">{logs.data?.logs.map((log) => <article className={log.ok ? 'tool-log ok' : 'tool-log failed'} key={log.id}><strong>{log.ok ? '成功' : '失败'} · {log.durationMs}ms</strong><time>{new Date(log.at).toLocaleString('zh-CN')}</time><p>{log.argsPreview}</p><p>{log.error || log.resultPreview}</p></article>)}</div></SettingsDialog> : null}
  </>;
}
