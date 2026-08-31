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
import { projectAgentFork } from '../context-engine/index.ts';
import type { ContextPolicy, ContextUsageSnapshot } from '../shared/types.ts';
import type { CommittedAssistantMessage, RunEventPayload, RunPhase } from '../run-protocol/index.ts';
import { CONTEXT_TOOL_DEFINITIONS, LOCAL_TOOL_DEFINITIONS, SKILL_TOOL_DEFINITIONS } from './tool-definitions.ts';
import { MEMORY_TOOL_DEFINITIONS, isMemoryTool } from '../managed-memory/tools.ts';
import type { RunCommandSource } from './run-commands.ts';
import {
  isAgentOrchestrationTool,
  validateOrchestrationToolInput,
  type AgentOrchestrationPort,
} from '../agent-manager/contracts.ts';
import { agentOrchestrationToolDefinitions } from './tool-definitions.ts';

export type CodingToolHost = {
  readFile: (path: string) => Promise<unknown> | unknown;
  writeFile: (path: string, content: string) => unknown;
  runCommand: (command: string, ctx?: { onCommandConfirm?: CommandConfirmHook; signal?: AbortSignal; timeoutMs?: number; runInBackground?: boolean }) => unknown;
  readCommandOutput?: (taskId: string, waitMs?: number) => unknown;
  stopCommand?: (taskId: string) => unknown;
  readLints?: (path?: string) => unknown;
  diffFile?: (path: string, snapshotId?: string) => unknown;
  listWorkspace: () => unknown;
  searchInWorkspace: (query: string, path?: string) => unknown;
  patchFile: (path: string, patch: string) => unknown;
  listVersions: () => unknown;
  createSnapshot: (name?: string, description?: string) => unknown;
  restoreSnapshot: (snapshotId: string) => unknown;
  executeAgentTool?: (toolName: string, args: Record<string, unknown>, context: AgentToolExecutionContext) => Promise<unknown>;
  executeManagedMemoryTool?: (toolName: string, args: Record<string, unknown>, context: { runId: string; sessionId?: string; signal: AbortSignal }) => Promise<unknown>;
  isToolEnabled?: (name: string) => boolean;
};

export type ExternalMcpRegistry = {
  listTools: () => Promise<ExternalMcpTool[]>;
  callTool: (qualifiedName: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  hasExternalTools: () => boolean;
  normalizeToolName: (serverName: string, toolName: string) => string;
};

export type SkillRegistry = {
  listSkills: () => SkillSummary[];
  readSkill: (name: string) => SkillReadResult;
  activateSkill: (name: string, trigger: SkillTrigger, reason?: string) => SkillActivationResult;
  deactivateSkill: (name: string, reason?: string) => SkillActivationResult;
};

export type ConfirmHook = (question: string, options?: string[]) => Promise<string>;
export type ExecutorHooks = { onConfirm?: ConfirmHook; onCommandConfirm?: CommandConfirmHook; onApproval?: ToolApprovalHook };
export type ExecutorSemanticHooks = {
  assistantCommitted(message: AssistantMessage, identity: { messageId: string; turn: number }): Promise<void>;
  toolStarted(call: ToolCall): Promise<void>;
  toolOutcome(message: ToolResultMessage, presentation: import('../shared/types.ts').ToolPresentation): Promise<void>;
  contextPrepared?(prepared: PreparedContext): Promise<void>;
  turnEnded?(event: { turn: number; toolCalls: ToolCall[]; finishReason: ModelResponse['finishReason'] }): Promise<void>;
};
export type ToolPolicy = {
  allow?: string[];
  deny?: string[];
  allowExternalMcp?: boolean;
  allowSkills?: boolean;
  allowOrchestration?: boolean;
};
export type RunStatus = 'completed' | 'aborted' | 'failed' | 'limited';
export type TerminationReason =
  | 'natural_completion'
  | 'user_abort'
  | 'model_failure'
  | 'invalid_model_response'
  | 'model_attempt_limit'
  | 'output_token_limit'
  | 'model_turn_limit';

export type LoopResult = {
  messages: ChatMessage[];
  finalContent: string;
  finalMessageId?: string;
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
  contextRefreshWarnings: Array<{ itemId: string; message: string }>;
  error?: { code: string; message: string };
};

export type ReActLoopOptions = {
  runId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  maxIterations?: number;
  maxModelAttempts?: number;
  maxRetriesPerTurn?: number;
  maxOutputTokens?: number;
  toolPolicy?: ToolPolicy;
  callerAgentId?: string;
  nonInteractive?: boolean;
  semantic?: ExecutorSemanticHooks;
  commandSource?: RunCommandSource;
  refreshDirective?: (directive: string) => Promise<{ systemSections: ContextSection[]; managedMemoryRefs?: import('../shared/types.ts').ManagedMemoryContextRef[] }>;
  presentation?: { emit(event: RunEventPayload): void };
  context?: {
    engine: ContextEngine;
    sessionId: string;
    activeRequest: string;
    systemSections: ContextSection[];
    policy: ContextPolicy;
    readArtifact: (input: { ref: string; offset?: number; limit?: number }) => Promise<unknown>;
    managedMemoryRefs?: import('../shared/types.ts').ManagedMemoryContextRef[];
  };
};

export type Executor = ReturnType<typeof createExecutor>;

const INITIAL_OUTPUT_TOKENS = 16_384;
const SECOND_OUTPUT_TOKENS = 32_768;
const MAX_RECOVERY_OUTPUT_TOKENS = 65_536;
const MAX_CONTINUATIONS = 3;
const CONTINUE_AFTER_LENGTH = 'Output token limit reached. Resume directly from the exact stopping point. Do not apologize, recap, or repeat completed content; keep the remaining work concise.';

function outputTokenBudgets(model: ModelClient, runMaximum?: number): number[] {
  const declaredInitial = model.outputTokenLimits?.initial ?? model.maxOutputTokens ?? INITIAL_OUTPUT_TOKENS;
  const declaredMaximum = model.outputTokenLimits?.maximum ?? model.maxOutputTokens ?? INITIAL_OUTPUT_TOKENS;
  const maximum = Math.max(1, Math.floor(Math.min(declaredMaximum, runMaximum ?? Number.POSITIVE_INFINITY, MAX_RECOVERY_OUTPUT_TOKENS)));
  const initial = Math.max(1, Math.floor(Math.min(INITIAL_OUTPUT_TOKENS, declaredInitial, maximum)));
  return [...new Set([initial, Math.min(SECOND_OUTPUT_TOKENS, maximum), maximum])].sort((left, right) => left - right);
}

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

function isOrphanEmptyAssistant(message: ChatMessage): boolean {
  return message.role === 'assistant'
    && message.content === null
    && (message.tool_calls?.length ?? 0) === 0;
}

const MAX_REASONING_PRESENTATION_CHARS = 64_000;

function committedAssistantMessage(response: ModelResponse, turn: number, messageId: string): CommittedAssistantMessage {
  const reasoning = response.reasoning.slice(0, MAX_REASONING_PRESENTATION_CHARS);
  const reasoningTruncated = reasoning.length < response.reasoning.length;
  const contentBlocks: CommittedAssistantMessage['contentBlocks'] = [
    ...(reasoning ? [{ contentIndex: 0, kind: 'reasoning' as const, content: reasoning, ...(reasoningTruncated ? { truncated: true } : {}) }] : []),
    ...(response.content ? [{ contentIndex: 1, kind: 'text' as const, content: response.content }] : []),
  ];
  return {
    messageId,
    turn,
    content: response.content,
    contentBlocks,
    toolCalls: response.toolCalls.map((call, index) => ({
      contentIndex: index + 2,
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
    finishReason: response.finishReason,
    ...(response.usage ? { usage: response.usage } : {}),
    ...(reasoningTruncated ? { truncated: true } : {}),
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
  presentation?: {
    messageId: string;
    emit(event: RunEventPayload): void;
    phase(phase: RunPhase): void;
  },
): AsyncIterable<ModelEvent> {
  for await (const event of events) {
    if (event.type === 'text_delta' && event.delta) {
      if (presentation) {
        presentation.phase('answering');
        presentation.emit({ type: 'assistant_content_delta', messageId: presentation.messageId, contentIndex: 1, kind: 'text', delta: event.delta });
      } else onEvent({ type: 'chunk', chunk: event.delta });
    } else if (event.type === 'reasoning_delta' && event.delta) {
      if (presentation) {
        presentation.phase('thinking');
        presentation.emit({ type: 'assistant_content_delta', messageId: presentation.messageId, contentIndex: 0, kind: 'reasoning', delta: event.delta });
      } else onEvent({ type: 'reasoning_chunk', chunk: event.delta });
    } else if (event.type === 'tool_call_delta' && event.argumentsDelta) {
      if (presentation) {
        presentation.phase('preparing_tool');
        presentation.emit({
          type: 'assistant_content_delta',
          messageId: presentation.messageId,
          contentIndex: event.index + 2,
          kind: 'tool_input',
          delta: event.argumentsDelta,
        });
      }
    }
    yield event;
  }
}

export function createExecutor(
  codingToolHost: CodingToolHost,
  externalMcpRegistry?: ExternalMcpRegistry,
  skillRegistry?: SkillRegistry,
  orchestration?: AgentOrchestrationPort,
) {
  const skillToolNames = new Set(SKILL_TOOL_DEFINITIONS.map((tool) => tool.function.name));

  function policyAllows(toolName: string, policy: ToolPolicy | undefined): boolean {
    if (!policy) return true;
    if (policy.deny?.includes(toolName)) return false;
    if (toolName.startsWith('mcp__') && policy.allowExternalMcp === false) return false;
    if (skillToolNames.has(toolName) && policy.allowSkills === false) return false;
    if (isAgentOrchestrationTool(toolName) && policy.allowOrchestration === false) return false;
    return !policy.allow || policy.allow.includes(toolName);
  }

  const toolFns: Record<string, (args: Record<string, unknown>) => unknown> = {
    read_file: ({ path }) => codingToolHost.readFile(path as string),
    write_file: ({ path, content }) => codingToolHost.writeFile(path as string, content as string),
    patch_file: ({ path, patch }) => codingToolHost.patchFile(path as string, patch as string),
    search_in_workspace: ({ query, path }) => codingToolHost.searchInWorkspace(query as string, path as string | undefined),
    run_command: ({ command, timeout_ms, run_in_background }) => codingToolHost.runCommand(command as string, {
      ...(typeof timeout_ms === 'number' ? { timeoutMs: timeout_ms } : {}),
      ...(typeof run_in_background === 'boolean' ? { runInBackground: run_in_background } : {}),
    }),
    read_command_output: ({ task_id, wait_ms }) => codingToolHost.readCommandOutput?.(String(task_id ?? ''), typeof wait_ms === 'number' ? wait_ms : undefined) ?? { error: 'read_command_output unavailable' },
    stop_command: ({ task_id }) => codingToolHost.stopCommand?.(String(task_id ?? '')) ?? { error: 'stop_command unavailable' },
    read_lints: ({ path }) => codingToolHost.readLints?.(path as string | undefined) ?? { error: 'read_lints unavailable' },
    diff_file: ({ path, snapshotId }) => codingToolHost.diffFile?.(path as string, snapshotId as string | undefined) ?? { error: 'diff_file unavailable' },
    list_workspace: () => codingToolHost.listWorkspace(),
    list_versions: () => codingToolHost.listVersions(),
    create_snapshot: ({ name, description }) => codingToolHost.createSnapshot(name as string | undefined, description as string | undefined),
    restore_snapshot: ({ snapshotId }) => codingToolHost.restoreSnapshot(snapshotId as string),
  };

  async function buildToolDefinitions(includeContextTools = false, policy?: ToolPolicy) {
    const local = skillRegistry && policy?.allowSkills !== false
      ? [...LOCAL_TOOL_DEFINITIONS, ...MEMORY_TOOL_DEFINITIONS, ...SKILL_TOOL_DEFINITIONS]
      : [...LOCAL_TOOL_DEFINITIONS, ...MEMORY_TOOL_DEFINITIONS];
    const enabled = codingToolHost.isToolEnabled
      ? local.filter((tool) => codingToolHost.isToolEnabled?.(tool.function.name))
      : local;
    const withOrchestration = orchestration && policy?.allowOrchestration !== false
      ? [...enabled, ...agentOrchestrationToolDefinitions(orchestration.definitions?.() ?? [])]
      : enabled;
    const builtIn = (includeContextTools ? [...withOrchestration, ...CONTEXT_TOOL_DEFINITIONS] : withOrchestration)
      .filter((tool) => policyAllows(tool.function.name, policy));
    if (policy?.allowExternalMcp === false || !externalMcpRegistry?.hasExternalTools()) return builtIn;
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
    })).filter((tool) => policyAllows(tool.function.name, policy))];
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
      // Keep the append-only ledger intact while projecting legacy invalid turns
      // out of provider requests. An empty assistant turn without tool calls is
      // not a valid Chat Completions history item and can make the next Run 400.
      const workingMessages = messages.filter((message) => !isOrphanEmptyAssistant(message));
      const loopMessages: ChatMessage[] = [];
      const toolsUsed: string[] = [];
      const filesModified: string[] = [];
      const fileChanges: FileDiff[] = [];
      const skillsUsed: string[] = [];
      let finalContent = '';
      let finalMessageId: string | undefined;
      let modelTurnCount = 0;
      let modelAttemptCount = 0;
      let usage: LoopResult['usage'] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, unknown: 0 };
      let latestInputTokens: number | undefined;
      let latestContextUsage: ContextUsageSnapshot | undefined;
      const contextSummaryUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const contextRefreshWarnings: Array<{ itemId: string; message: string }> = [];
      let forceSummaryNext = false;
      let currentDefinitions: Awaited<ReturnType<typeof buildToolDefinitions>> = [];
      let forkSnapshot: ChatMessage[] = [];
      const base = () => ({ messages: loopMessages, finalContent, ...(finalMessageId ? { finalMessageId } : {}), toolsUsed, filesModified, fileChanges, skillsUsed, modelTurnCount, modelAttemptCount, usage, latestInputTokens, latestContextUsage, contextSummaryUsage, contextRefreshWarnings });
      const maxTurns = options.maxIterations ?? Number.POSITIVE_INFINITY;
      const maxAttempts = options.maxModelAttempts
        ?? (Number.isFinite(maxTurns) ? maxTurns * (MAX_CONTINUATIONS + 3) : Number.POSITIVE_INFINITY);
      const maxRetries = options.maxRetriesPerTurn ?? 1;
      const sessionId = options.sessionId ?? options.context?.sessionId ?? '';

      const applySteer = async (decision: Extract<Awaited<ReturnType<RunCommandSource['atSafeBoundary']>>, { action: 'continue' }>) => {
        workingMessages.push(decision.steer);
        loopMessages.push(decision.steer);
        if (options.context) options.context.activeRequest = decision.directive;
        if (!options.refreshDirective) return;
        onEvent({ type: 'context_refresh_started', sessionId, runId, itemId: decision.itemId });
        try {
          const refreshed = await options.refreshDirective(decision.directive);
          if (options.context) {
            options.context.systemSections = refreshed.systemSections;
            options.context.managedMemoryRefs = refreshed.managedMemoryRefs;
          }
          else {
            const system = refreshed.systemSections.map((section) => section.content).join('\n\n');
            const existing = workingMessages.findIndex((message) => message.role === 'system');
            if (existing >= 0) workingMessages[existing] = { role: 'system', content: system };
            else workingMessages.unshift({ role: 'system', content: system });
          }
          onEvent({ type: 'context_refresh_completed', sessionId, runId, itemId: decision.itemId });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          contextRefreshWarnings.push({ itemId: decision.itemId, message });
          onEvent({ type: 'context_refresh_failed', sessionId, runId, itemId: decision.itemId, message });
        }
      };
      let activePhase: RunPhase | undefined;
      const emitPresentation = (event: RunEventPayload) => options.presentation?.emit(event);
      const emitPhase = (phase: RunPhase) => {
        if (!options.presentation || activePhase === phase) return;
        activePhase = phase;
        emitPresentation({ type: 'run_phase_changed', phase });
      };

      while (modelTurnCount < maxTurns) {
        if (signal.aborted) return aborted(base());
        modelTurnCount += 1;
        let retries = 0;
        let overflowRecovered = false;
        let recoverNext = false;
        let response: ModelResponse | undefined;
        const outputBudgets = outputTokenBudgets(modelClient, options.maxOutputTokens);
        let outputBudgetIndex = 0;
        let continuationCount = 0;
        let continuedContent = '';
        let continuedReasoning = '';
        const messageId = `${runId}:message:${modelTurnCount}`;
        let messageStarted = false;
        const resetDraft = () => {
          if (!options.presentation || !messageStarted) return;
          emitPresentation({ type: 'assistant_message_reset', messageId });
          if (continuedReasoning) emitPresentation({ type: 'assistant_content_delta', messageId, contentIndex: 0, kind: 'reasoning', delta: continuedReasoning });
          if (continuedContent) emitPresentation({ type: 'assistant_content_delta', messageId, contentIndex: 1, kind: 'text', delta: continuedContent });
        };
        while (!response) {
          if (modelAttemptCount >= maxAttempts) {
            return { ...base(), status: 'limited', terminationReason: 'model_attempt_limit' };
          }
          modelAttemptCount += 1;
          if (!options.presentation) onEvent({ type: 'task_status', taskId: runId, status: 'executing', note: `model attempt ${modelAttemptCount}` });
          const definitions = await buildToolDefinitions(Boolean(options.context), options.toolPolicy);
          currentDefinitions = definitions;
          let prepared: PreparedContext | undefined;
          const continuationMessages: ChatMessage[] = continuationCount > 0
            ? [
                ...(continuedContent ? [{ role: 'assistant' as const, content: continuedContent }] : []),
                { role: 'user', content: CONTINUE_AFTER_LENGTH },
              ]
            : [];
          const requestCanonicalMessages = continuationMessages.length > 0
            ? [...workingMessages, ...continuationMessages]
            : workingMessages;
          let requestMessages: ChatMessage[] = requestCanonicalMessages;
          if (options.context) {
            const prepareInput = {
              sessionId: options.context.sessionId,
              runId,
              turn: modelTurnCount,
              attempt: modelAttemptCount,
              activeRequest: options.context.activeRequest,
              systemSections: options.context.systemSections,
              canonicalMessages: requestCanonicalMessages,
              toolDefinitions: definitions,
              policy: { ...options.context.policy, maxOutputTokens: outputBudgets[outputBudgetIndex] },
              forceSummary: forceSummaryNext,
              signal,
              onActivity: (presentation: import('../shared/types.ts').ContextPresentation) => {
                if (options.presentation) emitPresentation({ type: 'context_activity_changed', presentation });
                else onEvent({ type: 'context_activity', presentation });
              },
              ...(options.context.managedMemoryRefs ? { managedMemoryRefs: options.context.managedMemoryRefs } : {}),
            };
            prepared = recoverNext
              ? await options.context.engine.recoverFromOverflow(prepareInput)
              : await options.context.engine.prepare(prepareInput);
            recoverNext = false;
            forceSummaryNext = false;
            await options.semantic?.contextPrepared?.(prepared);
            requestMessages = prepared.messages;
            latestContextUsage = prepared.usage;
            if (options.presentation) emitPresentation({ type: 'context_usage_changed', usage: prepared.usage });
            else onEvent({ type: 'context_usage', ...prepared.usage });
            if (prepared.activity && prepared.summaryRecord) {
              const contextPresentation = {
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
                } as const;
              if (options.presentation) emitPresentation({ type: 'context_activity_changed', presentation: contextPresentation });
              else onEvent({ type: 'context_activity', presentation: contextPresentation });
            }
            const summary = prepared.summaryRecord?.summaryUsage;
            if (summary) {
              contextSummaryUsage.inputTokens += summary.inputTokens ?? 0;
              contextSummaryUsage.outputTokens += summary.outputTokens ?? 0;
              contextSummaryUsage.totalTokens += summary.totalTokens ?? 0;
            }
          }
          emitPhase('requesting_model');
          if (options.presentation && !messageStarted) {
            messageStarted = true;
            emitPresentation({ type: 'assistant_message_started', turn: modelTurnCount, messageId });
          }
          forkSnapshot = structuredClone(requestMessages);
          const turn = await collectModelTurn(observeModelEvents(modelClient.streamMessage(requestMessages, {
            tools: definitions,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            max_tokens: outputBudgets[outputBudgetIndex],
            signal,
          }), onEvent, options.presentation ? { messageId, emit: emitPresentation, phase: emitPhase } : undefined));
          if (signal.aborted || (turn.status === 'failed' && turn.failure.category === 'cancelled')) {
            return aborted(base());
          }
          if (turn.status === 'failed') {
            if (turn.failure.category === 'context_overflow' && options.context && !overflowRecovered && !turn.producedSemanticOutput) {
              overflowRecovered = true;
              recoverNext = true;
              emitPhase('retrying');
              continue;
            }
            if (turn.failure.retryable && !turn.producedSemanticOutput && retries < maxRetries) {
              retries += 1;
              emitPhase('retrying');
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
            if (options.presentation) emitPresentation({ type: 'context_usage_changed', usage: latestContextUsage });
            else onEvent({ type: 'context_usage', ...latestContextUsage });
          } else if (prepared && options.context) {
            latestContextUsage = { ...prepared.usage, timing: 'last_request' };
            if (options.presentation) emitPresentation({ type: 'context_usage_changed', usage: latestContextUsage });
            else onEvent({ type: 'context_usage', ...latestContextUsage });
          }
          usage = usageSummary(usage, turn.response.usage);
          latestInputTokens = turn.response.usage?.inputTokens;
          if (turn.response.finishReason === 'length') {
            if (outputBudgetIndex < outputBudgets.length - 1) {
              outputBudgetIndex += 1;
              emitPhase('retrying');
              resetDraft();
              continue;
            }
            continuedContent += turn.response.content;
            continuedReasoning += turn.response.reasoning;
            if (continuationCount < MAX_CONTINUATIONS) {
              continuationCount += 1;
              emitPhase('retrying');
              resetDraft();
              continue;
            }
            response = { ...turn.response, content: continuedContent, reasoning: continuedReasoning, toolCalls: [] };
            continue;
          }
          response = continuedContent || continuedReasoning
            ? {
                ...turn.response,
                content: continuedContent + turn.response.content,
                reasoning: continuedReasoning + turn.response.reasoning,
              }
            : turn.response;
        }

        latestInputTokens = response.usage?.inputTokens ?? latestInputTokens;
        if (!options.context) {
          latestContextUsage = {
            ...(latestInputTokens !== undefined ? { usedTokens: latestInputTokens } : {}),
            ...(modelClient.contextWindow !== undefined ? { contextWindowTokens: modelClient.contextWindow } : {}),
            source: latestInputTokens !== undefined ? 'provider' : 'unknown',
            timing: 'last_request',
            asOfTurn: modelTurnCount,
            asOfAttempt: modelAttemptCount,
          };
          if (options.presentation) emitPresentation({ type: 'context_usage_changed', usage: latestContextUsage });
          else onEvent({ type: 'context_usage', ...latestContextUsage });
        }
        if (response.finishReason === 'length' && response.toolCalls.length === 0 && response.content.length === 0) {
          return { ...base(), status: 'limited', terminationReason: 'output_token_limit' };
        }
        finalContent = response.content || finalContent;
        const assistant = assistantMessage(response);
        await options.semantic?.assistantCommitted(assistant, { messageId, turn: modelTurnCount });
        emitPresentation({ type: 'assistant_message_committed', turn: modelTurnCount, message: committedAssistantMessage(response, modelTurnCount, messageId) });
        workingMessages.push(assistant);
        loopMessages.push(assistant);
        if (response.toolCalls.length === 0) {
          finalMessageId = messageId;
          await options.semantic?.turnEnded?.({ turn: modelTurnCount, toolCalls: [], finishReason: response.finishReason });
          if (response.finishReason === 'length') {
            return { ...base(), status: 'limited', terminationReason: 'output_token_limit' };
          }
          const decision = await options.commandSource?.atSafeBoundary({
            sessionId,
            runId,
            remainingModelTurns: maxTurns - modelTurnCount,
            wouldNaturallyComplete: true,
          }) ?? { action: 'finish' as const };
          if (decision.action === 'stop') return aborted(base());
          if (decision.action === 'continue') {
            if (modelTurnCount >= maxTurns) return { ...base(), status: 'limited', terminationReason: 'model_turn_limit' };
            await applySteer(decision);
            continue;
          }
          if (decision.action === 'proceed' && modelTurnCount >= maxTurns) {
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
          const semanticContextTool = toolName === 'compact_context' || isAgentOrchestrationTool(toolName);
          const policyDenied = !policyAllows(toolName, options.toolPolicy);
          const orchestrationInvalid = isAgentOrchestrationTool(toolName) ? validateOrchestrationToolInput(toolName, args) : undefined;
          const invalid = policyDenied
            ? `tool forbidden by policy: ${toolName}`
            : orchestrationInvalid ?? validationError(currentDefinitions, toolName, args);
          let toolRunning = false;
          const markToolRunning = () => {
            if (semanticContextTool || toolRunning) return;
            toolRunning = true;
            emitPhase('running_tool');
            if (options.presentation) {
              emitPresentation({
                type: 'tool_progress',
                callId: call.id,
                presentation: presentTool({ callRef: call.id, tool: toolName, args, status: 'running' }),
              });
            } else {
              onEvent({ type: 'tool_status', callId: call.id, tool: toolName, status: 'running' });
              onEvent({ type: 'tool_view', presentation: presentTool({ callRef: call.id, tool: toolName, args, status: 'running' }) });
            }
          };
          try {
            await options.semantic?.toolStarted(legacyCall);
            if (!semanticContextTool) {
              if (options.presentation) {
                emitPresentation({
                  type: 'tool_started',
                  callId: call.id,
                  presentation: presentTool({ callRef: call.id, tool: toolName, args, status: 'queued' }),
                });
              }
            }
            if (invalid) toolResult = policyDenied
              ? { status: 'blocked', code: 'blocked_by_policy', tool: toolName, reason: invalid }
              : { status: 'rejected', error: invalid };
            if (invalid) {
              // Rejected calls still receive a paired tool result but never reach an execution adapter.
            } else if (toolName === 'ask_user') {
              if (!onConfirm) toolResult = { status: 'blocked', code: 'approval_required', tool: toolName, reason: 'interactive confirmation is unavailable for this Agent' };
              else {
                if (!options.presentation) onEvent({ type: 'task_status', taskId: runId, status: 'waiting_confirm' });
                toolResult = { answer: await onConfirm(String(args.question ?? 'Please confirm'), Array.isArray(args.options) ? args.options.map(String) : undefined) };
              }
            } else if (toolName === 'read_artifact' && options.context) {
              markToolRunning();
              toolResult = await options.context.readArtifact({
                ref: String(args.ref ?? ''),
                ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
                ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
              });
            } else if (toolName === 'compact_context' && options.context) {
              toolResult = { status: 'scheduled', message: '上下文将在当前工具批次完成后整理' };
              forceSummaryNext = true;
            } else if (isAgentOrchestrationTool(toolName) && orchestration) {
              const caller = {
                sessionId,
                ...(options.callerAgentId ? { callerAgentId: options.callerAgentId } : {}),
                callerRunId: runId,
                toolCallId: call.id,
                delegationGroupId: `delegation-${runId}-${modelTurnCount}`,
                forkSnapshot: projectAgentFork(forkSnapshot, {
                  maxSegments: 4,
                  maxTokens: Math.max(1_000, Math.floor((modelClient.contextWindow ?? 32_000) * 0.25)),
                }).messages,
              };
              if (toolName === 'spawn_agent') {
                toolResult = await orchestration.spawn({
                  task: String(args.task),
                  ...(typeof args.agent === 'string' ? { agent: args.agent } : {}),
                  ...(typeof args.context_mode === 'string' ? { contextMode: args.context_mode as 'fresh' | 'fork' } : {}),
                  ...(typeof args.name === 'string' ? { name: args.name } : {}),
                  ...(typeof args.isolation === 'string' ? { isolation: args.isolation as 'shared' | 'worktree' } : {}),
                }, caller);
              } else if (toolName === 'wait_agent') {
                toolResult = await orchestration.wait({
                  agentIds: (args.agent_ids as unknown[]).map(String),
                  ...(typeof args.mode === 'string' ? { mode: args.mode as 'any' | 'all' } : {}),
                  ...(typeof args.timeout_ms === 'number' ? { timeoutMs: args.timeout_ms } : {}),
                }, caller);
              } else if (toolName === 'followup_agent') {
                toolResult = await orchestration.followup({ agentId: String(args.agent_id), task: String(args.task) }, caller);
              } else {
                toolResult = await orchestration.stop({ agentId: String(args.agent_id), ...(typeof args.reason === 'string' ? { reason: args.reason } : {}) }, caller);
              }
            } else if (isMemoryTool(toolName) && codingToolHost.executeManagedMemoryTool) {
              markToolRunning();
              toolResult = await codingToolHost.executeManagedMemoryTool(toolName, args, { runId, ...(options.sessionId ? { sessionId: options.sessionId } : {}), signal });
            } else if (toolName === 'list_skills' && skillRegistry) {
              markToolRunning();
              toolResult = { skills: skillRegistry.listSkills() };
              if (options.presentation) emitPresentation({ type: 'skill_activity', skill: '*', action: 'listed' });
              else onEvent({ type: 'skill', skill: '*', action: 'listed', summary: 'Listed available skills' });
            } else if (toolName === 'read_skill' && skillRegistry) {
              markToolRunning();
              const name = String(args.name ?? '');
              toolResult = skillRegistry.readSkill(name);
              if ((toolResult as SkillReadResult).ok) {
                if (options.presentation) emitPresentation({ type: 'skill_activity', skill: name, action: 'read' });
                else onEvent({ type: 'skill', skill: name, action: 'read', summary: `Loaded skill: ${name}` });
              }
            } else if (toolName === 'activate_skill' && skillRegistry) {
              markToolRunning();
              const name = String(args.name ?? '');
              const trigger = args.trigger === 'explicit' ? 'explicit' : 'implicit';
              toolResult = skillRegistry.activateSkill(name, trigger, typeof args.reason === 'string' ? args.reason : undefined);
              if ((toolResult as SkillActivationResult).ok) {
                if (!skillsUsed.includes(name)) skillsUsed.push(name);
                if (options.presentation) emitPresentation({ type: 'skill_activity', skill: name, action: 'activated' });
                else onEvent({ type: 'skill', skill: name, action: 'activated', trigger, summary: `Activated skill: ${name}` });
              }
            } else if (toolName === 'deactivate_skill' && skillRegistry) {
              markToolRunning();
              const name = String(args.name ?? '');
              toolResult = skillRegistry.deactivateSkill(name, typeof args.reason === 'string' ? args.reason : undefined);
              if (options.presentation) emitPresentation({ type: 'skill_activity', skill: name, action: 'deactivated' });
              else onEvent({ type: 'skill', skill: name, action: 'deactivated', summary: `Deactivated skill: ${name}` });
            } else {
              const fn = toolFns[toolName];
              if (fn) {
                if (codingToolHost.executeAgentTool) {
                  const execute = () => codingToolHost.executeAgentTool!(toolName, args, {
                    origin: 'agent',
                    onApproval,
                    nonInteractive: options.nonInteractive,
                    signal,
                    onEffectStart: markToolRunning,
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
                  markToolRunning();
                  toolResult = await codingToolHost.runCommand(String(args.command ?? ''), { onCommandConfirm, signal });
                } else if ((toolName === 'write_file' || toolName === 'patch_file') && typeof args.path === 'string') {
                  markToolRunning();
                  const captured = await captureFileDiff(codingToolHost.readFile, args.path, () => fn(args));
                  toolResult = captured.result;
                  fileDiff = captured.diff;
                  fileChanges.push(captured.diff);
                  filesModified.push(args.path);
                } else {
                  markToolRunning();
                  toolResult = await fn(args);
                }
              } else if (toolName.startsWith('mcp__') && externalMcpRegistry) {
                if (codingToolHost.executeAgentTool) {
                  toolResult = await codingToolHost.executeAgentTool(toolName, args, {
                    origin: 'agent',
                    onApproval,
                    nonInteractive: options.nonInteractive,
                    signal,
                    onEffectStart: markToolRunning,
                    executeExternal: (name, input, executionSignal) => externalMcpRegistry.callTool(name, input, executionSignal),
                  });
                } else if (!onConfirm) {
                  toolResult = { status: 'denied', error: 'external MCP tool requires an approval channel' };
                } else {
                  if (!options.presentation) onEvent({ type: 'task_status', taskId: runId, status: 'waiting_confirm' });
                  const decision = await onConfirm(`Allow external MCP tool ${toolName}?`, ['allow', 'deny']);
                  toolResult = decision === 'allow'
                    ? await (async () => { markToolRunning(); return externalMcpRegistry.callTool(toolName, args, signal); })()
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
            if (!options.presentation) onEvent({ type: 'tool_status', callId: call.id, tool: toolName, status: 'settled' });
          }
          const toolMessage: ToolResultMessage = {
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: stringifyToolResult(toolResult),
          };
          const presentation = presentTool({ callRef: call.id, tool: toolName, args, result: toolResult, fileDiff });
          if (!semanticContextTool && !options.presentation) onEvent({ type: 'tool_view', presentation });
          await options.semantic?.toolOutcome(toolMessage, presentation);
          if (!semanticContextTool && options.presentation) emitPresentation({ type: 'tool_finished', callId: call.id, presentation });
          workingMessages.push(toolMessage);
          loopMessages.push(toolMessage);
        }
        await options.semantic?.turnEnded?.({
          turn: modelTurnCount,
          toolCalls: response.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
          finishReason: response.finishReason,
        });
        const decision = await options.commandSource?.atSafeBoundary({
          sessionId,
          runId,
          remainingModelTurns: maxTurns - modelTurnCount,
          wouldNaturallyComplete: false,
        }) ?? { action: 'proceed' as const };
        if (decision.action === 'stop') return aborted(base());
        if (decision.action === 'continue') {
          if (modelTurnCount >= maxTurns) return { ...base(), status: 'limited', terminationReason: 'model_turn_limit' };
          await applySteer(decision);
        }
      }
      return { ...base(), status: 'limited', terminationReason: 'model_turn_limit' };
    },
  };
}
