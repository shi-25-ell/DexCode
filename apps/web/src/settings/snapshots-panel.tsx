import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiJson } from '../api';
import { PanelHeader, SettingsFeedback } from './settings-shared';
import type { Snapshot } from './types';

export function SnapshotsPanel({ workspaceRef }: { workspaceRef: string }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const query = useQuery({ queryKey: ['snapshots', workspaceRef], queryFn: () => apiJson<{ versions: Snapshot[] }>('/api/versions', { workspaceRef }) });
  const refresh = () => client.invalidateQueries({ queryKey: ['snapshots', workspaceRef] });
  const create = useMutation({ mutationFn: () => apiJson('/api/version/snapshot', { method: 'POST', workspaceRef, body: JSON.stringify({ name, description }) }), onSuccess: async () => { setName(''); setDescription(''); await refresh(); } });
  const restore = useMutation({ mutationFn: (snapshotId: string) => apiJson('/api/version/restore', { method: 'POST', workspaceRef, body: JSON.stringify({ snapshotId }) }), onSuccess: refresh });
  return <><PanelHeader title="快照" description="在大范围修改前保存项目状态；恢复会覆盖当前工作区，请谨慎操作。" onRefresh={() => void query.refetch()} /><form className="inline-settings-form" onSubmit={(event) => { event.preventDefault(); if (name.trim()) create.mutate(); }}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="快照名称" /><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="简短说明（可选）" /><button type="submit" disabled={create.isPending}>{create.isPending ? '创建中…' : '创建快照'}</button></form>{create.error ? <SettingsFeedback error={create.error} /> : null}<SettingsFeedback loading={query.isLoading} error={query.error} empty={!query.isLoading && query.data?.versions.length === 0 ? '暂无快照' : undefined} /><div className="settings-list">{query.data?.versions.map((snapshot) => <article className="settings-row" key={snapshot.id}><div className="settings-row-main"><div className="settings-row-title"><strong>{snapshot.name || '未命名快照'}</strong><span>{new Date(snapshot.createdAt).toLocaleString('zh-CN')}</span></div><p>{snapshot.description || '没有说明'}</p></div><button className="secondary-button warning" disabled={restore.isPending} onClick={() => { if (window.confirm(`确定恢复“${snapshot.name || '该快照'}”吗？当前工作区内容会被覆盖。`)) restore.mutate(snapshot.id); }}>{restore.isPending ? '恢复中…' : '恢复'}</button></article>)}</div>{restore.error ? <SettingsFeedback error={restore.error} /> : null}</>;
}
