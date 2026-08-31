import {
  MANAGED_MEMORY_LIMITS,
  MANAGED_MEMORY_TYPES,
  type ManagedMemoryActor,
  type ManagedMemoryType,
} from './contracts.ts';
import type { ManagedMemoryStore } from './store.ts';
import { ManagedMemoryValidationError } from './format.ts';

export const MEMORY_TOOL_NAMES = [
  'memory_list',
  'memory_read',
  'memory_search',
  'memory_upsert',
  'memory_remove',
] as const;

export const MEMORY_AGENT_TOOL_POLICY = {
  allow: [...MEMORY_TOOL_NAMES],
  allowExternalMcp: false,
  allowSkills: false,
} as const;

export const MEMORY_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'memory_list',
      description: '列出当前 Workspace 自动记忆的有界 topic manifest，用于查重和定位。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'memory_read',
      description: '分页读取 MEMORY.md 或一个自动记忆 topic，返回 digest 供安全更新。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
        required: ['path'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'memory_search',
      description: '在当前 Workspace 的自动记忆 topic 中做安全的 literal 文本搜索。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          type: { type: 'string', enum: [...MANAGED_MEMORY_TYPES] },
          maxResults: { type: 'number' },
        },
        required: ['query'], additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'memory_upsert',
      description: '原子创建或更新一个语义 topic，并同步 MEMORY.md 索引。新建传 expectedDigest:null；更新传最新 digest。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
          type: { type: 'string', enum: [...MANAGED_MEMORY_TYPES] }, body: { type: 'string' },
          indexTitle: { type: 'string' }, indexHook: { type: 'string' },
          expectedDigest: { type: ['string', 'null'] }, operationId: { type: 'string' },
        },
        required: ['path', 'name', 'description', 'type', 'body', 'indexTitle', 'indexHook', 'expectedDigest', 'operationId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'memory_remove',
      description: '按最新 digest 删除一个自动记忆 topic 并同步移除索引指针。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, expectedDigest: { type: 'string' }, reason: { type: 'string' }, operationId: { type: 'string' } },
        required: ['path', 'expectedDigest', 'reason', 'operationId'], additionalProperties: false,
      },
    },
  },
];

export type ManagedMemoryToolContext = {
  workspaceId: string;
  actor: ManagedMemoryActor;
  generation: number;
  runId?: string;
  sessionId?: string;
};

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new ManagedMemoryValidationError(`${name} is required`);
  return value;
}

export function createManagedMemoryToolExecutor(store: ManagedMemoryStore) {
  return async function execute(toolName: string, args: Record<string, unknown>, context: ManagedMemoryToolContext): Promise<unknown> {
    const settings = await store.settings();
    if (!settings.enabled) return { error: 'Managed memory is disabled', code: 'MEMORY_DISABLED' };
    if (settings.generation !== context.generation) return { error: 'Memory generation changed', code: 'MEMORY_GENERATION_CHANGED' };
    if (toolName === 'memory_list') {
      const memories = await store.scan(context.workspaceId);
      return { memories, count: memories.length, truncated: memories.length >= MANAGED_MEMORY_LIMITS.maxTopics };
    }
    if (toolName === 'memory_read') {
      const path = stringArg(args, 'path');
      const offset = typeof args.offset === 'number' ? Math.max(0, Math.floor(args.offset)) : 0;
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(MANAGED_MEMORY_LIMITS.maxReadBytes, Math.floor(args.limit))) : MANAGED_MEMORY_LIMITS.maxReadBytes;
      if (path === 'MEMORY.md') return store.readIndex(context.workspaceId);
      return store.readTopic(context.workspaceId, path, { offset, maxBytes: limit });
    }
    if (toolName === 'memory_search') {
      const type = typeof args.type === 'string' && MANAGED_MEMORY_TYPES.includes(args.type as ManagedMemoryType) ? args.type : undefined;
      const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 20;
      return { results: await store.search(context.workspaceId, stringArg(args, 'query'), type, maxResults) };
    }
    if (toolName === 'memory_upsert') {
      const expectedDigest = args.expectedDigest;
      if (expectedDigest !== null && typeof expectedDigest !== 'string') throw new ManagedMemoryValidationError('expectedDigest must be string or null');
      return store.upsert({
        workspaceId: context.workspaceId, actor: context.actor,
        path: stringArg(args, 'path'), name: stringArg(args, 'name'), description: stringArg(args, 'description'),
        type: stringArg(args, 'type') as ManagedMemoryType, body: stringArg(args, 'body'),
        indexTitle: stringArg(args, 'indexTitle'), indexHook: stringArg(args, 'indexHook'),
        expectedDigest, operationId: stringArg(args, 'operationId'),
        ...(context.runId ? { runId: context.runId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        expectedGeneration: context.generation,
      });
    }
    if (toolName === 'memory_remove') {
      return store.remove({
        workspaceId: context.workspaceId, actor: context.actor, path: stringArg(args, 'path'), expectedDigest: stringArg(args, 'expectedDigest'),
        reason: stringArg(args, 'reason'), operationId: stringArg(args, 'operationId'),
        ...(context.runId ? { runId: context.runId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        expectedGeneration: context.generation,
      });
    }
    return { error: `unknown memory tool: ${toolName}` };
  };
}

export function isMemoryTool(name: string): name is typeof MEMORY_TOOL_NAMES[number] {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(name);
}
