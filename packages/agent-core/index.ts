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
import { createExecutor } from './executor.ts';
import type { ConfirmHook, ExecutorHooks, ExecutorSemanticHooks, LoopResult, ReActLoopOptions } from './executor.ts';
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
  parseExplicitInvocations,
} from '../skill-system/index.ts';

type PromptContext = {
  prompt: string;
  selectedFile: string | null;
  selectedFileContent: unknown;
  workspaceSummary: string;
  projectMemorySummary?: string;
  contextBudget: {
    includedFiles: string[];
    maxChars: number;
    maxFiles: number;
    strategy?: string;
  };
};

type CodingToolHost = Parameters<typeof createExecutor>[0] & {
  writeFile: (...args: any[]) => unknown;
};

type ContextManager = {
  buildForPrompt: (
    prompt: string,
    selectedFile?: string | null,
    options?: { projectMemory?: string },
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
  projectMemory: string,
  taskSummaries: TaskSummary[],
  skillsBlock = '',
  scope: SessionScope = { kind: 'general' },
): ContextSection[] {
  const parts = [
    scope.kind === 'workspace'
      ? 'You are DexCode, a coding agent responsible for tasks in this Session workspace.'
      : 'You are DexCode in general conversation mode. No workspace is attached, so workspace file and command tools are unavailable.',
    'Use ask_user only for destructive actions or decisions that cannot be safely inferred.',
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
  const memory = context.projectMemorySummary?.trim() || projectMemory.trim();
  if (memory) sections.push({ source: 'projectMemory', content: `## Project Memory\n${memory}` });
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

function summaryFor(prompt: string, result: LoopResult): string {
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
) {
  if (!environment) throw new Error('CodingAgent environment is required');
  const agentEnvironment = environment;
  const effectiveSkillRegistry = agentEnvironment.scope.kind === 'workspace' ? skillRegistry : undefined;
  const effectiveToolHost = agentEnvironment.scope.kind === 'general'
    ? { ...codingToolHost, isToolEnabled: () => false }
    : codingToolHost;
  const executor = createExecutor(effectiveToolHost, externalMcpRegistry, effectiveSkillRegistry);
  const contextStrategy = contextCompactionStrategy();
  const contextPolicy = contextStrategy === 'four_layer' ? defaultContextPolicy(modelClient) : undefined;
  const contextEngine = contextStrategy === 'four_layer' && sessionRepository ? createContextEngine({
    modelClient,
    artifactRepository: sessionRepository,
    lifecycle: {
      loadSession: (sessionId) => sessionRepository.loadSession(sessionId),
      beginContextCompaction: (input) => sessionRepository.beginContextCompaction(input),
      failContextCompaction: (input) => sessionRepository.failContextCompaction(input),
      recordContextProviderUsage: (input) => sessionRepository.recordContextProviderUsage(input),
    },
  }) : undefined;

  async function execute(
    runId: string,
    messages: ChatMessage[],
    onEvent: (event: AgentEvent) => void,
    hooks?: ConfirmHook | ExecutorHooks,
    signal?: AbortSignal,
    semantic?: ExecutorSemanticHooks,
    context?: ReActLoopOptions['context'],
    presentation?: ReActLoopOptions['presentation'],
  ) {
    return executor.runReActLoop(modelClient, messages, onEvent, hooks, { runId, signal, semantic, context, presentation });
  }

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
      clientRequestId?: string;
      onRunEvent?: (event: RunEventEnvelope) => void;
      legacyEvents?: boolean;
      presentationHooks?: (emit: (event: RunEventPayload) => void) => ExecutorHooks;
    } = {},
  ): Promise<TaskSummary> {
    if (!sessionRepository) throw new Error('sessionRepository is required for runTask');
    const session = await sessionRepository.loadSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
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
        ...(options.clientRequestId ? { clientRequestId: options.clientRequestId } : {}),
      });
    }
    publish({ type: 'run_started', sessionId, isNew: options.prestarted ?? false });
    publish({ type: 'run_phase_changed', phase: 'preparing_context' });
    let result: LoopResult;
    try {
      const projectMemory = await sessionRepository.readProjectMemory(
        agentEnvironment.scope.kind === 'workspace' ? agentEnvironment.scope.workspaceId : undefined,
      );
      const context = agentEnvironment.scope.kind === 'workspace'
        ? await contextManager.buildForPrompt(userPrompt, selectedFile, { projectMemory })
        : {
            prompt: userPrompt,
            selectedFile: null,
            selectedFileContent: null,
            workspaceSummary: '',
            projectMemorySummary: '',
            contextBudget: { includedFiles: [], maxChars: 0, maxFiles: 0, strategy: 'none' },
          };
      const systemSections = buildSystemSections(
        context,
        projectMemory,
        session.taskSummaries,
        skillsBlock(effectiveSkillRegistry, userPrompt),
        agentEnvironment.scope,
      );
      const historyMessages = options.prestarted
        && session.messages.at(-1)?.role === 'user'
        && session.messages.at(-1)?.content === userPrompt
        ? session.messages.slice(0, -1)
        : session.messages;
      const legacy = contextStrategy === 'legacy'
        ? projectLegacyHistory(runId, historyMessages)
        : undefined;
      if (legacy) {
        await sessionRepository.commitContext({
          sessionId,
          runId,
          manifest: legacy.manifest,
          ...(legacy.checkpoint ? { checkpoint: legacy.checkpoint } : {}),
        });
      }
      const executionMessages = legacy
        ? [{ role: 'system' as const, content: systemSections.map((section) => section.content).join('\n\n') }, ...legacy.messages, user]
        : pairedMessages([...historyMessages, user]);
      result = await execute(
        runId,
        executionMessages,
        onEvent,
        resolvedHooks,
        options.signal,
        {
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
        contextEngine && contextPolicy ? {
          engine: contextEngine,
          sessionId,
          activeRequest: userPrompt,
          systemSections,
          policy: contextPolicy,
          readArtifact: (input) => sessionRepository.readContextArtifact({ sessionId, ...input }),
        } : undefined,
        { emit: publish },
      );
    } catch (error) {
      result = {
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
        error: { code: 'RUN_INFRASTRUCTURE_FAILURE', message: error instanceof Error ? error.message : String(error) },
      };
    }
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
      contextSummaryUsage: result.contextSummaryUsage,
      ...(result.latestInputTokens !== undefined ? { latestInputTokens: result.latestInputTokens } : {}),
      ...(result.latestContextUsage ? { latestContextUsage: result.latestContextUsage } : {}),
      toolsUsed: taskSummary.toolsUsed,
      filesModified: taskSummary.filesModified,
      ...(result.error ? { error: result.error } : {}),
    };
    publish({ type: 'run_phase_changed', phase: 'finalizing' });
    const finished = await sessionRepository.finishRun({ sessionId, report, summary: taskSummary });
    const conversation = projectConversation(finished.session, { contextWindow: modelClient.contextWindow });
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
          projectMemorySummary: '',
          contextBudget: { includedFiles: [], maxChars: 0, maxFiles: 0, strategy: 'none' },
        };
    const system: SystemMessage = {
      role: 'system',
      content: buildSystemPrompt(context, '', [], skillsBlock(effectiveSkillRegistry, prompt), agentEnvironment.scope),
    };
    const onEvent = (event: AgentEvent) => onChunk?.(event);
    const result = await execute(crypto.randomUUID(), [system, { role: 'user', content: prompt }], onEvent, undefined, options.signal);
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

  return {
    runTask,
    preview,
  };
}
