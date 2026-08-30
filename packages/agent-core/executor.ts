import type { ModelClient } from '../llm-client/index.ts';
import type { ChatMessage, AssistantMessage, ToolResultMessage, ToolCall, AgentEvent, FileDiff } from '../shared/types.ts';
import type { ExternalMcpTool } from '../mcp-client/index.ts';
import type { CommandConfirmHook } from '../tool-gateway/run-command.ts';
import { enrichToolResult } from '../tool-gateway/tool-fallback.ts';
import type { SkillActivationResult, SkillReadResult, SkillSummary, SkillTrigger } from '../skill-system/index.ts';
import { LOCAL_TOOL_DEFINITIONS, SKILL_TOOL_DEFINITIONS } from './tool-definitions.ts';
import { captureFileDiff } from './file-diff.ts';

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

export type LoopResult = {
  messages: ChatMessage[];
  finalContent: string;
  toolsUsed: string[];
  filesModified: string[];
  fileChanges: FileDiff[];
  skillsUsed: string[];
};

const MAX_ITERATIONS = 20;

export type ReActLoopOptions = {
  maxIterations?: number;
};

export type Executor = ReturnType<typeof createExecutor>;

function extractText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const msg = message as Record<string, unknown>;
  if (Array.isArray(msg.content)) {
    return (msg.content as unknown[])
      .map((part) => (typeof part === 'string' ? part : (part as Record<string, unknown>)?.text ?? ''))
      .join('');
  }
  return typeof msg.content === 'string' ? msg.content : '';
}

function extractToolCalls(message: unknown): ToolCall[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as Record<string, unknown>;
  const raw = msg.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => ({
      id: String(c.id ?? ''),
      type: 'function' as const,
      function: {
        name: String((c.function as Record<string, unknown>)?.name ?? ''),
        arguments: String((c.function as Record<string, unknown>)?.arguments ?? '{}'),
      },
    }));
}

function toolSummary(result: unknown): string {
  if (result && typeof result === 'object') return JSON.stringify(result, null, 2);
  return String(result);
}

export type ExecutorHooks = {
  onConfirm?: ConfirmHook;
  onCommandConfirm?: CommandConfirmHook;
};

export function createExecutor(codingToolHost: CodingToolHost, externalMcpRegistry?: ExternalMcpRegistry, skillRegistry?: SkillRegistry) {
  const toolFns: Record<string, (args: Record<string, unknown>) => unknown> = {
    read_file: ({ path }) => codingToolHost.readFile(path as string),
    write_file: ({ path, content }) => codingToolHost.writeFile(path as string, content as string),
    patch_file: ({ path, patch }) => codingToolHost.patchFile(path as string, patch as string),
    search_in_workspace: ({ query, path }) => codingToolHost.searchInWorkspace(query as string, path as string | undefined),
    run_command: ({ command }) =>
      codingToolHost.runCommand(command as string),
    read_lints: ({ path }) =>
      codingToolHost.readLints ? codingToolHost.readLints(path as string | undefined) : { error: 'read_lints unavailable' },
    diff_file: ({ path, snapshotId }) =>
      codingToolHost.diffFile
        ? codingToolHost.diffFile(path as string, snapshotId as string | undefined)
        : { error: 'diff_file unavailable' },
    list_workspace: () => codingToolHost.listWorkspace(),
    list_versions: () => codingToolHost.listVersions(),
    create_snapshot: ({ name, description }) => codingToolHost.createSnapshot(name as string | undefined, description as string | undefined),
    restore_snapshot: ({ snapshotId }) => codingToolHost.restoreSnapshot(snapshotId as string),
  };

  function filterEnabledTools<T extends { function: { name: string } }>(tools: T[]): T[] {
    if (!codingToolHost.isToolEnabled) return tools;
    return tools.filter((t) => codingToolHost.isToolEnabled!(t.function.name));
  }

  async function buildToolDefinitions() {
    const localDefinitions = skillRegistry ? [...LOCAL_TOOL_DEFINITIONS, ...SKILL_TOOL_DEFINITIONS] : LOCAL_TOOL_DEFINITIONS;
    const localTools = filterEnabledTools(localDefinitions);
    if (!externalMcpRegistry || !externalMcpRegistry.hasExternalTools()) return localTools;

    const externalTools = await externalMcpRegistry.listTools();
    const mapped = externalTools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: externalMcpRegistry.normalizeToolName(tool.server, tool.name),
        description: `[external:${tool.server}] ${tool.description || tool.name}`,
        parameters: Object.keys(tool.inputSchema).length > 0
          ? tool.inputSchema
          : { type: 'object', properties: {}, additionalProperties: true },
      },
    }));

    return [...localTools, ...mapped];
  }

  return {
    async runReActLoop(
      modelClient: ModelClient,
      messages: ChatMessage[],
      onEvent: (event: AgentEvent) => void,
      hooks?: ConfirmHook | ExecutorHooks,
      options: ReActLoopOptions = {},
    ): Promise<LoopResult> {
      const onConfirm =
        typeof hooks === 'function' ? hooks : hooks?.onConfirm;
      const onCommandConfirm =
        typeof hooks === 'object' && hooks && 'onCommandConfirm' in hooks
          ? hooks.onCommandConfirm
          : undefined;
      const workingMessages: ChatMessage[] = [...messages];
      const loopMessages: ChatMessage[] = [];
      const toolsUsed: string[] = [];
      const filesModified: string[] = [];
      const fileChanges: FileDiff[] = [];
      const skillsUsed: string[] = [];
      let finalContent = '';
      const maxIterations = options.maxIterations ?? MAX_ITERATIONS;

      for (let i = 0; i < maxIterations; i++) {
        const toolDefinitions = await buildToolDefinitions();
        const result = await modelClient.createMessage(workingMessages, {
          tools: toolDefinitions,
          tool_choice: 'auto',
          parallel_tool_calls: false,
        }) as { choices?: Array<{ message?: unknown; finish_reason?: string }> };

        const choice = result?.choices?.[0];
        const rawMessage = (choice as Record<string, unknown> | undefined)?.message;
        const finishReason = (choice as Record<string, unknown> | undefined)?.finish_reason;

        const content = extractText(rawMessage);
        const toolCalls = extractToolCalls(rawMessage);

        const assistantMsg: AssistantMessage = {
          role: 'assistant',
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        };
        workingMessages.push(assistantMsg);
        loopMessages.push(assistantMsg);

        if (content) {
          finalContent = content;
          onEvent({ type: 'chunk', chunk: content });
        }

        if (toolCalls.length === 0 || finishReason === 'stop') {
          break;
        }

        for (const call of toolCalls) {
          const toolName = call.function.name;
          toolsUsed.push(toolName);

          let toolResult: unknown;

          if (toolName === 'ask_user') {
            if (onConfirm) {
              let args: { question?: string; options?: string[] } = {};
              try { args = JSON.parse(call.function.arguments); } catch { /* ignore */ }
              onEvent({ type: 'task_status', taskId: '', status: 'waiting_confirm' });
              const answer = await onConfirm(args.question ?? 'Please confirm', args.options);
              toolResult = { answer };
            } else {
              toolResult = { answer: 'confirmed' };
            }
          } else {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* ignore */ }

            if (toolName === 'list_skills' && skillRegistry) {
              toolResult = { skills: skillRegistry.listSkills() };
              onEvent({ type: 'skill', skill: '*', action: 'listed', summary: 'Listed available skills' });
            } else if (toolName === 'read_skill' && skillRegistry) {
              const name = String(args.name ?? '');
              toolResult = skillRegistry.readSkill(name);
              if ((toolResult as SkillReadResult).ok) {
                onEvent({ type: 'skill', skill: name, action: 'read', summary: `Loaded skill: ${name}` });
              }
            } else if (toolName === 'activate_skill' && skillRegistry) {
              const name = String(args.name ?? '');
              const trigger = args.trigger === 'explicit' ? 'explicit' : 'implicit';
              const reason = typeof args.reason === 'string' ? args.reason : undefined;
              toolResult = skillRegistry.activateSkill(name, trigger, reason);
              if ((toolResult as SkillActivationResult).ok) {
                if (!skillsUsed.includes(name)) skillsUsed.push(name);
                onEvent({ type: 'skill', skill: name, action: 'activated', trigger, reason, summary: `Activated skill: ${name}` });
              }
            } else if (toolName === 'deactivate_skill' && skillRegistry) {
              const name = String(args.name ?? '');
              const reason = typeof args.reason === 'string' ? args.reason : undefined;
              toolResult = skillRegistry.deactivateSkill(name, reason);
              onEvent({ type: 'skill', skill: name, action: 'deactivated', reason, summary: `Deactivated skill: ${name}` });
            } else {
              const fn = toolFns[toolName];
              if (fn) {
                try {
                  if (toolName === 'run_command' && onCommandConfirm) {
                    toolResult = await codingToolHost.runCommand(args.command as string, {
                      onCommandConfirm,
                    });
                  } else if ((toolName === 'write_file' || toolName === 'patch_file') && typeof args.path === 'string') {
                    const captured = await captureFileDiff(
                      codingToolHost.readFile,
                      args.path,
                      () => fn(args),
                    );
                    toolResult = captured.result;
                    fileChanges.push(captured.diff);
                  } else {
                    toolResult = await fn(args);
                  }
                } catch (err) {
                  toolResult = { error: String(err) };
                }
              } else if (toolName.startsWith('mcp__') && externalMcpRegistry) {
                try {
                  toolResult = await externalMcpRegistry.callTool(toolName, args);
                } catch (err) {
                  toolResult = { error: String(err) };
                }
              } else {
                toolResult = { error: `未知工具: ${toolName}` };
              }
            }

            toolResult = enrichToolResult(toolName, toolResult);

            if (toolName === 'write_file' || toolName === 'patch_file') {
              if (typeof args.path === 'string') filesModified.push(args.path);
            } else if (toolName === 'restore_snapshot') {
              filesModified.push('[workspace restored from snapshot]');
            }
          }

          onEvent({
            type: 'tool',
            tool: toolName,
            summary: `Tool call: ${toolName}`,
            detail: toolSummary(toolResult),
          });

          const toolResultMsg: ToolResultMessage = {
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: JSON.stringify(toolResult),
          };
          workingMessages.push(toolResultMsg);
          loopMessages.push(toolResultMsg);
        }
      }

      return { messages: loopMessages, finalContent, toolsUsed, filesModified, fileChanges, skillsUsed };
    },
  };
}
