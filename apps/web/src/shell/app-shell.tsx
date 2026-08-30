import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Menu, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiJson, resolveWorkspace, scopeWorkspaceRef } from '../api';
import type { ConversationScope } from '../types';
import { BrandIcon } from '../shared/brand-icon';
import { CapabilityCenter } from './capability-center';
import { ConversationHistory } from './conversation-history';
import { WorkspacePicker } from './workspace-picker';

type Meta = {
  appName: string;
  model: { displayName: string; contextWindow?: number };
  workspace: { ref: string; displayName: string; canonicalPath: string };
};

export type AppShellProps = {
  scope: ConversationScope;
  conversationRef?: string;
  title: string;
  status?: 'idle' | 'running' | 'waiting' | 'failed';
  children: ReactNode;
};

function SidebarContent({ scope, conversationRef, closeMobile }: { scope: ConversationScope; conversationRef?: string; closeMobile?: () => void }) {
  const navigate = useNavigate();
  const [path, setPath] = useState('');
  const [pathError, setPathError] = useState('');
  const [loadingPath, setLoadingPath] = useState(false);
  const workspaceRef = scopeWorkspaceRef(scope);
  const meta = useQuery({
    queryKey: ['meta', workspaceRef],
    queryFn: () => apiJson<Meta>('/api/meta', { workspaceRef }),
    enabled: scope.kind === 'workspace',
  });

  useEffect(() => {
    if (scope.kind === 'general') setPath('');
    else if (meta.data?.workspace.canonicalPath) setPath(meta.data.workspace.canonicalPath);
  }, [meta.data?.workspace.canonicalPath, scope.kind]);

  const submitWorkspace = async (nextPath: string): Promise<boolean> => {
    if (!nextPath) {
      navigate('/');
      closeMobile?.();
      return true;
    }
    setLoadingPath(true);
    setPathError('');
    try {
      const workspace = await resolveWorkspace(nextPath);
      navigate(`/w/${encodeURIComponent(workspace.workspaceRef)}/new`);
      closeMobile?.();
      return true;
    } catch (error) {
      setPathError(error instanceof Error ? error.message : '项目加载失败');
      return false;
    } finally {
      setLoadingPath(false);
    }
  };

  return (
    <div className="sidebar-content">
      <div className="brand-row">
        <BrandIcon />
        <span className="brand-name">DexCode</span>
      </div>
      <WorkspacePicker value={path} loading={loadingPath} error={pathError} onChange={setPath} onResolve={submitWorkspace} />
      <ConversationHistory
        scope={scope}
        conversationRef={conversationRef}
        heading={scope.kind === 'general' ? '首页会话' : meta.data?.workspace.displayName ?? '当前项目'}
        closeMobile={closeMobile}
      />
      <CapabilityCenter scope={scope} closeMobile={closeMobile} />
    </div>
  );
}

export function AppShell({ scope, conversationRef, title, status = 'idle', children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const dragging = useRef(false);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragging.current) return;
      setSidebarWidth(Math.max(248, Math.min(360, event.clientX)));
    };
    const stop = () => { dragging.current = false; document.body.classList.remove('resizing'); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
  }, []);

  const shellStyle = { '--sidebar-width': `${collapsed ? 52 : sidebarWidth}px` } as CSSProperties;
  return (
    <Tooltip.Provider delayDuration={350}>
      <div className={collapsed ? 'app-shell sidebar-collapsed' : 'app-shell'} style={shellStyle}>
        <aside className="desktop-sidebar">
          {collapsed ? (
            <div className="collapsed-rail">
              <BrandIcon />
              <button aria-label="展开侧边栏" onClick={() => setCollapsed(false)}><ChevronLeft className="flip" size={18} /></button>
            </div>
          ) : <SidebarContent scope={scope} conversationRef={conversationRef} />}
          {!collapsed ? (
            <>
              <button className="collapse-sidebar" onClick={() => setCollapsed(true)}><ChevronLeft size={16} /> 收起侧边栏</button>
              <button
                className="sidebar-resizer"
                aria-label="调整侧边栏宽度"
                onPointerDown={() => { dragging.current = true; document.body.classList.add('resizing'); }}
              />
            </>
          ) : null}
        </aside>

        <main className="main-panel">
          <header className="conversation-header">
            <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
              <Dialog.Trigger asChild><button className="mobile-menu" aria-label="打开侧边栏"><Menu size={19} /></button></Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="drawer-overlay" />
                <Dialog.Content className="drawer-content">
                  <Dialog.Title className="sr-only">导航</Dialog.Title>
                  <Dialog.Close asChild><button className="drawer-close" aria-label="关闭侧边栏"><X size={19} /></button></Dialog.Close>
                  <SidebarContent scope={scope} conversationRef={conversationRef} closeMobile={() => setMobileOpen(false)} />
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
            <div className="header-title-wrap">
              <h1>{title}</h1>
              <span className={`header-status ${status}`}><i />{status === 'running' ? '运行中' : status === 'waiting' ? '等待确认' : status === 'failed' ? '未完成' : '就绪'}</span>
            </div>
          </header>
          {children}
        </main>
      </div>
    </Tooltip.Provider>
  );
}
