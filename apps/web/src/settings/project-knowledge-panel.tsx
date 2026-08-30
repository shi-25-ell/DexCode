import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiJson } from '../api';
import { PanelHeader, SettingsFeedback } from './settings-shared';

export function ProjectKnowledgePanel({ workspaceRef }: { workspaceRef: string }) {
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const query = useQuery({ queryKey: ['project-knowledge', workspaceRef], queryFn: () => apiJson<{ content?: string; template?: string }>('/api/project-memory', { workspaceRef }) });
  useEffect(() => { if (query.data) setContent(query.data.content || query.data.template || '# 项目知识\n'); }, [query.data]);
  const save = useMutation({ mutationFn: () => apiJson<{ updatedAt?: string }>('/api/project-memory', { method: 'PUT', workspaceRef, body: JSON.stringify({ content }) }), onSuccess: (result) => setSaved(result.updatedAt ? `已保存 ${new Date(result.updatedAt).toLocaleTimeString('zh-CN')}` : '已保存') });
  return <><PanelHeader title="项目知识" description="查看和编辑长期有效的项目约定、架构说明与经验；后续会话会按需检索。" onRefresh={() => void query.refetch()} /><SettingsFeedback loading={query.isLoading} error={query.error} /><textarea className="knowledge-editor" aria-label="项目知识内容" value={content} onChange={(event) => { setContent(event.target.value); setSaved(''); }} spellCheck={false} /><div className="settings-save-row"><span>{save.error instanceof Error ? save.error.message : saved || 'Markdown 格式'}</span><button className="primary-button" onClick={() => save.mutate()} disabled={save.isPending || query.isLoading}>{save.isPending ? '保存中…' : '保存项目知识'}</button></div></>;
}
