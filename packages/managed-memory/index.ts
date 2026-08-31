import type { ModelClient } from '../llm-client/index.ts';
import type { MemorySelector } from './contracts.ts';
import { createManagedMemoryCoordinator, parseManagedMemoryMode } from './coordinator.ts';
import { createModelMemorySelector } from './recall.ts';
import { createManagedMemoryStore } from './store.ts';

export function createManagedMemorySystem(options: {
  workspaceId: string;
  workspaceStateDir: string;
  modelClient: ModelClient;
  selector?: MemorySelector;
  environment?: Record<string, string | undefined>;
  clock?: () => Date;
  observe?: (event: Record<string, unknown>) => void;
}) {
  const store = createManagedMemoryStore({ workspaceId: options.workspaceId, workspaceStateDir: options.workspaceStateDir, clock: options.clock });
  const coordinator = createManagedMemoryCoordinator({
    workspaceId: options.workspaceId,
    mode: parseManagedMemoryMode(options.environment),
    store,
    selector: options.selector ?? createModelMemorySelector(options.modelClient),
    now: options.clock,
    observe: options.observe,
  });
  return { ...coordinator, store };
}

export * from './contracts.ts';
export * from './format.ts';
export * from './paths.ts';
export * from './prompt.ts';
export * from './recall.ts';
export * from './store.ts';
export * from './tools.ts';
export * from './coordinator.ts';
