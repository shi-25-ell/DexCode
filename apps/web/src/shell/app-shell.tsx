import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Menu, MoreVertical, Plus, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { apiJson, listCapabilities, listConversations, resolveWorkspace, scopeWorkspaceRef } from '../api';
import type { ConversationScope } from '../types';
import { BrandIcon } from '../shared/brand-icon';
import { capabilityIcons } from '../shared/icons';

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

function routeForConversation(scope: ConversationScope, ref?: string): string {
  if (scope.kind === 'general') return ref ? `/c/${encodeURIComponent(ref)}` : '/';
  return ref ? `/w/${encodeURIComponent(scope.workspaceRef)}/c/${encodeURIComponent(ref)}` : `/w/${encodeURIComponent(scope.workspaceRef)}/new`;
}

function SidebarContent({ scope, conversationRef, closeMobile }: { scope: ConversationScope; conversationRef?: string; closeMobile?: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [path, setPath] = useState('');
  const [pathError, setPathError] = useState('');
  const [loadingPath, setLoadingPath] = useState(false);
  const workspaceRef = scopeWorkspaceRef(scope);
  const meta = useQuery({
    queryKey: ['meta', workspaceRef],
    queryFn: () => apiJson<Meta>('/api/meta', { workspaceRef }),
    enabled: scope.kind === 'workspace',
  });
  const conversations = useQuery({
    queryKey: ['conversations', scope],
    queryFn: () => listConversations(scope),
  });
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: listCapabilities, staleTime: 60_000 });

  useEffect(() => {
    if (scope.kind === 'general') setPath('');
    else if (meta.data?.workspace.canonicalPath) setPath(meta.data.workspace.canonicalPath);
  }, [meta.data?.workspace.canonicalPath, scope.kind]);

  const submitWorkspace = async () => {
    if (!path.trim()) {
      navigate('/');
      closeMobile?.();
      return;
    }
    setLoadingPath(true);
    setPathError('');
    try {
      const workspace = await resolveWorkspace(path.trim());
      navigate(`/w/${encodeURIComponent(workspace.workspaceRef)}/new`);
      closeMobile?.();
    } catch (error) {
      setPathError(error instanceof Error ? error.message : '项目加载失败');
    } finally {
      setLoadingPath(false);
    }
  };

  const returnTo = encodeURIComponent(location.pathname + location.search);
  return (
    <div className="sidebar-content">
      <div className="brand-row">
        <BrandIcon />
        <span className="brand-name">DexCode</span>
      </div>
      <form className="workspace-form" onSubmit={(event) => { event.preventDefault(); void submitWorkspace(); }}>
        <input
          aria-label="项目绝对路径"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="输入项目绝对路径"
          spellCheck={false}
        />
        <button type="submit" disabled={loadingPath}>{loadingPath ? '加载中' : '加载'}</button>
      </form>
      {pathError ? <p className="inline-error">{pathError}</p> : null}

      <div className="sidebar-section-heading">
        <span>{scope.kind === 'general' ? '首页会话' : meta.data?.workspace.displayName ?? '当前项目'}</span>
      </div>
      <nav className="conversation-list" aria-label="历史会话">
        {conversations.isLoading ? <div className="sidebar-muted">正在加载会话…</div> : null}
        {conversations.data?.map((conversation) => (
          <Link
            key={conversation.ref}
            to={routeForConversation(scope, conversation.ref)}
            className={conversation.ref === conversationRef ? 'conversation-link selected' : 'conversation-link'}
            onClick={closeMobile}
            title={conversation.title}
          >
            <span className={`conversation-state ${conversation.state}`} aria-hidden="true" />
            <span>{conversation.title}</span>
          </Link>
        ))}
        {!conversations.isLoading && conversations.data?.length === 0 ? <div className="sidebar-muted">还没有历史会话</div> : null}
      </nav>
      <button className="new-conversation" onClick={() => { navigate(routeForConversation(scope)); closeMobile?.(); }}>
        <Plus size={17} />
        新建会话
      </button>

      <div className="capability-zone">
        <div className="sidebar-section-heading"><span>能力中心</span></div>
        <div className="capability-grid">
          {capabilities.data?.map((capability) => {
            const Icon = capabilityIcons[capability.icon];
            const unavailable = capability.workspaceRequired && scope.kind === 'general';
            const href = `${capability.route}?${workspaceRef ? `workspaceRef=${encodeURIComponent(workspaceRef)}&` : ''}returnTo=${returnTo}`;
            return (
              <Tooltip.Root key={capability.id}>
                <Tooltip.Trigger asChild>
                  <Link
                    to={href}
                    className={unavailable ? 'capability-link unavailable' : 'capability-link'}
                    onClick={closeMobile}
                    aria-label={unavailable ? `${capability.label}，需要先加载项目` : capability.label}
                  >
                    <Icon size={17} strokeWidth={1.7} />
                    <span>{capability.label}</span>
                  </Link>
                </Tooltip.Trigger>
                {unavailable ? <Tooltip.Portal><Tooltip.Content className="tooltip-content">加载项目后可使用<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal> : null}
              </Tooltip.Root>
            );
          })}
        </div>
      </div>
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
            <button className="icon-button" aria-label="更多操作"><MoreVertical size={19} /></button>
          </header>
          {children}
        </main>
      </div>
    </Tooltip.Provider>
  );
}
