import type { ModelClient } from '../llm-client/index.ts';
import type { AgentEvent, ChatMessage, ReviewOutput, SubTask, TaskTrace, TaskType } from '../shared/types.ts';
import type { ConfirmHook, Executor, ExecutorHooks, LoopResult } from './executor.ts';
import { runReviewAgent } from './review-agent.ts';
import { runWorkerPool, type WorkerTask } from './worker-pool.ts';

type CodingToolHost = {
  readFile: (path: string) => Promise<unknown> | unknown;
  listWorkspace: () => Promise<unknown> | unknown;
  searchInWorkspace: (query: string, path?: string) => Promise<unknown> | unknown;
};

export type TaskClassification = {
  type: TaskType;
  subTasks?: SubTask[];
  readTargets?: string[];
};

export type OrchestratorResult = LoopResult & {
  review: ReviewOutput;
  trace: TaskTrace;
};

const COMPOUND_WORDS = [
  'and',
  'also',
  'then',
  '并',
  '以及',
  '同时',
  '然后',
  '分析',
  '解释',
  '总结',
];
const READ_HEAVY_WORDS = [
  'analyze',
  'explain',
  'find',
  'where',
  'flow',
  'review',
  'summarize',
  '分析',
  '解释',
  '总结',
  '说明',
  '查找',
];

function splitSubTasks(prompt: string): SubTask[] {
  const normalized = prompt.replace(/[，；。]/g, ',');
  const connectorParts = normalized
    .split(/\s+(?:and|also|then)\s+|(?:并|以及|同时|然后)/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3);

  const actionParts = normalized
    .split(/[,;]\s*(?:并)?(?=分析|解释|总结|说明|analyze|explain|summarize|review)/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3);
  const parts = actionParts.length > connectorParts.length ? actionParts : connectorParts;

  return parts.map((description, index) => ({
    id: `subtask-${index + 1}`,
    description,
    assignedTo: 'code-agent' as const,
    status: 'pending' as const,
    dependsOn: index > 0 ? [`subtask-${index}`] : undefined,
  }));
}

function extractReadTargets(prompt: string, workspaceFiles: string[]): string[] {
  const normalized = prompt.replace(/\\/g, '/');
  return workspaceFiles
    .filter((file) => normalized.includes(file) || normalized.includes(file.split('/').at(-1) ?? file))
    .slice(0, 6);
}

export function classifyTask(prompt: string, workspaceFiles: string[] = []): TaskClassification {
  if (COMPOUND_WORDS.some((word) => prompt.includes(word))) {
    const subTasks = splitSubTasks(prompt);
    if (subTasks.length > 1) return { type: 'compound', subTasks };
  }

  if (READ_HEAVY_WORDS.some((word) => prompt.includes(word))) {
    const readTargets = extractReadTargets(prompt, workspaceFiles);
    return { type: 'read-heavy', readTargets };
  }

  return { type: 'code-only' };
}

function toFileList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item && typeof item === 'object' ? (item as { path?: unknown }).path : undefined))
    .filter((path): path is string => typeof path === 'string');
}

function workerTasksFor(classification: TaskClassification, prompt: string): WorkerTask[] {
  if (classification.readTargets?.length) {
    return classification.readTargets.map((path) => ({ tool: 'read_file', params: { path } }));
  }
  return [
    { tool: 'list_workspace', params: {} },
    { tool: 'search_in_workspace', params: { query: prompt } },
  ];
}

function buildWorkerContext(results: Awaited<ReturnType<typeof runWorkerPool>>): string {
  return results
    .map((result) => [
      `WORKER ${result.tool} ${JSON.stringify(result.params)}`,
      result.error ? `ERROR: ${result.error}` : result.output,
    ].join('\n'))
    .join('\n\n');
}

async function prefetchReferencedFiles(
  codingToolHost: CodingToolHost,
  prompt: string,
  workspaceFiles: string[],
) {
  const readTargets = extractReadTargets(prompt, workspaceFiles);
  if (readTargets.length === 0) {
    return { context: '', workerTaskCount: 0, serialDurationMs: 0 };
  }

  const tasks = readTargets.map((path): WorkerTask => ({ tool: 'read_file', params: { path } }));
  const workerResults = await runWorkerPool(codingToolHost, tasks);
  return {
    context: buildWorkerContext(workerResults),
    workerTaskCount: tasks.length,
    serialDurationMs: workerResults.reduce((sum, item) => sum + item.durationMs, 0),
  };
}

export function createOrchestrator(codingToolHost: CodingToolHost, executor: Executor, modelClient: ModelClient) {
  async function runCodeAgent(
    messages: ChatMessage[],
    onEvent: (event: AgentEvent) => void,
    hooks?: ConfirmHook | ExecutorHooks,
  ) {
    return executor.runReActLoop(modelClient, messages, onEvent, hooks, { maxIterations: 20 });
  }

  return {
    async run(
      taskId: string,
      originalPrompt: string,
      messages: ChatMessage[],
      onEvent: (event: AgentEvent) => void,
      hooks?: ConfirmHook | ExecutorHooks,
    ): Promise<OrchestratorResult> {
      const workspaceFiles = toFileList(await codingToolHost.listWorkspace());
      const classification = classifyTask(originalPrompt, workspaceFiles);
      onEvent({
        type: 'plan',
        taskId,
        steps: [`classified:${classification.type}`, ...(classification.subTasks ?? []).map((task) => task.description)],
      });

      const start = Date.now();
      let workerTaskCount = 0;
      let serialDurationMs = 0;
      let loopResult: LoopResult;

      if (classification.type === 'read-heavy') {
        const tasks = workerTasksFor(classification, originalPrompt);
        const workerResults = await runWorkerPool(codingToolHost, tasks);
        workerTaskCount = tasks.length;
        serialDurationMs = workerResults.reduce((sum, item) => sum + item.durationMs, 0);
        const context = buildWorkerContext(workerResults);
        loopResult = await runCodeAgent([
          ...messages,
          { role: 'user', content: `Use this worker context:\n${context}\n\nTask: ${originalPrompt}` },
        ], onEvent, hooks);
      } else if (classification.type === 'compound' && classification.subTasks?.length) {
        let carriedContext = '';
        const combined: LoopResult = { messages: [], finalContent: '', toolsUsed: [], filesModified: [], fileChanges: [], skillsUsed: [] };
        const prefetch = await prefetchReferencedFiles(codingToolHost, originalPrompt, workspaceFiles);
        workerTaskCount = prefetch.workerTaskCount;
        serialDurationMs = prefetch.serialDurationMs;
        for (const subTask of classification.subTasks) {
          subTask.status = 'running';
          const prompt = [
            prefetch.context ? `Use this worker context and avoid re-reading these files unless necessary:\n${prefetch.context}` : '',
            subTask.description,
            `Original task: ${originalPrompt}`,
            carriedContext,
          ].filter(Boolean).join('\n\n');
          const result = await runCodeAgent([...messages, { role: 'user', content: prompt }], onEvent, hooks);
          subTask.status = 'done';
          subTask.result = result.finalContent;
          carriedContext = `Previous subtask result:\n${result.finalContent}`;
          combined.messages.push(...result.messages);
          combined.toolsUsed.push(...result.toolsUsed);
          combined.filesModified.push(...result.filesModified);
          combined.fileChanges.push(...result.fileChanges);
          combined.skillsUsed.push(...(result.skillsUsed ?? []));
          combined.finalContent = result.finalContent;
        }
        loopResult = combined;
      } else {
        loopResult = await runCodeAgent(messages, onEvent, hooks);
      }

      const review = await runReviewAgent({
        originalPrompt,
        diff: loopResult.fileChanges,
        modelClient,
      });
      const trace: TaskTrace = {
        taskId,
        classifiedAs: classification.type,
        workerTaskCount,
        workerParallelDurationMs: Date.now() - start,
        serialDurationMs,
        codeAgentIterations: loopResult.messages.filter((message) => message.role === 'assistant').length,
        reviewPassed: review.passed,
        reviewRetries: 0,
        subTaskCount: classification.subTasks?.length ?? 0,
      };

      return { ...loopResult, review, trace };
    },
  };
}
