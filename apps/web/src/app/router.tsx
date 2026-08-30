import { lazy, Suspense } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { ConversationPage } from '../conversation/conversation-page';

const SettingsPage = lazy(() => import('../settings/settings-page').then((module) => ({ default: module.SettingsPage })));

export function GeneralConversationRoute() {
  const { conversationRef } = useParams();
  return <ConversationPage scope={{ kind: 'general' }} conversationRef={conversationRef} />;
}

export function WorkspaceConversationRoute() {
  const { workspaceRef, conversationRef } = useParams();
  if (!workspaceRef) return <Navigate to="/" replace />;
  return <ConversationPage scope={{ kind: 'workspace', workspaceRef }} conversationRef={conversationRef} />;
}

export function SettingsRoute() {
  const { capabilityId } = useParams();
  if (!capabilityId) return <Navigate to="/" replace />;
  return <Suspense fallback={<div className="route-loading">正在加载能力页面…</div>}><SettingsPage capabilityId={capabilityId} /></Suspense>;
}
