import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Download, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { conversationExportUrl, deleteConversation, listConversations, updateConversation } from '../api';
import type { ConversationListItem, ConversationScope } from '../types';

export function routeForConversation(scope: ConversationScope, ref?: string): string {
  if (scope.kind === 'general') return ref ? `/c/${encodeURIComponent(ref)}` : '/';
  return ref ? `/w/${encodeURIComponent(scope.workspaceRef)}/c/${encodeURIComponent(ref)}` : `/w/${encodeURIComponent(scope.workspaceRef)}/new`;
}

function ConversationActions({
  conversation,
  scope,
  selected,
  afterNavigate,
}: {
  conversation: ConversationListItem;
  scope: ConversationScope;
  selected: boolean;
  afterNavigate?: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => client.invalidateQueries({ queryKey: ['conversations', scope] });
  const update = useMutation({
    mutationFn: (meta: { title?: string; archived?: boolean }) => updateConversation(scope, conversation.ref, meta),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => deleteConversation(scope, conversation.ref),
    onSuccess: async () => {
      await refresh();
      if (selected) navigate(routeForConversation(scope));
      afterNavigate?.();
    },
  });
  const rename = () => {
    const title = window.prompt('输入新的会话标题', conversation.title)?.trim();
    if (title && title !== conversation.title) update.mutate({ title });
  };
  const archive = () => update.mutate({ archived: !conversation.archived });
  const deleteSelected = () => {
    if (window.confirm(`确定删除“${conversation.title}”吗？此操作无法撤销。`)) remove.mutate();
  };
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="conversation-menu-trigger" aria-label={`管理会话：${conversation.title}`} onClick={(event) => event.stopPropagation()}>
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="conversation-menu" sideOffset={5} align="start">
          <DropdownMenu.Item onSelect={rename}><Pencil size={14} />重命名</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={archive}><Archive size={14} />{conversation.archived ? '取消归档' : '归档'}</DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <a href={conversationExportUrl(scope, conversation.ref)} download={`${conversation.ref}.jsonl`}><Download size={14} />导出</a>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item className="danger" onSelect={deleteSelected}><Trash2 size={14} />删除</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ConversationHistory({
  scope,
  conversationRef,
  heading,
  closeMobile,
}: {
  scope: ConversationScope;
  conversationRef?: string;
  heading: string;
  closeMobile?: () => void;
}) {
  const navigate = useNavigate();
  const conversations = useQuery({
    queryKey: ['conversations', scope],
    queryFn: () => listConversations(scope),
  });
  return (
    <section className="sidebar-history">
      <div className="sidebar-section-heading"><span>{heading}</span></div>
      <nav className="conversation-list" aria-label="历史会话">
        {conversations.isLoading ? <div className="sidebar-muted">正在加载会话…</div> : null}
        {conversations.isError ? <div className="sidebar-muted error">会话加载失败，请稍后重试</div> : null}
        {conversations.data?.map((conversation) => (
          <div className={conversation.archived ? 'conversation-entry archived' : 'conversation-entry'} key={conversation.ref}>
            <Link
              to={routeForConversation(scope, conversation.ref)}
              className={conversation.ref === conversationRef ? 'conversation-link selected' : 'conversation-link'}
              onClick={closeMobile}
              title={conversation.title}
            >
              <span className={`conversation-state ${conversation.state}`} aria-hidden="true" />
              <span>{conversation.title}</span>
            </Link>
            <ConversationActions
              conversation={conversation}
              scope={scope}
              selected={conversation.ref === conversationRef}
              afterNavigate={closeMobile}
            />
          </div>
        ))}
        {!conversations.isLoading && conversations.data?.length === 0 ? <div className="sidebar-muted">还没有历史会话</div> : null}
      </nav>
      <button className="new-conversation" onClick={() => { navigate(routeForConversation(scope)); closeMobile?.(); }}>
        <Plus size={17} />
        新建会话
      </button>
    </section>
  );
}
