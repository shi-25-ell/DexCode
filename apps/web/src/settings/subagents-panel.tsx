import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { apiJson } from '../api';
import { PanelHeader, SettingsDialog, SettingsFeedback, Toggle } from './settings-shared';
import type {
  SubagentContextMode,
  SubagentDefinition,
  SubagentDefinitionInput,
  SubagentDefinitionsResponse,
  SubagentFilePermission,
} from './types';

const EMPTY_FORM: SubagentDefinitionInput = {
  name: '',
  description: '',
  instructions: '',
  filePermission: 'read_only',
  contextMode: 'fork',
};

function permissionLabel(permission: SubagentFilePermission) {
  return permission === 'write_files' ? '可修改文件' : '只读';
}

function contextLabel(mode: SubagentContextMode) {
  return mode === 'fork' ? '继承主对话' : '独立上下文';
}

export function SubagentsPanel() {
  const client = useQueryClient();
  const [form, setForm] = useState<SubagentDefinitionInput | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const query = useQuery({
    queryKey: ['subagents'],
    queryFn: () => apiJson<SubagentDefinitionsResponse>('/api/agent-definitions'),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['subagents'] });
  const save = useMutation({
    mutationFn: ({ originalName, input }: { originalName: string | null; input: SubagentDefinitionInput }) => apiJson(
      originalName ? `/api/agent-definitions/${encodeURIComponent(originalName)}` : '/api/agent-definitions',
      { method: originalName ? 'PUT' : 'POST', body: JSON.stringify(input) },
    ),
    onSuccess: async () => { setForm(null); setEditingName(null); setFormError(''); await refresh(); },
    onError: (error) => setFormError(error instanceof Error ? error.message : '保存失败'),
  });
  const toggle = useMutation({
    mutationFn: (agent: SubagentDefinition) => apiJson(`/api/agent-definitions/${encodeURIComponent(agent.name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !agent.enabled }),
    }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (agent: SubagentDefinition) => apiJson(`/api/agent-definitions/${encodeURIComponent(agent.name)}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const openNew = () => { setEditingName(null); setForm({ ...EMPTY_FORM }); setFormError(''); };
  const openEdit = (agent: SubagentDefinition) => {
    setEditingName(agent.name);
    setForm({
      name: agent.name,
      description: agent.description,
      instructions: agent.instructions,
      filePermission: agent.filePermission,
      contextMode: agent.contextMode,
    });
    setFormError('');
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    if (!form.name.trim() || !form.description.trim() || !form.instructions.trim()) {
      setFormError('名称、使用场景描述和子智能体指令均为必填项');
      return;
    }
    setFormError('');
    save.mutate({ originalName: editingName, input: { ...form, name: form.name.trim(), description: form.description.trim(), instructions: form.instructions.trim() } });
  };

  const count = query.data?.agents.filter((agent) => agent.source !== 'builtin').length ?? 0;
  const limit = query.data?.customLimit ?? query.data?.limit ?? 10;
  const atCapacity = count >= limit;
  return <>
    <PanelHeader
      title="子智能体"
      description="你可以在这里预定义一些子智能体，也可以在对话时让模型按需生成。"
      onRefresh={() => { void query.refetch(); }}
      action={<><span className="settings-count">{count}/{limit}</span><button className="primary-button" onClick={openNew} disabled={atCapacity} title={atCapacity ? '已达到子智能体数量上限' : undefined}><Plus size={15} />新建子智能体</button></>}
    />
    <SettingsFeedback loading={query.isLoading} error={query.error ?? toggle.error ?? remove.error} empty={!query.isLoading && count === 0 ? '暂无子智能体' : undefined} />
    <div className="settings-list subagent-grid">{query.data?.agents.map((agent) => <article className="settings-row subagent-card" key={agent.name}>
      <div className="settings-row-main">
        <div className="subagent-card-top">
          <span className="subagent-avatar" aria-hidden="true"><Bot size={25} strokeWidth={1.8} /></span>
          <div className="subagent-badges"><span>{agent.source === 'builtin' ? '内置' : '自定义'}</span><span>{agent.enabled ? '已启用' : '已停用'}</span></div>
        </div>
        <strong className="subagent-card-name" title={agent.name}>{agent.name}</strong>
        <p>{agent.description}</p>
        <div className="settings-meta">文件权限：{permissionLabel(agent.filePermission)} · 上下文：{contextLabel(agent.contextMode)}</div>
        <details className="subagent-instructions"><summary>查看子智能体指令</summary><pre>{agent.instructions}</pre></details>
      </div>
      <div className="settings-row-actions">
        {agent.editable ? <button className="secondary-button" onClick={() => openEdit(agent)}><Pencil size={14} />编辑</button> : null}
        {agent.deletable ? <button className="danger-icon" aria-label={`删除 ${agent.name}`} onClick={() => { if (window.confirm(`确定删除子智能体“${agent.name}”吗？`)) remove.mutate(agent); }} disabled={remove.isPending}><Trash2 size={15} /></button> : null}
        {agent.toggleable ? <Toggle enabled={agent.enabled} label={agent.name} disabled={toggle.isPending} onChange={() => toggle.mutate(agent)} /> : <span className="settings-locked">始终启用</span>}
      </div>
    </article>)}</div>
    {query.data?.diagnostics.length ? <details className="raw-settings-result"><summary>查看加载诊断（{query.data.diagnostics.length}）</summary><pre>{query.data.diagnostics.map((item) => `${item.path}: ${item.message}`).join('\n')}</pre></details> : null}
    {form ? <SettingsDialog title={editingName ? `编辑子智能体：${editingName}` : '新建子智能体'} onClose={() => setForm(null)} wide>
      <form onSubmit={submit}>
        <label className="settings-field"><span>名称</span><input value={form.name} disabled={Boolean(editingName)} maxLength={64} placeholder="例如：test-writer" onChange={(event) => setForm({ ...form, name: event.target.value })} /><small>以小写字母开头，可使用小写字母、数字、连字符和下划线。</small></label>
        <label className="settings-field"><span>使用场景描述</span><textarea rows={3} maxLength={500} value={form.description} placeholder="告诉主智能体什么时候应该选择它" onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        <label className="settings-field"><span>子智能体指令</span><textarea rows={10} maxLength={20000} value={form.instructions} placeholder="定义它应如何完成任务、输出什么结果" onChange={(event) => setForm({ ...form, instructions: event.target.value })} /></label>
        <div className="settings-form-grid">
          <label className="settings-field"><span>文件权限</span><select value={form.filePermission} onChange={(event) => setForm({ ...form, filePermission: event.target.value as SubagentFilePermission })}><option value="read_only">只读</option><option value="write_files">可修改文件</option></select></label>
          <label className="settings-field"><span>上下文</span><select value={form.contextMode} onChange={(event) => setForm({ ...form, contextMode: event.target.value as SubagentContextMode })}><option value="fork">继承主对话</option><option value="fresh">独立上下文</option></select></label>
        </div>
        <p className="settings-form-note">自定义子智能体最多 10 个；保存后默认启用。</p>
        {formError ? <p className="dialog-error">{formError}</p> : null}
        <footer className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setForm(null)}>取消</button><button type="submit" className="primary-button" disabled={save.isPending}>{save.isPending ? '保存中…' : '保存子智能体'}</button></footer>
      </form>
    </SettingsDialog> : null}
  </>;
}
