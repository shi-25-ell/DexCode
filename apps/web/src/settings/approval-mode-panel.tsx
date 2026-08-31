import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from '../api';
import type { ApprovalMode, ApprovalModeState } from './types';
import { PanelHeader, SettingsFeedback } from './settings-shared';
import { WhitelistPanel } from './whitelist-panel';

const MODE_OPTIONS: Array<{ mode: ApprovalMode; title: string; description: string }> = [
  { mode: 'read_only', title: '只读模式', description: '读取和可信只读命令自动执行；写入及其他命令需要批准。' },
  { mode: 'allowlist', title: '白名单模式', description: '文件修改自动执行；未在白名单中的命令需要批准。' },
  { mode: 'full_access', title: '完全访问', description: '所有 Agent 操作自动执行；仅保留系统硬性保护。' },
];

export function ApprovalModePanel({ workspaceRef }: { workspaceRef?: string }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['approval-mode'],
    queryFn: () => apiJson<ApprovalModeState>('/api/approval-mode'),
  });
  const save = useMutation({
    mutationFn: (mode: ApprovalMode) => apiJson<ApprovalModeState>('/api/approval-mode', {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),
    onSuccess: (state) => client.setQueryData(['approval-mode'], state),
  });

  const choose = (mode: ApprovalMode) => {
    if (mode === query.data?.mode || save.isPending) return;
    if (mode === 'full_access' && !window.confirm('完全访问会立即影响当前运行任务后续尚未授权的操作，但不会绕过 Hard Guard。确定继续吗？')) return;
    save.mutate(mode);
  };

  return <div className="approval-settings">
    <section className="approval-section">
      <PanelHeader title="批准模式" description="全局设置；对尚未开始执行的操作立即生效。已执行操作和已发出的批准请求不会被追溯改变。" onRefresh={() => void query.refetch()} />
      <SettingsFeedback loading={query.isLoading} error={query.error} />
      {query.data ? <fieldset className="approval-mode-options" disabled={save.isPending} aria-label="全局批准模式">
        <legend className="sr-only">全局批准模式</legend>
        {MODE_OPTIONS.map((option) => <label className={`approval-mode-option${query.data?.mode === option.mode ? ' selected' : ''}`} key={option.mode}>
          <input type="radio" name="approval-mode" value={option.mode} checked={query.data?.mode === option.mode} onChange={() => choose(option.mode)} />
          <span><strong>{option.title}</strong><small>{option.description}</small></span>
        </label>)}
      </fieldset> : null}
      {save.isPending ? <p className="approval-save-state">正在保存全局模式…</p> : null}
      {save.error ? <SettingsFeedback error={save.error} /> : null}
      {query.data?.diagnostic ? <SettingsFeedback error={new Error(query.data.diagnostic)} /> : null}
      {query.data ? <p className="approval-current">当前模式：{MODE_OPTIONS.find((option) => option.mode === query.data?.mode)?.title} · revision {query.data.revision}</p> : null}
    </section>
    <WhitelistPanel workspaceRef={workspaceRef} inactive={query.data?.mode === 'full_access'} />
  </div>;
}
