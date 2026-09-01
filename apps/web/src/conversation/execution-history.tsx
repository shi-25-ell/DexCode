import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown } from 'lucide-react';
import { type ReactNode, useState } from 'react';

export function ExecutionHistoryDisclosure({
  children,
  itemCount,
  label = '执行过程',
  defaultOpen = false,
  className = '',
}: {
  children: ReactNode;
  itemCount: number;
  label?: string;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={`execution-history ${className}`.trim()}>
      <Collapsible.Trigger className="execution-history-trigger" aria-label={`${open ? '收起' : '展开'}${label}`}>
        <span>{label}</span>
        <small>{itemCount} 项</small>
        <ChevronDown className={open ? 'chevron open' : 'chevron'} size={15} />
      </Collapsible.Trigger>
      <Collapsible.Content className="execution-history-content">
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
