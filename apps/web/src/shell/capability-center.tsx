import * as Tooltip from '@radix-ui/react-tooltip';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { listCapabilities, scopeWorkspaceRef } from '../api';
import { capabilityIcons } from '../shared/icons';
import type { ConversationScope } from '../types';

export function CapabilityCenter({ scope, closeMobile }: { scope: ConversationScope; closeMobile?: () => void }) {
  const location = useLocation();
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: listCapabilities, staleTime: 60_000 });
  const workspaceRef = scopeWorkspaceRef(scope);
  const returnTo = encodeURIComponent(location.pathname + location.search);
  return (
    <section className="capability-zone" aria-label="能力中心">
      <div className="sidebar-section-heading"><span>能力中心</span></div>
      <div className="capability-grid">
        {capabilities.isLoading ? Array.from({ length: 6 }, (_, index) => <span className="capability-skeleton" key={index} />) : null}
        {capabilities.isError ? <button className="capability-retry" onClick={() => void capabilities.refetch()}>能力加载失败，点击重试</button> : null}
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
                  <Icon size={15} strokeWidth={1.7} />
                  <span>{capability.label}</span>
                </Link>
              </Tooltip.Trigger>
              {unavailable ? <Tooltip.Portal><Tooltip.Content className="tooltip-content">加载项目后可使用<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal> : null}
            </Tooltip.Root>
          );
        })}
      </div>
    </section>
  );
}
