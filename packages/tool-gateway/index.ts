import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TreeNode, WorkspaceFile } from '../workspace-manager/index.ts';
import type { ToolInfo } from '../shared/types.ts';
import { createMcpServer, type McpServer } from '../mcp-server/index.ts';
import { validateCommand } from './command-safety.ts';
import { createCommandWhitelistStore } from './command-whitelist-store.ts';
import {
  executeCommand,
  type CommandConfirmHook,
  type RunCommandResult,
} from './run-command.ts';
import { diffFileAgainstSnapshot } from './diff-file.ts';
import { readLints } from './read-lints.ts';
import { createToolCallLogStore } from './tool-call-log.ts';

export type { CommandConfirmHook, CommandConfirmDecision, CommandConfirmRequest } from './run-command.ts';
export type { WhitelistEntry, CommandRisk } from './command-safety.ts';
export type { CommandWhitelistStore } from './command-whitelist-store.ts';

type WorkspaceService = {
  rootDir: string;
  projectId: string;
  projectDir: string;
  getRootDir: () => string;
  findFile: (path: string) => WorkspaceFile | null;
  updateFile: (path: string, content: string) => Promise<unknown>;
  listTree: () => TreeNode[];
  listFiles: () => WorkspaceFile[];
  searchInWorkspace: (query: string, path?: string) => unknown[];
  patchFile: (path: string, patch: string) => Promise<unknown> | unknown;
  listVersions: () => Promise<unknown[]>;
  createSnapshot: (name?: string, description?: string) => Promise<unknown>;
  restoreSnapshot: (snapshotId: string) => Promise<unknown>;
  loadFromDisk: () => Promise<unknown>;
};

function buildInputSchema(properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

type RunCommandContext = {
  onCommandConfirm?: CommandConfirmHook;
};

function buildToolDefinitions(
  workspaceService: WorkspaceService,
  runCommandSafe: (command: string, ctx?: RunCommandContext) => Promise<RunCommandResult>,
  readLintsFn: (path?: string) => Promise<unknown>,
  diffFileFn: (path: string, snapshotId?: string) => Promise<unknown>,
) {
  return [
    {
      name: 'read_file',
      description: '读取工作区中的文件内容',
      inputSchema: buildInputSchema({ path: { type: 'string', minLength: 1 } }, ['path']),
      handler: async ({ path }: Record<string, unknown>) => {
        const rootDir = workspaceService.getRootDir();
        const absPath = resolve(join(rootDir, String(path ?? '')));
        if (!absPath.startsWith(resolve(rootDir))) return null;
        try {
          const content = await readFile(absPath, 'utf8');
          return { path, content };
        } catch {
          return null;
        }
      },
    },
    {
      name: 'write_file',
      description: '写入工作区中的文件内容',
      inputSchema: buildInputSchema(
        {
          path: { type: 'string', minLength: 1 },
          content: { type: 'string' },
        },
        ['path', 'content'],
      ),
      handler: ({ path, content }: Record<string, unknown>) => workspaceService.updateFile(String(path ?? ''), String(content ?? '')),
    },
    {
      name: 'patch_file',
      description:
        '局部替换文件。支持 unified diff、before\\n---\\nafter、before => after、@@ line N 行号锚点。失败时先 read_file。',
      inputSchema: buildInputSchema(
        {
          path: { type: 'string', minLength: 1 },
          patch: { type: 'string', minLength: 1 },
        },
        ['path', 'patch'],
      ),
      handler: ({ path, patch }: Record<string, unknown>) => workspaceService.patchFile(String(path ?? ''), String(patch ?? '')),
    },
    {
      name: 'search_in_workspace',
      description: '在工作区中搜索文本或代码片段',
      inputSchema: buildInputSchema(
        {
          query: { type: 'string', minLength: 1 },
          path: { type: 'string' },
          limit: { type: 'number', minimum: 1, maximum: 100 },
        },
        ['query'],
      ),
      handler: ({ query, path, limit }: Record<string, unknown>) => {
        const hits = workspaceService.searchInWorkspace(String(query ?? ''), path ? String(path) : undefined);
        const max = typeof limit === 'number' ? Math.max(1, Math.min(100, Math.floor(limit))) : hits.length;
        return hits.slice(0, max);
      },
    },
    {
      name: 'run_command',
      description:
        '在工作区目录执行 shell 命令。非白名单命令会暂停并等待用户确认（类似 Cursor）。安装依赖、删除文件等高风险操作需用户批准。',
      inputSchema: buildInputSchema(
        {
          command: { type: 'string', minLength: 1 },
        },
        ['command'],
      ),
      handler: ({ command }: Record<string, unknown>) =>
        runCommandSafe(String(command ?? '')),
    },
    {
      name: 'read_lints',
      description:
        '读取工作区或指定文件的静态检查问题（TypeScript tsc、启发式规则）。只读，无需命令确认。复杂 lint 脚本请用 run_command。',
      inputSchema: buildInputSchema(
        {
          path: { type: 'string', description: '相对工作区的文件路径，省略则检查整个项目' },
        },
        [],
      ),
      handler: ({ path }: Record<string, unknown>) =>
        readLintsFn(path ? String(path) : undefined),
    },
    {
      name: 'diff_file',
      description:
        '对比指定文件与版本快照中的内容，返回增删行。默认与最新快照对比；可传 snapshotId。',
      inputSchema: buildInputSchema(
        {
          path: { type: 'string', minLength: 1 },
          snapshotId: { type: 'string' },
        },
        ['path'],
      ),
      handler: ({ path, snapshotId }: Record<string, unknown>) =>
        diffFileFn(String(path ?? ''), snapshotId ? String(snapshotId) : undefined),
    },
    {
      name: 'list_workspace',
      description: '列出当前工作区文件树',
      inputSchema: buildInputSchema(
        {
          depth: { type: 'number', minimum: 1, maximum: 20 },
        },
        [],
      ),
      handler: ({ depth }: Record<string, unknown>) => {
        const tree = workspaceService.listTree();
        if (typeof depth !== 'number') return tree;
        const maxDepth = Math.max(1, Math.min(20, Math.floor(depth)));
        const trim = (nodes: TreeNode[], currentDepth = 1): TreeNode[] =>
          nodes.map((node) =>
            node.type === 'folder'
              ? { ...node, children: currentDepth >= maxDepth ? [] : trim(node.children ?? [], currentDepth + 1) }
              : node,
          );
        return trim(tree);
      },
    },
    {
      name: 'list_versions',
      description: '列出当前工作区的版本快照',
      inputSchema: buildInputSchema({}, []),
      handler: () => workspaceService.listVersions(),
    },
    {
      name: 'create_snapshot',
      description: '为当前工作区创建一个可回滚的版本快照',
      inputSchema: buildInputSchema(
        {
          name: { type: 'string' },
          description: { type: 'string' },
        },
        [],
      ),
      handler: ({ name, description }: Record<string, unknown>) =>
        workspaceService.createSnapshot(String(name ?? ''), String(description ?? '')),
    },
    {
      name: 'restore_snapshot',
      description: '从指定版本快照恢复当前工作区',
      inputSchema: buildInputSchema(
        {
          snapshotId: { type: 'string', minLength: 1 },
        },
        ['snapshotId'],
      ),
      handler: ({ snapshotId }: Record<string, unknown>) => workspaceService.restoreSnapshot(String(snapshotId ?? '')),
    },
  ];
}

function buildResourceDefinitions(workspaceService: WorkspaceService) {
  return [
    {
      name: 'workspace_tree',
      description: '当前工作区文件树',
      uri: 'mcp://workspace/tree',
      mimeType: 'application/json',
      handler: () => workspaceService.listTree(),
    },
    {
      name: 'workspace_files',
      description: '当前工作区文件列表',
      uri: 'mcp://workspace/files',
      mimeType: 'application/json',
      handler: () => workspaceService.listFiles(),
    },
    {
      name: 'workspace_meta',
      description: '工作区元信息',
      uri: 'mcp://workspace/meta',
      mimeType: 'application/json',
      handler: () => ({ projectId: workspaceService.projectId, rootDir: workspaceService.getRootDir() }),
    },
  ];
}

function buildPromptDefinitions() {
  return [
    {
      name: 'patch_file_prompt',
      description: '生成局部补丁的提示词模板',
      inputSchema: buildInputSchema(
        {
          filePath: { type: 'string', minLength: 1 },
          before: { type: 'string', minLength: 1 },
          after: { type: 'string', minLength: 1 },
        },
        ['filePath', 'before', 'after'],
      ),
      handler: ({ filePath, before, after }: Record<string, unknown>) => ({
        messages: [
          {
            role: 'system',
            content: '你是代码补丁助手，只输出可直接用于 patch_file 的内容。',
          },
          {
            role: 'user',
            content: JSON.stringify({ filePath, before, after }, null, 2),
          },
        ],
      }),
    },
  ];
}

export function createCodingToolHost(workspaceService: WorkspaceService) {
  const whitelistStore = createCommandWhitelistStore(workspaceService.projectDir);
  const cwd = () => workspaceService.getRootDir();

  async function runCommandSafe(
    command: string,
    ctx: RunCommandContext = {},
  ): Promise<RunCommandResult> {
    const entries = await whitelistStore.list();
    const validation = validateCommand(command, entries);

    if (!validation.allowed) {
      return {
        command,
        status: 'blocked',
        error: validation.reason,
        risk: validation.risk,
      };
    }

    if (!validation.needsConfirmation) {
      const result = await executeCommand(validation.normalizedCommand, cwd(), validation.timeoutMs);
      return { ...result, risk: validation.risk, whitelisted: true };
    }

    if (!ctx.onCommandConfirm) {
      return {
        command,
        status: 'denied',
        error: '该命令需要用户确认，但当前没有可用的确认通道',
        risk: validation.risk,
      };
    }

    const decision = await ctx.onCommandConfirm({
      command: validation.normalizedCommand,
      cwd: cwd(),
      validation,
    });

    if (decision === 'deny') {
      return {
        command: validation.normalizedCommand,
        status: 'denied',
        error: '用户拒绝执行该命令',
        risk: validation.risk,
      };
    }

    if (decision === 'allow_whitelist') {
      await whitelistStore.addFromCommand(validation.normalizedCommand);
    }

    const result = await executeCommand(validation.normalizedCommand, cwd(), validation.timeoutMs);
    return {
      ...result,
      risk: validation.risk,
      confirmed: true,
      whitelisted: decision === 'allow_whitelist',
    };
  }

  const readLintsFn = (path?: string) =>
    readLints({ workspaceRoot: cwd(), path });

  const diffFileFn = (path: string, snapshotId?: string) =>
    diffFileAgainstSnapshot({
      path,
      workspaceRoot: cwd(),
      projectDir: workspaceService.projectDir,
      snapshotId,
      listVersions: async () => {
        const versions = await workspaceService.listVersions();
        return versions.map((v) => ({
          id: String((v as { id: string }).id),
          name: String((v as { name?: string }).name ?? (v as { id: string }).id),
          snapshotPath: String((v as { snapshotPath: string }).snapshotPath),
        }));
      },
    });

  const mcpServer: McpServer = createMcpServer({
    tools: buildToolDefinitions(workspaceService, runCommandSafe, readLintsFn, diffFileFn),
    resources: buildResourceDefinitions(workspaceService),
    prompts: buildPromptDefinitions(),
  });

  type ToolRecord = {
    name: string;
    description: string;
    source: 'local' | 'external';
    enabled: boolean;
    callCount: number;
    successCount: number;
    avgDurationMs: number;
    lastCalledAt: string | null;
    handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  };

  const toolRecords = new Map<string, ToolRecord>();
  const callLog = createToolCallLogStore();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function wrapWithStats(name: string, description: string, fn: (...args: any[]) => unknown | Promise<unknown>): (...args: any[]) => Promise<unknown> {
    const record: ToolRecord = {
      name,
      description,
      source: 'local',
      enabled: true,
      callCount: 0,
      successCount: 0,
      avgDurationMs: 0,
      lastCalledAt: null,
      handler: fn as (args: Record<string, unknown>) => unknown | Promise<unknown>,
    };
    toolRecords.set(name, record);

    return async (...args: unknown[]) => {
      if (!record.enabled) return { error: `工具 ${name} 已被禁用` };
      const start = Date.now();
      try {
        const result = await fn(...args);
        const duration = Date.now() - start;
        record.callCount++;
        callLog.append(name, args, result, duration);
        const ok =
          result &&
          typeof result === 'object' &&
          !(result as Record<string, unknown>).error &&
          (result as Record<string, unknown>).ok !== false &&
          (result as Record<string, unknown>).status !== 'failed' &&
          (result as Record<string, unknown>).status !== 'denied' &&
          (result as Record<string, unknown>).action !== 'patch_failed';
        if (ok) record.successCount++;
        record.avgDurationMs = record.avgDurationMs === 0 ? duration : Math.round(record.avgDurationMs * 0.9 + duration * 0.1);
        record.lastCalledAt = new Date().toISOString();
        return result;
      } catch (err) {
        const duration = Date.now() - start;
        record.callCount++;
        callLog.append(name, args, null, duration, err);
        record.avgDurationMs = record.avgDurationMs === 0 ? duration : Math.round(record.avgDurationMs * 0.9 + duration * 0.1);
        record.lastCalledAt = new Date().toISOString();
        throw err;
      }
    };
  }

  function registryIsToolEnabled(name: string): boolean {
    const record = toolRecords.get(name);
    if (!record) return true;
    return record.enabled;
  }

  function registryGetToolLogs(name: string, limit = 30) {
    return callLog.getLogs(name, limit);
  }

  function registryGetAllToolInfos(): ToolInfo[] {
    return [...toolRecords.values()].map(({ name, description, source, enabled, callCount, successCount, avgDurationMs, lastCalledAt }) => ({
      name, description, source, enabled, callCount, successCount, avgDurationMs, lastCalledAt,
    }));
  }

  function registrySetToolEnabled(name: string, enabled: boolean): boolean {
    const record = toolRecords.get(name);
    if (!record) return false;
    record.enabled = enabled;
    return true;
  }

  function registryTestTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const record = toolRecords.get(name);
    if (!record) return Promise.reject(new Error(`工具 ${name} 不存在`));
    if (!record.enabled) return Promise.resolve({ error: `工具 ${name} 已被禁用` });
    return mcpServer.callTool(name, args);
  }

  return {
    readFile: wrapWithStats('read_file', '读取工作区中的文件内容', async (path: string) => {
      const rootDir = workspaceService.getRootDir();
      const absPath = resolve(join(rootDir, String(path)));
      if (!absPath.startsWith(resolve(rootDir))) return null;
      try {
        const content = await readFile(absPath, 'utf8');
        return { path, content };
      } catch {
        return null;
      }
    }),
    writeFile: wrapWithStats('write_file', '写入工作区中的文件内容', (path: string, content: string) => {
      return workspaceService.updateFile(path, content);
    }),
    listWorkspace: wrapWithStats('list_workspace', '列出当前工作区文件树', () => {
      return workspaceService.listFiles();
    }),
    searchInWorkspace: wrapWithStats('search_in_workspace', '在工作区中搜索文本或代码片段', (query: string, path?: string) => {
      return workspaceService.searchInWorkspace(query, path);
    }),
    patchFile: wrapWithStats('patch_file', '根据局部补丁修改工作区中的文件', (path: string, patch: string) => {
      return workspaceService.patchFile(path, patch);
    }),
    listVersions: wrapWithStats('list_versions', '列出当前工作区的版本快照', () => {
      return workspaceService.listVersions();
    }),
    createSnapshot: wrapWithStats('create_snapshot', '为当前工作区创建一个可回滚的版本快照', (name?: string, description?: string) => {
      return workspaceService.createSnapshot(name, description);
    }),
    restoreSnapshot: wrapWithStats('restore_snapshot', '从指定版本快照恢复当前工作区', (snapshotId: string) => {
      return workspaceService.restoreSnapshot(snapshotId);
    }),
    runCommand: wrapWithStats(
      'run_command',
      '在工作区目录中执行命令（非白名单命令需用户确认）',
      (command: string, ctx?: RunCommandContext) => runCommandSafe(command, ctx),
    ),
    readLints: wrapWithStats('read_lints', '读取静态检查与 lint 问题', (path?: string) => readLintsFn(path)),
    diffFile: wrapWithStats('diff_file', '对比文件与版本快照差异', (path: string, snapshotId?: string) =>
      diffFileFn(path, snapshotId),
    ),
    commandWhitelist: whitelistStore,
    isToolEnabled: registryIsToolEnabled,
    registry: {
      getAllToolInfos: registryGetAllToolInfos,
      setToolEnabled: registrySetToolEnabled,
      testTool: registryTestTool,
      getToolLogs: registryGetToolLogs,
      isToolEnabled: registryIsToolEnabled,
    },
    mcp: mcpServer,
  };
}
