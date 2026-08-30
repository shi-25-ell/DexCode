import { createSuccessResponse } from '../shared/index.ts';
import type {
  AgentEvent,
  ChatMessage,
  Session,
  SystemMessage,
  TaskSummary,
  UserMessage,
} from '../shared/types.ts';
import type { ModelClient } from '../llm-client/index.ts';
import { createExecutor } from './executor.ts';
import type { ConfirmHook, ExecutorHooks, LoopResult } from './executor.ts';
import type { CommandConfirmHook } from '../tool-gateway/run-command.ts';
import { createExternalMcpRegistry } from '../mcp-client/index.ts';
import { createTemplateGenerator } from '../template-generator/index.ts';
import type { TemplateParams } from '../template-generator/types.ts';
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

type SessionRepository = {
  loadSession: (id: string) => Promise<Session | null>;
  getOrCreateCurrentSession: () => Promise<Session>;
  appendMessages: (sessionId: string, messages: ChatMessage[]) => Promise<Session>;
  appendTaskSummary: (sessionId: string, summary: TaskSummary) => Promise<Session>;
  readProjectMemory: () => Promise<string>;
};

type ContextManager = {
  buildForPrompt: (
    prompt: string,
    selectedFile?: string | null,
    options?: { projectMemory?: string },
  ) => Promise<PromptContext>;
};

type SkillRegistry = ReturnType<typeof createSkillRegistry>;

function completeTurns(messages: ChatMessage[], maxCount = 40): ChatMessage[] {
  if (messages.length <= maxCount) return messages;
  const tail = messages.slice(-maxCount);
  const firstUser = tail.findIndex((message) => message.role === 'user');
  const candidate = firstUser >= 0 ? tail.slice(firstUser) : [];
  const knownCalls = new Set<string>();
  const result: ChatMessage[] = [];
  for (const message of candidate) {
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

function buildSystemPrompt(
  context: PromptContext,
  projectMemory: string,
  taskSummaries: TaskSummary[],
  skillsBlock = '',
): string {
  const parts = [
    'You are DexCode, a coding agent responsible for tasks in the active workspace.',
    'Before using normal tools, check Available Skills. If a skill directly matches, read and activate it before following its instructions.',
    'Use tools for file reads, writes, and commands. Do not fabricate tool results.',
    'For existing files, prefer patch_file. Use write_file only for new files or deliberate full rewrites.',
    'Use ask_user only for destructive actions or decisions that cannot be safely inferred.',
    'When the task is done, summarize results in concise Chinese.',
  ];
  if (skillsBlock.trim()) parts.push('', skillsBlock.trim());
  parts.push('', '## Workspace Summary', context.workspaceSummary || '(empty workspace)');
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
) {
  const executor = createExecutor(codingToolHost, externalMcpRegistry, skillRegistry);
  const templateGenerator = createTemplateGenerator();

  async function execute(
    runId: string,
    messages: ChatMessage[],
    onEvent: (event: AgentEvent) => void,
    hooks?: ConfirmHook | ExecutorHooks,
    signal?: AbortSignal,
  ) {
    return executor.runReActLoop(modelClient, messages, onEvent, hooks, { runId, signal });
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
    const runId = options.runId ?? crypto.randomUUID();
    const startedAt = new Date().toISOString();
    onEvent({ type: 'task_status', taskId: runId, status: 'planning' });
    const projectMemory = await sessionRepository.readProjectMemory();
    const context = await contextManager.buildForPrompt(userPrompt, selectedFile, { projectMemory });
    const system: SystemMessage = {
      role: 'system',
      content: buildSystemPrompt(context, projectMemory, session.taskSummaries, skillsBlock(skillRegistry, userPrompt)),
    };
    const user: UserMessage = { role: 'user', content: userPrompt };
    await sessionRepository.appendMessages(sessionId, [user]);
    const history = completeTurns(session.messages);
    const result = await execute(runId, [system, ...history, user], onEvent, hooks, options.signal);
    if (result.messages.length > 0) await sessionRepository.appendMessages(sessionId, result.messages);
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
    await sessionRepository.appendTaskSummary(sessionId, taskSummary);
    onEvent({
      type: 'task_status',
      taskId: runId,
      status: result.status === 'completed' ? 'done' : result.status === 'aborted' ? 'aborted' : 'error',
      note: result.terminationReason,
    });
    onEvent({ type: 'result', result: { ...taskSummary, output: result.finalContent, run: result } });
    return taskSummary;
  }

  async function preview(
    prompt: string,
    selectedFile: string | null = null,
    onChunk: ((chunk: unknown) => void) | null = null,
    options: { signal?: AbortSignal } = {},
  ) {
    const context = await contextManager.buildForPrompt(prompt, selectedFile);
    const system: SystemMessage = {
      role: 'system',
      content: buildSystemPrompt(context, '', [], skillsBlock(skillRegistry, prompt)),
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
    async generateScaffold(projectParams: TemplateParams, onChunk?: (chunk: unknown) => void) {
      const generated = templateGenerator.generateProject(projectParams.templateId, projectParams);
      for (const file of generated.files) {
        await codingToolHost.writeFile(file.path, file.content);
        onChunk?.({ type: 'tool', tool: 'write_file', summary: `Created file: ${file.path}` });
      }
      return createSuccessResponse({ status: 'scaffold_ok', scaffoldInfo: generated.scaffoldInfo, files: generated.files.map((file) => ({ path: file.path })), output: generated.summary });
    },
    getTemplates: () => templateGenerator.getTemplateList(),
    getTemplatesByCategory: (category: string) => templateGenerator.getTemplatesByCategory(category),
    getTemplateDetail: (templateId: string) => templateGenerator.getTemplateDetail(templateId),
    writeFile: (path: string, content: string) => codingToolHost.writeFile(path, content),
    runCommand: (command: string, ctx?: { onCommandConfirm?: CommandConfirmHook }) => codingToolHost.runCommand(command, ctx),
  };
}
