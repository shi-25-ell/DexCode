import { createSuccessResponse } from '../shared/index.ts';
import type {
  AgentEvent,
  ChatMessage,
  RunReport,
  RunContext,
  Session,
  SessionScope,
  SystemMessage,
  TaskSummary,
  UserMessage,
} from '../shared/types.ts';
import type { ModelClient } from '../llm-client/index.ts';
import type { CodingToolHost, ConfirmHook, ExecutorHooks } from './executor.ts';
import { createAgentRuntime } from './agent-runtime.ts';
import type { AgentLifecycleHooks, AgentOrigin, AgentRunBudget, AgentRunResult } from './agent-runtime.ts';
import type { SessionRepository } from './session-contracts.ts';
import { projectConversation } from '../conversation-view/index.ts';
import {
  RunEventSequenceValidator,
  runEventToLegacy,
  safeRunNote,
  type RunEventEnvelope,
  type RunEventPayload,
} from '../run-protocol/index.ts';
import { createContextEngine, defaultContextPolicy, type ContextSection } from '../context-engine/index.ts';
import { contextCompactionStrategy, projectLegacyHistory } from './context-strategy.ts';
import { createExternalMcpRegistry } from '../mcp-client/index.ts';
import {
  buildAvailableSkillsBlock,
  createSkillRegistry,
  createAgentScopedSkillRegistry,
  parseExplicitInvocations,
} from '../skill-system/index.ts';
import type { RunCommandSource } from './run-commands.ts';
import type { ManagedMemoryCoordinator } from '../managed-memory/coordinator.ts';
import { MEMORY_TOOL_NAMES, isMemoryTool } from '../managed-memory/tools.ts';
import type { ManagedMemoryActor, MemoryPrefetch, PreparedManagedMemory } from '../managed-memory/contracts.ts';
import type { AgentOrchestrationPort, AgentRecord, AgentRunRecord } from '../agent-manager/contracts.ts';
import type { AgentPersistenceHooks } from './agent-runtime.ts';

function composeLifecycleHooks(...hooks: Array<AgentLifecycleHooks | undefined>): AgentLifecycleHooks {
  const active = hooks.filter((hook): hook is AgentLifecycleHooks => Boolean(hook));
  return {
    onAgentStart: async (event) => { for (const hook of active) await hook.onAgentStart?.(event); },
    onTurnEnd: async (event) => { for (const hook of active) await hook.onTurnEnd?.(event); },
    beforeToolCall: async (event) => { for (const hook of active) await hook.beforeToolCall?.(event); },
    afterToolCall: async (event) => { for (const hook of active) await hook.afterToolCall?.(event); },
    onAgentEnd: async (event) => { for (const hook of active) await hook.onAgentEnd?.(event); },
  };
}

type PromptContext = {
  prompt: string;
  selectedFile: string | null;
  selectedFileContent: unknown;
  workspaceSummary: string;
  projectKnowledgeSummary?: string;
  contextBudget: {
    includedFiles: string[];
    maxChars: number;
    maxFiles: number;
    strategy?: string;
  };
};

type ContextManager = {
  buildForPrompt: (
    prompt: string,
    selectedFile?: string | null,
    options?: { projectKnowledge?: string },
  ) => Promise<PromptContext>;
};

type SkillRegistry = ReturnType<typeof createSkillRegistry>;

function pairedMessages(messages: ChatMessage[]): ChatMessage[] {
  const knownCalls = new Set<string>();
  const result: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) knownCalls.add(call.id);
      result.push(message);
    } else if (message.role === 'tool') {
      if (knownCalls.has(message.tool_call_id)) result.push(message);
    } else {
      result.push(message);
    }
  }
  return result;
}

function buildSystemSections(
  context: PromptContext,
  projectKnowledge: string,
  taskSummaries: TaskSummary[],
  skillsBlock = '',
  scope: SessionScope = { kind: 'general' },
): ContextSection[] {
  const parts = [
    scope.kind === 'workspace'
      ? 'You are DexCode, a coding agent responsible for tasks in this Session workspace.'
      : 'You are DexCode in general conversation mode. No workspace is attached, so workspace file and command tools are unavailable.',
    'When a destructive action or consequential choice requires user input, ask in ordinary conversation instead of inventing a tool result.',
    'When the task is done, summarize results in concise Chinese.',
  ];
  if (scope.kind === 'workspace') {
    parts.splice(1, 0,
      'Before using normal tools, check Available Skills. If a skill directly matches, read and activate it before following its instructions.',
      'Use tools for file reads, writes, and commands. Do not fabricate tool results.',
      'For existing files, prefer patch_file. Use write_file only for new files or deliberate full rewrites.',
    );
  }
  if (skillsBlock.trim()) parts.push('', skillsBlock.trim());
  const sections: ContextSection[] = [{ source: 'systemPrompt', content: parts.join('\n') }];
  if (scope.kind === 'workspace') {
    sections.push({ source: 'workspaceCode', content: `## Workspace Summary\n${context.workspaceSummary || '(empty workspace)'}` });
  }
  const knowledge = context.projectKnowledgeSummary?.trim() || projectKnowledge.trim();
  if (knowledge) sections.push({ source: 'projectKnowledge', content: `## Project Knowledge\n${knowledge}` });
  const recent = taskSummaries.slice(-5);
  if (recent.length > 0) {
    const recentParts = ['## Recent Tasks'];
    for (const summary of recent) {
      recentParts.push(`- [${summary.startedAt.slice(0, 10)}] ${summary.prompt}: ${summary.summary}`);
    }
    sections.push({ source: 'systemPrompt', content: recentParts.join('\n') });
  }
  return sections;
}

function buildSystemPrompt(...args: Parameters<typeof buildSystemSections>): string {
  return buildSystemSections(...args).map((section) => section.content).join('\n\n');
}

function skillsBlock(registry: SkillRegistry | undefined, prompt: string): string {
  if (!registry) return '';
  return buildAvailableSkillsBlock(
    registry.listImplicitCandidates(),
    parseExplicitInvocations(prompt, registry.listSkills()),
  );
}

function summaryFor(prompt: string, result: AgentRunResult): string {
  const facts = [
    result.finalContent || `Task ${result.status}: ${result.terminationReason}`,
    result.filesModified.length > 0
      ? `Modified files: ${[...new Set(result.filesModified)].slice(0, 10).join(', ')}`
      : '',
    result.error ? `${result.error.code}: ${result.error.message}` : '',
  ].filter(Boolean);
  return facts.join('\n') || prompt;
}

export function createCodingAgent(
  contextManager: ContextManager,
  codingToolHost: CodingToolHost,
  modelClient: ModelClient,
  sessionRepository?: SessionRepository,
  externalMcpRegistry?: ReturnType<typeof createExternalMcpRegistry>,
  skillRegistry?: SkillRegistry,
  environment?: { scope: SessionScope; rootPath?: string },
  managedMemory?: ManagedMemoryCoordinator,
  extensions?: { orchestration?: AgentOrchestrationPort; resolveModel?: (model?: string) => ModelClient },
) {
  if (!environment) throw new Error('CodingAgent environment is required');
  const agentEnvironment = environment;
  const effectiveSkillRegistry = agentEnvironment.scope.kind === 'workspace' ? skillRegistry : undefined;
  const effectiveToolHost = agentEnvironment.scope.kind === 'general'
    ? { ...codingToolHost, isToolEnabled: () => false }
    : codingToolHost;
  const runtime = createAgentRuntime({
    toolHost: effectiveToolHost,
    modelClient,
    externalMcpRegistry,
    skillRegistry: effectiveSkillRegistry,
    orchestration: extensions?.orchestration,
  });
  const childSkillRegistries = new Map<string, ReturnType<typeof createAgentScopedSkillRegistry>>();
  const contextRuntimes = new Map<ModelClient, {
    policy?: ReturnType<typeof defaultContextPolicy>;
    engine?: ReturnType<typeof createContextEngine>;
  }>();
  const resolveModel = (model?: string) => extensions?.resolveModel?.(model) ?? modelClient;
  const contextRuntimeFor = (runModel: ModelClient) => {
    const existing = contextRuntimes.get(runModel);
    if (existing) return existing;
    const contextStrategy = contextCompactionStrategy();
    const runtimeContext = contextStrategy === 'four_layer' && sessionRepository ? {
      policy: defaultContextPolicy(runModel),
      engine: createContextEngine({
        modelClient: runModel,
        artifactRepository: sessionRepository,
        lifecycle: {
          loadSession: (sessionId: string) => sessionRepository.loadSession(sessionId),
          beginContextCompaction: (input) => sessionRepository.beginContextCompaction(input),
          failContextCompaction: (input) => sessionRepository.failContextCompaction(input),
          recordContextProviderUsage: (input) => sessionRepository.recordContextProviderUsage(input),
        },
      }),
    } : {};
    contextRuntimes.set(runModel, runtimeContext);
    return runtimeContext;
  };
  function withManagedMemoryTools(base: CodingToolHost, generation: number, actor: ManagedMemoryActor): CodingToolHost {
    if (!managedMemory) return base;
    return {
      ...base,
      isToolEnabled(name) {
        if (isMemoryTool(name)) return managedMemory.mode === 'on';
        return base.isToolEnabled?.(name) ?? true;
      },
      executeManagedMemoryTool(name, args, execution) {
        return managedMemory.executeTool(name, args, {
          workspaceId: managedMemory.workspaceId,
          actor,
          generation,
          runId: execution.runId,
          ...(execution.sessionId ? { sessionId: execution.sessionId } : {}),
        });
      },
    };
  }
  if (managedMemory) {
    managedMemory.setInternalRunner({
      run: (input) => runtime.runInternalAgent({
        runId: `memory-${crypto.randomUUID()}`,
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
        profile: 'memory',
        messages: input.messages,
        modelClient: input.modelClient,
        systemSections: input.systemSections,
        toolPolicy: { allow: [...MEMORY_TOOL_NAMES], allowExternalMcp: false, allowSkills: false },
        toolHost: withManagedMemoryTools(effectiveToolHost, input.generation, input.kind === 'extraction' ? 'memory-extractor' : 'memory-consolidator'),
        contextPolicy: { mode: 'isolated' },
        budget: { maxModelTurns: 5, maxModelAttempts: 6, maxRetriesPerTurn: 1 },
        signal: input.signal,
        productSessionId: input.sessionId,
      }),
    });
  }
  const contextStrategy = contextCompactionStrategy();

  async function runTask(
    sessionId: string,
    userPrompt: string,
    selectedFile: string | null,
    onEvent: (event: AgentEvent) => void,
    hooks: ConfirmHook | ExecutorHooks,
    options: {
      runId?: string;
      signal?: AbortSignal;
      prestarted?: boolean;
      isNew?: boolean;
      clientRequestId?: string;
      commandSource?: RunCommandSource;
      sourceItemId?: string;
      beforeFinish?: (result: { status: AgentRunResult['status'] }) => Promise<void>;
      onRunEvent?: (event: RunEventEnvelope) => void;
      legacyEvents?: boolean;
      presentationHooks?: (emit: (event: RunEventPayload) => void) => ExecutorHooks;
      lifecycle?: AgentLifecycleHooks;
      origin?: AgentOrigin;
      budget?: AgentRunBudget;
      model?: string;
    } = {},
  ): Promise<TaskSummary> {
    if (!sessionRepository) throw new Error('sessionRepository is required for runTask');
    const session = await sessionRepository.loadSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const runModel = resolveModel(options.model ?? session.selectedModel);
    const { policy: contextPolicy, engine: contextEngine } = contextRuntimeFor(runModel);
    const expectedScope = JSON.stringify(agentEnvironment.scope);
    if (JSON.stringify(session.scope) !== expectedScope) {
      throw new Error('Session scope does not match the Agent environment');
    }
    const runContext: RunContext = agentEnvironment.scope.kind === 'workspace'
      ? {
          scope: agentEnvironment.scope,
          workspace: {
            workspaceId: agentEnvironment.scope.workspaceId,
            rootPath: agentEnvironment.rootPath ?? '',
          },
        }
      : { scope: agentEnvironment.scope };
    if (agentEnvironment.scope.kind === 'workspace' && !runContext.workspace?.rootPath) {
      throw new Error('Workspace Agent environment requires a resolved root path');
    }
    const runId = options.runId ?? crypto.randomUUID();
    const sequence = new RunEventSequenceValidator(runId);
    let terminalPublished = false;
    const publish = (event: RunEventPayload) => {
      if (terminalPublished) throw new Error(`Run event emitted after terminal: ${event.type}`);
      const envelope: RunEventEnvelope = {
        version: 2,
        runId,
        seq: sequence.lastSeq + 1,
        at: new Date().toISOString(),
        event,
      };
      sequence.accept(envelope);
      options.onRunEvent?.(envelope);
      if (options.legacyEvents !== false) {
        for (const legacy of runEventToLegacy(envelope)) onEvent(legacy);
      }
      if (event.type === 'run_finished') terminalPublished = true;
    };
    const resolvedHooks = options.presentationHooks?.(publish) ?? hooks;
    const startedAt = new Date().toISOString();
    const user: UserMessage = { role: 'user', content: userPrompt };
    if (!options.prestarted) {
      await sessionRepository.beginRun({
        sessionId,
        runId,
        userMessage: user,
        context: runContext,
        profile: 'main',
        origin: 'user',
        model: runModel.model,
        ...(options.clientRequestId ? { clientRequestId: options.clientRequestId } : {}),
      });
    }
    publish({ type: 'run_started', sessionId, isNew: options.isNew ?? false, ...(options.sourceItemId ? { sourceItemId: options.sourceItemId } : {}) });
    publish({ type: 'run_phase_changed', phase: 'preparing_context' });
    let result: AgentRunResult;
    let managedMemoryRefs: import('../shared/types.ts').ManagedMemoryContextRef[] = [];
    let memoryPrefetch: MemoryPrefetch | undefined;
    const memoryController = new AbortController();
    const memorySignal = options.signal ? AbortSignal.any([options.signal, memoryController.signal]) : memoryController.signal;
    try {
      const projectKnowledge = await sessionRepository.readProjectKnowledge(
        agentEnvironment.scope.kind === 'workspace' ? agentEnvironment.scope.workspaceId : undefined,
      );
      const [context, preparedMemory] = await Promise.all([
        agentEnvironment.scope.kind === 'workspace'
          ? contextManager.buildForPrompt(userPrompt, selectedFile, { projectKnowledge })
          : Promise.resolve({
            prompt: userPrompt,
            selectedFile: null,
            selectedFileContent: null,
            workspaceSummary: '',
            projectKnowledgeSummary: '',
            contextBudget: { includedFiles: [], maxChars: 0, maxFiles: 0, strategy: 'none' },
          }),
        agentEnvironment.scope.kind === 'workspace' && managedMemory
          ? managedMemory.prepareRun({ workspaceId: agentEnvironment.scope.workspaceId, sessionId, runId, query: userPrompt, signal: memorySignal })
          : Promise.resolve<PreparedManagedMemory>({ enabled: false, generation: 0, sections: [], refs: [], recall: { candidateCount: 0, selectedCount: 0, selector: 'none', durationMs: 0 } }),
      ]);
      let systemSections = [...buildSystemSections(
        context,
        projectKnowledge,
        session.taskSummaries,
        skillsBlock(effectiveSkillRegistry, userPrompt),
        agentEnvironment.scope,
      ), ...preparedMemory.sections];
      managedMemoryRefs = preparedMemory.refs;
      memoryPrefetch = preparedMemory.prefetch;
      let memorySnapshot: { messages: ChatMessage[]; messageIds: Array<string | undefined> } | undefined;
      const pollContext = () => {
        const ready = memoryPrefetch?.takeReady();
        if (!ready) return undefined;
        systemSections = [...systemSections, ...ready.sections];
        managedMemoryRefs = [...managedMemoryRefs, ...ready.refs];
        return { systemSections, managedMemoryRefs };
      };
      const historyMessages = options.prestarted
        && session.messages.at(-1)?.role === 'user'
        && session.messages.at(-1)?.content === userPrompt
        ? session.messages.slice(0, -1)
        : session.messages;
      const legacy = contextStrategy === 'legacy'
        ? projectLegacyHistory(runId, historyMessages)
        : undefined;
      if (legacy) {
        if (preparedMemory.refs.length > 0) legacy.manifest.managedMemoryRefs = preparedMemory.refs;
        await sessionRepository.commitContext({
          sessionId,
          runId,
          manifest: legacy.manifest,
          ...(legacy.checkpoint ? { checkpoint: legacy.checkpoint } : {}),
        });
      }
      const executionMessages = legacy
        ? [...legacy.messages, user]
        : pairedMessages([...historyMessages, user]);
      const observedToolCalls = new Map<string, { name: string; input: unknown; outcome?: unknown }>();
      const memoryLifecycle: AgentLifecycleHooks | undefined = managedMemory && agentEnvironment.scope.kind === 'workspace' ? {
        beforeToolCall(event) {
          let input: unknown;
          try { input = JSON.parse(event.call.function.arguments); } catch { input = undefined; }
          observedToolCalls.set(event.call.id, { name: event.call.function.name, input });
        },
        afterToolCall(event) {
          const current = observedToolCalls.get(event.message.tool_call_id) ?? { name: event.message.name, input: undefined };
          try { current.outcome = JSON.parse(event.message.content); } catch { current.outcome = event.message.content; }
          observedToolCalls.set(event.message.tool_call_id, current);
        },
        onAgentEnd(event) {
          const snapshot = memorySnapshot;
          if (!snapshot) return;
          managedMemory.enqueueExtraction({
            workspaceId: agentEnvironment.scope.kind === 'workspace' ? agentEnvironment.scope.workspaceId : '',
            sessionId,
            runId,
            completedAt: event.result.completedAt,
            status: event.result.status,
            ...snapshot,
            modelClient: runModel,
            // The prepared system message is already in the snapshot, exactly as sent.
            systemSections: [],
            toolCalls: [...observedToolCalls.values()],
          });
        },
      } : undefined;
      const refreshDirective = async (directive: string) => {
        memoryPrefetch?.dispose();
        const [refreshedContext, refreshedMemory] = await Promise.all([
          agentEnvironment.scope.kind === 'workspace'
            ? contextManager.buildForPrompt(directive, null, { projectKnowledge })
            : Promise.resolve({
                prompt: directive,
                selectedFile: null,
                selectedFileContent: null,
                workspaceSummary: '',
                projectKnowledgeSummary: '',
                contextBudget: { includedFiles: [], maxChars: 0, maxFiles: 0, strategy: 'none' },
              }),
          agentEnvironment.scope.kind === 'workspace' && managedMemory
            ? managedMemory.prepareRun({ workspaceId: agentEnvironment.scope.workspaceId, sessionId, runId, query: directive, signal: memorySignal })
            : Promise.resolve<PreparedManagedMemory>({ enabled: false, generation: 0, sections: [], refs: [], recall: { candidateCount: 0, selectedCount: 0, selector: 'none', durationMs: 0 } }),
        ]);
        managedMemoryRefs = refreshedMemory.refs;
        memoryPrefetch = refreshedMemory.prefetch;
        systemSections = [...buildSystemSections(
            refreshedContext,
            projectKnowledge,
            session.taskSummaries,
            skillsBlock(effectiveSkillRegistry, directive),
            agentEnvironment.scope,
          ), ...refreshedMemory.sections];
        return { systemSections, managedMemoryRefs };
      };
      result = await runtime.runAgent({
        identity: { runId, profile: 'main', origin: options.origin ?? 'user' },
        messages: executionMessages,
        systemSections,
        persistence: 'session',
        persistenceHooks: {
          assistantCommitted: (message, identity) => sessionRepository.appendRunMessage({ sessionId, runId, message, ...identity }).then(() => undefined),
          toolStarted: (call) => {
            let input: Record<string, unknown> | undefined;
            try { input = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { input = undefined; }
            return sessionRepository.markToolStarted({ sessionId, runId, callId: call.id, tool: call.function.name, input }).then(() => undefined);
          },
          toolOutcome: (message, presentation) => sessionRepository.commitToolOutcome({ sessionId, runId, message, presentation }).then(() => undefined),
          contextPrepared: (prepared) => sessionRepository.commitContext({
            sessionId,
            runId,
            manifest: prepared.manifest,
            ...(prepared.summaryRecord ? { summaryRecord: prepared.summaryRecord } : {}),
            ...(prepared.activity ? { activity: prepared.activity } : {}),
          }).then(() => undefined),
        },
        budget: options.budget ?? {},
        signal: options.signal,
        productSessionId: sessionId,
        executorHooks: resolvedHooks,
        commandSource: options.commandSource,
        onContextSnapshot: managedMemory ? (snapshot) => { memorySnapshot = snapshot; } : undefined,
        pollContext,
        ...(contextStrategy === 'legacy' ? { refreshDirective } : {}),
        presentation: { emit: publish },
        onExecutorEvent: onEvent,
        lifecycle: composeLifecycleHooks(memoryLifecycle, options.lifecycle),
        metadata: { sessionId },
        toolPolicy: preparedMemory.enabled ? undefined : { deny: [...MEMORY_TOOL_NAMES] },
        toolHost: withManagedMemoryTools(effectiveToolHost, preparedMemory.generation, 'main-agent'),
        modelClient: runModel,
        contextPolicy: contextEngine && contextPolicy ? {
          mode: 'managed',
          engine: contextEngine,
          sessionId,
          activeRequest: userPrompt,
          policy: contextPolicy,
          readArtifact: (input) => sessionRepository.readContextArtifact({ sessionId, ...input }),
          managedMemoryRefs: preparedMemory.refs,
          refreshDirective,
        } : { mode: 'isolated' },
      });
    } catch (error) {
      result = {
        runId,
        profile: 'main',
        origin: options.origin ?? 'user',
        messages: [],
        finalContent: '',
        toolsUsed: [],
        filesModified: [],
        fileChanges: [],
        skillsUsed: [],
        status: options.signal?.aborted ? 'aborted' : 'failed',
        terminationReason: options.signal?.aborted ? 'user_abort' : 'model_failure',
        modelTurnCount: 0,
        modelAttemptCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, unknown: 0 },
        contextSummaryUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        contextRefreshWarnings: [],
        runtimeWarnings: [],
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: 0,
        error: { code: 'RUN_INFRASTRUCTURE_FAILURE', message: error instanceof Error ? error.message : String(error) },
      };
    } finally {
      memoryController.abort();
      memoryPrefetch?.dispose();
    }
    await options.beforeFinish?.({ status: result.status });
    const taskSummary: TaskSummary = {
      taskId: runId,
      prompt: userPrompt,
      startedAt,
      completedAt: new Date().toISOString(),
      status: result.status,
      summary: summaryFor(userPrompt, result),
      toolsUsed: [...new Set(result.toolsUsed)],
      filesModified: [...new Set(result.filesModified)],
      skillsUsed: [...new Set(result.skillsUsed)],
    };
    const report: RunReport = {
      version: 1,
      runId,
      model: runModel.model,
      context: runContext,
      status: result.status,
      terminationReason: result.terminationReason,
      ...(result.finalContent ? { finalAnswer: result.finalContent } : {}),
      ...(result.finalMessageId ? { finalMessageId: result.finalMessageId } : {}),
      startedAt,
      completedAt: taskSummary.completedAt,
      modelTurnCount: result.modelTurnCount,
      modelAttemptCount: result.modelAttemptCount,
      usage: result.usage,
      contextStrategy,
      ...(managedMemoryRefs.length > 0 ? { managedMemoryRefs } : {}),
      contextSummaryUsage: result.contextSummaryUsage,
      ...(result.latestInputTokens !== undefined ? { latestInputTokens: result.latestInputTokens } : {}),
      ...(result.latestContextUsage ? { latestContextUsage: result.latestContextUsage } : {}),
      toolsUsed: taskSummary.toolsUsed,
      filesModified: taskSummary.filesModified,
      ...(result.error ? { error: result.error } : {}),
      ...(result.contextRefreshWarnings.length > 0 ? { contextRefreshWarnings: result.contextRefreshWarnings } : {}),
      ...(result.runtimeWarnings.length > 0 ? { runtimeWarnings: result.runtimeWarnings } : {}),
    };
    publish({ type: 'run_phase_changed', phase: 'finalizing' });
    const finished = await sessionRepository.finishRun({ sessionId, report, summary: taskSummary });
    const conversation = projectConversation(finished.session, { contextWindow: runModel.contextWindow });
    publish({
      type: 'run_finished',
      terminal: {
        status: finished.report.status,
        reason: finished.report.terminationReason,
        ...(finished.report.error ? {
          error: {
            code: finished.report.error.code,
            message: safeRunNote(finished.report.error.message) ?? '运行失败',
          },
        } : {}),
      },
      conversationRevision: finished.session.revision ?? 0,
      ...(finished.report.finalMessageId ? { finalMessageId: finished.report.finalMessageId } : {}),
      conversation,
      legacyResult: { ...taskSummary, output: result.finalContent, run: result, report: finished.report, conversation },
    });
    return taskSummary;
  }

  async function preview(
    prompt: string,
    selectedFile: string | null = null,
    onChunk: ((chunk: unknown) => void) | null = null,
    options: { signal?: AbortSignal } = {},
  ) {
    const context = agentEnvironment.scope.kind === 'workspace'
      ? await contextManager.buildForPrompt(prompt, selectedFile)
      : {
          prompt,
          selectedFile: null,
          selectedFileContent: null,
          workspaceSummary: '',
          projectKnowledgeSummary: '',
          contextBudget: { includedFiles: [], maxChars: 0, maxFiles: 0, strategy: 'none' },
        };
    const system: SystemMessage = {
      role: 'system',
      content: buildSystemPrompt(context, '', [], skillsBlock(effectiveSkillRegistry, prompt), agentEnvironment.scope),
    };
    const onEvent = (event: AgentEvent) => onChunk?.(event);
    const result = await runtime.runAgent({
      identity: { profile: 'main', origin: 'user' },
      messages: [{ role: 'user', content: prompt }],
      systemSections: [{ source: 'systemPrompt', content: system.content }],
      persistence: 'none',
      toolPolicy: { deny: [...MEMORY_TOOL_NAMES] },
      budget: {},
      signal: options.signal,
      onExecutorEvent: onEvent,
    });
    return createSuccessResponse({
      status: result.status,
      model: modelClient.model,
      output: result.finalContent,
      toolsUsed: result.toolsUsed,
      filesModified: result.filesModified,
      skillsUsed: result.skillsUsed,
      terminationReason: result.terminationReason,
    });
  }

  async function runChild(input: {
    sessionId: string;
    agent: AgentRecord;
    run: AgentRunRecord;
    messages: ChatMessage[];
    persistenceHooks: AgentPersistenceHooks;
    signal: AbortSignal;
  }): Promise<AgentRunResult> {
    if (agentEnvironment.scope.kind !== 'workspace') throw new Error('Child Agents require a workspace');
    if (!sessionRepository) throw new Error('Child Agent persistence requires a Session repository');
    const projectKnowledge = input.agent.definitionSnapshot.memoryPolicy.read
      ? await sessionRepository.readProjectKnowledge(agentEnvironment.scope.workspaceId)
      : '';
    const context = await contextManager.buildForPrompt(input.run.input, null, { projectKnowledge });
    const session = await sessionRepository.loadSession(input.sessionId);
    if (!session) throw new Error(`Session not found: ${input.sessionId}`);
    const childModel = resolveModel(input.run.modelId ?? input.agent.modelId ?? session.selectedModel);
    const { policy: contextPolicy, engine: contextEngine } = contextRuntimeFor(childModel);
    const sections: ContextSection[] = [
      { source: 'systemPrompt', content: `You are a DexCode child Agent named ${input.agent.name}.\n${input.agent.definitionSnapshot.systemPrompt}\nDo not ask for interactive approval. If an operation is blocked, report it and continue safely.` },
      ...buildSystemSections(context, projectKnowledge, [], '', agentEnvironment.scope).slice(1),
    ];
    const preparedMemory: PreparedManagedMemory = managedMemory && input.agent.definitionSnapshot.memoryPolicy.read
      ? await managedMemory.prepareRun({ workspaceId: agentEnvironment.scope.workspaceId, sessionId: input.sessionId, contextOwnerId: `agent:${input.agent.agentId}`, runId: input.run.agentRunId, query: input.run.input, signal: input.signal })
      : { enabled: false, generation: 0, sections: [], refs: [], recall: { candidateCount: 0, selectedCount: 0, selector: 'none' as const, durationMs: 0 } };
    sections.push(...preparedMemory.sections);
    const childToolHost = withManagedMemoryTools(effectiveToolHost, preparedMemory.generation, 'child-agent');
    const childSkillRegistry = effectiveSkillRegistry && input.agent.definitionSnapshot.toolPolicy.allowSkills
      ? (childSkillRegistries.get(input.agent.agentId) ?? (() => {
          const registry = createAgentScopedSkillRegistry(effectiveSkillRegistry);
          childSkillRegistries.set(input.agent.agentId, registry);
          return registry;
        })())
      : undefined;
    const contextOwner = { kind: 'agent' as const, sessionId: input.sessionId, agentId: input.agent.agentId };
    const persistenceHooks: AgentPersistenceHooks = contextEngine && contextPolicy ? {
      ...input.persistenceHooks,
      contextPrepared: (prepared) => sessionRepository.commitContext({
        sessionId: input.sessionId,
        runId: input.run.agentRunId,
        manifest: prepared.manifest,
        ...(prepared.summaryRecord ? { summaryRecord: prepared.summaryRecord } : {}),
        ...(prepared.activity ? { activity: prepared.activity } : {}),
      }).then(() => undefined),
    } : input.persistenceHooks;
    return runtime.runAgent({
      identity: { runId: input.run.agentRunId, parentRunId: input.run.invokedByRunId, profile: 'child', origin: 'orchestrated' },
      messages: pairedMessages(input.messages),
      systemSections: sections,
      persistence: 'child',
      persistenceHooks,
      budget: input.agent.definitionSnapshot.budget,
      signal: input.signal,
      productSessionId: input.sessionId,
      toolPolicy: { ...input.agent.definitionSnapshot.toolPolicy, allowOrchestration: false },
      toolHost: childToolHost,
      skillRegistry: childSkillRegistry,
      modelClient: childModel,
      pollContext: () => {
        const ready = preparedMemory.prefetch?.takeReady();
        if (!ready) return undefined;
        sections.push(...ready.sections);
        preparedMemory.refs.push(...ready.refs);
        return { systemSections: sections, managedMemoryRefs: preparedMemory.refs };
      },
      contextPolicy: contextEngine && contextPolicy ? {
        mode: 'managed',
        engine: contextEngine,
        sessionId: input.sessionId,
        contextOwner,
        activeRequest: input.run.input,
        policy: contextPolicy,
        readArtifact: (artifactInput) => sessionRepository.readContextArtifact({ sessionId: input.sessionId, ...artifactInput }),
        managedMemoryRefs: preparedMemory.refs,
      } : { mode: 'isolated' },
      metadata: { sessionId: input.sessionId, agentId: input.agent.agentId },
    }).finally(() => preparedMemory.prefetch?.dispose());
  }

  return {
    runTask,
    runChild,
    preview,
  };
}

export { createAgentRuntime, INTERNAL_READONLY_TOOL_POLICY } from './agent-runtime.ts';
export type {
  AgentContextPolicy,
  AgentLifecycleHooks,
  AgentOrigin,
  AgentPersistencePolicy,
  AgentProfile,
  AgentRunBudget,
  AgentRunIdentity,
  AgentRunResult,
  AgentRunSpec,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeWarning,
  ToolPolicy,
} from './agent-runtime.ts';
