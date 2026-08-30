import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiJson, listCapabilities } from '../api';
import { AppShell } from '../shell/app-shell';
import type { ConversationScope } from '../types';

type ToolInfo = { name: string; displayName: string; description: string; source: 'local' | 'external'; enabled: boolean; callCount: number; successCount: number; avgDurationMs: number };
type SkillInfo = { name: string; description: string; source: string; enabled: boolean; allowImplicitInvocation: boolean; missingCapabilities: string[]; usage: { readCount: number; activationCount: number } };
type WhitelistEntry = { id: string; pattern: string; matchType: 'exact' | 'prefix' | 'command'; label?: string; addedAt: string };
type Snapshot = { id: string; name: string; description: string; createdAt: string };
type McpServer = { name: string; type: 'http' | 'stdio'; url?: string; command?: string; enabled?: boolean; headers?: Record<string, string>; args?: string[]; env?: Record<string, string> };

function useWorkspaceRef() {
  const [params] = useSearchParams();
  return params.get('workspaceRef') || undefined;
}

function PanelHeader({ title, description, onRefresh }: { title: string; description: string; onRefresh?: () => void }) {
  return <div className="settings-panel-header"><div><h2>{title}</h2><p>{description}</p></div>{onRefresh ? <button className="secondary-button" onClick={onRefresh}><RefreshCw size={15} />刷新</button> : null}</div>;
}

function Toggle({ enabled, onChange, label }: { enabled: boolean; onChange: () => void; label: string }) {
  return <button className={enabled ? 'toggle on' : 'toggle'} onClick={onChange} aria-label={`${label}：${enabled ? '已启用' : '已禁用'}`}><span /></button>;
}

function WorkspaceRequired() {
  return <div className="settings-empty"><h2>需要先加载项目</h2><p>这项能力属于项目作用域。请返回对话页，在左侧输入项目绝对路径。</p><Link className="primary-link" to="/">返回首页</Link></div>;
}

function ToolsPanel({ workspaceRef }: { workspaceRef: string }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['tools', workspaceRef], queryFn: () => apiJson<{ tools: ToolInfo[] }>('/api/tools', { workspaceRef }) });
  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => apiJson(`/api/tools/${encodeURIComponent(name)}`, { method: 'PATCH', workspaceRef, body: JSON.stringify({ enabled }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['tools', workspaceRef] }),
  });
  return <><PanelHeader title="工具" description="控制项目内可由 Agent 使用的工具。代码名称仅在高级详情中显示。" onRefresh={() => void query.refetch()} /><div className="settings-list">{query.data?.tools.map((tool) => <article className="settings-row" key={tool.name}><div className="settings-row-main"><div className="settings-row-title"><strong>{tool.displayName}</strong><span>{tool.source === 'local' ? '内置' : '外部'}</span></div><p>{tool.description}</p><div className="settings-meta">调用 {tool.callCount} 次 · 成功 {tool.successCount} 次 · 平均 {tool.avgDurationMs}ms</div><details><summary>高级详情</summary><code>{tool.name}</code></details></div><Toggle enabled={tool.enabled} label={tool.displayName} onChange={() => toggle.mutate({ name: tool.name, enabled: !tool.enabled })} /></article>)}</div></>;
}

function SkillsPanel({ workspaceRef }: { workspaceRef: string }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['skills', workspaceRef], queryFn: () => apiJson<{ skills: SkillInfo[] }>('/api/skills', { workspaceRef }) });
  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => apiJson(`/api/skills/${encodeURIComponent(name)}`, { method: 'PATCH', workspaceRef, body: JSON.stringify({ enabled }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['skills', workspaceRef] }),
  });
  return <><PanelHeader title="Skill" description="管理 Agent 可读取和激活的项目能力说明。调用时会在对话时间线中显示。" onRefresh={() => void query.refetch()} /><div className="settings-list">{query.data?.skills.map((skill) => <article className="settings-row" key={skill.name}><div className="settings-row-main"><div className="settings-row-title"><strong>{skill.name}</strong><span>{skill.source === 'builtin' ? '内置' : '项目'}</span></div><p>{skill.description}</p><div className={skill.missingCapabilities.length ? 'settings-warning' : 'settings-meta'}>{skill.missingCapabilities.length ? `缺少能力：${skill.missingCapabilities.join('、')}` : `${skill.allowImplicitInvocation ? '可自动触发' : '仅显式触发'} · 已激活 ${skill.usage.activationCount} 次`}</div></div><Toggle enabled={skill.enabled} label={skill.name} onChange={() => toggle.mutate({ name: skill.name, enabled: !skill.enabled })} /></article>)}</div></>;
}

function WhitelistPanel({ workspaceRef }: { workspaceRef: string }) {
  const client = useQueryClient();
  const [pattern, setPattern] = useState('');
  const [matchType, setMatchType] = useState<WhitelistEntry['matchType']>('exact');
  const query = useQuery({ queryKey: ['whitelist', workspaceRef], queryFn: () => apiJson<{ entries: WhitelistEntry[] }>('/api/command-whitelist', { workspaceRef }) });
  const add = useMutation({ mutationFn: () => apiJson('/api/command-whitelist', { method: 'POST', workspaceRef, body: JSON.stringify({ pattern: pattern.trim(), matchType }) }), onSuccess: () => { setPattern(''); return client.invalidateQueries({ queryKey: ['whitelist', workspaceRef] }); } });
  const remove = useMutation({ mutationFn: (id: string) => apiJson(`/api/command-whitelist/${encodeURIComponent(id)}`, { method: 'DELETE', workspaceRef }), onSuccess: () => client.invalidateQueries({ queryKey: ['whitelist', workspaceRef] }) });
  const labels = { exact: '完整命令', prefix: '命令前缀', command: '命令名称' };
  return <><PanelHeader title="命令白名单" description="命中规则的命令可以跳过重复确认，请只添加你信任的范围。" onRefresh={() => void query.refetch()} /><form className="inline-settings-form" onSubmit={(event) => { event.preventDefault(); if (pattern.trim()) add.mutate(); }}><input value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder="例如 npm test" /><select value={matchType} onChange={(event) => setMatchType(event.target.value as WhitelistEntry['matchType'])}><option value="exact">完整命令</option><option value="prefix">命令前缀</option><option value="command">命令名称</option></select><button type="submit">添加规则</button></form><div className="settings-list">{query.data?.entries.map((entry) => <article className="settings-row compact" key={entry.id}><div className="settings-row-main"><div className="settings-row-title"><code>{entry.pattern}</code><span>{labels[entry.matchType]}</span></div>{entry.label ? <p>{entry.label}</p> : null}</div><button className="danger-icon" onClick={() => remove.mutate(entry.id)} aria-label="删除规则"><Trash2 size={16} /></button></article>)}</div></>;
}

function SnapshotsPanel({ workspaceRef }: { workspaceRef: string }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const query = useQuery({ queryKey: ['snapshots', workspaceRef], queryFn: () => apiJson<{ versions: Snapshot[] }>('/api/versions', { workspaceRef }) });
  const create = useMutation({ mutationFn: () => apiJson('/api/version/snapshot', { method: 'POST', workspaceRef, body: JSON.stringify({ name, description }) }), onSuccess: () => { setName(''); setDescription(''); return client.invalidateQueries({ queryKey: ['snapshots', workspaceRef] }); } });
  const restore = useMutation({ mutationFn: (snapshotId: string) => apiJson('/api/version/restore', { method: 'POST', workspaceRef, body: JSON.stringify({ snapshotId }) }), onSuccess: () => client.invalidateQueries({ queryKey: ['snapshots', workspaceRef] }) });
  return <><PanelHeader title="快照" description="在大范围修改前保存项目状态。恢复操作会覆盖当前工作区。" onRefresh={() => void query.refetch()} /><form className="inline-settings-form" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="快照名称" /><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="简短说明（可选）" /><button type="submit">创建快照</button></form><div className="settings-list">{query.data?.versions.map((snapshot) => <article className="settings-row" key={snapshot.id}><div className="settings-row-main"><div className="settings-row-title"><strong>{snapshot.name || '未命名快照'}</strong><span>{new Date(snapshot.createdAt).toLocaleString('zh-CN')}</span></div><p>{snapshot.description || '没有说明'}</p></div><button className="secondary-button warning" onClick={() => { if (window.confirm(`确定恢复“${snapshot.name || '该快照'}”吗？`)) restore.mutate(snapshot.id); }}>恢复</button></article>)}</div></>;
}

function ProjectKnowledgePanel({ workspaceRef }: { workspaceRef: string }) {
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const query = useQuery({ queryKey: ['project-knowledge', workspaceRef], queryFn: () => apiJson<{ content?: string; template?: string }>('/api/project-memory', { workspaceRef }) });
  useEffect(() => { if (query.data) setContent(query.data.content || query.data.template || '# 项目知识\n'); }, [query.data]);
  const save = useMutation({ mutationFn: () => apiJson<{ updatedAt?: string }>('/api/project-memory', { method: 'PUT', workspaceRef, body: JSON.stringify({ content }) }), onSuccess: (result) => setSaved(result.updatedAt ? `已保存 ${new Date(result.updatedAt).toLocaleTimeString('zh-CN')}` : '已保存') });
  return <><PanelHeader title="项目知识" description="记录长期有效的项目约定和经验，后续会话会按需检索。" onRefresh={() => void query.refetch()} /><textarea className="knowledge-editor" value={content} onChange={(event) => { setContent(event.target.value); setSaved(''); }} spellCheck={false} /><div className="settings-save-row"><span>{saved || 'Markdown 格式'}</span><button className="primary-button" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? '保存中…' : '保存项目知识'}</button></div></>;
}

function McpPanel() {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const query = useQuery({ queryKey: ['mcp-servers'], queryFn: () => apiJson<{ servers: McpServer[] }>('/api/external-mcp/servers') });
  const tools = useQuery({ queryKey: ['mcp-tools'], queryFn: () => apiJson<{ tools: Array<{ server: string; name: string; description: string }> }>('/api/external-mcp/tools'), retry: false });
  const save = useMutation({
    mutationFn: (servers: McpServer[]) => apiJson('/api/external-mcp/servers', { method: 'POST', body: JSON.stringify({ servers }) }),
    onSuccess: async () => { setName(''); setUrl(''); await client.invalidateQueries({ queryKey: ['mcp-servers'] }); await client.invalidateQueries({ queryKey: ['mcp-tools'] }); },
  });
  const submit = (event: FormEvent) => { event.preventDefault(); if (!name.trim() || !url.trim()) return; save.mutate([...(query.data?.servers ?? []).filter((server) => server.name !== name.trim()), { name: name.trim(), type: 'http', url: url.trim(), enabled: true }]); };
  const remove = (server: McpServer) => save.mutate((query.data?.servers ?? []).filter((item) => item.name !== server.name));
  return <><PanelHeader title="MCP" description="连接外部工具服务。调用时会在对话时间线中显示服务器和结果状态。" onRefresh={() => { void query.refetch(); void tools.refetch(); }} /><form className="inline-settings-form" onSubmit={submit}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="服务器名称" /><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="HTTP MCP 地址" /><button type="submit">添加服务器</button></form><div className="settings-list">{query.data?.servers.map((server) => <article className="settings-row" key={server.name}><div className="settings-row-main"><div className="settings-row-title"><strong>{server.name}</strong><span>{server.type === 'http' ? 'HTTP' : '本地进程'}</span></div><p>{server.type === 'http' ? server.url : server.command}</p><div className="settings-meta">{tools.data?.tools.filter((tool) => tool.server === server.name).length ?? 0} 个可用工具</div></div><button className="danger-icon" aria-label={`删除 ${server.name}`} onClick={() => remove(server)}><Trash2 size={16} /></button></article>)}</div></>;
}

export function SettingsPage({ capabilityId }: { capabilityId: string }) {
  const [params] = useSearchParams();
  const workspaceRef = useWorkspaceRef();
  const scope: ConversationScope = workspaceRef ? { kind: 'workspace', workspaceRef } : { kind: 'general' };
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: listCapabilities });
  const capability = capabilities.data?.find((item) => item.id === capabilityId);
  const returnTo = params.get('returnTo') || (workspaceRef ? `/w/${encodeURIComponent(workspaceRef)}/new` : '/');
  const content = !capability && !capabilities.isLoading
    ? <div className="settings-empty"><h2>这项能力没有启用</h2><p>它可能已经从能力注册表中删除或被配置禁用。</p></div>
    : capability?.workspaceRequired && !workspaceRef
      ? <WorkspaceRequired />
      : capabilityId === 'mcp' ? <McpPanel />
        : capabilityId === 'tools' && workspaceRef ? <ToolsPanel workspaceRef={workspaceRef} />
          : capabilityId === 'skills' && workspaceRef ? <SkillsPanel workspaceRef={workspaceRef} />
            : capabilityId === 'whitelist' && workspaceRef ? <WhitelistPanel workspaceRef={workspaceRef} />
              : capabilityId === 'snapshots' && workspaceRef ? <SnapshotsPanel workspaceRef={workspaceRef} />
                : capabilityId === 'project-knowledge' && workspaceRef ? <ProjectKnowledgePanel workspaceRef={workspaceRef} />
                  : <div className="settings-empty">正在加载…</div>;
  return <AppShell scope={scope} title={capability?.label ?? '能力设置'}><div className="settings-scroll"><div className="settings-page"><Link className="back-link" to={returnTo}><ArrowLeft size={16} />返回对话</Link>{content}</div></div></AppShell>;
}
