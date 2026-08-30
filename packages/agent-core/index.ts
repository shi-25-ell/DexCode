import { createSuccessResponse } from '../shared/index.ts';
import type {
  AgentEvent,
  ChatMessage,
  CompactionCheckpoint,
  ContextManifest,
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
import type { ConfirmHook, ExecutorHooks, ExecutorSemanticHooks, LoopResult } from './executor.ts';
import type { SessionRepository } from './session-contracts.ts';
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

function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

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

function messagePreview(message: ChatMessage): string {
  if (message.role === 'assistant') {
    const tools = message.tool_calls?.map((call) => call.function.name).join(', ');
    return `assistant: ${(message.content ?? '').slice(0, 600)}${tools ? ` [tools: ${tools}]` : ''}`;
  }
  if (message.role === 'tool') return `tool(${message.name}): ${message.content.slice(0, 400)}`;
  return `${message.role}: ${message.content.slice(0, 600)}`;
}

function projectHistory(runId: string, messages: ChatMessage[], maxEstimatedTokens = 12_000): {
  messages: ChatMessage[];
  manifest: ContextManifest;
  checkpoint?: CompactionCheckpoint;
} {
  const paired = pairedMessages(messages);
  const serialized = JSON.stringify(paired);
  const estimated = Math.ceil(serialized.length / 4);
  if (estimated <= maxEstimatedTokens) {
    return {
      messages: paired,
      manifest: {
        version: 1,
        id: crypto.randomUUID(),
        runId,
        estimatedInputTokens: estimated,
        selectedMessageCount: paired.length,
        omittedMessageCount: 0,
        requestDigest: digest(serialized),
      },
    };
  }

  const retainedCharBudget = Math.floor(maxEstimatedTokens * 4 * 0.65);
  let retainedChars = 0;
  let start = paired.length;
  while (start > 0 && retainedChars < retainedCharBudget) {
    start -= 1;
    retainedChars += JSON.stringify(paired[start]).length;
  }
  while (start < paired.length && paired[start]?.role !== 'user') start += 1;
  const retained = paired.slice(start);
  const omitted = paired.slice(0, start);
  const summary = omitted.map(messagePreview).join('\n').slice(0, 8_000);
  const checkpoint: CompactionCheckpoint = {
    version: 1,
    id: crypto.randomUUID(),
    sourceMessageCount: omitted.length,
    sourceDigest: digest(JSON.stringify(omitted)),
    summary,
    strategyVersion: 'deterministic-summary-v1',
  };
  const checkpointMessage: SystemMessage = {
    role: 'system',
    content: `## Previous conversation checkpoint\n${summary}`,
  };
  const selected = [checkpointMessage, ...retained];
  return {
    messages: selected,
    manifest: {
      version: 1,
      id: crypto.randomUUID(),
      runId,
      estimatedInputTokens: Math.ceil(JSON.stringify(selected).length / 4),
      selectedMessageCount: retained.length,
      omittedMessageCount: omitted.length,
      requestDigest: digest(JSON.stringify(selected)),
      checkpointId: checkpoint.id,
    },
    checkpoint,
  };
}

function buildSystemPrompt(
  context: PromptContext,
  projectMemory: string,
  taskSummaries: TaskSummary[],
  skillsBlock = '',
  scope: SessionScope = { kind: 'general' },
): string {
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
  if (scope.kind === 'workspace') {
    parts.push('', '## Workspace Summary', context.workspaceSummary || '(empty workspace)');
  }
  const memory = context.projectMemorySummary?.trim() || projectMemory.trim();
  if (memory) parts.push('', '## Project Memory', memory);
  const recent = taskSummaries.slice(-5);
  if (recent.length > 0) {
    parts.push('', '## Recent Tasks');
    for (const summary of recent) {
      parts.push(`- [${summary.startedAt.slice(0, 10)}] ${summary.prompt}: ${summary.summary}`);
    }
  }
  return parts.join('\n');
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

  async function execute(
    runId: string,
    messages: ChatMessage[],
    onEvent: (event: AgentEvent) => void,
    hooks?: ConfirmHook | ExecutorHooks,
    signal?: AbortSignal,
    semantic?: ExecutorSemanticHooks,
  ) {
    return executor.runReActLoop(modelClient, messages, onEvent, hooks, { runId, signal, semantic });
  }

  async function runTask(
    sessionId: string,
    userPrompt: string,
    selectedFile: string | null,
    onEvent: (event: AgentEvent) => void,
    hooks: ConfirmHook | ExecutorHooks,
    options: { runId?: string; signal?: AbortSignal } = {},
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
    const startedAt = new Date().toISOString();
    onEvent({ type: 'task_status', taskId: runId, status: 'planning' });
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
    const system: SystemMessage = {
      role: 'system',
      content: buildSystemPrompt(context, projectMemory, session.taskSummaries, skillsBlock(effectiveSkillRegistry, userPrompt), agentEnvironment.scope),
    };
    const user: UserMessage = { role: 'user', content: userPrompt };
    const history = projectHistory(runId, session.messages);
    await sessionRepository.beginRun({ sessionId, runId, userMessage: user, context: runContext });
    await sessionRepository.commitContext({ sessionId, runId, manifest: history.manifest, checkpoint: history.checkpoint });
    let result: LoopResult;
    try {
      result = await execute(
        runId,
        [system, ...history.messages, user],
        onEvent,
        hooks,
        options.signal,
        {
          assistantCommitted: (message) => sessionRepository.appendRunMessage({ sessionId, runId, message }).then(() => undefined),
          toolStarted: (call) => sessionRepository.markToolStarted({ sessionId, runId, callId: call.id, tool: call.function.name }).then(() => undefined),
          toolOutcome: (message) => sessionRepository.appendRunMessage({ sessionId, runId, message }).then(() => undefined),
        },
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
      startedAt,
      completedAt: taskSummary.completedAt,
      modelTurnCount: result.modelTurnCount,
      modelAttemptCount: result.modelAttemptCount,
      usage: result.usage,
      toolsUsed: taskSummary.toolsUsed,
      filesModified: taskSummary.filesModified,
      ...(result.error ? { error: result.error } : {}),
    };
    await sessionRepository.finishRun({ sessionId, report, summary: taskSummary });
    onEvent({
      type: 'task_status',
      taskId: runId,
      status: result.status === 'completed' ? 'done' : result.status === 'aborted' ? 'aborted' : 'error',
      note: result.terminationReason,
    });
    onEvent({ type: 'result', result: { ...taskSummary, output: result.finalContent, run: result, report } });
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
