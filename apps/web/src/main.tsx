import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { GeneralConversationRoute, SettingsRoute, WorkspaceConversationRoute } from './app/router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<GeneralConversationRoute />} />
          <Route path="/c/:conversationRef" element={<GeneralConversationRoute />} />
          <Route path="/w/:workspaceRef/new" element={<WorkspaceConversationRoute />} />
          <Route path="/w/:workspaceRef/c/:conversationRef" element={<WorkspaceConversationRoute />} />
          <Route path="/settings/:capabilityId" element={<SettingsRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
