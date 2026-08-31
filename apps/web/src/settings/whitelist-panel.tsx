import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { apiJson } from '../api';
import { PanelHeader, SettingsFeedback } from './settings-shared';
import type { WhitelistEntry } from './types';

const MATCH_LABELS = { exact: '完整命令', prefix: '命令前缀', command: '命令名称' };

export function WhitelistPanel({ workspaceRef, inactive = false }: { workspaceRef?: string; inactive?: boolean }) {
  const client = useQueryClient();
  const [pattern, setPattern] = useState('');
  const [label, setLabel] = useState('');
  const [matchType, setMatchType] = useState<WhitelistEntry['matchType']>('exact');
  const query = useQuery({
    queryKey: ['whitelist', workspaceRef],
    queryFn: () => apiJson<{ entries: WhitelistEntry[] }>('/api/command-whitelist', { workspaceRef }),
    enabled: Boolean(workspaceRef),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['whitelist', workspaceRef] });
  const add = useMutation({
    mutationFn: () => apiJson('/api/command-whitelist', {
      method: 'POST',
      workspaceRef,
      body: JSON.stringify({ pattern: pattern.trim(), matchType, ...(label.trim() ? { label: label.trim() } : {}) }),
    }),
    onSuccess: async () => {
      setPattern('');
      setLabel('');
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiJson(`/api/command-whitelist/${encodeURIComponent(id)}`, { method: 'DELETE', workspaceRef }),
    onSuccess: refresh,
  });

  if (!workspaceRef) {
    return <section className="approval-section">
      <PanelHeader title="命令白名单" description="白名单按项目隔离，不会把一个项目的命令信任扩散到其他项目。" />
      <SettingsFeedback empty="选择项目后管理命令白名单" />
    </section>;
  }

  const submit = () => {
    if (!pattern.trim()) return;
    if (matchType === 'command' && !window.confirm('命令名称规则会允许该程序的所有参数组合，风险较高。确定添加吗？')) return;
    add.mutate();
  };

  return <section className="approval-section">
    <PanelHeader title="命令白名单" description="管理当前项目无需重复确认的可信命令范围；规则越宽，风险越高。" onRefresh={() => void query.refetch()} />
    {inactive ? <p className="approval-notice">完全访问模式当前不使用白名单；切回只读或白名单模式后这些规则继续生效。</p> : null}
    <form className="inline-settings-form whitelist-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <input value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder="例如 npm test" />
      <select aria-label="白名单匹配范围" value={matchType} onChange={(event) => setMatchType(event.target.value as WhitelistEntry['matchType'])}>
        <option value="exact">完整命令</option>
        <option value="prefix">命令前缀</option>
        <option value="command">命令名称（高风险）</option>
      </select>
      <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="说明（可选）" />
      <button type="submit" disabled={add.isPending}>添加规则</button>
    </form>
    {matchType !== 'exact' ? <p className="settings-warning whitelist-warning">当前规则会匹配多个命令。前缀要求完整 token 边界；命令名称会允许该程序的所有参数组合。</p> : null}
    {add.error ? <SettingsFeedback error={add.error} /> : null}
    <SettingsFeedback loading={query.isLoading} error={query.error} empty={!query.isLoading && query.data?.entries.length === 0 ? '暂无白名单规则' : undefined} />
    <div className="settings-list">
      {query.data?.entries.map((entry) => <article className="settings-row compact" key={entry.id}>
        <div className="settings-row-main">
          <div className="settings-row-title"><code>{entry.pattern}</code><span>{MATCH_LABELS[entry.matchType]}</span></div>
          {entry.label ? <p>{entry.label}</p> : null}
          <div className="settings-meta">{entry.source === 'builtin' ? '系统内置规则' : `添加于 ${new Date(entry.addedAt).toLocaleString('zh-CN')}`}</div>
        </div>
        {entry.source === 'builtin' ? null : <button className="danger-icon" onClick={() => remove.mutate(entry.id)} aria-label="删除规则"><Trash2 size={16} /></button>}
      </article>)}
    </div>
  </section>;
}
