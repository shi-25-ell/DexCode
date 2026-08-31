import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { listCapabilities } from '../api';
import { AppShell } from '../shell/app-shell';
import type { CapabilityId, ConversationScope } from '../types';
import { McpPanel } from './mcp-panel';
import { ProjectKnowledgePanel } from './project-knowledge-panel';
import { SkillsPanel } from './skills-panel';
import { ToolsPanel } from './tools-panel';
import { ApprovalModePanel } from './approval-mode-panel';
import { MemoryPanel } from './memory-panel';

type CapabilityPanelProps = { workspaceRef?: string };

const CAPABILITY_PANELS: Record<CapabilityId, ComponentType<CapabilityPanelProps>> = {
  mcp: () => <McpPanel />,
  tools: ({ workspaceRef }) => <ToolsPanel workspaceRef={workspaceRef!} />,
  skills: ({ workspaceRef }) => <SkillsPanel workspaceRef={workspaceRef!} />,
  approval: ({ workspaceRef }) => <ApprovalModePanel workspaceRef={workspaceRef} />,
  'project-knowledge': ({ workspaceRef }) => <ProjectKnowledgePanel workspaceRef={workspaceRef!} />,
  memory: ({ workspaceRef }) => <MemoryPanel workspaceRef={workspaceRef!} />,
};

function WorkspaceRequired() {
  return <div className="settings-empty"><h2>需要先加载项目</h2><p>这项能力属于项目作用域。请返回对话页，在左侧输入或选择项目绝对路径。</p><Link className="primary-link" to="/">返回首页</Link></div>;
}

export function SettingsPage({ capabilityId }: { capabilityId: string }) {
  const [params] = useSearchParams();
  const workspaceRef = params.get('workspaceRef') || undefined;
  const scope: ConversationScope = workspaceRef ? { kind: 'workspace', workspaceRef } : { kind: 'general' };
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: listCapabilities });
  const capability = capabilities.data?.find((item) => item.id === capabilityId);
  const returnTo = params.get('returnTo') || (workspaceRef ? `/w/${encodeURIComponent(workspaceRef)}/new` : '/');
  let content: ReactNode;
  if (capabilities.isError) content = <div className="settings-empty"><h2>能力中心加载失败</h2><p>{capabilities.error instanceof Error ? capabilities.error.message : '请稍后重试'}</p></div>;
  else if (!capability && !capabilities.isLoading) content = <div className="settings-empty"><h2>这项能力没有启用</h2><p>它可能已经从能力注册表中删除或被配置禁用。</p></div>;
  else if (capability?.workspaceRequired && !workspaceRef) content = <WorkspaceRequired />;
  else if (capability) {
    const CapabilityPanel = CAPABILITY_PANELS[capability.id];
    content = <CapabilityPanel workspaceRef={workspaceRef} />;
  } else content = <div className="settings-empty">正在加载…</div>;
  return <AppShell scope={scope} title={capability?.label ?? '能力设置'}><div className="settings-scroll"><div className="settings-page"><Link className="back-link" to={returnTo}><ArrowLeft size={16} />返回对话</Link>{content}</div></div></AppShell>;
}
