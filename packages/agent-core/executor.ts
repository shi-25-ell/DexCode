import type {
  JsonObject,
  ModelClient,
  ModelEvent,
  ModelFailure,
  ModelResponse,
  ModelUsage,
} from '../llm-client/index.ts';
import { collectModelTurn } from '../llm-client/index.ts';
import type {
  AgentEvent,
  AssistantMessage,
  ChatMessage,
  FileDiff,
  ToolCall,
  ToolResultMessage,
} from '../shared/types.ts';
import type { ExternalMcpTool } from '../mcp-client/index.ts';
import type { CommandConfirmHook } from '../tool-gateway/run-command.ts';
import type { AgentToolExecutionContext, ToolApprovalHook } from '../tool-gateway/index.ts';
import { enrichToolResult } from '../tool-gateway/tool-fallback.ts';
import type {
  SkillActivationResult,
  SkillReadResult,
  SkillSummary,
  SkillTrigger,
} from '../skill-system/index.ts';
import { captureFileDiff } from './file-diff.ts';
import { presentTool } from '../conversation-view/tool-presentation.ts';
import type { ContextEngine, ContextSection, PreparedContext } from '../context-engine/index.ts';
import type { ContextPolicy, ContextUsageSnapshot } from '../shared/types.ts';
import { CONTEXT_TOOL_DEFINITIONS, LOCAL_TOOL_DEFINITIONS, SKILL_TOOL_DEFINITIONS } from './tool-definitions.ts';

export type CodingToolHost = {
  readFile: (path: string) => Promise<unknown> | unknown;
  writeFile: (path: string, content: string) => unknown;
  runCommand: (command: string, ctx?: { onCommandConfirm?: CommandConfirmHook; signal?: AbortSignal }) => unknown;
  readLints?: (path?: string) => unknown;
  diffFile?: (path: string, snapshotId?: string) => unknown;
  listWorkspace: () => unknown;
  searchInWorkspace: (query: string, path?: string) => unknown;
  patchFile: (path: string, patch: string) => unknown;
  listVersions: () => unknown;
  createSnapshot: (name?: string, description?: string) => unknown;
  restoreSnapshot: (snapshotId: string) => unknown;
  executeAgentTool?: (toolName: string, args: Record<string, unknown>, context: AgentToolExecutionContext) => Promise<unknown>;
  isToolEnabled?: (name: string) => boolean;
};

type ExternalMcpRegistry = {
  listTools: () => Promise<ExternalMcpTool[]>;
  callTool: (qualifiedName: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  hasExternalTools: () => boolean;
  normalizeToolName: (serverName: string, toolName: string) => string;
};

type SkillRegistry = {
  listSkills: () => SkillSummary[];
  readSkill: (name: string) => SkillReadResult;
  activateSkill: (name: string, trigger: SkillTrigger, reason?: string) => SkillActivationResult;
  deactivateSkill: (name: string, reason?: string) => SkillActivationResult;
};

export type ConfirmHook = (question: string, options?: string[]) => Promise<string>;
export type ExecutorHooks = { onConfirm?: ConfirmHook; onCommandConfirm?: CommandConfirmHook; onApproval?: ToolApprovalHook };
export type ExecutorSemanticHooks = {
  assistantCommitted(message: AssistantMessage): Promise<void>;
  toolStarted(call: ToolCall): Promise<void>;
  toolOutcome(message: ToolResultMessage, presentation: import('../shared/types.ts').ToolPresentation): Promise<void>;
  contextPrepared?(prepared: PreparedContext): Promise<void>;
};
export type RunStatus = 'completed' | 'aborted' | 'failed' | 'limited';
export type TerminationReason =
  | 'natural_completion'
  | 'user_abort'
  | 'model_failure'
  | 'invalid_model_response'
  | 'model_attempt_limit'
  | 'model_turn_limit';

export type LoopResult = {
  messages: ChatMessage[];
  finalContent: string;
  toolsUsed: string[];
  filesModified: string[];
  fileChanges: FileDiff[];
  skillsUsed: string[];
  status: RunStatus;
  terminationReason: TerminationReason;
  modelTurnCount: number;
  modelAttemptCount: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; unknown: number };
  latestInputTokens?: number;
  latestContextUsage?: ContextUsageSnapshot;
  contextSummaryUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
  error?: { code: string; message: string };
};

export type ReActLoopOptions = {
  runId?: string;
  signal?: AbortSignal;
  maxIterations?: number;
  maxModelAttempts?: number;
  maxRetriesPerTurn?: number;
  semantic?: ExecutorSemanticHooks;
  context?: {
    engine: ContextEngine;
    sessionId: string;
    activeRequest: string;
    systemSections: ContextSection[];
    policy: ContextPolicy;
    readArtifact: (input: { ref: string; offset?: number; limit?: number }) => Promise<unknown>;
  };
};

export type Executor = ReturnType<typeof createExecutor>;

const MAX_ITERATIONS = 20;

function aborted(base: Omit<LoopResult, 'status' | 'terminationReason'>): LoopResult {
  return { ...base, status: 'aborted', terminationReason: 'user_abort' };
}

function usageSummary(current: LoopResult['usage'], usage: ModelUsage | undefined): LoopResult['usage'] {
  if (!usage) return { ...current, unknown: current.unknown + 1 };
  return {
    inputTokens: current.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: current.outputTokens + (usage.outputTokens ?? 0),
    totalTokens: current.totalTokens + (usage.totalTokens ?? 0),
    unknown: current.unknown,
  };
}

function failureReason(failure: ModelFailure): TerminationReason {
  return failure.category === 'invalid_response' || failure.category === 'adapter_bug'
    ? 'invalid_model_response'
    : 'model_failure';
}

function assistantMessage(response: ModelResponse): AssistantMessage {
  const calls: ToolCall[] = response.toolCalls.map((call) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
  return {
    role: 'assistant',
    content: response.content || null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
  };
}

function stringifyToolResult(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'tool result is not serializable' });
  }
}

function toolSummary(result: unknown): string {
  try {
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  } catch {
    return '[unserializable tool result]';
  }
}

function validationError(
  definitions: Array<{ function: { name: string; parameters?: unknown } }>,
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  const definition = definitions.find((item) => item.function.name === name);
  if (!definition) return `unknown or disabled tool: ${name}`;
  const schema = definition.function.parameters;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const shape = schema as { required?: unknown; properties?: unknown; additionalProperties?: unknown };
  const required = Array.isArray(shape.required) ? shape.required.filter((value): value is string => typeof value === 'string') : [];
  for (const key of required) if (!(key in args)) return `missing required tool argument: ${key}`;
  const properties = shape.properties && typeof shape.properties === 'object' && !Array.isArray(shape.properties)
    ? shape.properties as Record<string, { type?: unknown }>
    : {};
  if (shape.additionalProperties === false) {
    const unknown = Object.keys(args).find((key) => !(key in properties));
    if (unknown) return `unknown tool argument: ${unknown}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const expected = properties[key]?.type;
    if (typeof expected !== 'string') continue;
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actual !== expected) return `tool argument ${key} must be ${expected}`;
  }
  return undefined;
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function* observeModelEvents(
  events: AsyncIterable<ModelEvent>,
  onEvent: (event: AgentEvent) => void,
): AsyncIterable<ModelEvent> {
  for await (const event of events) {
    if (event.type === 'text_delta' && event.delta) {
      onEvent({ type: 'chunk', chunk: event.delta });
    } else if (event.type === 'reasoning_delta' && event.delta) {
      onEvent({ type: 'reasoning_chunk', chunk: event.delta });
    }
    yield event;
  }
}

export function createExecutor(
  codingToolHost: CodingToolHost,
  externalMcpRegistry?: ExternalMcpRegistry,
  skillRegistry?: SkillRegistry,
) {
  const toolFns: Record<string, (args: Record<string, unknown>) => unknown> = {
    read_file: ({ path }) => codingToolHost.readFile(path as string),
    write_file: ({ path, content }) => codingToolHost.writeFile(path as string, content as string),
    patch_file: ({ path, patch }) => codingToolHost.patchFile(path as string, patch as string),
    search_in_workspace: ({ query, path }) => codingToolHost.searchInWorkspace(query as string, path as string | undefined),
    run_command: ({ command }) => codingToolHost.runCommand(command as string),
    read_lints: ({ path }) => codingToolHost.readLints?.(path as string | undefined) ?? { error: 'read_lints unavailable' },
    diff_file: ({ path, snapshotId }) => codingToolHost.diffFile?.(path as string, snapshotId as string | undefined) ?? { error: 'diff_file unavailable' },
    list_workspace: () => codingToolHost.listWorkspace(),
    list_versions: () => codingToolHost.listVersions(),
    create_snapshot: ({ name, description }) => codingToolHost.createSnapshot(name as string | undefined, description as string | undefined),
    restore_snapshot: ({ snapshotId }) => codingToolHost.restoreSnapshot(snapshotId as string),
  };

  async function buildToolDefinitions(includeContextTools = false) {
    const local = skillRegistry ? [...LOCAL_TOOL_DEFINITIONS, ...SKILL_TOOL_DEFINITIONS] : LOCAL_TOOL_DEFINITIONS;
    const enabled = codingToolHost.isToolEnabled
      ? local.filter((tool) => codingToolHost.isToolEnabled?.(tool.function.name))
      : local;
    const builtIn = includeContextTools ? [...enabled, ...CONTEXT_TOOL_DEFINITIONS] : enabled;
    if (!externalMcpRegistry?.hasExternalTools()) return builtIn;
    const external = await externalMcpRegistry.listTools();
    return [...builtIn, ...external.map((tool) => ({
      type: 'function' as const,
      function: {
        name: externalMcpRegistry.normalizeToolName(tool.server, tool.name),
        description: `[external:${tool.server}] ${tool.description || tool.name}`,
        parameters: Object.keys(tool.inputSchema).length > 0
          ? tool.inputSchema
          : { type: 'object', properties: {}, additionalProperties: true },
      },
    }))];
  }

  return {
    async runReActLoop(
      modelClient: ModelClient,
      messages: ChatMessage[],
      onEvent: (event: AgentEvent) => void,
      hooks?: ConfirmHook | ExecutorHooks,
      options: ReActLoopOptions = {},
    ): Promise<LoopResult> {
      const onConfirm = typeof hooks === 'function' ? hooks : hooks?.onConfirm;
      const onCommandConfirm = typeof hooks === 'object' ? hooks?.onCommandConfirm : undefined;
      const onApproval = typeof hooks === 'object' ? hooks?.onApproval : undefined;
      const controller = options.signal ? undefined : new AbortController();
      const signal = options.signal ?? controller!.signal;
      const runId = options.runId ?? crypto.randomUUID();
      const workingMessages = [...messages];
      const loopMessages: ChatMessage[] = [];
      const toolsUsed: string[] = [];
      const filesModified: string[] = [];
      const fileChanges: FileDiff[] = [];
      const skillsUsed: string[] = [];
      let finalContent = '';
      let modelTurnCount = 0;
      let modelAttemptCount = 0;
      let usage: LoopResult['usage'] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, unknown: 0 };
      let latestInputTokens: number | undefined;
      let latestContextUsage: ContextUsageSnapshot | undefined;
      const contextSummaryUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let forceSummaryNext = false;
      let currentDefinitions: Awaited<ReturnType<typeof buildToolDefinitions>> = [];
      const base = () => ({ messages: loopMessages, finalContent, toolsUsed, filesModified, fileChanges, skillsUsed, modelTurnCount, modelAttemptCount, usage, latestInputTokens, latestContextUsage, contextSummaryUsage });
      const maxTurns = options.maxIterations ?? MAX_ITERATIONS;
      const maxAttempts = options.maxModelAttempts ?? maxTurns * 2;
      const maxRetries = options.maxRetriesPerTurn ?? 1;

      while (modelTurnCount < maxTurns) {
        if (signal.aborted) return aborted(base());
        modelTurnCount += 1;
        let retries = 0;
        let overflowRecovered = false;
        let recoverNext = false;
        let response: ModelResponse | undefined;
        while (!response) {
          if (modelAttemptCount >= maxAttempts) {
            return { ...base(), status: 'limited', terminationReason: 'model_attempt_limit' };
          }
          modelAttemptCount += 1;
          onEvent({ type: 'task_status', taskId: runId, status: 'executing', note: `model attempt ${modelAttemptCount}` });
          const definitions = await buildToolDefinitions(Boolean(options.context));
          currentDefinitions = definitions;
          let prepared: PreparedContext | undefined;
          let requestMessages: ChatMessage[] = workingMessages;
          if (options.context) {
            const prepareInput = {
              sessionId: options.context.sessionId,
              runId,
              turn: modelTurnCount,
              attempt: modelAttemptCount,
              activeRequest: options.context.activeRequest,
              systemSections: options.context.systemSections,
              canonicalMessages: workingMessages,
              toolDefinitions: definitions,
              policy: options.context.policy,
              forceSummary: forceSummaryNext,
              signal,
              onActivity: (presentation: import('../shared/types.ts').ContextPresentation) => onEvent({ type: 'context_activity', presentation }),
            };
            prepared = recoverNext
              ? await options.context.engine.recoverFromOverflow(prepareInput)
              : await options.context.engine.prepare(prepareInput);
            recoverNext = false;
            forceSummaryNext = false;
            await options.semantic?.contextPrepared?.(prepared);
            requestMessages = prepared.messages;
            latestContextUsage = prepared.usage;
            onEvent({ type: 'context_usage', ...prepared.usage });
            if (prepared.activity) {
              onEvent({
                type: 'context_activity',
                presentation: {
                  operationRef: prepared.activity.operationRef,
                  status: 'completed',
                  beforeTokens: prepared.activity.beforeTokens,
                  afterTokens: prepared.activity.afterTokens,
                  breakdown: prepared.activity.afterBreakdown,
                  externalizedToolResults: prepared.activity.externalizedToolResults,
                  archivedMessages: prepared.activity.archivedMessages,
                  archivedConversationSegments: prepared.activity.archivedConversationSegments,
                  compactedToolResults: prepared.activity.compactedToolResults,
                  summarizedMessages: prepared.activity.summarizedMessages,
                  retainedConversationSegments: prepared.activity.retainedConversationSegments,
                  retainedMessageCount: prepared.activity.retainedMessageCount,
                },
              });
            }
            const summary = prepared.summaryRecord?.summaryUsage;
            if (summary) {
              contextSummaryUsage.inputTokens += summary.inputTokens ?? 0;
              contextSummaryUsage.outputTokens += summary.outputTokens ?? 0;
              contextSummaryUsage.totalTokens += summary.totalTokens ?? 0;
            }
          }
          const turn = await collectModelTurn(observeModelEvents(modelClient.streamMessage(requestMessages, {
            tools: definitions,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            signal,
          }), onEvent));
          if (signal.aborted || (turn.status === 'failed' && turn.failure.category === 'cancelled')) {
            return aborted(base());
          }
          if (turn.status === 'failed') {
            if (turn.failure.category === 'context_overflow' && options.context && !overflowRecovered && !turn.producedSemanticOutput) {
              overflowRecovered = true;
              recoverNext = true;
              continue;
            }
            if (turn.failure.retryable && !turn.producedSemanticOutput && retries < maxRetries) {
              retries += 1;
              const waited = await waitForRetry(turn.failure.retryAfterMs ?? 250, signal);
              if (!waited) return aborted(base());
              continue;
            }
            return {
              ...base(),
              status: 'failed',
              terminationReason: failureReason(turn.failure),
              error: { code: `MODEL_${turn.failure.category.toUpperCase()}`, message: turn.failure.message },
            };
          }
          if (prepared && turn.response.usage?.inputTokens !== undefined && options.context) {
            await options.context.engine.recordProviderUsage({
              sessionId: options.context.sessionId,
              runId,
              manifestId: prepared.manifest.id,
              inputTokens: turn.response.usage.inputTokens,
            });
            const actual = turn.response.usage.inputTokens;
            const estimatedTotal = Object.values(prepared.manifest.breakdown).reduce((sum, value) => sum + value, 0);
            const breakdown = { ...prepared.manifest.breakdown };
            if (estimatedTotal > 0) {
              let assigned = 0;
              const keys = Object.keys(breakdown) as Array<keyof typeof breakdown>;
              for (const key of keys.slice(0, -1)) {
                breakdown[key] = Math.floor(actual * breakdown[key] / estimatedTotal);
                assigned += breakdown[key];
              }
              breakdown.other = actual - assigned;
            } else {
              breakdown.other = actual;
            }
            latestContextUsage = {
              usedTokens: actual,
              ...(options.context.policy.contextWindowTokens !== undefined ? {
                contextWindowTokens: options.context.policy.contextWindowTokens,
                percentage: Number((actual / options.context.policy.contextWindowTokens * 100).toFixed(1)),
              } : {}),
              ...(prepared.usage.hardLimitTokens !== undefined ? { hardLimitTokens: prepared.usage.hardLimitTokens } : {}),
              ...(prepared.usage.targetTokens !== undefined ? { targetTokens: prepared.usage.targetTokens } : {}),
              source: 'provider',
              timing: 'last_request',
              asOfTurn: modelTurnCount,
              asOfAttempt: modelAttemptCount,
              breakdown,
              breakdownEstimated: true,
            };
            onEvent({ type: 'context_usage', ...latestContextUsage });
          } else if (prepared && options.context) {
            latestContextUsage = { ...prepared.usage, timing: 'last_request' };
            onEvent({ type: 'context_usage', ...latestContextUsage });
          }
          response = turn.response;
        }

        usage = usageSummary(usage, response.usage);
        latestInputTokens = response.usage?.inputTokens;
        if (!options.context) {
          latestContextUsage = {
            ...(latestInputTokens !== undefined ? { usedTokens: latestInputTokens } : {}),
            ...(modelClient.contextWindow !== undefined ? { contextWindowTokens: modelClient.contextWindow } : {}),
            source: latestInputTokens !== undefined ? 'provider' : 'unknown',
            timing: 'last_request',
            asOfTurn: modelTurnCount,
            asOfAttempt: modelAttemptCount,
          };
          onEvent({ type: 'context_usage', ...latestContextUsage });
        }
        finalContent = response.content || finalContent;
        const assistant = assistantMessage(response);
        await options.semantic?.assistantCommitted(assistant);
        workingMessages.push(assistant);
        loopMessages.push(assistant);
        if (response.toolCalls.length === 0) {
          if (response.finishReason === 'length') {
            return { ...base(), status: 'limited', terminationReason: 'model_turn_limit' };
          }
          return { ...base(), status: 'completed', terminationReason: 'natural_completion' };
        }
        if (response.finishReason !== 'tool_calls') {
          return {
            ...base(),
            status: 'failed',
            terminationReason: 'invalid_model_response',
            error: { code: 'MODEL_INVALID_RESPONSE', message: 'tool calls require finishReason=tool_calls' },
          };
        }
        const seenCallIds = new Set<string>();
        for (const call of response.toolCalls) {
          if (seenCallIds.has(call.id)) {
            return {
              ...base(),
              status: 'failed',
              terminationReason: 'invalid_model_response',
              error: { code: 'MODEL_INVALID_RESPONSE', message: `duplicate tool call id: ${call.id}` },
            };
          }
          seenCallIds.add(call.id);
          if (signal.aborted) return aborted(base());
          const toolName = call.name;
          const legacyCall: ToolCall = {
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          };
          const args = call.arguments as JsonObject & Record<string, unknown>;
          toolsUsed.push(toolName);
          let toolResult: unknown;
          let fileDiff: FileDiff | undefined;
          const semanticContextTool = toolName === 'compact_context';
          const invalid = validationError(currentDefinitions, toolName, args);
          try {
            if (invalid) {
              toolResult = { status: 'rejected', error: invalid };
            } else {
              await options.semantic?.toolStarted(legacyCall);
              if (!semanticContextTool) {
                onEvent({ type: 'tool_status', callId: call.id, tool: toolName, status: 'running' });
                onEvent({ type: 'tool_view', presentation: presentTool({ callRef: call.id, tool: toolName, args, status: 'running' }) });
              }
            }
            if (invalid) {
              // Rejected calls still receive a paired tool result but never reach an execution adapter.
            } else if (toolName === 'ask_user') {
              if (!onConfirm) toolResult = { error: 'confirmation unavailable' };
              else {
                onEvent({ type: 'task_status', taskId: runId, status: 'waiting_confirm' });
                toolResult = { answer: await onConfirm(String(args.question ?? 'Please confirm'), Array.isArray(args.options) ? args.options.map(String) : undefined) };
              }
            } else if (toolName === 'read_artifact' && options.context) {
              toolResult = await options.context.readArtifact({
                ref: String(args.ref ?? ''),
                ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
                ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
              });
            } else if (toolName === 'compact_context' && options.context) {
              toolResult = { status: 'scheduled', message: '上下文将在当前工具批次完成后整理' };
              forceSummaryNext = true;
            } else if (toolName === 'list_skills' && skillRegistry) {
              toolResult = { skills: skillRegistry.listSkills() };
              onEvent({ type: 'skill', skill: '*', action: 'listed', summary: 'Listed available skills' });
            } else if (toolName === 'read_skill' && skillRegistry) {
              const name = String(args.name ?? '');
              toolResult = skillRegistry.readSkill(name);
              if ((toolResult as SkillReadResult).ok) onEvent({ type: 'skill', skill: name, action: 'read', summary: `Loaded skill: ${name}` });
            } else if (toolName === 'activate_skill' && skillRegistry) {
              const name = String(args.name ?? '');
              const trigger = args.trigger === 'explicit' ? 'explicit' : 'implicit';
              toolResult = skillRegistry.activateSkill(name, trigger, typeof args.reason === 'string' ? args.reason : undefined);
              if ((toolResult as SkillActivationResult).ok) {
                if (!skillsUsed.includes(name)) skillsUsed.push(name);
                onEvent({ type: 'skill', skill: name, action: 'activated', trigger, summary: `Activated skill: ${name}` });
              }
            } else if (toolName === 'deactivate_skill' && skillRegistry) {
              const name = String(args.name ?? '');
              toolResult = skillRegistry.deactivateSkill(name, typeof args.reason === 'string' ? args.reason : undefined);
              onEvent({ type: 'skill', skill: name, action: 'deactivated', summary: `Deactivated skill: ${name}` });
            } else {
              const fn = toolFns[toolName];
              if (fn) {
                if (codingToolHost.executeAgentTool) {
                  const execute = () => codingToolHost.executeAgentTool!(toolName, args, {
                    origin: 'agent',
                    onApproval,
                    signal,
                  });
                  if ((toolName === 'write_file' || toolName === 'patch_file') && typeof args.path === 'string') {
                    const captured = await captureFileDiff(codingToolHost.readFile, args.path, execute);
                    toolResult = captured.result;
                    fileDiff = captured.diff;
                    if (captured.diff.before !== captured.diff.after) {
                      fileChanges.push(captured.diff);
                      filesModified.push(args.path);
                    }
                  } else {
                    toolResult = await execute();
                  }
                } else if (toolName === 'run_command' && onCommandConfirm) {
                  toolResult = await codingToolHost.runCommand(String(args.command ?? ''), { onCommandConfirm, signal });
                } else if ((toolName === 'write_file' || toolName === 'patch_file') && typeof args.path === 'string') {
                  const captured = await captureFileDiff(codingToolHost.readFile, args.path, () => fn(args));
                  toolResult = captured.result;
                  fileDiff = captured.diff;
                  fileChanges.push(captured.diff);
                  filesModified.push(args.path);
                } else {
                  toolResult = await fn(args);
                }
              } else if (toolName.startsWith('mcp__') && externalMcpRegistry) {
                if (codingToolHost.executeAgentTool) {
                  toolResult = await codingToolHost.executeAgentTool(toolName, args, {
                    origin: 'agent',
                    onApproval,
                    signal,
                    executeExternal: (name, input, executionSignal) => externalMcpRegistry.callTool(name, input, executionSignal),
                  });
                } else if (!onConfirm) {
                  toolResult = { status: 'denied', error: 'external MCP tool requires an approval channel' };
                } else {
                  onEvent({ type: 'task_status', taskId: runId, status: 'waiting_confirm' });
                  const decision = await onConfirm(`Allow external MCP tool ${toolName}?`, ['allow', 'deny']);
                  toolResult = decision === 'allow'
                    ? await externalMcpRegistry.callTool(toolName, args, signal)
                    : { status: 'denied', error: 'external MCP tool denied' };
                }
              } else {
                toolResult = { error: `unknown tool: ${toolName}` };
              }
              toolResult = enrichToolResult(toolName, toolResult);
              if (toolName === 'restore_snapshot') filesModified.push('[workspace restored from snapshot]');
            }
          } catch (error) {
            toolResult = { error: error instanceof Error ? error.message : String(error) };
          }
          if (!semanticContextTool) {
            onEvent({ type: 'tool', tool: toolName, summary: `Tool call: ${toolName}`, detail: toolSummary(toolResult) });
            onEvent({ type: 'tool_status', callId: call.id, tool: toolName, status: 'settled' });
          }
          const toolMessage: ToolResultMessage = {
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: stringifyToolResult(toolResult),
          };
          const presentation = presentTool({ callRef: call.id, tool: toolName, args, result: toolResult, fileDiff });
          if (!semanticContextTool) onEvent({ type: 'tool_view', presentation });
          await options.semantic?.toolOutcome(toolMessage, presentation);
          workingMessages.push(toolMessage);
          loopMessages.push(toolMessage);
        }
      }
      return { ...base(), status: 'limited', terminationReason: 'model_turn_limit' };
    },
  };
}
