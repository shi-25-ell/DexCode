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
import { enrichToolResult } from '../tool-gateway/tool-fallback.ts';
import type {
  SkillActivationResult,
  SkillReadResult,
  SkillSummary,
  SkillTrigger,
} from '../skill-system/index.ts';
import { captureFileDiff } from './file-diff.ts';
import { LOCAL_TOOL_DEFINITIONS, SKILL_TOOL_DEFINITIONS } from './tool-definitions.ts';

export type CodingToolHost = {
  readFile: (path: string) => Promise<unknown> | unknown;
  writeFile: (path: string, content: string) => unknown;
  runCommand: (command: string, ctx?: { onCommandConfirm?: CommandConfirmHook }) => unknown;
  readLints?: (path?: string) => unknown;
  diffFile?: (path: string, snapshotId?: string) => unknown;
  listWorkspace: () => unknown;
  searchInWorkspace: (query: string, path?: string) => unknown;
  patchFile: (path: string, patch: string) => unknown;
  listVersions: () => unknown;
  createSnapshot: (name?: string, description?: string) => unknown;
  restoreSnapshot: (snapshotId: string) => unknown;
  isToolEnabled?: (name: string) => boolean;
};

type ExternalMcpRegistry = {
  listTools: () => Promise<ExternalMcpTool[]>;
  callTool: (qualifiedName: string, args?: Record<string, unknown>) => Promise<unknown>;
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
export type ExecutorHooks = { onConfirm?: ConfirmHook; onCommandConfirm?: CommandConfirmHook };
export type ExecutorSemanticHooks = {
  assistantCommitted(message: AssistantMessage): Promise<void>;
  toolStarted(call: ToolCall): Promise<void>;
  toolOutcome(message: ToolResultMessage): Promise<void>;
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
  error?: { code: string; message: string };
};

export type ReActLoopOptions = {
  runId?: string;
  signal?: AbortSignal;
  maxIterations?: number;
  maxModelAttempts?: number;
  maxRetriesPerTurn?: number;
  semantic?: ExecutorSemanticHooks;
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

  async function buildToolDefinitions() {
    const local = skillRegistry ? [...LOCAL_TOOL_DEFINITIONS, ...SKILL_TOOL_DEFINITIONS] : LOCAL_TOOL_DEFINITIONS;
    const enabled = codingToolHost.isToolEnabled
      ? local.filter((tool) => codingToolHost.isToolEnabled?.(tool.function.name))
      : local;
    if (!externalMcpRegistry?.hasExternalTools()) return enabled;
    const external = await externalMcpRegistry.listTools();
    return [...enabled, ...external.map((tool) => ({
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
      const base = () => ({ messages: loopMessages, finalContent, toolsUsed, filesModified, fileChanges, skillsUsed, modelTurnCount, modelAttemptCount, usage });
      const maxTurns = options.maxIterations ?? MAX_ITERATIONS;
      const maxAttempts = options.maxModelAttempts ?? maxTurns * 2;
      const maxRetries = options.maxRetriesPerTurn ?? 1;

      while (modelTurnCount < maxTurns) {
        if (signal.aborted) return aborted(base());
        modelTurnCount += 1;
        let retries = 0;
        let response: ModelResponse | undefined;
        while (!response) {
          if (modelAttemptCount >= maxAttempts) {
            return { ...base(), status: 'limited', terminationReason: 'model_attempt_limit' };
          }
          modelAttemptCount += 1;
          onEvent({ type: 'task_status', taskId: runId, status: 'executing', note: `model attempt ${modelAttemptCount}` });
          const definitions = await buildToolDefinitions();
          const turn = await collectModelTurn(observeModelEvents(modelClient.streamMessage(workingMessages, {
            tools: definitions,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            signal,
          }), onEvent));
          if (signal.aborted || (turn.status === 'failed' && turn.failure.category === 'cancelled')) {
            return aborted(base());
          }
          if (turn.status === 'failed') {
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
          response = turn.response;
        }

        usage = usageSummary(usage, response.usage);
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
          await options.semantic?.toolStarted(legacyCall);
          const args = call.arguments as JsonObject & Record<string, unknown>;
          toolsUsed.push(toolName);
          onEvent({ type: 'tool_status', callId: call.id, tool: toolName, status: 'running' });
          let toolResult: unknown;
          try {
            if (toolName === 'ask_user') {
              if (!onConfirm) toolResult = { error: 'confirmation unavailable' };
              else {
                onEvent({ type: 'task_status', taskId: runId, status: 'waiting_confirm' });
                toolResult = { answer: await onConfirm(String(args.question ?? 'Please confirm'), Array.isArray(args.options) ? args.options.map(String) : undefined) };
              }
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
                if (toolName === 'run_command' && onCommandConfirm) {
                  toolResult = await codingToolHost.runCommand(String(args.command ?? ''), { onCommandConfirm });
                } else if ((toolName === 'write_file' || toolName === 'patch_file') && typeof args.path === 'string') {
                  const captured = await captureFileDiff(codingToolHost.readFile, args.path, () => fn(args));
                  toolResult = captured.result;
                  fileChanges.push(captured.diff);
                  filesModified.push(args.path);
                } else {
                  toolResult = await fn(args);
                }
              } else if (toolName.startsWith('mcp__') && externalMcpRegistry) {
                toolResult = await externalMcpRegistry.callTool(toolName, args);
              } else {
                toolResult = { error: `unknown tool: ${toolName}` };
              }
              toolResult = enrichToolResult(toolName, toolResult);
              if (toolName === 'restore_snapshot') filesModified.push('[workspace restored from snapshot]');
            }
          } catch (error) {
            toolResult = { error: error instanceof Error ? error.message : String(error) };
          }
          onEvent({ type: 'tool', tool: toolName, summary: `Tool call: ${toolName}`, detail: toolSummary(toolResult) });
          onEvent({ type: 'tool_status', callId: call.id, tool: toolName, status: 'settled' });
          const toolMessage: ToolResultMessage = {
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: stringifyToolResult(toolResult),
          };
          await options.semantic?.toolOutcome(toolMessage);
          workingMessages.push(toolMessage);
          loopMessages.push(toolMessage);
        }
      }
      return { ...base(), status: 'limited', terminationReason: 'model_turn_limit' };
    },
  };
}
