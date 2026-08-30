import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { apiJson } from '../api';
import { PanelHeader, SettingsDialog, SettingsFeedback, Toggle } from './settings-shared';
import type { McpServer, McpTool } from './types';

function parseRecord(value: string, label: string): Record<string, string> {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.values(parsed).some((item) => typeof item !== 'string')) throw new Error(`${label}必须是字符串键值对 JSON`);
  return parsed as Record<string, string>;
}

function parseArgs(value: string): string[] {
  if (!value.trim()) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error('启动参数必须是字符串数组 JSON');
  return parsed;
}

export function McpPanel() {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [originalName, setOriginalName] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<'http' | 'stdio'>('http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [headers, setHeaders] = useState('{}');
  const [args, setArgs] = useState('[]');
  const [env, setEnv] = useState('{}');
  const [enabled, setEnabled] = useState(true);
  const [formError, setFormError] = useState('');
  const query = useQuery({ queryKey: ['mcp-servers'], queryFn: () => apiJson<{ servers: McpServer[] }>('/api/external-mcp/servers') });
  const tools = useQuery({ queryKey: ['mcp-tools'], queryFn: () => apiJson<{ tools: McpTool[] }>('/api/external-mcp/tools'), retry: false });
  const save = useMutation({
    mutationFn: (servers: McpServer[]) => apiJson('/api/external-mcp/servers', { method: 'POST', body: JSON.stringify({ servers }) }),
    onSuccess: async () => { setEditing(false); await client.invalidateQueries({ queryKey: ['mcp-servers'] }); await client.invalidateQueries({ queryKey: ['mcp-tools'] }); },
    onError: (error) => setFormError(error instanceof Error ? error.message : '保存失败'),
  });
  const remove = useMutation({ mutationFn: (server: McpServer) => apiJson(`/api/external-mcp/servers/${encodeURIComponent(server.name)}`, { method: 'DELETE' }), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['mcp-servers'] }); await client.invalidateQueries({ queryKey: ['mcp-tools'] }); } });
  const resetForm = () => { setOriginalName(''); setName(''); setType('http'); setUrl(''); setCommand(''); setHeaders('{}'); setArgs('[]'); setEnv('{}'); setEnabled(true); setFormError(''); };
  const openNew = () => { resetForm(); setEditing(true); };
  const openEdit = (server: McpServer) => {
    setOriginalName(server.name); setName(server.name); setType(server.type); setEnabled(server.enabled !== false); setFormError('');
    if (server.type === 'http') { setUrl(server.url); setHeaders(JSON.stringify(server.headers ?? {}, null, 2)); setCommand(''); setArgs('[]'); setEnv('{}'); }
    else { setCommand(server.command); setArgs(JSON.stringify(server.args ?? [], null, 2)); setEnv(JSON.stringify(server.env ?? {}, null, 2)); setUrl(''); setHeaders('{}'); }
    setEditing(true);
  };
  const buildServer = (): McpServer => {
    if (!name.trim()) throw new Error('请输入服务器名称');
    if (type === 'http') {
      if (!url.trim()) throw new Error('请输入 HTTP MCP 地址');
      return { name: name.trim(), type, url: url.trim(), headers: parseRecord(headers, '请求头'), enabled };
    }
    if (!command.trim()) throw new Error('请输入启动命令');
    return { name: name.trim(), type, command: command.trim(), args: parseArgs(args), env: parseRecord(env, '环境变量'), enabled };
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const server = buildServer();
      const current = (query.data?.servers ?? []).filter((item) => item.name !== (originalName || server.name));
      setFormError('');
      save.mutate([...current, server]);
    } catch (error) { setFormError(error instanceof Error ? error.message : '配置无效'); }
  };
  const toggle = (server: McpServer) => save.mutate((query.data?.servers ?? []).map((item) => item.name === server.name ? { ...item, enabled: item.enabled === false } : item));
  return <><PanelHeader title="MCP" description="添加、识别和管理 HTTP 或本地进程 MCP 服务器；对话调用时会显示对应提示。" onRefresh={() => { void query.refetch(); void tools.refetch(); }} action={<button className="primary-button" aria-label="添加 MCP 服务器" onClick={openNew}><Plus size={15} />添加</button>} /><SettingsFeedback loading={query.isLoading} error={query.error} empty={!query.isLoading && query.data?.servers.length === 0 ? '暂无 MCP 服务器' : undefined} /><div className="settings-list">{query.data?.servers.map((server) => { const serverTools = tools.data?.tools.filter((tool) => tool.server === server.name) ?? []; return <article className="settings-row" key={server.name}><div className="settings-row-main"><div className="settings-row-title"><strong>{server.name}</strong><span>{server.type === 'http' ? 'HTTP' : '本地进程'}</span><span>{server.enabled === false ? '已停用' : '已启用'}</span></div><p>{server.type === 'http' ? server.url : server.command}</p><div className="settings-meta">{tools.isError && server.enabled !== false ? '工具识别失败，请检查连接' : `识别到 ${serverTools.length} 个工具`}</div>{serverTools.length ? <details><summary>查看工具</summary><div className="mcp-tool-list">{serverTools.map((tool) => <span title={tool.description} key={tool.name}>{tool.name}</span>)}</div></details> : null}</div><div className="settings-row-actions"><button className="secondary-button" onClick={() => openEdit(server)}><Pencil size={14} />编辑</button><button className="danger-icon" aria-label={`删除 ${server.name}`} onClick={() => { if (window.confirm(`确定删除 MCP 服务器“${server.name}”吗？`)) remove.mutate(server); }}><Trash2 size={15} /></button><Toggle enabled={server.enabled !== false} label={server.name} disabled={save.isPending} onChange={() => toggle(server)} /></div></article>; })}</div>
    {editing ? <SettingsDialog title={originalName ? `编辑 MCP：${originalName}` : '添加 MCP 服务器'} onClose={() => setEditing(false)} wide><form onSubmit={submit}><div className="settings-form-grid"><label className="settings-field"><span>服务器名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label><label className="settings-field"><span>连接类型</span><select value={type} onChange={(event) => setType(event.target.value as 'http' | 'stdio')}><option value="http">HTTP</option><option value="stdio">本地进程（stdio）</option></select></label></div>{type === 'http' ? <><label className="settings-field"><span>HTTP MCP 地址</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" /></label><details className="advanced-settings"><summary>高级设置：请求头</summary><p>可能包含密钥。只发送到本机 Runtime，不写入浏览器历史。</p><textarea rows={7} value={headers} onChange={(event) => setHeaders(event.target.value)} spellCheck={false} /></details></> : <><label className="settings-field"><span>启动命令</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" /></label><details className="advanced-settings"><summary>高级设置：参数与环境变量</summary><label className="settings-field"><span>启动参数（JSON 数组）</span><textarea rows={5} value={args} onChange={(event) => setArgs(event.target.value)} spellCheck={false} /></label><label className="settings-field"><span>环境变量（JSON 对象）</span><textarea rows={6} value={env} onChange={(event) => setEnv(event.target.value)} spellCheck={false} /></label></details></>}<label className="checkbox-field"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />保存后立即启用并识别工具</label>{formError ? <p className="dialog-error">{formError}</p> : null}<footer className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setEditing(false)}>取消</button><button type="submit" className="primary-button" disabled={save.isPending}>{save.isPending ? '保存中…' : '保存服务器'}</button></footer></form></SettingsDialog> : null}
  </>;
}
