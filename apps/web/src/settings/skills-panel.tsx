import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { apiJson } from '../api';
import { PanelHeader, SettingsDialog, SettingsFeedback, Toggle } from './settings-shared';
import type { SkillImportMode, SkillImportReport, SkillInfo } from './types';

const SOURCE_LABELS: Record<SkillInfo['source'], string> = { builtin: '内置', project: '项目', user: '用户', imported: '导入' };

export function SkillsPanel({ workspaceRef }: { workspaceRef: string }) {
  const client = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);
  const [mode, setMode] = useState<SkillImportMode>('local_path');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [report, setReport] = useState<SkillImportReport | null>(null);
  const query = useQuery({ queryKey: ['skills', workspaceRef], queryFn: () => apiJson<{ skills: SkillInfo[] }>('/api/skills', { workspaceRef }) });
  const refresh = () => client.invalidateQueries({ queryKey: ['skills', workspaceRef] });
  const toggle = useMutation({ mutationFn: ({ name: skillName, enabled }: { name: string; enabled: boolean }) => apiJson(`/api/skills/${encodeURIComponent(skillName)}`, { method: 'PATCH', workspaceRef, body: JSON.stringify({ enabled }) }), onSuccess: refresh });
  const reload = useMutation({ mutationFn: () => apiJson('/api/skills/reload', { method: 'POST', workspaceRef }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (skill: SkillInfo) => apiJson(`/api/skills/${encodeURIComponent(skill.name)}`, { method: 'DELETE', workspaceRef, body: JSON.stringify({ rootPath: skill.rootPath }) }), onSuccess: refresh });
  const payload = useMemo(() => mode === 'inline_markdown' ? { mode, name: name.trim(), content } : { mode, path: path.trim() }, [content, mode, name, path]);
  const preview = useMutation({
    mutationFn: () => apiJson<{ ok: boolean; report: SkillImportReport }>('/api/skills/import/preview', { method: 'POST', workspaceRef, body: JSON.stringify({ ...payload, confirm: false }) }),
    onSuccess: (result) => setReport(result.report),
  });
  const importSkill = useMutation({
    mutationFn: () => apiJson('/api/skills/import', { method: 'POST', workspaceRef, body: JSON.stringify({ ...payload, confirm: true }) }),
    onSuccess: async () => { setImportOpen(false); setReport(null); setPath(''); setName(''); setContent(''); await refresh(); },
  });
  const changeMode = (next: SkillImportMode) => { setMode(next); setReport(null); };
  return <><PanelHeader title="Skill" description="查看、导入、启停和删除项目 Skill；导入前会先识别格式、依赖和冲突。" onRefresh={() => void query.refetch()} action={<button className="primary-button" aria-label="导入 Skill" onClick={() => setImportOpen(true)}><Download size={15} />导入</button>} /><SettingsFeedback loading={query.isLoading} error={query.error} empty={!query.isLoading && query.data?.skills.length === 0 ? '暂无 Skill' : undefined} /><div className="settings-list">{query.data?.skills.map((skill) => <article className="settings-row" key={skill.name}><div className="settings-row-main"><div className="settings-row-title"><strong>{skill.name}</strong><span>{SOURCE_LABELS[skill.source]}</span>{skill.shadowed ? <span>被覆盖</span> : null}</div><p>{skill.description}</p><div className={skill.missingCapabilities.length ? 'settings-warning' : 'settings-meta'}>{skill.missingCapabilities.length ? `缺少能力：${skill.missingCapabilities.join('、')}` : `${skill.allowImplicitInvocation ? '可自动触发' : '仅显式触发'} · 读取 ${skill.usage.readCount} 次 · 激活 ${skill.usage.activationCount} 次`}</div><details><summary>识别详情</summary><div className="skill-detail-grid"><span>标签：{skill.tags.length ? skill.tags.join('、') : '无'}</span><span>文件规则：{skill.filePatterns.length ? skill.filePatterns.join('、') : '无'}</span><span>来源路径：{skill.rootPath}</span></div></details></div><div className="settings-row-actions">{skill.source === 'project' || skill.source === 'imported' ? <button className="danger-icon" aria-label={`删除 ${skill.name}`} onClick={() => { if (window.confirm(`确定删除 Skill“${skill.name}”吗？`)) remove.mutate(skill); }}><Trash2 size={15} /></button> : null}<Toggle enabled={skill.enabled} label={skill.name} disabled={toggle.isPending} onChange={() => toggle.mutate({ name: skill.name, enabled: !skill.enabled })} /></div></article>)}</div><button className="secondary-button settings-tail-action" onClick={() => reload.mutate()} disabled={reload.isPending}>{reload.isPending ? '重新识别中…' : '重新扫描 Skill'}</button>
    {importOpen ? <SettingsDialog title="导入 Skill" onClose={() => setImportOpen(false)} wide><div className="segmented-control">{([['local_path', '本机目录'], ['workspace_path', '项目目录'], ['inline_markdown', '粘贴内容']] as const).map(([value, label]) => <button key={value} className={mode === value ? 'active' : ''} onClick={() => changeMode(value)}>{label}</button>)}</div>{mode === 'inline_markdown' ? <><label className="settings-field"><span>Skill 名称</span><input value={name} onChange={(event) => { setName(event.target.value); setReport(null); }} /></label><label className="settings-field"><span>SKILL.md 内容</span><textarea rows={12} value={content} onChange={(event) => { setContent(event.target.value); setReport(null); }} spellCheck={false} /></label></> : <label className="settings-field"><span>{mode === 'local_path' ? '本机绝对路径' : '项目内路径'}</span><input value={path} onChange={(event) => { setPath(event.target.value); setReport(null); }} placeholder={mode === 'local_path' ? 'D:\\skills\\my-skill' : '.aicoding/skills/my-skill'} /></label>}{preview.error ? <p className="dialog-error">{preview.error instanceof Error ? preview.error.message : '预检查失败'}</p> : null}{report ? <section className="skill-import-report"><div><strong>{report.recognized ? '已识别' : '无法识别'}：{report.name || '未命名'}</strong><p>{report.description}</p></div><dl><dt>格式</dt><dd>{report.format}</dd><dt>目标位置</dt><dd>{report.targetPath}</dd><dt>需要能力</dt><dd>{report.requiredCapabilities.join('、') || '无'}</dd><dt>缺失能力</dt><dd>{report.missingCapabilities.join('、') || '无'}</dd><dt>资源</dt><dd>{report.resources.join('、') || '无'}</dd><dt>脚本</dt><dd>{report.scripts.join('、') || '无'}</dd></dl>{report.warnings.length ? <p className="dialog-warning">{report.warnings.join('；')}</p> : null}{report.conflicts.length ? <p className="dialog-error">冲突：{report.conflicts.join('；')}</p> : null}</section> : null}<footer className="dialog-actions"><button className="secondary-button" onClick={() => preview.mutate()} disabled={preview.isPending}>{preview.isPending ? '识别中…' : '预检查'}</button><button className="primary-button" onClick={() => importSkill.mutate()} disabled={!report?.recognized || Boolean(report.conflicts.length) || importSkill.isPending}>{importSkill.isPending ? '导入中…' : '确认导入'}</button></footer></SettingsDialog> : null}
  </>;
}
