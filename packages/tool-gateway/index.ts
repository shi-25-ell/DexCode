import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { WorkspaceFile } from '../workspace-manager/index.ts';
import type { ToolInfo } from '../shared/types.ts';
import { normalizeToolResult, toolFailure } from '../shared/tool-result.ts';
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
import { createToolCallLogStore } from './tool-call-log.ts';
import { buildWorkspaceTree, findPaths, listDirectory } from './directory-walker.ts';
import { grepWorkspace } from './grep.ts';
import { readWorkspaceFile, type ReadFileInput } from './read-file.ts';
import { agentCodingToolDefinitions, codingToolSpec, codingToolSpecs, type CodingToolName } from './tool-registry.ts';
import type { PatchFileInput } from './structured-edit.ts';
import { resolveShellCapabilities, type ShellResolverOptions } from './shell/shell-resolver.ts';
import type { EnsureRgOptions } from './managed-tools/ensure-rg.ts';

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
  updateFile: (path: string, content: string, signal?: AbortSignal) => Promise<unknown>;
  listTree: () => unknown[];
  listFiles: () => WorkspaceFile[];
  patchFile: (input: PatchFileInput) => Promise<unknown> | unknown;
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

type LocalToolHandlers = Record<CodingToolName, (args: Record<string, unknown>) => unknown | Promise<unknown>>;

function buildToolDefinitions(handlers: LocalToolHandlers, shellDescription: string) {
  return codingToolSpecs({ shellDescription }).map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    handler: handlers[spec.name],
  }));
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
      description: '生成 targeted 结构化编辑输入',
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
            content: '只输出 patch_file targeted 模式的 JSON：path、mode="targeted"、edits[{old_text,new_text}]。old_text 必须精确命中一次。',
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
  options: {
    approvalModeStore?: Pick<ApprovalModeStore, 'getMode'>;
    shell?: ShellResolverOptions;
    rg?: Omit<EnsureRgOptions, 'managedDir'> & { managedDir?: string };
  } = {},
) {
  const whitelistStore = createCommandWhitelistStore(workspaceService.projectDir);
  const shellCapabilities = resolveShellCapabilities(options.shell);
  const runtimeToolSpecs = new Map(codingToolSpecs({ shellDescription: shellCapabilities.selected.description }).map((spec) => [spec.name, spec] as const));
  const commandRunner = createCommandRunner({ shell: shellCapabilities.selected });
  const rgOptions: EnsureRgOptions = {
    ...options.rg,
    managedDir: options.rg?.managedDir ?? join(workspaceService.projectDir, 'managed-tools', 'ripgrep'),
    offline: options.rg?.offline ?? process.env.DEXCODE_OFFLINE === '1',
  };
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

  let mcpServer!: McpServer;

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
      if (!record.enabled) return toolFailure('blocked', 'TOOL_DISABLED', `工具 ${name} 已被禁用`, { tool: name });
      const start = Date.now();
      try {
        const result = await fn(...args);
        const duration = Date.now() - start;
        record.callCount++;
        callLog.append(name, args, result, duration);
        const ok = normalizeToolResult(result).ok;
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
    if (!record.enabled) return Promise.resolve(toolFailure('blocked', 'TOOL_DISABLED', `工具 ${name} 已被禁用`, { tool: name }));
    return mcpServer.callTool(name, args);
  }

  const readFileTool = wrapWithStats('read_file', runtimeToolSpecs.get('read_file')!.description,
    (input: ReadFileInput, signal?: AbortSignal) => readWorkspaceFile(workspaceService.getRootDir(), input, signal));
  const readFileHost = (path: string, options: Omit<ReadFileInput, 'path'> = {}, signal?: AbortSignal) => readFileTool({ path, ...options }, signal);
  const readFileForDiff = async (path: string) => {
    const rootDir = workspaceService.getRootDir();
    const absPath = await safeExistingPath(rootDir, path);
    if (!absPath) return null;
    try {
      return { path, content: await readFile(absPath, 'utf8') };
    } catch {
      return null;
    }
  };
  const writeFileTool = wrapWithStats('write_file', runtimeToolSpecs.get('write_file')!.description,
    (path: string, content: string, signal?: AbortSignal) => workspaceService.updateFile(path, content, signal));
  const findTool = wrapWithStats('find', runtimeToolSpecs.get('find')!.description,
    (input: { pattern: string; path?: string; limit?: number }, signal?: AbortSignal) => findPaths(cwd(), input, signal));
  const lsTool = wrapWithStats('ls', runtimeToolSpecs.get('ls')!.description,
    (input: { path?: string; limit?: number }) => listDirectory(cwd(), input));
  const listWorkspaceTool = wrapWithStats('list_workspace', runtimeToolSpecs.get('list_workspace')!.description,
    (input: { depth?: number } = {}, signal?: AbortSignal) => buildWorkspaceTree(cwd(), input, signal));
  const grepTool = wrapWithStats('grep', runtimeToolSpecs.get('grep')!.description,
    (input: Parameters<typeof grepWorkspace>[1], signal?: AbortSignal) => grepWorkspace(cwd(), input, rgOptions, signal));
  const patchFileTool = wrapWithStats('patch_file', runtimeToolSpecs.get('patch_file')!.description,
    (input: PatchFileInput) => workspaceService.patchFile(input));
  const runCommandTool = wrapWithStats('run_command', runtimeToolSpecs.get('run_command')!.description,
    (command: string, ctx?: RunCommandContext) => runCommandSafe(command, ctx));
  const readCommandOutputTool = wrapWithStats('read_command_output', runtimeToolSpecs.get('read_command_output')!.description,
    (taskId: string, waitMs?: number) => commandRunner.read(taskId, waitMs));
  const stopCommandTool = wrapWithStats('stop_command', runtimeToolSpecs.get('stop_command')!.description,
    (taskId: string) => commandRunner.stop(taskId));

  const localHandlers: LocalToolHandlers = {
    find: (args) => findTool({
      pattern: String(args.pattern ?? ''),
      ...(typeof args.path === 'string' ? { path: args.path } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    }),
    ls: (args) => lsTool({
      ...(typeof args.path === 'string' ? { path: args.path } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    }),
    list_workspace: (args) => listWorkspaceTool(typeof args.depth === 'number' ? { depth: args.depth } : {}),
    read_file: (args) => readFileTool({
      path: String(args.path ?? ''),
      ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    }),
    grep: (args) => grepTool(args as Parameters<typeof grepWorkspace>[1]),
    run_command: (args) => runCommandTool(String(args.command ?? ''), {
      approvalGranted: true,
      ...(typeof args.timeout_ms === 'number' ? { timeoutMs: args.timeout_ms } : {}),
      ...(typeof args.run_in_background === 'boolean' ? { runInBackground: args.run_in_background } : {}),
    }),
    patch_file: (args) => patchFileTool(args as PatchFileInput),
    write_file: (args) => writeFileTool(String(args.path ?? ''), String(args.content ?? '')),
    read_command_output: (args) => readCommandOutputTool(String(args.task_id ?? ''), typeof args.wait_ms === 'number' ? args.wait_ms : undefined),
    stop_command: (args) => stopCommandTool(String(args.task_id ?? '')),
  };

  mcpServer = createMcpServer({
    tools: buildToolDefinitions(localHandlers, shellCapabilities.selected.description),
    resources: buildResourceDefinitions(workspaceService),
    prompts: buildPromptDefinitions(),
  });

  const host = {
    readFile: readFileHost,
    readFileForDiff,
    writeFile: writeFileTool,
    find: findTool,
    ls: lsTool,
    listWorkspace: listWorkspaceTool,
    listWorkspaceFiles: () => workspaceService.listFiles(),
    grep: grepTool,
    patchFile: patchFileTool,
    runCommand: runCommandTool,
    readCommandOutput: readCommandOutputTool,
    stopCommand: stopCommandTool,
    getToolDefinitions: () => agentCodingToolDefinitions({ shellDescription: shellCapabilities.selected.description }),
    shellCapabilities,
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

  async function approvalSubject(
    toolName: string,
    input: Record<string, unknown>,
    origin: ApprovalOrigin,
  ): Promise<ApprovalSubject> {
    let normalizedInput: Record<string, unknown> = { ...input };
    let effect: ApprovalEffect = codingToolSpec(toolName)?.effect ?? 'external';
    let summary = `执行 ${toolName}`;
    let command: string | undefined;
    let matchedRule: string | undefined;
    let hardDeniedReason: string | undefined;

    if (toolName === 'run_command') {
      command = normalizeCommand(String(input.command ?? ''));
      normalizedInput = {
        command,
        shell: shellCapabilities.selected.kind,
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
      const payloadLength = toolName === 'write_file'
        ? String(input.content ?? '').length
        : input.mode === 'targeted' && Array.isArray(input.edits)
          ? input.edits.length
          : Number(input.expected_occurrences ?? 0);
      summary = toolName === 'write_file'
        ? `写入 ${path}（内容 ${payloadLength} 字符）`
        : `修改 ${path}（${input.mode === 'targeted' ? `${payloadLength} 处定点编辑` : `${payloadLength} 处全量替换`}）`;
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
      if (validationError) return toolFailure('invalid_arguments', 'INVALID_ARGUMENTS', validationError, { tool: toolName });
    }
    const subject = await approvalSubject(toolName, input, context.origin);
    const decision = approvalPolicy.authorize(subject, approvalMode.getMode());
    if (decision.outcome === 'deny') return toolFailure('blocked', 'BLOCKED_BY_POLICY', decision.reason, { tool: toolName });
    if (decision.outcome === 'ask') {
      if (!context.onApproval || context.origin === 'mcp_http') {
        return context.nonInteractive
          ? toolFailure('blocked', 'APPROVAL_REQUIRED', decision.reason, { tool: toolName })
          : toolFailure('denied', 'APPROVAL_REQUIRED', '该操作需要用户批准，但当前没有可用的批准通道', { tool: toolName });
      }
      const response = await context.onApproval(approvalRequest(subject, decision.options, decision.reason));
      if (response.fingerprint !== subject.fingerprint) {
        return toolFailure('denied', 'APPROVAL_MISMATCH', '批准 fingerprint 与待执行操作不匹配', { tool: toolName });
      }
      if (!decision.options.includes(response.decision)) {
        return toolFailure('denied', 'APPROVAL_MISMATCH', '批准决定不适用于当前操作', { tool: toolName });
      }
      if (response.decision === 'deny') return toolFailure('denied', 'APPROVAL_DENIED', '用户拒绝执行该操作', { tool: toolName });
      if (response.decision === 'allow_whitelist') {
        if (toolName !== 'run_command' || !subject.command) {
          return toolFailure('denied', 'APPROVAL_MISMATCH', '只有命令可以加入白名单', { tool: toolName });
        }
        await whitelistStore.addFromCommand(subject.command, 'exact');
      }
    }

    const args = subject.normalizedInput as Record<string, unknown>;
    context.onEffectStart?.();
    switch (toolName) {
      case 'read_file': return host.readFile(String(args.path ?? ''), {
        ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      }, context.signal);
      case 'write_file': return host.writeFile(String(args.path ?? ''), String(args.content ?? ''), context.signal);
      case 'find': return host.find(args as Parameters<typeof findPaths>[1], context.signal);
      case 'ls': return host.ls(args as Parameters<typeof listDirectory>[1]);
      case 'list_workspace': return host.listWorkspace(args as Parameters<typeof buildWorkspaceTree>[1], context.signal);
      case 'grep': return host.grep(args as Parameters<typeof grepWorkspace>[1], context.signal);
      case 'patch_file': return host.patchFile(args as PatchFileInput);
      case 'run_command': return host.runCommand(String(args.command ?? ''), {
        approvalGranted: true,
        signal: context.signal,
        ...(typeof args.timeout_ms === 'number' ? { timeoutMs: args.timeout_ms } : {}),
        ...(typeof args.run_in_background === 'boolean' ? { runInBackground: args.run_in_background } : {}),
      });
      case 'read_command_output': return host.readCommandOutput(String(args.task_id ?? ''), typeof args.wait_ms === 'number' ? args.wait_ms : undefined);
      case 'stop_command': return host.stopCommand(String(args.task_id ?? ''));
      default:
        if (toolName.startsWith('mcp__') && context.executeExternal) {
          return context.executeExternal(toolName, args, context.signal);
        }
        return toolFailure('failed', 'UNSUPPORTED_TOOL', `未知工具：${toolName}`, { tool: toolName });
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
    const normalized = normalizeToolResult(result);
    return !normalized.ok
      ? { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: normalized.error.message, data: normalized } }
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
