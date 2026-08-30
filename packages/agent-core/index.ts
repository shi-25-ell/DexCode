import { createSuccessResponse } from "../shared/index.ts";
import type {
  AgentEvent,
  ChatMessage,
  Session,
  SystemMessage,
  TaskSummary,
  UserMessage,
} from "../shared/types.ts";
import type { ModelClient } from "../llm-client/index.ts";
import { createExecutor } from "./executor.ts";
import { createOrchestrator } from "./orchestrator.ts";
import type { ConfirmHook, ExecutorHooks } from "./executor.ts";
import type { CommandConfirmHook } from "../tool-gateway/run-command.ts";
import { createSummarizer } from "./summarizer.ts";
import { createExternalMcpRegistry } from "../mcp-client/index.ts";
import { createTemplateGenerator } from "../template-generator/index.ts";
import type { TemplateParams } from "../template-generator/types.ts";
import { buildAvailableSkillsBlock, createSkillRegistry, parseExplicitInvocations } from "../skill-system/index.ts";

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

type CodingToolHost = {
  readFile: (...args: any[]) => unknown;
  writeFile: (...args: any[]) => unknown;
  runCommand: (...args: any[]) => unknown;
  listWorkspace: (...args: any[]) => unknown;
  searchInWorkspace: (...args: any[]) => unknown;
  patchFile: (...args: any[]) => unknown;
  listVersions: (...args: any[]) => unknown;
  createSnapshot: (...args: any[]) => unknown;
  restoreSnapshot: (...args: any[]) => unknown;
};

type SessionRepository = {
  loadSession: (id: string) => Promise<Session | null>;
  getOrCreateCurrentSession: () => Promise<Session>;
  appendMessages: (sessionId: string, messages: ChatMessage[]) => Promise<Session>;
  appendTaskSummary: (sessionId: string, summary: TaskSummary) => Promise<Session>;
  readProjectMemory: () => Promise<string>;
};

type ContextManager = {
  buildForPrompt: (prompt: string, selectedFile?: string | null, options?: { projectMemory?: string }) => Promise<PromptContext>;
};

type SkillRegistry = ReturnType<typeof createSkillRegistry>;

function truncateMessages(messages: ChatMessage[], maxCount = 40): ChatMessage[] {
  if (messages.length <= maxCount) return messages;
  const tail = messages.slice(-maxCount);
  const firstUser = tail.findIndex((m) => m.role === 'user');
  return firstUser > 0 ? tail.slice(firstUser) : tail;
}

function sanitizeHistoryForNewRun(messages: ChatMessage[]): ChatMessage[] {
  const sanitized: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') continue;
    if (message.role === 'assistant' && message.content === null) continue;
    sanitized.push(message);
  }
  return sanitized;
}

function buildProjectMemorySuggestion(prompt: string, toolsUsed: string[], filesModified: string[]): string {
  const facts: string[] = [];
  if (filesModified.length > 0) {
    facts.push(`modified files: ${filesModified.slice(0, 5).join(', ')}`);
  }
  if (toolsUsed.length > 0) {
    facts.push(`tools used: ${[...new Set(toolsUsed)].slice(0, 5).join(', ')}`);
  }
  if (facts.length === 0) return '';
  return `Project memory suggestion: if reusable, save this task experience: ${prompt}; ${facts.join('; ')}.`;
}

function buildSystemPrompt(
  context: PromptContext,
  projectMemory: string,
  taskSummaries: TaskSummary[],
  skillsBlock = '',
): string {
  const parts = [
    'You are DexCode, a coding agent responsible for tasks in the active workspace.',
    'Before using normal tools, check Available Skills. If a skill description directly matches the task, call read_skill first, then activate_skill if applicable, and follow SKILL.md. Use normal tools directly only when no skill matches.',
  ];

  if (skillsBlock.trim()) {
    parts.push('', skillsBlock.trim());
  }

  parts.push(
    'Use tools for file reads, writes, and commands. Do not fabricate tool results.',
    'For existing files, prefer patch_file. Use write_file only for new files, full rewrites, or failed patches.',
    'Use search_in_workspace when you need to locate a target first.',
    'External MCP tools may be called by their mcp__server__tool names when available.',
    'When the task is done, summarize results in concise Chinese.',
    'Use ask_user only for destructive actions or uncertain decisions.',
    'run_command may request confirmation for non-whitelisted commands; prefer read_lints for static checks and diff_file for file history.',
    '',
    '## Workspace Summary',
    context.workspaceSummary || '(empty workspace)',
  );

  const retrievedMemory = context.projectMemorySummary?.trim() || projectMemory.trim();
  if (retrievedMemory) {
    parts.push('', '## Project Memory', retrievedMemory);
  }

  const recentSummaries = taskSummaries.slice(-5);
  if (recentSummaries.length > 0) {
    parts.push('', '## Recent Tasks');
    for (const s of recentSummaries) {
      const date = s.startedAt.slice(0, 10);
      parts.push(`- [${date}] ${s.prompt}: ${s.summary}`);
    }
  }

  return parts.join('\n');
}
function buildSkillsBlock(skillRegistry: SkillRegistry | undefined, prompt: string): string {
  if (!skillRegistry) return '';
  const skillSummaries = skillRegistry.listImplicitCandidates();
  const explicitSkillInvocations = parseExplicitInvocations(prompt, skillRegistry.listSkills());
  return buildAvailableSkillsBlock(skillSummaries, explicitSkillInvocations);
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
  const orchestrator = createOrchestrator(codingToolHost, executor, modelClient);
  const summarizer = createSummarizer();
  const templateGenerator = createTemplateGenerator();

  // 带会话持久化的主任务入口。
  async function runTask(
    sessionId: string,
    userPrompt: string,
    selectedFile: string | null,
    onEvent: (event: AgentEvent) => void,
    hooks: ConfirmHook | ExecutorHooks,
  ): Promise<TaskSummary> {
    if (!sessionRepository) throw new Error('sessionRepository is required for runTask');

    const session = await sessionRepository.loadSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const taskId = `task-${Date.now()}`;
    const startedAt = new Date().toISOString();

    onEvent({ type: 'task_status', taskId, status: 'planning' });

    const projectMemory = await sessionRepository.readProjectMemory();
    const context = await contextManager.buildForPrompt(userPrompt, selectedFile, { projectMemory });
    const skillsBlock = buildSkillsBlock(skillRegistry, userPrompt);

    const systemMsg: SystemMessage = {
      role: 'system',
      content: buildSystemPrompt(context, projectMemory, session.taskSummaries, skillsBlock),
    };

    const userMsg: UserMessage = { role: 'user', content: userPrompt };

    await sessionRepository.appendMessages(sessionId, [userMsg]);

    const history = truncateMessages(sanitizeHistoryForNewRun(session.messages));
    const llmMessages: ChatMessage[] = [systemMsg, ...history, userMsg];

    onEvent({ type: 'task_status', taskId, status: 'executing' });

    const loopResult = await orchestrator.run(taskId, userPrompt, llmMessages, onEvent, hooks);

    await sessionRepository.appendMessages(sessionId, loopResult.messages);

    onEvent({ type: 'task_status', taskId, status: 'summarizing' });
    const reviewNotes = [
      `Review passed: ${loopResult.review.passed}`,
      ...loopResult.review.issues.map((issue) => `${issue.severity}: ${issue.file} ${issue.description}`),
      ...loopResult.review.suggestions,
    ];
    const summaryText = summarizer.summarize({
      plan: { goal: userPrompt, selectedFile },
      execution: { content: loopResult.finalContent },
      review: { summary: loopResult.finalContent, notes: reviewNotes },
    });
    const memorySuggestion = buildProjectMemorySuggestion(
      userPrompt,
      loopResult.toolsUsed,
      loopResult.filesModified,
    );

    const taskSummary: TaskSummary = {
      taskId,
      prompt: userPrompt,
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'completed',
      summary: memorySuggestion ? `${summaryText}\n\n${memorySuggestion}` : summaryText,
      toolsUsed: loopResult.toolsUsed,
      filesModified: loopResult.filesModified,
      skillsUsed: loopResult.skillsUsed,
      trace: loopResult.trace,
    };

    await sessionRepository.appendTaskSummary(sessionId, taskSummary);

    onEvent({ type: 'task_status', taskId, status: 'done' });
    onEvent({ type: 'result', result: taskSummary });

    return taskSummary;
  }

  // 无会话持久化的兼容入口。
  async function preview(
    prompt: string,
    selectedFile: string | null = null,
    onChunk: ((chunk: unknown) => void) | null = null,
  ) {
    const context = await contextManager.buildForPrompt(prompt, selectedFile);
    const skillsBlock = buildSkillsBlock(skillRegistry, prompt);

    if (modelClient.model === 'mock') {
      const fallback = 'Understood request; built context; generated or edited files; ran verification; returned result.';
      if (onChunk) onChunk(fallback);
      return createSuccessResponse({ status: 'mocked', output: fallback, context });
    }

    const systemMsg: SystemMessage = {
      role: 'system',
      content: buildSystemPrompt(context, '', [], skillsBlock),
    };
    const userMsg: UserMessage = { role: 'user', content: prompt };
    const messages: ChatMessage[] = [systemMsg, userMsg];

    const onEvent = (event: AgentEvent) => { if (onChunk) onChunk(event); };

    const loopResult = await executor.runReActLoop(modelClient, messages, onEvent);

    const toolResults = loopResult.messages
      .filter((m) => m.role === 'tool')
      .map((m) => ({ name: (m as { name: string }).name, result: { ok: true } }));

    return createSuccessResponse({
      status: 'ok',
      model: modelClient.model,
      output: loopResult.finalContent,
      toolsUsed: loopResult.toolsUsed,
      filesModified: loopResult.filesModified,
      skillsUsed: loopResult.skillsUsed,
      toolResults,
    });
  }

  return {
    runTask,
    preview,

    async generateScaffold(
      projectParams: TemplateParams,
      onChunk?: (chunk: unknown) => void,
    ) {
      const generated = templateGenerator.generateProject(
        projectParams.templateId,
        projectParams,
      );

      for (const file of generated.files) {
        await codingToolHost.writeFile(file.path, file.content);
        if (onChunk) {
          onChunk({
            type: "tool",
            tool: "write_file",
            summary: `Created file: ${file.path}`,
          });
        }
      }

      return createSuccessResponse({
        status: "scaffold_ok",
        scaffoldInfo: generated.scaffoldInfo,
        files: generated.files.map((file) => ({ path: file.path })),
        output: generated.summary,
      });
    },

    getTemplates() {
      return templateGenerator.getTemplateList();
    },

    getTemplatesByCategory(category: string) {
      return templateGenerator.getTemplatesByCategory(category);
    },

    getTemplateDetail(templateId: string) {
      return templateGenerator.getTemplateDetail(templateId);
    },

    async writeFile(path: string, content: string) {
      return codingToolHost.writeFile(path, content);
    },

    async runCommand(command: string, ctx?: { onCommandConfirm?: CommandConfirmHook }) {
      return codingToolHost.runCommand(command, ctx);
    },
  };
}
