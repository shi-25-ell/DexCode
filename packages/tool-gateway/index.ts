import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { TreeNode, WorkspaceFile } from '../workspace-manager/index.ts';
import type { ToolInfo } from '../shared/types.ts';
import { createMcpServer, type McpJsonRpcRequest, type McpJsonRpcResponse, type McpServer } from '../mcp-server/index.ts';
import { isTrustedReadonlyCommand, matchWhitelistEntry, normalizeCommand, validateCommand } from './command-safety.ts';
import { createCommandWhitelistStore } from './command-whitelist-store.ts';
import type {
  ApprovalEffect,
  ApprovalOrigin,
  ApprovalSubject,
  ToolApprovalRequest,
} from '../shared/types.ts';
import { createApprovalFingerprint, createApprovalPolicy, type ToolApprovalHook } from './approval-policy.ts';
import type { ApprovalModeStore } from './approval-mode-store.ts';
import {
  createCommandRunner,
  type CommandConfirmHook,
  type RunCommandResult,
} from './run-command.ts';
import { diffFileAgainstSnapshot } from './diff-file.ts';
import { readLints } from './read-lints.ts';
import { createToolCallLogStore } from './tool-call-log.ts';

export type { CommandConfirmHook, CommandConfirmDecision, CommandConfirmRequest } from './run-command.ts';
export type { WhitelistEntry, CommandRisk } from './command-safety.ts';
export type { CommandWhitelistStore } from './command-whitelist-store.ts';
export { createApprovalModeStore, isApprovalMode, type ApprovalModeStore } from './approval-mode-store.ts';
export { createApprovalPolicy, createApprovalFingerprint, type ApprovalPolicy } from './approval-policy.ts';
export type { ToolApprovalHook } from './approval-policy.ts';

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
  signal?: AbortSignal;
  approvalGranted?: boolean;
  timeoutMs?: number;
  runInBackground?: boolean;
};

export type AgentToolExecutionContext = {
  origin: ApprovalOrigin;
  onApproval?: ToolApprovalHook;
  onEffectStart?: () => void;
  signal?: AbortSignal;
  executeExternal?: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  nonInteractive?: boolean;
};

function isWithinRoot(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

async function safeExistingPath(root: string, requested: string): Promise<string | null> {
  const lexical = resolve(root, requested);
  if (!isWithinRoot(root, lexical)) return null;
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(lexical)]);
    return isWithinRoot(realRoot, realTarget) ? realTarget : null;
  } catch {
    return null;
  }
}

function buildToolDefinitions(
  workspaceService: WorkspaceService,
  runCommandSafe: (command: string, ctx?: RunCommandContext) => Promise<RunCommandResult>,
  readCommandOutput: (taskId: string, waitMs?: number) => Promise<RunCommandResult>,
  stopCommand: (taskId: string) => Promise<RunCommandResult>,
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
        const absPath = await safeExistingPath(rootDir, String(path ?? ''));
        if (!absPath) return null;
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
          timeout_ms: { type: 'number', minimum: 1000, maximum: 600000 },
          run_in_background: { type: 'boolean' },
        },
        ['command'],
      ),
      handler: ({ command, timeout_ms, run_in_background }: Record<string, unknown>) =>
        runCommandSafe(String(command ?? ''), {
          ...(typeof timeout_ms === 'number' ? { timeoutMs: timeout_ms } : {}),
          ...(typeof run_in_background === 'boolean' ? { runInBackground: run_in_background } : {}),
        }),
    },
    {
      name: 'read_command_output',
      description: '读取后台命令的输出和当前状态，可等待最多 60 秒',
      inputSchema: buildInputSchema(
        { task_id: { type: 'string', minLength: 1 }, wait_ms: { type: 'number', minimum: 0, maximum: 60000 } },
        ['task_id'],
      ),
      handler: ({ task_id, wait_ms }: Record<string, unknown>) =>
        readCommandOutput(String(task_id ?? ''), typeof wait_ms === 'number' ? wait_ms : undefined),
    },
    {
      name: 'stop_command',
      description: '停止仍在运行的后台命令',
      inputSchema: buildInputSchema({ task_id: { type: 'string', minLength: 1 } }, ['task_id']),
      handler: ({ task_id }: Record<string, unknown>) => stopCommand(String(task_id ?? '')),
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

export function createCodingToolHost(
  workspaceService: WorkspaceService,
  options: { approvalModeStore?: Pick<ApprovalModeStore, 'getMode'> } = {},
) {
  const whitelistStore = createCommandWhitelistStore(workspaceService.projectDir);
  const commandRunner = createCommandRunner();
  const cwd = () => workspaceService.getRootDir();
  const approvalMode = options.approvalModeStore ?? { getMode: () => 'allowlist' as const };
  const approvalPolicy = createApprovalPolicy();

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

    if (!validation.needsConfirmation || ctx.approvalGranted) {
      const result = await commandRunner.run(validation.normalizedCommand, cwd(), {
        foregroundTimeoutMs: Math.max(1_000, Math.min(600_000, ctx.timeoutMs ?? validation.timeoutMs)),
        runInBackground: ctx.runInBackground,
        signal: ctx.signal,
      });
      return { ...result, risk: validation.risk, whitelisted: validation.whitelisted };
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

    const result = await commandRunner.run(validation.normalizedCommand, cwd(), {
      foregroundTimeoutMs: Math.max(1_000, Math.min(600_000, ctx.timeoutMs ?? validation.timeoutMs)),
      runInBackground: ctx.runInBackground,
      signal: ctx.signal,
    });
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
    tools: buildToolDefinitions(workspaceService, runCommandSafe, commandRunner.read, commandRunner.stop, readLintsFn, diffFileFn),
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

  const host = {
    readFile: wrapWithStats('read_file', '读取工作区中的文件内容', async (path: string) => {
      const rootDir = workspaceService.getRootDir();
      const absPath = await safeExistingPath(rootDir, String(path));
      if (!absPath) return null;
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
    readCommandOutput: wrapWithStats('read_command_output', '读取后台命令输出', (taskId: string, waitMs?: number) => commandRunner.read(taskId, waitMs)),
    stopCommand: wrapWithStats('stop_command', '停止后台命令', (taskId: string) => commandRunner.stop(taskId)),
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

  const EFFECTS: Record<string, ApprovalEffect> = {
    read_file: 'read',
    search_in_workspace: 'read',
    read_lints: 'read',
    diff_file: 'read',
    list_workspace: 'read',
    list_versions: 'read',
    write_file: 'write',
    patch_file: 'write',
    create_snapshot: 'write',
    restore_snapshot: 'write',
    run_command: 'execute',
    read_command_output: 'read',
    stop_command: 'execute',
    ask_user: 'interactive',
  };

  async function approvalSubject(
    toolName: string,
    input: Record<string, unknown>,
    origin: ApprovalOrigin,
  ): Promise<ApprovalSubject> {
    let normalizedInput: Record<string, unknown> = { ...input };
    let effect = EFFECTS[toolName] ?? (toolName.startsWith('mcp__') ? 'external' : 'external');
    let summary = `执行 ${toolName}`;
    let command: string | undefined;
    let matchedRule: string | undefined;
    let hardDeniedReason: string | undefined;

    if (toolName === 'run_command') {
      command = normalizeCommand(String(input.command ?? ''));
      normalizedInput = {
        command,
        ...(typeof input.timeout_ms === 'number' ? { timeout_ms: input.timeout_ms } : {}),
        ...(typeof input.run_in_background === 'boolean' ? { run_in_background: input.run_in_background } : {}),
      };
      const entries = await whitelistStore.list();
      const validation = validateCommand(command, entries);
      if (!validation.allowed) hardDeniedReason = validation.reason;
      const match = entries.find((entry) => matchWhitelistEntry(command!, entry));
      matchedRule = match?.id;
      if (!matchedRule && isTrustedReadonlyCommand(command)) effect = 'read';
      summary = validation.reason;
    } else if (toolName === 'stop_command') {
      normalizedInput = { task_id: String(input.task_id ?? '') };
      summary = `停止后台命令 ${normalizedInput.task_id}`;
    } else if (toolName === 'write_file' || toolName === 'patch_file') {
      const path = String(input.path ?? '').trim().replace(/\\/g, '/');
      normalizedInput = { ...input, path };
      const payloadLength = String(toolName === 'write_file' ? input.content ?? '' : input.patch ?? '').length;
      summary = toolName === 'write_file'
        ? `写入 ${path}（内容 ${payloadLength} 字符）`
        : `修改 ${path}（补丁 ${payloadLength} 字符）`;
      if (!path || !await safeMutationPath(cwd(), path)) hardDeniedReason = '目标路径超出工作区或经过不安全的链接';
    } else if (toolName.startsWith('mcp__')) {
      summary = `调用外部工具 ${toolName.replace(/^mcp__/, '').replace('__', ' · ')}`;
    }

    const fingerprint = createApprovalFingerprint({ toolName, effect, normalizedInput });
    return {
      origin,
      toolName,
      effect,
      workspaceRef: workspaceService.projectId,
      summary,
      normalizedInput,
      fingerprint,
      ...(command ? { command } : {}),
      ...(matchedRule ? { matchedRule } : {}),
      ...(hardDeniedReason ? { hardDeniedReason } : {}),
    };
  }

  function approvalRequest(subject: ApprovalSubject, options: ToolApprovalRequest['options'], reason: string): ToolApprovalRequest {
    const path = subject.normalizedInput && typeof subject.normalizedInput === 'object'
      ? String((subject.normalizedInput as Record<string, unknown>).path ?? '')
      : '';
    const target = subject.command
      || path
      || (subject.toolName.startsWith('mcp__') ? subject.toolName.replace(/^mcp__/, '').replace('__', ' · ') : '');
    return {
      version: 1,
      toolName: subject.toolName,
      effect: subject.effect,
      title: subject.effect === 'write' ? '批准文件修改' : subject.effect === 'execute' ? '批准命令执行' : '批准外部工具调用',
      ...(target ? { target } : {}),
      reason: subject.summary && subject.summary !== reason ? `${reason}；${subject.summary}` : reason,
      fingerprint: subject.fingerprint,
      options,
    };
  }

  async function executeAgentTool(
    toolName: string,
    input: Record<string, unknown>,
    context: AgentToolExecutionContext,
  ): Promise<unknown> {
    if (!toolName.startsWith('mcp__')) {
      const validationError = mcpServer.validateToolCall(toolName, input);
      if (validationError) return { status: 'blocked', error: validationError };
    }
    const subject = await approvalSubject(toolName, input, context.origin);
    const decision = approvalPolicy.authorize(subject, approvalMode.getMode());
    if (decision.outcome === 'deny') return context.nonInteractive
      ? { status: 'blocked', code: 'blocked_by_policy', tool: toolName, reason: decision.reason }
      : { status: 'blocked', error: decision.reason };
    if (decision.outcome === 'ask') {
      if (!context.onApproval || context.origin === 'mcp_http') {
        return context.nonInteractive
          ? { status: 'blocked', code: 'approval_required', tool: toolName, reason: decision.reason }
          : { status: 'denied', error: '该操作需要用户批准，但当前没有可用的批准通道' };
      }
      const response = await context.onApproval(approvalRequest(subject, decision.options, decision.reason));
      if (response.fingerprint !== subject.fingerprint) {
        return { status: 'denied', error: '批准 fingerprint 与待执行操作不匹配' };
      }
      if (!decision.options.includes(response.decision)) {
        return { status: 'denied', error: '批准决定不适用于当前操作' };
      }
      if (response.decision === 'deny') return { status: 'denied', error: '用户拒绝执行该操作' };
      if (response.decision === 'allow_whitelist') {
        if (toolName !== 'run_command' || !subject.command) {
          return { status: 'denied', error: '只有命令可以加入白名单' };
        }
        await whitelistStore.addFromCommand(subject.command, 'exact');
      }
    }

    const args = subject.normalizedInput as Record<string, unknown>;
    context.onEffectStart?.();
    switch (toolName) {
      case 'read_file': return host.readFile(String(args.path ?? ''));
      case 'write_file': return host.writeFile(String(args.path ?? ''), String(args.content ?? ''));
      case 'patch_file': return host.patchFile(String(args.path ?? ''), String(args.patch ?? ''));
      case 'search_in_workspace': return host.searchInWorkspace(String(args.query ?? ''), typeof args.path === 'string' ? args.path : undefined);
      case 'run_command': return host.runCommand(String(args.command ?? ''), {
        approvalGranted: true,
        signal: context.signal,
        ...(typeof args.timeout_ms === 'number' ? { timeoutMs: args.timeout_ms } : {}),
        ...(typeof args.run_in_background === 'boolean' ? { runInBackground: args.run_in_background } : {}),
      });
      case 'read_command_output': return host.readCommandOutput(String(args.task_id ?? ''), typeof args.wait_ms === 'number' ? args.wait_ms : undefined);
      case 'stop_command': return host.stopCommand(String(args.task_id ?? ''));
      case 'read_lints': return host.readLints(typeof args.path === 'string' ? args.path : undefined);
      case 'diff_file': return host.diffFile(String(args.path ?? ''), typeof args.snapshotId === 'string' ? args.snapshotId : undefined);
      case 'list_workspace': return host.listWorkspace();
      case 'list_versions': return host.listVersions();
      case 'create_snapshot': return host.createSnapshot(typeof args.name === 'string' ? args.name : undefined, typeof args.description === 'string' ? args.description : undefined);
      case 'restore_snapshot': return host.restoreSnapshot(String(args.snapshotId ?? ''));
      default:
        if (toolName.startsWith('mcp__') && context.executeExternal) {
          return context.executeExternal(toolName, args, context.signal);
        }
        return { status: 'denied', error: `未知工具默认拒绝：${toolName}` };
    }
  }

  async function mcpJsonRpc(request: McpJsonRpcRequest): Promise<McpJsonRpcResponse | null> {
    if (request.method !== 'tools/call') return mcpServer.jsonRpc(request);
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : {};
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments as Record<string, unknown>
      : {};
    const name = String(params.name ?? '');
    const result = await executeAgentTool(name, args, { origin: 'mcp_http' });
    const failed = result && typeof result === 'object'
      && ('error' in result || ['blocked', 'denied', 'failed'].includes(String((result as Record<string, unknown>).status ?? '')));
    return failed
      ? { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: String((result as Record<string, unknown>).error ?? 'Tool call failed'), data: result } }
      : { jsonrpc: '2.0', id: request.id ?? null, result: { success: true, tool: name, data: result } };
  }

  return { ...host, executeAgentTool, mcpJsonRpc };
}

async function safeMutationPath(root: string, requested: string): Promise<boolean> {
  const lexical = resolve(root, requested);
  if (!isWithinRoot(root, lexical)) return false;
  let cursor = lexical;
  while (isWithinRoot(root, cursor)) {
    try {
      const [realRoot, realCursor] = await Promise.all([realpath(root), realpath(cursor)]);
      return isWithinRoot(realRoot, realCursor);
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') return false;
      const parent = dirname(cursor);
      if (parent === cursor) return false;
      cursor = parent;
    }
  }
  return false;
}
