import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { apiJson } from '../api';
import { PanelHeader, SettingsFeedback } from './settings-shared';
import type { WhitelistEntry } from './types';

export function WhitelistPanel({ workspaceRef }: { workspaceRef: string }) {
  const client = useQueryClient();
  const [pattern, setPattern] = useState('');
  const [label, setLabel] = useState('');
  const [matchType, setMatchType] = useState<WhitelistEntry['matchType']>('exact');
  const query = useQuery({ queryKey: ['whitelist', workspaceRef], queryFn: () => apiJson<{ entries: WhitelistEntry[] }>('/api/command-whitelist', { workspaceRef }) });
  const refresh = () => client.invalidateQueries({ queryKey: ['whitelist', workspaceRef] });
  const add = useMutation({ mutationFn: () => apiJson('/api/command-whitelist', { method: 'POST', workspaceRef, body: JSON.stringify({ pattern: pattern.trim(), matchType, ...(label.trim() ? { label: label.trim() } : {}) }) }), onSuccess: async () => { setPattern(''); setLabel(''); await refresh(); } });
  const remove = useMutation({ mutationFn: (id: string) => apiJson(`/api/command-whitelist/${encodeURIComponent(id)}`, { method: 'DELETE', workspaceRef }), onSuccess: refresh });
  const labels = { exact: '完整命令', prefix: '命令前缀', command: '命令名称' };
  return <><PanelHeader title="命令白名单" description="管理无需重复确认的可信命令范围；规则越宽，风险越高。" onRefresh={() => void query.refetch()} /><form className="inline-settings-form whitelist-form" onSubmit={(event) => { event.preventDefault(); if (pattern.trim()) add.mutate(); }}><input value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder="例如 npm test" /><select value={matchType} onChange={(event) => setMatchType(event.target.value as WhitelistEntry['matchType'])}><option value="exact">完整命令</option><option value="prefix">命令前缀</option><option value="command">命令名称</option></select><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="说明（可选）" /><button type="submit" disabled={add.isPending}>添加规则</button></form>{add.error ? <SettingsFeedback error={add.error} /> : null}<SettingsFeedback loading={query.isLoading} error={query.error} empty={!query.isLoading && query.data?.entries.length === 0 ? '暂无白名单规则' : undefined} /><div className="settings-list">{query.data?.entries.map((entry) => <article className="settings-row compact" key={entry.id}><div className="settings-row-main"><div className="settings-row-title"><code>{entry.pattern}</code><span>{labels[entry.matchType]}</span></div>{entry.label ? <p>{entry.label}</p> : null}<div className="settings-meta">添加于 {new Date(entry.addedAt).toLocaleString('zh-CN')}</div></div><button className="danger-icon" onClick={() => remove.mutate(entry.id)} aria-label="删除规则"><Trash2 size={16} /></button></article>)}</div></>;
}
