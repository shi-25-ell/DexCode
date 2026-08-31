import type { ContextEngine, ContextSection } from '../context-engine/index.ts';
import type { ModelClient } from '../llm-client/index.ts';
import type { AgentEvent, ChatMessage, ContextPolicy, FileDiff, ToolCall, ToolPresentation, ToolResultMessage } from '../shared/types.ts';
import type { RunEventPayload } from '../run-protocol/index.ts';
import {
  createExecutor,
  type CodingToolHost,
  type ConfirmHook,
  type ExecutorHooks,
  type ExecutorSemanticHooks,
  type ExternalMcpRegistry,
  type LoopResult,
  type ReActLoopOptions,
  type SkillRegistry,
  type ToolPolicy,
} from './executor.ts';
import type { RunCommandSource } from './run-commands.ts';
import type { AgentOrchestrationPort } from '../agent-manager/contracts.ts';

export type AgentProfile = 'main' | 'child' | 'memory' | 'internal' | 'internal-readonly';
export type AgentOrigin = 'user' | 'orchestrated' | 'internal';
export type AgentPersistencePolicy = 'session' | 'none' | 'child';

export type AgentRunIdentity = {
  runId: string;
  parentRunId?: string;
  profile: AgentProfile;
  origin: AgentOrigin;
};

export type AgentRunBudget = {
  maxModelTurns: number;
  maxModelAttempts?: number;
  maxRetriesPerTurn?: number;
  maxOutputTokens?: number;
};

export type AgentContextPolicy =
  | { mode: 'isolated' }
  | {
      mode: 'managed';
      engine: ContextEngine;
      sessionId: string;
      activeRequest: string;
      policy: ContextPolicy;
      readArtifact: (input: { ref: string; offset?: number; limit?: number }) => Promise<unknown>;
      refreshDirective?: (directive: string) => Promise<{ systemSections: ContextSection[]; managedMemoryRefs?: import('../shared/types.ts').ManagedMemoryContextRef[] }>;
      managedMemoryRefs?: import('../shared/types.ts').ManagedMemoryContextRef[];
    };

export type AgentRuntimeWarning = {
  stage: 'event' | 'agent_start' | 'turn_end' | 'before_tool_call' | 'after_tool_call' | 'agent_end';
  message: string;
};

export type AgentStartedEvent = {
  type: 'agent_start';
  identity: AgentRunIdentity;
  startedAt: string;
  metadata?: Record<string, unknown>;
};

export type AgentTurnEndedEvent = {
  type: 'turn_end';
  identity: AgentRunIdentity;
  turn: number;
  toolCalls: ToolCall[];
  finishReason: import('../llm-client/index.ts').ModelResponse['finishReason'];
};

export type AgentToolCallEvent = {
  type: 'tool_call_requested';
  identity: AgentRunIdentity;
  call: ToolCall;
};

export type AgentToolFinishedEvent = {
  type: 'tool_finished';
  identity: AgentRunIdentity;
  message: ToolResultMessage;
  presentation: ToolPresentation;
};

export type AgentEndedEvent = {
  type: 'agent_end';
  identity: AgentRunIdentity;
  result: AgentRunResult;
};

export type AgentRuntimeEvent =
  | AgentStartedEvent
  | AgentTurnEndedEvent
  | AgentToolCallEvent
  | AgentToolFinishedEvent
  | AgentEndedEvent;

export interface AgentLifecycleHooks {
  onAgentStart?(event: AgentStartedEvent): Promise<void> | void;
  onTurnEnd?(event: AgentTurnEndedEvent): Promise<void> | void;
  beforeToolCall?(event: AgentToolCallEvent): Promise<void> | void;
  afterToolCall?(event: AgentToolFinishedEvent): Promise<void> | void;
  /** Post-run extension hook. Internal Runs emit agent_end events but do not invoke this hook. */
  onAgentEnd?(event: AgentEndedEvent): Promise<void> | void;
}

export type AgentPersistenceHooks = Pick<
  ExecutorSemanticHooks,
  'assistantCommitted' | 'toolStarted' | 'toolOutcome' | 'contextPrepared'
>;

export interface AgentRunSpec {
  identity: {
    runId?: string;
    parentRunId?: string;
    profile: AgentProfile;
    origin: AgentOrigin;
  };
  messages: ChatMessage[];
  systemSections?: ContextSection[];
  toolPolicy?: ToolPolicy;
  contextPolicy?: AgentContextPolicy;
  persistence: AgentPersistencePolicy;
  persistenceHooks?: AgentPersistenceHooks;
  budget: AgentRunBudget;
  signal?: AbortSignal;
  productSessionId?: string;
  modelClient?: ModelClient;
  toolHost?: CodingToolHost;
  skillRegistry?: SkillRegistry;
  executorHooks?: ConfirmHook | ExecutorHooks;
  commandSource?: RunCommandSource;
  refreshDirective?: (directive: string) => Promise<{ systemSections: ContextSection[]; managedMemoryRefs?: import('../shared/types.ts').ManagedMemoryContextRef[] }>;
  presentation?: { emit(event: RunEventPayload): void };
  onExecutorEvent?: (event: AgentEvent) => void;
  onEvent?: (event: AgentRuntimeEvent) => Promise<void> | void;
  lifecycle?: AgentLifecycleHooks;
  metadata?: Record<string, unknown>;
}

export interface AgentRunResult {
  runId: string;
  parentRunId?: string;
  profile: AgentProfile;
  origin: AgentOrigin;
  status: LoopResult['status'];
  terminationReason: LoopResult['terminationReason'];
  finalContent: string;
  finalMessageId?: string;
  messages: ChatMessage[];
  modelTurnCount: number;
  modelAttemptCount: number;
  usage: LoopResult['usage'];
  toolsUsed: string[];
  filesModified: string[];
  fileChanges: FileDiff[];
  skillsUsed: string[];
  latestInputTokens?: number;
  latestContextUsage?: LoopResult['latestContextUsage'];
  contextSummaryUsage: LoopResult['contextSummaryUsage'];
  contextRefreshWarnings: LoopResult['contextRefreshWarnings'];
  runtimeWarnings: AgentRuntimeWarning[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error?: { code: string; message: string };
}

export const INTERNAL_READONLY_TOOL_POLICY: Readonly<ToolPolicy> = {
  allow: ['read_file', 'search_in_workspace', 'list_workspace'],
  allowExternalMcp: false,
  allowSkills: false,
};

type AgentRuntimeDependencies = {
  toolHost: CodingToolHost;
  modelClient: ModelClient;
  externalMcpRegistry?: ExternalMcpRegistry;
  skillRegistry?: SkillRegistry;
  orchestration?: AgentOrchestrationPort;
};

type InternalAgentRunSpec = Omit<
  AgentRunSpec,
  'identity' | 'persistence' | 'persistenceHooks' | 'toolPolicy' | 'budget'
> & {
  runId?: string;
  parentRunId?: string;
  profile?: Exclude<AgentProfile, 'main'>;
  toolPolicy?: ToolPolicy;
  budget?: Partial<AgentRunBudget>;
};

function failureLoopResult(error: unknown, signal?: AbortSignal): LoopResult {
  const aborted = signal?.aborted === true;
  return {
    messages: [],
    finalContent: '',
    toolsUsed: [],
    filesModified: [],
    fileChanges: [],
    skillsUsed: [],
    status: aborted ? 'aborted' : 'failed',
    terminationReason: aborted ? 'user_abort' : 'model_failure',
    modelTurnCount: 0,
    modelAttemptCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, unknown: 0 },
    contextSummaryUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    contextRefreshWarnings: [],
    error: {
      code: 'RUN_INFRASTRUCTURE_FAILURE',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function validateBudget(budget: AgentRunBudget): void {
  const positiveInteger = (name: string, value: number | undefined) => {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive integer`);
    }
  };
  positiveInteger('maxModelTurns', budget.maxModelTurns);
  positiveInteger('maxModelAttempts', budget.maxModelAttempts);
  positiveInteger('maxOutputTokens', budget.maxOutputTokens);
  if (budget.maxRetriesPerTurn !== undefined
    && (!Number.isInteger(budget.maxRetriesPerTurn) || budget.maxRetriesPerTurn < 0)) {
    throw new Error('maxRetriesPerTurn must be a non-negative integer');
  }
}

function systemMessage(sections: ContextSection[]): ChatMessage[] {
  const content = sections.map((section) => section.content.trim()).filter(Boolean).join('\n\n');
  return content ? [{ role: 'system', content }] : [];
}

export function createAgentRuntime(dependencies: AgentRuntimeDependencies) {
  async function runAgent(spec: AgentRunSpec): Promise<AgentRunResult> {
    if (spec.persistence === 'none' && spec.persistenceHooks) {
      throw new Error('persistenceHooks are not allowed when persistence is none');
    }
    if (spec.persistence !== 'none' && !spec.persistenceHooks) {
      throw new Error(`persistenceHooks are required when persistence is ${spec.persistence}`);
    }
    validateBudget(spec.budget);

    const identity: AgentRunIdentity = {
      runId: spec.identity.runId ?? crypto.randomUUID(),
      ...(spec.identity.parentRunId ? { parentRunId: spec.identity.parentRunId } : {}),
      profile: spec.identity.profile,
      origin: spec.identity.origin,
    };
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const runtimeWarnings: AgentRuntimeWarning[] = [];
    const warn = (stage: AgentRuntimeWarning['stage'], error: unknown) => {
      runtimeWarnings.push({ stage, message: error instanceof Error ? error.message : String(error) });
    };
    const safe = async (stage: AgentRuntimeWarning['stage'], action: (() => Promise<void> | void) | undefined) => {
      if (!action) return;
      try { await action(); } catch (error) { warn(stage, error); }
    };
    const emit = (event: AgentRuntimeEvent) => safe('event', () => spec.onEvent?.(event));

    const startedEvent: AgentStartedEvent = {
      type: 'agent_start',
      identity,
      startedAt,
      ...(spec.metadata ? { metadata: spec.metadata } : {}),
    };
    await emit(startedEvent);
    await safe('agent_start', () => spec.lifecycle?.onAgentStart?.(startedEvent));

    const persistence = spec.persistenceHooks;
    const semantic: ExecutorSemanticHooks = {
      assistantCommitted: async (message, messageIdentity) => {
        await persistence?.assistantCommitted(message, messageIdentity);
      },
      toolStarted: async (call) => {
        await persistence?.toolStarted(call);
        const event: AgentToolCallEvent = { type: 'tool_call_requested', identity, call };
        await emit(event);
        await safe('before_tool_call', () => spec.lifecycle?.beforeToolCall?.(event));
      },
      toolOutcome: async (message, presentation) => {
        await persistence?.toolOutcome(message, presentation);
        const event: AgentToolFinishedEvent = { type: 'tool_finished', identity, message, presentation };
        await emit(event);
        await safe('after_tool_call', () => spec.lifecycle?.afterToolCall?.(event));
      },
      contextPrepared: persistence?.contextPrepared
        ? (prepared) => persistence.contextPrepared!(prepared)
        : undefined,
      turnEnded: async ({ turn, toolCalls, finishReason }) => {
        const event: AgentTurnEndedEvent = { type: 'turn_end', identity, turn, toolCalls, finishReason };
        await emit(event);
        await safe('turn_end', () => spec.lifecycle?.onTurnEnd?.(event));
      },
    };

    const contextPolicy = spec.contextPolicy ?? { mode: 'isolated' as const };
    const sections = spec.systemSections ?? [];
    const messages = contextPolicy.mode === 'managed'
      ? [...spec.messages]
      : [...systemMessage(sections), ...spec.messages];
    const modelClient = spec.modelClient ?? dependencies.modelClient;
    const executor = createExecutor(
      spec.toolHost ?? dependencies.toolHost,
      dependencies.externalMcpRegistry,
      spec.skillRegistry ?? dependencies.skillRegistry,
      dependencies.orchestration,
    );

    let loop: LoopResult;
    try {
      loop = await executor.runReActLoop(
        modelClient,
        messages,
        spec.onExecutorEvent ?? (() => {}),
        spec.executorHooks,
        {
          runId: identity.runId,
          sessionId: spec.productSessionId,
          signal: spec.signal,
          maxIterations: spec.budget.maxModelTurns,
          maxModelAttempts: spec.budget.maxModelAttempts,
          maxRetriesPerTurn: spec.budget.maxRetriesPerTurn,
          maxOutputTokens: spec.budget.maxOutputTokens,
          toolPolicy: spec.toolPolicy,
          nonInteractive: identity.origin === 'orchestrated',
          semantic,
          commandSource: spec.commandSource,
          presentation: spec.presentation,
          refreshDirective: contextPolicy.mode === 'managed' ? contextPolicy.refreshDirective : spec.refreshDirective,
          ...(contextPolicy.mode === 'managed' ? {
            sessionId: spec.productSessionId ?? contextPolicy.sessionId,
            context: {
              engine: contextPolicy.engine,
              sessionId: contextPolicy.sessionId,
              activeRequest: contextPolicy.activeRequest,
              systemSections: sections,
              policy: contextPolicy.policy,
              readArtifact: contextPolicy.readArtifact,
              ...(contextPolicy.managedMemoryRefs ? { managedMemoryRefs: contextPolicy.managedMemoryRefs } : {}),
            },
          } : {}),
        },
      );
    } catch (error) {
      loop = failureLoopResult(error, spec.signal);
    }

    const completedAt = new Date().toISOString();
    const result: AgentRunResult = {
      runId: identity.runId,
      ...(identity.parentRunId ? { parentRunId: identity.parentRunId } : {}),
      profile: identity.profile,
      origin: identity.origin,
      status: loop.status,
      terminationReason: loop.terminationReason,
      finalContent: loop.finalContent,
      ...(loop.finalMessageId ? { finalMessageId: loop.finalMessageId } : {}),
      messages: loop.messages,
      modelTurnCount: loop.modelTurnCount,
      modelAttemptCount: loop.modelAttemptCount,
      usage: loop.usage,
      toolsUsed: [...new Set(loop.toolsUsed)],
      filesModified: [...new Set(loop.filesModified)],
      fileChanges: loop.fileChanges,
      skillsUsed: [...new Set(loop.skillsUsed)],
      ...(loop.latestInputTokens !== undefined ? { latestInputTokens: loop.latestInputTokens } : {}),
      ...(loop.latestContextUsage ? { latestContextUsage: loop.latestContextUsage } : {}),
      contextSummaryUsage: loop.contextSummaryUsage,
      contextRefreshWarnings: loop.contextRefreshWarnings,
      runtimeWarnings,
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.now() - startedMs),
      ...(loop.error ? { error: loop.error } : {}),
    };
    const endedEvent: AgentEndedEvent = { type: 'agent_end', identity, result };
    await emit(endedEvent);
    if (identity.origin === 'user') {
      await safe('agent_end', () => spec.lifecycle?.onAgentEnd?.(endedEvent));
    }
    return result;
  }

  function runInternalAgent(spec: InternalAgentRunSpec): Promise<AgentRunResult> {
    return runAgent({
      ...spec,
      identity: {
        ...(spec.runId ? { runId: spec.runId } : {}),
        ...(spec.parentRunId ? { parentRunId: spec.parentRunId } : {}),
        profile: spec.profile ?? 'internal-readonly',
        origin: 'internal',
      },
      persistence: 'none',
      toolPolicy: spec.toolPolicy ?? { ...INTERNAL_READONLY_TOOL_POLICY, allow: [...(INTERNAL_READONLY_TOOL_POLICY.allow ?? [])] },
      budget: {
        maxModelTurns: spec.budget?.maxModelTurns ?? 5,
        ...(spec.budget?.maxModelAttempts !== undefined ? { maxModelAttempts: spec.budget.maxModelAttempts } : {}),
        ...(spec.budget?.maxRetriesPerTurn !== undefined ? { maxRetriesPerTurn: spec.budget.maxRetriesPerTurn } : {}),
        ...(spec.budget?.maxOutputTokens !== undefined ? { maxOutputTokens: spec.budget.maxOutputTokens } : {}),
      },
    });
  }

  return { runAgent, runInternalAgent };
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
export type { ToolPolicy } from './executor.ts';
