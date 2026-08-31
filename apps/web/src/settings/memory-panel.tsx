import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiJson } from '../api';
import { PanelHeader, SettingsDialog, SettingsFeedback, Toggle } from './settings-shared';
import type { ManagedMemorySettings, ManagedMemorySnapshot } from './types';

export function MemoryPanel({ workspaceRef }: { workspaceRef: string }) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');
  const query = useQuery({
    queryKey: ['managed-memory', workspaceRef],
    queryFn: () => apiJson<ManagedMemorySnapshot>('/api/managed-memory', { workspaceRef }),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['managed-memory', workspaceRef] });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => apiJson<ManagedMemorySettings>('/api/managed-memory/settings', {
      method: 'PUT', workspaceRef, body: JSON.stringify({ enabled }),
    }),
    onSuccess: (settings) => {
      client.setQueryData<ManagedMemorySnapshot>(['managed-memory', workspaceRef], (current) => current ? { ...current, settings } : current);
      setNotice(settings.enabled ? '项目记忆已启用' : '项目记忆已关闭，已有记忆仍保留');
    },
  });
  const clear = useMutation({
    mutationFn: () => apiJson<{ deletedFiles: number; releasedBytes: number; generation: number }>('/api/managed-memory', {
      method: 'DELETE', workspaceRef, body: JSON.stringify({ confirmationToken: 'CLEAR_MANAGED_MEMORY' }),
    }),
    onSuccess: (result) => {
      setConfirming(false);
      setNotice(`已清空 ${result.deletedFiles} 个记忆文件`);
      void refresh();
    },
  });
  const busy = toggle.isPending || clear.isPending;
  const projectName = workspaceRef;
  return <>
    <PanelHeader title="记忆" description="管理当前项目中由 Agent 自动收集、更新和使用的长期记忆。" onRefresh={() => void query.refetch()} />
    <SettingsFeedback loading={query.isLoading} error={query.error || toggle.error || clear.error} />
    {query.data ? <div className="settings-list">
      <div className="settings-row compact">
        <div className="settings-row-main"><div className="settings-row-title"><strong>启用项目记忆</strong></div><p>允许 Agent 为当前项目自动收集、更新和使用记忆。</p></div>
        <Toggle enabled={query.data.settings.enabled} onChange={() => toggle.mutate(!query.data!.settings.enabled)} label="启用项目记忆" disabled={busy || query.data.mode === 'off'} />
      </div>
      <div className="settings-row compact">
        <div className="settings-row-main"><div className="settings-row-title"><strong>清空项目记忆</strong></div><p>清除 Agent 为这个项目保存的全部记忆；不会删除对话记录，也不会修改手动维护的项目知识。</p></div>
        <button className="secondary-button danger" type="button" onClick={() => setConfirming(true)} disabled={busy}>清空</button>
      </div>
      <div className="settings-feedback">当前项目：{projectName} · {query.data.topicCount} 个记忆主题{notice ? ` · ${notice}` : ''}</div>
    </div> : null}
    {confirming ? <SettingsDialog title="清空项目记忆" onClose={() => !clear.isPending && setConfirming(false)}>
      <div><p>将永久清空项目“{projectName}”的全部自动记忆。此操作不可撤销，但不会删除对话记录，也不会修改“项目知识”。</p><div className="settings-save-row"><button className="secondary-button" onClick={() => setConfirming(false)} disabled={clear.isPending}>取消</button><button className="secondary-button danger" onClick={() => clear.mutate()} disabled={clear.isPending}>{clear.isPending ? '清空中…' : '确认清空'}</button></div></div>
    </SettingsDialog> : null}
  </>;
}
