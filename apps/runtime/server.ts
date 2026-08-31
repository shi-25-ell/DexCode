import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { createCodingAgent } from '../../packages/agent-core/index.ts';
import { createConversationRunCoordinator } from '../../packages/agent-core/conversation-run-coordinator.ts';
import { QueueMutationError } from '../../packages/agent-core/session-contracts.ts';
import { createContextManager } from '../../packages/context-builder/index.ts';
import { createModelClient } from '../../packages/llm-client/index.ts';
import { createApprovalModeStore, createCodingToolHost, isApprovalMode } from '../../packages/tool-gateway/index.ts';
import { createWorkspaceRegistry, createWorkspaceService, type WorkspaceRecord } from '../../packages/workspace-manager/index.ts';
import { createSessionRepository } from '../../packages/session-store/index.ts';
import type { AgentEvent, ApprovalOption, PendingConfirm, PendingCommandConfirm, PendingToolApproval, Session, SessionScope } from '../../packages/shared/types.ts';
import { validateCommand } from '../../packages/tool-gateway/command-safety.ts';
import type { CommandConfirmHook } from '../../packages/tool-gateway/run-command.ts';
import type { ToolApprovalHook } from '../../packages/tool-gateway/index.ts';
import type { McpJsonRpcRequest } from '../../packages/mcp-server/index.ts';
import { createExternalMcpRegistry, type ExternalMcpServerConfig } from '../../packages/mcp-client/index.ts';
import { createExternalMcpConfigStore } from '../../packages/mcp-client/config-store.ts';
import { createSkillRegistry, importSkill, previewSkillImport, type SkillImportRequest } from '../../packages/skill-system/index.ts';
import { createTemplateGenerator } from '../../packages/template-generator/index.ts';
import { createSuccessResponse } from '../../packages/shared/index.ts';
import { createCapabilityRegistry } from '../../packages/capability-registry/index.ts';
import { presentTool, projectConversation, projectConversationListItem } from '../../packages/conversation-view/index.ts';
import { createManagedMemorySystem } from '../../packages/managed-memory/index.ts';
import {
  createRunReplayBuffer,
  isDroppableRunEvent,
  safeRunNote,
  type RunEventEnvelope,
  type RunEventPayload,
} from '../../packages/run-protocol/index.ts';

type RequestContext = {
  path?: string;
  content?: string;
  entry?: string;
  section?: string;
  nextName?: string;
  command?: string;
  prompt?: string;
  selectedFile?: string | null;
  name?: string;
  description?: string;
  snapshotId?: string;
};

type WorkspaceFile = {
  path: string;
  content?: string;
};

type WorkspaceTreeResponse = {
  tree: unknown[];
};

type VersionListResponse = {
  versions: unknown[];
};

type FileUpdateResponse = {
  ok: true;
  file: WorkspaceFile;
  tree: unknown[];
  action: string;
};

type ChatPayload = {
  prompt?: string;
  selectedFile?: string | null;
  sessionId?: string;
};

type ConfirmPayload = {
  confirmId?: string;
  answer?: string;
};

type CommandConfirmPayload = {
  confirmId?: string;
  decision?: 'allow_once' | 'allow_whitelist' | 'deny';
};

type WhitelistPayload = {
  pattern?: string;
  matchType?: 'exact' | 'prefix' | 'command';
  label?: string;
};

type ApprovalModePayload = {
  mode?: unknown;
};

type ToolApprovalPayload = {
  approvalId?: string;
  decision?: ApprovalOption;
  fingerprint?: string;
};

type CodingToolHost = ReturnType<typeof createCodingToolHost>;
type WorkspaceService = ReturnType<typeof createWorkspaceService>;
type CodingAgent = ReturnType<typeof createCodingAgent>;
type SessionRepository = ReturnType<typeof createSessionRepository>;
type SkillRegistry = ReturnType<typeof createSkillRegistry>;

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

const port = Number(process.env.PORT || 3000);
const webRoot = join(process.cwd(), "apps", "web");
const webDistRoot = join(webRoot, "dist");

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data, null, 2));
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function parseBody<T>(req: IncomingMessage): Promise<T> {
  let body = '';
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk) => {
      body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    req.on("end", () => resolve());
    req.on("error", (error) => reject(error));
  });
  if (!body) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON');
  }
}

// ── 挂起确认表（内存）──
const pendingConfirms = new Map<string, PendingConfirm>();
const pendingCommandConfirms = new Map<string, PendingCommandConfirm>();
const pendingToolApprovals = new Map<string, PendingToolApproval>();
const runReplayBuffer = createRunReplayBuffer();
const V2_RECONNECT_GRACE_MS = 3_000;

type V2Subscriber = {
  writer: ReturnType<typeof createBoundedRunSseWriter>;
  response: ServerResponse;
  closed: boolean;
};

type ActiveV2Chain = {
  sessionId: string;
  initialRunId?: string;
  clientRequestId?: string;
  subscribers: Set<V2Subscriber>;
  runOrder: string[];
  currentRunId?: string;
  startedRuns: Set<string>;
  lastSeqByRun: Map<string, number>;
  pendingByRun: Map<string, RunEventPayload[]>;
  finished: boolean;
  done: Promise<void>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
};

const activeV2Runs = new Map<string, ActiveV2Chain>();
const activeV2Requests = new Map<string, ActiveV2Chain>();
const completedV2Chains = new Map<string, ActiveV2Chain>();

function createToolApprovalHook(
  sessionId: string,
  taskId: string,
  onEvent: (event: AgentEvent) => void,
  emit?: (event: RunEventPayload) => void,
): ToolApprovalHook {
  return async (request) => {
    const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const durableRequest = { ...request, approvalId };
    await sessionRepository.recordApprovalRequested({
      sessionId,
      runId: taskId,
      approvalId,
      request: durableRequest,
    });

    const response = await new Promise<Parameters<PendingToolApproval['resolve']>[0]>((resolve, reject) => {
      pendingToolApprovals.set(approvalId, {
        approvalId,
        taskId,
        sessionId,
        request: durableRequest,
        createdAt: Date.now(),
        resolve,
        reject,
      });
      onEvent({ type: 'task_status', taskId, status: 'waiting_confirm', note: '等待工具批准' });
      onEvent({ ...durableRequest, type: 'approval_request', taskId, approvalId });
      emit?.({ type: 'run_phase_changed', phase: 'waiting_approval' });
      emit?.({
        type: 'approval_requested',
        request: {
          kind: 'tool',
          approvalId,
          toolName: durableRequest.toolName,
          effect: durableRequest.effect,
          title: durableRequest.title,
          ...(durableRequest.target ? { target: durableRequest.target } : {}),
          reason: durableRequest.reason,
          fingerprint: durableRequest.fingerprint,
          options: durableRequest.options,
        },
      });

      setTimeout(() => {
        if (pendingToolApprovals.has(approvalId)) {
          pendingToolApprovals.delete(approvalId);
          reject(new Error(`工具批准超时：${approvalId}`));
        }
      }, CONFIRM_TIMEOUT_MS);
    });
    onEvent({ type: 'task_status', taskId, status: 'executing', note: '工具批准已处理' });
    emit?.({ type: 'approval_resolved', approvalId, decision: response.decision });
    return response;
  };
}

function createCommandConfirmHook(
  sessionId: string,
  taskId: string,
  onEvent: (event: AgentEvent) => void,
  emit?: (event: RunEventPayload) => void,
): CommandConfirmHook {
  return (request) => {
    const confirmId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise<'allow_once' | 'allow_whitelist' | 'deny'>((resolve, reject) => {
      const pending: PendingCommandConfirm = {
        confirmId,
        taskId,
        sessionId,
        command: request.command,
        cwd: request.cwd,
        risk: request.validation.risk,
        reason: request.validation.reason,
        createdAt: Date.now(),
        resolve,
        reject,
      };
      pendingCommandConfirms.set(confirmId, pending);

      onEvent({ type: 'task_status', taskId, status: 'waiting_confirm', note: '等待命令执行确认' });
      onEvent({
        type: 'command_confirm_request',
        taskId,
        confirmId,
        command: request.command,
        cwd: request.cwd,
        risk: request.validation.risk,
        reason: request.validation.reason,
      });
      emit?.({ type: 'run_phase_changed', phase: 'waiting_approval' });
      emit?.({
        type: 'approval_requested',
        request: {
          kind: 'command',
          approvalId: confirmId,
          title: '批准命令执行',
          target: request.command,
          reason: request.validation.reason,
          options: ['allow_once', 'allow_whitelist', 'deny'],
        },
      });

      setTimeout(() => {
        if (pendingCommandConfirms.has(confirmId)) {
          pendingCommandConfirms.delete(confirmId);
          reject(new Error(`命令确认超时：${confirmId}`));
        }
      }, CONFIRM_TIMEOUT_MS);
    }).then((decision) => {
      emit?.({ type: 'approval_resolved', approvalId: confirmId, decision });
      return decision;
    });
  };
}

function createConfirmHook(
  sessionId: string,
  taskId: string,
  onEvent: (event: AgentEvent) => void,
  emit?: (event: RunEventPayload) => void,
) {
  return async (question: string, options?: string[]): Promise<string> => {
    const confirmId = `confirm-${Date.now()}`;

    return new Promise<string>((resolve, reject) => {
      const pending: PendingConfirm = {
        confirmId,
        taskId,
        sessionId,
        question,
        options,
        createdAt: Date.now(),
        resolve,
        reject,
      };
      pendingConfirms.set(confirmId, pending);

      onEvent({ type: 'confirm_request', taskId, confirmId, question, options });
      emit?.({ type: 'run_phase_changed', phase: 'waiting_approval' });
      emit?.({
        type: 'approval_requested',
        request: { kind: 'question', approvalId: confirmId, title: question, options: options?.length ? options : ['确认', '取消'] },
      });

      setTimeout(() => {
        if (pendingConfirms.has(confirmId)) {
          pendingConfirms.delete(confirmId);
          reject(new Error(`确认请求超时：${confirmId}`));
        }
      }, CONFIRM_TIMEOUT_MS);
    }).then((answer) => {
      emit?.({ type: 'approval_resolved', approvalId: confirmId, decision: answer });
      return answer;
    });
  };
}

function cancelPendingRun(runId: string, reason: string) {
  const error = new Error(`Run stopped: ${reason}`);
  for (const [id, pending] of pendingConfirms) {
    if (pending.taskId !== runId) continue;
    pendingConfirms.delete(id);
    pending.reject(error);
  }
  for (const [id, pending] of pendingCommandConfirms) {
    if (pending.taskId !== runId) continue;
    pendingCommandConfirms.delete(id);
    pending.reject(error);
  }
  for (const [id, pending] of pendingToolApprovals) {
    if (pending.taskId !== runId) continue;
    pendingToolApprovals.delete(id);
    pending.reject(error);
  }
}

// ── 模块级初始化 ──
const modelClient = createModelClient();
const sessionRepository: SessionRepository = createSessionRepository();
const approvalModeStore = await createApprovalModeStore({
  file: join(process.cwd(), 'workspaces', 'approval-settings.json'),
});
const workspaceRegistry = createWorkspaceRegistry({
  registryFile: join(process.cwd(), 'workspaces', 'workspace-registry.json'),
});
const externalMcpConfigStore = createExternalMcpConfigStore({
  file: join(process.cwd(), 'workspaces', 'external-mcp-servers.json'),
});
const environmentMcpConfigs: ExternalMcpServerConfig[] = (() => {
  const raw = process.env.EXTERNAL_MCP_SERVERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ExternalMcpServerConfig[] : [];
  } catch {
    return [];
  }
})();
let externalMcpConfigs = await externalMcpConfigStore.read(environmentMcpConfigs);
const externalMcpRegistry = createExternalMcpRegistry(externalMcpConfigs.filter((config) => config.enabled !== false));
const templateGenerator = createTemplateGenerator();
const capabilityRegistry = createCapabilityRegistry({
  disabled: (process.env.DEX_DISABLED_CAPABILITIES ?? '').split(',').map((value) => value.trim()).filter(Boolean),
});

type WorkspaceRuntime = {
  workspace: WorkspaceRecord;
  workspaceService: WorkspaceService;
  codingToolHost: CodingToolHost;
  skillRegistry: SkillRegistry;
  codingAgent: CodingAgent;
  managedMemory: ReturnType<typeof createManagedMemorySystem>;
};

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string');
}

type ConversationRunPayload = {
  prompt?: string;
  conversationRef?: string;
  clientRequestId?: string;
  afterSeq?: number;
  scope?: { kind?: 'general' | 'workspace'; workspaceRef?: string };
};

function conversationScope(url: URL, workspace: SessionScope): SessionScope {
  return url.searchParams.get('scope') === 'general' ? { kind: 'general' } : workspace;
}

function safeExportName(title: string): string {
  const normalized = title.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
  return (normalized || 'DexCode 会话').slice(0, 64);
}

const workspaceRuntimes = new Map<string, WorkspaceRuntime>();

async function loadWorkspaceRuntime(rootDir?: string, options: { allowCreate?: boolean } = {}): Promise<WorkspaceRuntime> {
  let workspace: WorkspaceRecord;
  if (options.allowCreate) {
    const bootstrap = createWorkspaceService({ rootDir });
    await bootstrap.loadFromDisk();
    workspace = await workspaceRegistry.register(bootstrap.getRootDir());
  } else {
    if (!rootDir) throw new Error('Workspace root path is required');
    workspace = await workspaceRegistry.register(rootDir);
  }
  const cached = workspaceRuntimes.get(workspace.workspaceId);
  if (cached) {
    await cached.workspaceService.loadFromDisk();
    await cached.skillRegistry.reload();
    return cached;
  }
  const stateDir = join(dirname(sessionRepository.sessionsDir), 'workspace-data', workspace.workspaceId);
  const nextWorkspaceService = createWorkspaceService({
    rootDir: workspace.canonicalRootPath,
    stateDir,
  });
  await nextWorkspaceService.loadFromDisk();
  const nextCodingToolHost = createCodingToolHost(nextWorkspaceService, { approvalModeStore });
  const nextContextManager = createContextManager(nextCodingToolHost);
  const nextSkillRegistry = createSkillRegistry({ workspaceRoot: workspace.canonicalRootPath });
  await nextSkillRegistry.loadAll();
  const nextManagedMemory = createManagedMemorySystem({
    workspaceId: workspace.workspaceId,
    workspaceStateDir: stateDir,
    modelClient,
    observe: (event) => console.info(JSON.stringify({ type: 'metric', ...event })),
  });
  const nextCodingAgent = createCodingAgent(
    nextContextManager,
    nextCodingToolHost,
    modelClient,
    sessionRepository,
    externalMcpRegistry,
    nextSkillRegistry,
    { scope: { kind: 'workspace', workspaceId: workspace.workspaceId }, rootPath: workspace.canonicalRootPath },
    nextManagedMemory,
  );
  const runtime = {
    workspace,
    workspaceService: nextWorkspaceService,
    codingToolHost: nextCodingToolHost,
    skillRegistry: nextSkillRegistry,
    codingAgent: nextCodingAgent,
    managedMemory: nextManagedMemory,
  };
  workspaceRuntimes.set(workspace.workspaceId, runtime);
  return runtime;
}

async function runtimeForSession(session: Session): Promise<WorkspaceRuntime> {
  if (session.scope.kind !== 'workspace') throw new HttpError(409, 'WORKSPACE_REQUIRED');
  return runtimeForWorkspaceRef(session.scope.workspaceId);
}

async function runtimeForWorkspaceRef(workspaceRef: string): Promise<WorkspaceRuntime> {
  const cached = workspaceRuntimes.get(workspaceRef);
  if (cached) return cached;
  const workspace = await workspaceRegistry.resolveAvailable(workspaceRef);
  return loadWorkspaceRuntime(workspace.canonicalRootPath);
}

const defaultRuntime = await loadWorkspaceRuntime(process.env.WORKSPACE_DIR, { allowCreate: true });
const generalAgent = createCodingAgent(
  createContextManager(defaultRuntime.codingToolHost),
  defaultRuntime.codingToolHost,
  modelClient,
  sessionRepository,
  externalMcpRegistry,
  undefined,
  { scope: { kind: 'general' } },
);

const conversationRunCoordinator = createConversationRunCoordinator({
  repository: sessionRepository,
  async resolveEnvironment(session) {
    if (session.scope.kind === 'general') return { agent: generalAgent, context: { scope: session.scope } };
    const runtime = await runtimeForSession(session);
    return {
      agent: runtime.codingAgent,
      context: {
        scope: session.scope,
        workspace: { workspaceId: session.scope.workspaceId, rootPath: runtime.workspace.canonicalRootPath },
      },
    };
  },
  createHooks: (sessionId, runId, sink, emit) => ({
    onConfirm: createConfirmHook(sessionId, runId, sink, emit),
    onCommandConfirm: createCommandConfirmHook(sessionId, runId, sink, emit),
    onApproval: createToolApprovalHook(sessionId, runId, sink, emit),
  }),
  cancelPending: (_sessionId, runId, reason) => cancelPendingRun(runId, reason),
  observe: (observation) => console.info(JSON.stringify({ type: 'metric', ...observation })),
});

function workspaceScope(runtime: WorkspaceRuntime): SessionScope {
  return { kind: 'workspace', workspaceId: runtime.workspace.workspaceId };
}

async function loadScopedSession(sessionId: string, scope: SessionScope): Promise<Session> {
  const session = await sessionRepository.loadSession(sessionId);
  if (!session || JSON.stringify(session.scope) !== JSON.stringify(scope)) {
    throw new HttpError(404, '该会话不属于当前范围');
  }
  return session;
}

await sessionRepository.getCurrentSession(workspaceScope(defaultRuntime));

// ── 静态文件 ──
async function tryReadStaticFile(pathname: string) {
  const candidates = [join(webDistRoot, pathname), join(webRoot, pathname)];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8');
    } catch {
      continue;
    }
  }
  return null;
}

function isWorkspaceFile(value: unknown): value is WorkspaceFile {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as Partial<WorkspaceFile>).path === 'string';
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== 'object') return false;
  return 'type' in value;
}

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  };
}

function createBoundedSseWriter(
  res: ServerResponse,
  onOverflow: () => void,
  capacity = 256,
) {
  const queue: AgentEvent[] = [];
  let scheduled = false;
  let active = Promise.resolve();
  const droppable = (event: AgentEvent) =>
    event.type === 'chunk' ||
    event.type === 'reasoning_chunk' ||
    event.type === 'tool_status' ||
    (event.type === 'tool_view' && event.presentation.status === 'running') ||
    (event.type === 'task_status' && event.status === 'executing');

  const waitForDrain = () => new Promise<void>((resolve) => res.once('drain', resolve));
  const pump = async () => {
    while (queue.length > 0) {
      const event = queue.shift();
      if (event && !res.write(`data: ${JSON.stringify(event)}\n\n`)) await waitForDrain();
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    active = (async () => {
      await Promise.resolve();
      try {
        await pump();
      } finally {
        scheduled = false;
        if (queue.length > 0) schedule();
      }
    })();
  };

  return {
    write(event: AgentEvent) {
      const last = queue.at(-1);
      if (event.type === 'chunk' && last?.type === 'chunk' && last.chunk.length + event.chunk.length <= 16_384) {
        last.chunk += event.chunk;
        return;
      }
      if (event.type === 'reasoning_chunk' && last?.type === 'reasoning_chunk' && last.chunk.length + event.chunk.length <= 16_384) {
        last.chunk += event.chunk;
        return;
      }
      if (queue.length >= capacity) {
        const discardIndex = queue.findIndex(droppable);
        if (discardIndex >= 0) queue.splice(discardIndex, 1);
        else {
          onOverflow();
          // Semantic events are never dropped. Aborting the producer bounds how
          // many additional events can arrive while the writer drains.
        }
      }
      queue.push(event);
      schedule();
    },
    async drain() {
      while (scheduled || queue.length > 0) {
        await active;
        if (!scheduled && queue.length > 0) schedule();
      }
    },
  };
}

function createBoundedRunSseWriter(
  res: ServerResponse,
  onOverflow: () => void,
  capacity = 256,
) {
  const queue: RunEventEnvelope[] = [];
  let scheduled = false;
  let active = Promise.resolve();
  const waitForDrain = () => new Promise<void>((resolve) => res.once('drain', resolve));
  const pump = async () => {
    while (queue.length > 0) {
      const event = queue.shift();
      if (event && !res.write(`data: ${JSON.stringify(event)}\n\n`)) await waitForDrain();
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    active = (async () => {
      await Promise.resolve();
      try {
        await pump();
      } finally {
        scheduled = false;
        if (queue.length > 0) schedule();
      }
    })();
  };

  return {
    write(event: RunEventEnvelope) {
      if (queue.length >= capacity) {
        const discardIndex = queue.findIndex(isDroppableRunEvent);
        if (discardIndex >= 0) queue.splice(discardIndex, 1);
        else if (isDroppableRunEvent(event)) return;
        else {
          onOverflow();
          return;
        }
      }
      queue.push(event);
      schedule();
    },
    async drain() {
      while (scheduled || queue.length > 0) {
        await active;
        if (!scheduled && queue.length > 0) schedule();
      }
    },
  };
}

function runIdForClientRequest(session: Session, clientRequestId: string): string | undefined {
  const started = [...(session.ledger ?? [])].reverse().find((record) => (
    record.type === 'run_started' && record.clientRequestId === clientRequestId
  ));
  if (started?.type === 'run_started') return started.runId;
  if (!session.clientRequestIds?.includes(clientRequestId)) return undefined;
  return session.activeTaskId ?? session.runReports?.at(-1)?.runId;
}

function registerV2Run(chain: ActiveV2Chain, runId: string): void {
  chain.currentRunId = runId;
  if (!chain.initialRunId) chain.initialRunId = runId;
  if (!chain.runOrder.includes(runId)) chain.runOrder.push(runId);
  activeV2Runs.set(runId, chain);
}

function publishV2Payload(chain: ActiveV2Chain, runId: string, event: RunEventPayload, at = new Date().toISOString()): void {
  registerV2Run(chain, runId);
  const envelope: RunEventEnvelope = {
    version: 2,
    runId,
    seq: (chain.lastSeqByRun.get(runId) ?? 0) + 1,
    at,
    event,
  };
  chain.lastSeqByRun.set(runId, envelope.seq);
  runReplayBuffer.append(envelope);
  for (const subscriber of chain.subscribers) {
    if (!subscriber.closed) subscriber.writer.write(envelope);
  }
}

function publishActiveV2(chain: ActiveV2Chain, incoming: RunEventEnvelope): void {
  publishV2Payload(chain, incoming.runId, incoming.event, incoming.at);
  if (incoming.event.type === 'run_started') {
    chain.startedRuns.add(incoming.runId);
    const pending = chain.pendingByRun.get(incoming.runId) ?? [];
    chain.pendingByRun.delete(incoming.runId);
    for (const event of pending) publishV2Payload(chain, incoming.runId, event);
  }
}

function coordinatorEventToV2(chain: ActiveV2Chain, event: AgentEvent): void {
  if (event.type === 'run_started') {
    registerV2Run(chain, event.runId);
    return;
  }
  let runId = chain.currentRunId;
  let payload: RunEventPayload | undefined;
  if (event.type === 'queue_item_added' || event.type === 'queue_item_updated' || event.type === 'queue_item_removed' || event.type === 'queue_reordered' || event.type === 'run_chain_paused') {
    payload = event;
  } else if (event.type === 'user_message_committed') {
    runId = event.runId;
    payload = { type: event.type, sessionId: event.sessionId, itemId: event.itemId };
  } else if (event.type === 'context_refresh_started' || event.type === 'context_refresh_completed') {
    runId = event.runId;
    payload = { type: event.type, sessionId: event.sessionId, itemId: event.itemId };
  } else if (event.type === 'context_refresh_failed') {
    runId = event.runId;
    payload = { type: event.type, sessionId: event.sessionId, itemId: event.itemId, message: event.message };
  }
  if (!payload || !runId) return;
  if (chain.startedRuns.has(runId)) publishV2Payload(chain, runId, payload);
  else chain.pendingByRun.set(runId, [...(chain.pendingByRun.get(runId) ?? []), payload]);
}

function scheduleV2Disconnect(chain: ActiveV2Chain): void {
  if (chain.finished || chain.subscribers.size > 0 || chain.disconnectTimer) return;
  chain.disconnectTimer = setTimeout(() => {
    chain.disconnectTimer = undefined;
    if (!chain.finished && chain.subscribers.size === 0) {
      void conversationRunCoordinator.stop({ sessionId: chain.sessionId, reason: 'disconnect' });
    }
  }, V2_RECONNECT_GRACE_MS);
}

async function attachActiveV2Run(chain: ActiveV2Chain, res: ServerResponse, afterSeq: number, resumeRunId?: string): Promise<void> {
  res.writeHead(200, sseHeaders());
  if (chain.disconnectTimer) {
    clearTimeout(chain.disconnectTimer);
    chain.disconnectTimer = undefined;
  }
  const subscriber: V2Subscriber = {
    writer: createBoundedRunSseWriter(res, () => { void conversationRunCoordinator.stop({ sessionId: chain.sessionId, reason: 'failure' }); }),
    response: res,
    closed: false,
  };
  const firstRun = resumeRunId ?? chain.initialRunId;
  const startIndex = firstRun ? Math.max(0, chain.runOrder.indexOf(firstRun)) : chain.runOrder.length;
  for (const [index, runId] of chain.runOrder.slice(startIndex).entries()) {
    const replay = runReplayBuffer.read(runId, index === 0 ? afterSeq : 0);
    if (replay.status === 'available') for (const event of replay.events) subscriber.writer.write(event);
  }
  if (!chain.finished) chain.subscribers.add(subscriber);
  res.on('close', () => {
    subscriber.closed = true;
    chain.subscribers.delete(subscriber);
    scheduleV2Disconnect(chain);
  });
  await chain.done;
  chain.subscribers.delete(subscriber);
  if (subscriber.closed) return;
  await subscriber.writer.drain();
  res.end();
}

function createV2Chain(sessionId: string, initialRunId?: string, clientRequestId?: string): ActiveV2Chain {
  const chain: ActiveV2Chain = {
    sessionId,
    ...(initialRunId ? { initialRunId } : {}),
    ...(clientRequestId ? { clientRequestId } : {}),
    subscribers: new Set(),
    runOrder: [],
    startedRuns: new Set(),
    lastSeqByRun: new Map(),
    pendingByRun: new Map(),
    finished: false,
    done: Promise.resolve(),
  };
  if (initialRunId) registerV2Run(chain, initialRunId);
  if (clientRequestId) activeV2Requests.set(clientRequestId, chain);
  return chain;
}

function completeV2Chain(chain: ActiveV2Chain): void {
  chain.finished = true;
  if (chain.disconnectTimer) clearTimeout(chain.disconnectTimer);
  for (const runId of chain.runOrder) if (activeV2Runs.get(runId) === chain) activeV2Runs.delete(runId);
  if (chain.clientRequestId && activeV2Requests.get(chain.clientRequestId) === chain) activeV2Requests.delete(chain.clientRequestId);
  if (chain.initialRunId) {
    completedV2Chains.delete(chain.initialRunId);
    completedV2Chains.set(chain.initialRunId, chain);
    while (completedV2Chains.size > 64) completedV2Chains.delete(completedV2Chains.keys().next().value!);
  }
}

async function writeCompletedV2Replay(res: ServerResponse, session: Session, runId: string, afterSeq: number): Promise<void> {
  res.writeHead(200, sseHeaders());
  const writer = createBoundedRunSseWriter(res, () => undefined);
  const replay = runReplayBuffer.read(runId, afterSeq);
  if (replay.status === 'available') {
    for (const event of replay.events) writer.write(event);
  } else {
    const report = session.runReports?.find((candidate) => candidate.runId === runId);
    const conversation = projectConversation(session, { contextWindow: modelClient.contextWindow });
    const reconstructed: RunEventEnvelope[] = [
      ...(afterSeq === 0 ? [{
        version: 2,
        runId,
        seq: 1,
        at: report?.startedAt ?? session.updatedAt,
        event: { type: 'run_started', sessionId: session.sessionId, isNew: false },
      } as RunEventEnvelope] : []),
      ...(report ? [{
        version: 2 as const,
        runId,
        seq: Math.max(2, afterSeq + 1),
        at: report.completedAt,
        event: {
          type: 'run_finished' as const,
          terminal: {
            status: report.status,
            reason: report.terminationReason,
            ...(report.error ? { error: { code: report.error.code, message: safeRunNote(report.error.message) ?? '运行失败' } } : {}),
          },
          conversationRevision: session.revision ?? 0,
          ...(report.finalMessageId ? { finalMessageId: report.finalMessageId } : {}),
          conversation,
        },
      }] : []),
    ];
    for (const event of reconstructed) writer.write(event);
  }
  await writer.drain();
  res.end();
}

export function startRuntimeServer() {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    try {
    if (url.pathname === '/api/capabilities' && req.method === 'GET') {
      sendJson(res, 200, { capabilities: capabilityRegistry.list() });
      return;
    }

    if (url.pathname === '/api/approval-mode' && req.method === 'GET') {
      sendJson(res, 200, {
        ...approvalModeStore.getState(),
        ...(approvalModeStore.getDiagnostic() ? { diagnostic: approvalModeStore.getDiagnostic() } : {}),
      });
      return;
    }

    if (url.pathname === '/api/approval-mode' && req.method === 'PUT') {
      const { mode } = await parseBody<ApprovalModePayload>(req);
      if (!isApprovalMode(mode)) throw new HttpError(400, '非法批准模式');
      const state = await approvalModeStore.setMode(mode);
      sendJson(res, 200, state);
      return;
    }

    const requestedWorkspaceRef = String(req.headers['x-workspace-ref'] ?? url.searchParams.get('workspaceRef') ?? '').trim();
    if (url.pathname.startsWith('/api/managed-memory') && !requestedWorkspaceRef) throw new HttpError(409, 'WORKSPACE_REQUIRED');
    const requestRuntime = requestedWorkspaceRef
      ? await runtimeForWorkspaceRef(requestedWorkspaceRef)
      : defaultRuntime;
    const workspaceService = requestRuntime.workspaceService;
    const codingToolHost = requestRuntime.codingToolHost;
    const skillRegistry = requestRuntime.skillRegistry;
    const codingAgent = requestRuntime.codingAgent;
    const requestWorkspaceScope = workspaceScope(requestRuntime);

    if (url.pathname === '/api/managed-memory' && req.method === 'GET') {
      sendJson(res, 200, await requestRuntime.managedMemory.inspect(requestRuntime.workspace.workspaceId));
      return;
    }

    if (url.pathname === '/api/managed-memory/settings' && req.method === 'PUT') {
      const patch = await parseBody<Record<string, unknown>>(req);
      sendJson(res, 200, await requestRuntime.managedMemory.updateSettings(requestRuntime.workspace.workspaceId, patch));
      return;
    }

    if (url.pathname === '/api/managed-memory' && req.method === 'DELETE') {
      const body = await parseBody<{ confirmationToken?: string }>(req);
      sendJson(res, 200, await requestRuntime.managedMemory.clearProjectMemory(requestRuntime.workspace.workspaceId, { confirmationToken: body.confirmationToken ?? '' }));
      return;
    }

    if (url.pathname === '/api/managed-memory/status' && req.method === 'GET') {
      sendJson(res, 200, await requestRuntime.managedMemory.inspect(requestRuntime.workspace.workspaceId));
      return;
    }

    if (url.pathname === '/api/managed-memory/files' && req.method === 'GET') {
      sendJson(res, 200, { files: await requestRuntime.managedMemory.store.scan(requestRuntime.workspace.workspaceId) });
      return;
    }

    const managedMemoryFileMatch = /^\/api\/managed-memory\/files\/(.+)$/.exec(url.pathname);
    if (managedMemoryFileMatch && req.method === 'GET') {
      const path = decodeURIComponent(managedMemoryFileMatch[1]);
      sendJson(res, 200, path === 'MEMORY.md'
        ? await requestRuntime.managedMemory.store.readIndex(requestRuntime.workspace.workspaceId)
        : await requestRuntime.managedMemory.store.readTopic(requestRuntime.workspace.workspaceId, path));
      return;
    }

    if (managedMemoryFileMatch && req.method === 'DELETE') {
      const path = decodeURIComponent(managedMemoryFileMatch[1]);
      const body = await parseBody<{ expectedDigest?: string; reason?: string; operationId?: string }>(req);
      sendJson(res, 200, await requestRuntime.managedMemory.store.remove({
        workspaceId: requestRuntime.workspace.workspaceId,
        actor: 'user',
        path,
        expectedDigest: body.expectedDigest ?? '',
        reason: body.reason ?? 'Deleted through diagnostics API',
        operationId: body.operationId ?? crypto.randomUUID(),
      }));
      return;
    }

    if (url.pathname === '/api/managed-memory/consolidate' && req.method === 'POST') {
      sendJson(res, 202, await requestRuntime.managedMemory.consolidate(true));
      return;
    }

    if (url.pathname === '/api/managed-memory/rebuild-index' && req.method === 'POST') {
      sendJson(res, 200, await requestRuntime.managedMemory.rebuildIndex(requestRuntime.workspace.workspaceId));
      return;
    }

    if (url.pathname === '/api/workspaces/resolve' && req.method === 'POST') {
      const { path } = await parseBody<{ path?: string }>(req);
      if (!path?.trim()) throw new HttpError(400, '请输入项目绝对路径');
      const runtime = await loadWorkspaceRuntime(path.trim());
      sendJson(res, 200, {
        workspaceRef: runtime.workspace.workspaceId,
        displayName: runtime.workspace.canonicalRootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? '项目',
        canonicalPath: runtime.workspace.canonicalRootPath,
      });
      return;
    }

    if (url.pathname === '/api/workspaces/recent' && req.method === 'GET') {
      const workspaces = (await workspaceRegistry.list())
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 10)
        .map((workspace) => ({
          path: workspace.canonicalRootPath,
          displayName: workspace.canonicalRootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? '项目',
        }));
      sendJson(res, 200, { workspaces });
      return;
    }

    if (url.pathname === '/api/conversations' && req.method === 'GET') {
      const scope = conversationScope(url, requestWorkspaceScope);
      const summaries = await sessionRepository.listSessions(scope);
      sendJson(res, 200, {
        conversations: summaries.map((item) => ({
          ref: item.sessionId,
          title: item.title || '新会话',
          ...(item.lastMessage ? { preview: item.lastMessage } : {}),
          updatedAt: item.updatedAt,
          state: item.state,
          archived: item.archived,
        })),
      });
      return;
    }

    const conversationViewMatch = /^\/api\/conversations\/([^/]+)\/view$/.exec(url.pathname);
    if (conversationViewMatch && req.method === 'GET') {
      const conversationRef = decodeURIComponent(conversationViewMatch[1]);
      const scope = conversationScope(url, requestWorkspaceScope);
      const session = await loadScopedSession(conversationRef, scope);
      const runtimeSnapshot = await conversationRunCoordinator.snapshot(session.sessionId);
      const latestSession = await sessionRepository.loadSession(session.sessionId) ?? session;
      const activePhase = runtimeSnapshot.activeRun?.phase === 'accepting_commands'
        ? 'running'
        : runtimeSnapshot.activeRun?.phase === 'terminal'
          ? undefined
          : runtimeSnapshot.activeRun?.phase;
      sendJson(res, 200, { conversation: projectConversation(latestSession, { contextWindow: modelClient.contextWindow, ...(activePhase ? { activePhase } : {}) }) });
      return;
    }

    const queueResumeMatch = /^\/api\/conversations\/([^/]+)\/queued-messages\/commands$/.exec(url.pathname);
    if (queueResumeMatch && req.method === 'POST') {
      const sessionId = decodeURIComponent(queueResumeMatch[1]);
      const scope = conversationScope(url, requestWorkspaceScope);
      await loadScopedSession(sessionId, scope);
      const { action } = await parseBody<{ action?: 'resume' }>(req);
      if (action !== 'resume') throw new HttpError(400, '不支持的队列命令');
      if (req.headers['x-dexcode-stream-version'] === '2') {
        const chain = createV2Chain(sessionId);
        chain.done = (async () => {
          try {
            await conversationRunCoordinator.resume(
              sessionId,
              (event) => coordinatorEventToV2(chain, event),
              { onRunEvent: (event) => publishActiveV2(chain, event), legacyEvents: false },
            );
          } catch (error) {
            const runId = chain.currentRunId ?? `resume-${crypto.randomUUID()}`;
            if (!chain.startedRuns.has(runId)) publishActiveV2(chain, {
              version: 2,
              runId,
              seq: 1,
              at: new Date().toISOString(),
              event: { type: 'run_started', sessionId, isNew: false },
            });
            publishV2Payload(chain, runId, { type: 'stream_error', message: safeRunNote(error instanceof Error ? error.message : String(error)) ?? '恢复队列失败' });
          } finally {
            completeV2Chain(chain);
          }
        })();
        await attachActiveV2Run(chain, res, 0);
        return;
      }
      res.writeHead(200, sseHeaders());
      const writer = createBoundedSseWriter(res, () => { void conversationRunCoordinator.stop({ sessionId, reason: 'disconnect' }); });
      writer.write({ type: 'session', sessionId, isNew: false });
      let responseFinished = false;
      res.on('close', () => {
        if (!responseFinished) void conversationRunCoordinator.stop({ sessionId, reason: 'disconnect' });
      });
      try {
        await conversationRunCoordinator.resume(sessionId, (event) => writer.write(event));
      } catch (error) {
        writer.write({ type: 'error', message: error instanceof Error ? error.message : '恢复队列失败' });
      } finally {
        responseFinished = true;
        await writer.drain();
        res.end();
      }
      return;
    }

    const queueCollectionMatch = /^\/api\/conversations\/([^/]+)\/queued-messages$/.exec(url.pathname);
    if (queueCollectionMatch && req.method === 'POST') {
      const sessionId = decodeURIComponent(queueCollectionMatch[1]);
      const scope = conversationScope(url, requestWorkspaceScope);
      await loadScopedSession(sessionId, scope);
      const body = await parseBody<{
        content?: string;
        delivery?: 'next_run' | 'steer';
        operationId?: string;
        expectedRunId?: string;
        expectedSessionRevision?: number;
      }>(req);
      if (!body.content?.trim()) throw new HttpError(400, '消息不能为空');
      if (body.delivery !== 'next_run' && body.delivery !== 'steer') throw new HttpError(400, 'delivery 必须是 next_run 或 steer');
      if (!body.operationId?.trim()) throw new HttpError(400, 'operationId required');
      const result = await conversationRunCoordinator.submitDuringRun({
        sessionId,
        content: body.content,
        delivery: body.delivery,
        operationId: body.operationId,
        ...(body.expectedRunId ? { expectedRunId: body.expectedRunId } : {}),
        ...(body.expectedSessionRevision !== undefined ? { expectedSessionRevision: body.expectedSessionRevision } : {}),
      });
      sendJson(res, 200, result);
      return;
    }

    const queueOrderMatch = /^\/api\/conversations\/([^/]+)\/queued-messages\/order$/.exec(url.pathname);
    if (queueOrderMatch && req.method === 'PATCH') {
      const sessionId = decodeURIComponent(queueOrderMatch[1]);
      const scope = conversationScope(url, requestWorkspaceScope);
      await loadScopedSession(sessionId, scope);
      const body = await parseBody<{ orderedItemIds?: string[]; operationId?: string; expectedSessionRevision?: number }>(req);
      if (!Array.isArray(body.orderedItemIds) || body.orderedItemIds.some((item) => typeof item !== 'string')) throw new HttpError(400, 'orderedItemIds 必须是字符串数组');
      if (!body.operationId?.trim()) throw new HttpError(400, 'operationId required');
      if (!Number.isInteger(body.expectedSessionRevision)) throw new HttpError(400, 'expectedSessionRevision required');
      const result = await conversationRunCoordinator.mutateQueue({
        type: 'reorder',
        sessionId,
        orderedItemIds: body.orderedItemIds,
        operationId: body.operationId,
        expectedSessionRevision: body.expectedSessionRevision!,
      });
      sendJson(res, 200, result);
      return;
    }

    const queueItemCommandMatch = /^\/api\/conversations\/([^/]+)\/queued-messages\/([^/]+)\/commands$/.exec(url.pathname);
    const queueItemMatch = /^\/api\/conversations\/([^/]+)\/queued-messages\/([^/]+)$/.exec(url.pathname);
    if ((queueItemCommandMatch && req.method === 'POST') || (queueItemMatch && req.method === 'DELETE')) {
      const match = queueItemCommandMatch ?? queueItemMatch!;
      const sessionId = decodeURIComponent(match[1]);
      const itemId = decodeURIComponent(match[2]);
      const scope = conversationScope(url, requestWorkspaceScope);
      await loadScopedSession(sessionId, scope);
      if (queueItemMatch && req.method === 'DELETE') {
        const body = await parseBody<{ operationId?: string; expectedSessionRevision?: number }>(req);
        if (!body.operationId?.trim()) throw new HttpError(400, 'operationId required');
        const result = await conversationRunCoordinator.mutateQueue({
          type: 'cancel',
          sessionId,
          itemId,
          operationId: body.operationId,
          ...(body.expectedSessionRevision !== undefined ? { expectedSessionRevision: body.expectedSessionRevision } : {}),
        });
        sendJson(res, 200, result);
        return;
      }
      const body = await parseBody<{ action?: 'promote_to_steer'; operationId?: string; expectedRunId?: string; expectedSessionRevision?: number }>(req);
      if (body.action !== 'promote_to_steer') throw new HttpError(400, '不支持的 Queue Item 命令');
      if (!body.operationId?.trim() || !body.expectedRunId?.trim()) throw new HttpError(400, 'operationId 和 expectedRunId required');
      const result = await conversationRunCoordinator.mutateQueue({
        type: 'promote_to_steer',
        sessionId,
        itemId,
        operationId: body.operationId,
        expectedRunId: body.expectedRunId,
        ...(body.expectedSessionRevision !== undefined ? { expectedSessionRevision: body.expectedSessionRevision } : {}),
      });
      sendJson(res, 200, result);
      return;
    }

    const conversationExportMatch = /^\/api\/conversations\/([^/]+)\/export$/.exec(url.pathname);
    if (conversationExportMatch && req.method === 'GET') {
      const conversationRef = decodeURIComponent(conversationExportMatch[1]);
      const session = await loadScopedSession(conversationRef, conversationScope(url, requestWorkspaceScope));
      const exported = await sessionRepository.exportSession(conversationRef);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `${safeExportName(projectConversationListItem(session).title)}-${date}.jsonl`;
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="dexcode-conversation-${date}.jsonl"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      });
      res.end(exported);
      return;
    }

    const conversationMutationMatch = /^\/api\/conversations\/([^/]+)$/.exec(url.pathname);
    if (conversationMutationMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const conversationRef = decodeURIComponent(conversationMutationMatch[1]);
      const session = await loadScopedSession(conversationRef, conversationScope(url, requestWorkspaceScope));
      if (req.method === 'DELETE') {
        if (session.activeTaskId) throw new HttpError(409, '正在运行的会话不能删除，请先停止运行');
        await sessionRepository.deleteSession(conversationRef);
        sendJson(res, 200, { ok: true });
        return;
      }
      const meta = await parseBody<{ title?: string; archived?: boolean }>(req);
      if (meta.title !== undefined && !meta.title.trim()) throw new HttpError(400, '会话标题不能为空');
      await sessionRepository.updateSessionMeta(conversationRef, {
        ...(meta.title !== undefined ? { title: meta.title.trim() } : {}),
        ...(meta.archived !== undefined ? { archived: meta.archived } : {}),
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    const runCommandMatch = /^\/api\/conversation-runs\/([^/]+)\/commands$/.exec(url.pathname);
    if (runCommandMatch && req.method === 'POST') {
      const runRef = decodeURIComponent(runCommandMatch[1]);
      const { action } = await parseBody<{ action?: 'stop' }>(req);
      if (action !== 'stop') throw new HttpError(400, '不支持的运行命令');
      const activeChain = activeV2Runs.get(runRef) ?? activeV2Requests.get(runRef);
      const result = activeChain
        ? await conversationRunCoordinator.stop({ sessionId: activeChain.sessionId, reason: 'user_stop' })
        : await conversationRunCoordinator.stop({ runId: runRef, reason: 'user_stop' });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (url.pathname === '/api/conversation-runs' && req.method === 'POST') {
      const payload = await parseBody<ConversationRunPayload>(req);
      const prompt = payload.prompt?.trim() ?? '';
      const clientRequestId = payload.clientRequestId?.trim() ?? '';
      const streamVersion = req.headers['x-dexcode-stream-version'] === '2' ? 2 : 1;
      const afterSeq = Number.isSafeInteger(payload.afterSeq) && Number(payload.afterSeq) >= 0 ? Number(payload.afterSeq) : 0;
      if (!prompt) throw new HttpError(400, '消息不能为空');
      if (!clientRequestId) throw new HttpError(400, 'clientRequestId required');

      let scope: SessionScope;
      if (payload.scope?.kind === 'workspace') {
        const workspaceRef = payload.scope.workspaceRef?.trim();
        if (!workspaceRef) throw new HttpError(400, 'workspaceRef required');
        const workspace = await workspaceRegistry.resolveAvailable(workspaceRef);
        const runtime = await loadWorkspaceRuntime(workspace.canonicalRootPath);
        scope = workspaceScope(runtime);
      } else {
        scope = { kind: 'general' };
      }

      const runId = crypto.randomUUID();
      const runContext = scope.kind === 'workspace'
        ? {
            scope,
            workspace: {
              workspaceId: scope.workspaceId,
              rootPath: (await workspaceRegistry.resolveAvailable(scope.workspaceId)).canonicalRootPath,
            },
          }
        : { scope };
      let session: Session;
      let isNew = false;
      let prestarted = false;
      if (payload.conversationRef) {
        session = await loadScopedSession(payload.conversationRef, scope);
        if (session.clientRequestIds?.includes(clientRequestId)) {
          if (streamVersion === 2) {
            const existingRunId = runIdForClientRequest(session, clientRequestId);
            if (!existingRunId) throw new HttpError(409, '无法定位幂等请求对应的 Run');
            const active = activeV2Runs.get(existingRunId) ?? completedV2Chains.get(existingRunId);
            if (active) await attachActiveV2Run(active, res, afterSeq, existingRunId);
            else await writeCompletedV2Replay(res, session, existingRunId, afterSeq);
            return;
          }
          res.writeHead(200, sseHeaders());
          res.write(`data: ${JSON.stringify({ type: 'session', sessionId: session.sessionId, isNew: false })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'result', result: { conversation: projectConversation(session, { contextWindow: modelClient.contextWindow }), idempotentReplay: true } })}\n\n`);
          res.end();
          return;
        }
      } else {
        const materialized = await sessionRepository.materializeRun({
          scope,
          clientRequestId,
          runId,
          userMessage: { role: 'user', content: prompt },
          context: runContext,
        });
        session = materialized.session;
        isNew = materialized.created;
        prestarted = materialized.created;
        if (!materialized.created) {
          if (streamVersion === 2) {
            const existingRunId = runIdForClientRequest(session, clientRequestId);
            if (!existingRunId) throw new HttpError(409, '无法定位幂等请求对应的 Run');
            const active = activeV2Runs.get(existingRunId) ?? completedV2Chains.get(existingRunId);
            if (active) await attachActiveV2Run(active, res, afterSeq, existingRunId);
            else await writeCompletedV2Replay(res, session, existingRunId, afterSeq);
            return;
          }
          res.writeHead(200, sseHeaders());
          res.write(`data: ${JSON.stringify({ type: 'session', sessionId: session.sessionId, isNew: false })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'result', result: { conversation: projectConversation(session, { contextWindow: modelClient.contextWindow }), idempotentReplay: true } })}\n\n`);
          res.end();
          return;
        }
      }

      if (streamVersion === 2) {
        const chain = createV2Chain(session.sessionId, runId, clientRequestId);
        chain.done = (async () => {
          try {
            await conversationRunCoordinator.start(
              { sessionId: session.sessionId, prompt, runId, prestarted, clientRequestId, isNew },
              (event) => coordinatorEventToV2(chain, event),
              { onRunEvent: (event) => publishActiveV2(chain, event), legacyEvents: false },
            );
          } catch (error) {
            if (!chain.startedRuns.has(runId)) publishActiveV2(chain, {
              version: 2,
              runId,
              seq: 1,
              at: new Date().toISOString(),
              event: { type: 'run_started', sessionId: session.sessionId, isNew },
            });
            publishV2Payload(chain, runId, { type: 'stream_error', message: safeRunNote(error instanceof Error ? error.message : String(error)) ?? '运行失败' });
          } finally {
            completeV2Chain(chain);
          }
        })();
        await attachActiveV2Run(chain, res, afterSeq, runId);
        return;
      }

      res.writeHead(200, sseHeaders());
      const writer = createBoundedSseWriter(res, () => { void conversationRunCoordinator.stop({ sessionId: session.sessionId, reason: 'disconnect' }); });
      writer.write({ type: 'session', sessionId: session.sessionId, isNew });
      const onEvent = (event: AgentEvent) => writer.write(event);
      let responseFinished = false;
      res.on('close', () => {
        if (!responseFinished) void conversationRunCoordinator.stop({ sessionId: session.sessionId, reason: 'disconnect' });
      });
      try {
        await conversationRunCoordinator.start({ sessionId: session.sessionId, prompt, runId, prestarted, clientRequestId }, onEvent);
      } catch (error) {
        writer.write({ type: 'error', message: error instanceof Error ? error.message : '运行失败' });
      } finally {
        responseFinished = true;
        await writer.drain();
        res.end();
      }
      return;
    }
    if (url.pathname === '/api/external-mcp/tools' && req.method === 'GET') {
      try {
        const tools = await externalMcpRegistry.listTools();
        sendJson(res, 200, { tools, statuses: externalMcpRegistry.getServerStatuses() });
      } catch (error: unknown) {
        sendJson(res, error instanceof HttpError ? error.status : 500, {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      return;
    }

    // ── POST /api/external-mcp/servers（注册/同步外部 MCP 服务器）──
    if (url.pathname === '/api/external-mcp/servers' && req.method === 'POST') {
      try {
        const { servers } = await parseBody<{ servers?: ExternalMcpServerConfig[] }>(req);
        if (!Array.isArray(servers)) { sendJson(res, 400, { error: 'servers array required' }); return; }
        const names = new Set<string>();
        for (const server of servers) {
          if (!server || typeof server !== 'object') throw new HttpError(400, '服务器配置必须是对象');
          if (typeof server.name !== 'string' || !server.name.trim()) throw new HttpError(400, '服务器名称不能为空');
          if (names.has(server.name)) throw new HttpError(400, `服务器名称重复：${server.name}`);
          names.add(server.name);
          if (server.type === 'http') {
            if (typeof server.url !== 'string' || !server.url.trim()) throw new HttpError(400, `HTTP 服务器缺少地址：${server.name}`);
            if (server.headers !== undefined && !isStringRecord(server.headers)) throw new HttpError(400, `HTTP 请求头必须是字符串键值对：${server.name}`);
          } else if (server.type === 'stdio') {
            if (typeof server.command !== 'string' || !server.command.trim()) throw new HttpError(400, `本地进程服务器缺少命令：${server.name}`);
            if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((value) => typeof value !== 'string'))) throw new HttpError(400, `启动参数必须是字符串数组：${server.name}`);
            if (server.env !== undefined && !isStringRecord(server.env)) throw new HttpError(400, `环境变量必须是字符串键值对：${server.name}`);
          } else {
            throw new HttpError(400, '不支持的 MCP 连接类型');
          }
        }
        const nextConfigs = servers.map((server) => ({ ...server }));
        await externalMcpConfigStore.write(nextConfigs);
        for (const server of externalMcpRegistry.listServers()) externalMcpRegistry.removeServer(server.name);
        externalMcpConfigs = nextConfigs;
        for (const server of externalMcpConfigs) if (server.enabled !== false) externalMcpRegistry.addServer(server);
        sendJson(res, 200, { ok: true, servers: externalMcpConfigs });
      } catch (error: unknown) {
        sendJson(res, error instanceof HttpError ? error.status : 500, {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      return;
    }

    // ── DELETE /api/external-mcp/servers/:name ──
    if (url.pathname.startsWith('/api/external-mcp/servers/') && req.method === 'DELETE') {
      const name = decodeURIComponent(url.pathname.replace('/api/external-mcp/servers/', ''));
      const nextConfigs = externalMcpConfigs.filter((server) => server.name !== name);
      await externalMcpConfigStore.write(nextConfigs);
      externalMcpRegistry.removeServer(name);
      externalMcpConfigs = nextConfigs;
      sendJson(res, 200, { ok: true, servers: externalMcpConfigs });
      return;
    }

    // ── GET /api/external-mcp/servers ──
    if (url.pathname === '/api/external-mcp/servers' && req.method === 'GET') {
      sendJson(res, 200, { servers: externalMcpConfigs });
      return;
    }

    // ── MCP 端点 ──
    if (url.pathname === '/mcp' && req.method === 'GET') {
      res.writeHead(200, sseHeaders());

      res.write(`event: ready\n`);
      res.write(`data: ${JSON.stringify({ ok: true, serverInfo: { name: 'ai-coding-agent-mcp', version: '0.1.0' } })}\n\n`);
      return;
    }

    if (url.pathname === '/mcp' && req.method === 'POST') {
      const parsed = await parseBody<McpJsonRpcRequest>(req);
      const response = await codingToolHost.mcpJsonRpc(parsed);
      if (response === null) {
        res.writeHead(204);
        res.end();
        return;
      }
      sendJson(res, 200, response);
      return;
    }

    // ── GET /api/meta ──
    if (url.pathname === '/api/meta') {
      sendJson(res, 200, {
        appName: 'DexCode',
        llmEnabled: modelClient.model !== 'mock',
        model: {
          displayName: modelClient.displayName ?? modelClient.model,
          reasoning: modelClient.reasoning,
          ...(modelClient.contextWindow ? { contextWindow: modelClient.contextWindow } : {}),
          ...(modelClient.providerDisplayName ? { providerDisplayName: modelClient.providerDisplayName } : {}),
        },
        workspace: {
          ref: requestRuntime.workspace.workspaceId,
          displayName: requestRuntime.workspace.canonicalRootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? '项目',
          canonicalPath: requestRuntime.workspace.canonicalRootPath,
        },
      });
      return;
    }

    // ── GET /api/session ──
    if (url.pathname === '/api/session' && req.method === 'GET') {
      const session = await sessionRepository.getCurrentSession(requestWorkspaceScope);
      sendJson(res, 200, {
        sessionId: session?.sessionId ?? null,
        scope: session?.scope ?? requestWorkspaceScope,
        createdAt: session?.createdAt ?? null,
        updatedAt: session?.updatedAt ?? null,
        messageCount: session?.messages.length ?? 0,
        taskSummaries: session?.taskSummaries ?? [],
        activeTaskId: session?.activeTaskId ?? null,
      });
      return;
    }

    // ── POST /api/session（新建会话）──
    if (url.pathname === '/api/session' && req.method === 'POST') {
      const { kind } = await parseBody<{ kind?: 'general' | 'workspace' }>(req);
      const scope = kind === 'general' ? { kind: 'general' } as const : requestWorkspaceScope;
      sendJson(res, 200, {
        sessionId: null,
        scope,
        createdAt: null,
        materialized: false,
        isNew: true,
      });
      return;
    }

    // ── GET /api/sessions（历史会话列表）──
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      const scope = url.searchParams.get('scope') === 'general' ? { kind: 'general' } as const : requestWorkspaceScope;
      const sessions = await sessionRepository.listSessions(scope);
      sendJson(res, 200, { sessions });
      return;
    }

    // ── POST /api/session/switch（切换会话）──
    if (url.pathname === '/api/session/switch' && req.method === 'POST') {
      const { sessionId } = await parseBody<{ sessionId?: string }>(req);
      if (!sessionId) { sendJson(res, 400, { error: 'sessionId is required' }); return; }
      try {
        const session = await sessionRepository.switchSession(sessionId, requestWorkspaceScope);
        sendJson(res, 200, {
          sessionId: session.sessionId,
          scope: session.scope,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messages: session.messages,
          taskSummaries: session.taskSummaries,
        });
      } catch (err) {
        sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ── DELETE /api/session/:id ──
    if (url.pathname.startsWith('/api/session/') && !url.pathname.includes('/export') && req.method === 'DELETE') {
      const sessionId = decodeURIComponent(url.pathname.replace('/api/session/', ''));
      const session = await loadScopedSession(sessionId, requestWorkspaceScope);
      if (session.activeTaskId) throw new HttpError(409, 'Cannot delete a Session with an active Run');
      const ok = await sessionRepository.deleteSession(sessionId);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true, sessionId } : { error: 'Session not found' });
      return;
    }

    // ── PATCH /api/session/:id ──
    if (url.pathname.startsWith('/api/session/') && !url.pathname.includes('/export') && req.method === 'PATCH') {
      const sessionId = decodeURIComponent(url.pathname.replace('/api/session/', ''));
      const meta = await parseBody<{ title?: string; archived?: boolean }>(req);
      try {
        await loadScopedSession(sessionId, requestWorkspaceScope);
        const updated = await sessionRepository.updateSessionMeta(sessionId, meta);
        sendJson(res, 200, updated);
      } catch (err) {
        sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ── GET /api/session/:id/export ──
    if (url.pathname.startsWith('/api/session/') && url.pathname.endsWith('/export') && req.method === 'GET') {
      const sessionId = decodeURIComponent(url.pathname.replace('/api/session/', '').replace('/export', ''));
      try {
        await loadScopedSession(sessionId, requestWorkspaceScope);
        const journal = await sessionRepository.exportSession(sessionId);
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="${sessionId}.jsonl"`,
        });
        res.end(journal);
      } catch (err) {
        sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ── GET /api/sessions/search ──
    if (url.pathname === '/api/sessions/search' && req.method === 'GET') {
      const query = url.searchParams.get('q') ?? '';
      const results = await sessionRepository.searchSessions(query, requestWorkspaceScope);
      sendJson(res, 200, { sessions: results });
      return;
    }

    // ── Skill 管理 API ──
    if (url.pathname === '/api/skills' && req.method === 'GET') {
      sendJson(res, 200, { skills: skillRegistry.listSkills() });
      return;
    }

    if (url.pathname === '/api/skills/reload' && req.method === 'POST') {
      await skillRegistry.reload();
      sendJson(res, 200, { ok: true, skills: skillRegistry.listSkills() });
      return;
    }

    if (url.pathname === '/api/skills/import/preview' && req.method === 'POST') {
      const parsed = await parseBody<SkillImportRequest>(req);
      const result = await previewSkillImport(workspaceService.getRootDir(), parsed);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (url.pathname === '/api/skills/import' && req.method === 'POST') {
      const parsed = await parseBody<SkillImportRequest>(req);
      const result = await importSkill(workspaceService.getRootDir(), parsed);
      if (result.ok) await skillRegistry.reload();
      sendJson(res, result.ok ? 200 : 400, result.ok ? { ...result, skills: skillRegistry.listSkills() } : result);
      return;
    }

    if (url.pathname.startsWith('/api/skills/') && req.method === 'GET') {
      const name = decodeURIComponent(url.pathname.replace('/api/skills/', ''));
      const skill = skillRegistry.getSkill(name);
      if (!skill) {
        sendJson(res, 404, { error: 'Skill not found' });
        return;
      }
      sendJson(res, 200, { skill });
      return;
    }

    if (url.pathname.startsWith('/api/skills/') && req.method === 'PATCH') {
      const name = decodeURIComponent(url.pathname.replace('/api/skills/', ''));
      const { enabled } = await parseBody<{ enabled?: boolean }>(req);
      if (typeof enabled !== 'boolean') {
        sendJson(res, 400, { error: 'enabled field required' });
        return;
      }
      const ok = await skillRegistry.setEnabled(name, enabled);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true, name, enabled } : { error: 'Skill not found' });
      return;
    }

    if (url.pathname.startsWith('/api/skills/') && req.method === 'DELETE') {
      const name = decodeURIComponent(url.pathname.replace('/api/skills/', ''));
      const { rootPath } = await parseBody<{ rootPath?: string }>(req);
      const result = await skillRegistry.deleteSkill(name, rootPath);
      sendJson(res, result.ok ? 200 : 400, result.ok ? { ...result, skills: skillRegistry.listSkills() } : result);
      return;
    }

    // ── POST /api/workspace/load（切换工作区目录）──
    if (url.pathname === '/api/project-memory' && req.method === 'GET') {
      sendJson(res, 200, await sessionRepository.getProjectMemory(requestRuntime.workspace.workspaceId));
      return;
    }

    if (url.pathname === '/api/project-memory' && req.method === 'PUT') {
      const { content } = await parseBody<RequestContext>(req);
      const updated = await sessionRepository.writeProjectMemory(content ?? '', requestRuntime.workspace.workspaceId);
      sendJson(res, 200, { ok: true, ...updated });
      return;
    }

    if (url.pathname === '/api/project-memory/append' && req.method === 'POST') {
      const { entry, section } = await parseBody<RequestContext>(req);
      if (!entry?.trim()) {
        sendJson(res, 400, { error: 'entry is required' });
        return;
      }
      try {
        const updated = await sessionRepository.appendProjectMemory(entry, section, requestRuntime.workspace.workspaceId);
        sendJson(res, 200, { ok: true, ...updated });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (url.pathname === '/api/workspace/load' && req.method === 'POST') {
      const { path: dirPath } = await parseBody<{ path?: string }>(req);
      if (!dirPath) {
        sendJson(res, 400, { error: 'path is required' });
        return;
      }
      try {
        const runtime = await loadWorkspaceRuntime(dirPath);
        const tree = runtime.workspaceService.listTree();
        sendJson(res, 200, {
          ok: true,
          workspaceId: runtime.workspace.workspaceId,
          rootDir: runtime.workspaceService.getRootDir(),
          tree,
          sessionId: null,
          sessionMaterialized: false,
        });
      } catch (err) {
        sendJson(res, 400, { error: `无法加载路径：${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }

    // ── GET /api/fs/suggest（路径补全）──
    if (url.pathname === '/api/fs/suggest' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      try {
        const endsWithSep = prefix.endsWith('/');
        const dir = endsWithSep ? prefix : (dirname(prefix) || '/');
        const partial = endsWithSep ? '' : prefix.slice(dir.endsWith('/') ? dir.length : dir.length + 1);
        const entries = await readdir(dir, { withFileTypes: true });
        const suggestions = entries
          .flatMap((entry) => typeof entry !== 'string' && entry.isDirectory() && !entry.name.startsWith('.') && entry.name.startsWith(partial) ? [entry.name] : [])
          .slice(0, 10)
          .map((name) => join(dir, name) + '/');
        sendJson(res, 200, { suggestions });
      } catch {
        sendJson(res, 200, { suggestions: [] });
      }
      return;
    }

    // ── GET /api/workspace ──
    if (url.pathname === '/api/workspace') {
      const treeResponse: WorkspaceTreeResponse = { tree: workspaceService.listTree() };
      sendJson(res, 200, treeResponse);
      return;
    }

    if (url.pathname === '/api/versions' && req.method === 'GET') {
      const versionsResponse: VersionListResponse = { versions: await workspaceService.listVersions() };
      sendJson(res, 200, versionsResponse);
      return;
    }

    // ── MCP tool/resource/prompt 辅助路由 ──
    if (url.pathname === '/api/mcp/tools') {
      sendJson(res, 200, codingToolHost.mcp.listTools());
      return;
    }

      if (url.pathname === "/api/mcp/resources") {
        sendJson(res, 200, codingToolHost.mcp.listResources());
        return;
      }

      if (url.pathname === "/api/mcp/prompts") {
        sendJson(res, 200, codingToolHost.mcp.listPrompts());
        return;
      }

      if (url.pathname.startsWith("/api/mcp/tool/") && req.method === "POST") {
        const name = decodeURIComponent(
          url.pathname.replace("/api/mcp/tool/", ""),
        );
        const parsed = await parseBody<RequestContext>(req);
        const result = await codingToolHost.mcp.callTool(
          name,
          parsed as Record<string, unknown>,
        );
        sendJson(res, result.success ? 200 : 400, result);
        return;
      }

      if (
        url.pathname.startsWith("/api/mcp/resource/") &&
        req.method === "GET"
      ) {
        const name = decodeURIComponent(
          url.pathname.replace("/api/mcp/resource/", ""),
        );
        const result = await codingToolHost.mcp.readResource(name);
        sendJson(res, result.success ? 200 : 404, result);
        return;
      }

      if (
        url.pathname.startsWith("/api/mcp/prompt/") &&
        req.method === "POST"
      ) {
        const name = decodeURIComponent(
          url.pathname.replace("/api/mcp/prompt/", ""),
        );
        const parsed = await parseBody<RequestContext>(req);
        const result = await codingToolHost.mcp.getPrompt(
          name,
          parsed as Record<string, unknown>,
        );
        sendJson(res, result.success ? 200 : 400, result);
        return;
      }

    // ── GET /api/tools ──
    if (url.pathname === '/api/tools' && req.method === 'GET') {
      const localTools = codingToolHost.registry.getAllToolInfos();
      let externalTools: { name: string; description: string; source: string; enabled: boolean; callCount: number; successCount: number; avgDurationMs: number; lastCalledAt: string | null }[] = [];
      try {
        const extList = await externalMcpRegistry.listTools();
        externalTools = extList.map((t) => ({
          name: externalMcpRegistry.normalizeToolName(t.server, t.name),
          description: t.description,
          source: 'external' as const,
          enabled: true,
          callCount: 0,
          successCount: 0,
          avgDurationMs: 0,
          lastCalledAt: null,
        }));
      } catch { /* external MCP not available */ }
      sendJson(res, 200, { tools: [...localTools, ...externalTools].map((tool) => ({
        ...tool,
        displayName: presentTool({ callRef: 'settings', tool: tool.name, status: 'running' }).name,
      })) });
      return;
    }

    // ── GET /api/tools/:name/logs ──
    if (url.pathname.startsWith('/api/tools/') && url.pathname.endsWith('/logs') && req.method === 'GET') {
      const toolName = decodeURIComponent(url.pathname.replace('/api/tools/', '').replace('/logs', ''));
      const limit = Number(url.searchParams.get('limit') || 30);
      const logs = codingToolHost.registry.getToolLogs(toolName, limit);
      sendJson(res, 200, { tool: toolName, logs });
      return;
    }

    // ── POST /api/tools/:name/test ──
    if (url.pathname.startsWith('/api/tools/') && url.pathname.endsWith('/test') && req.method === 'POST') {
      const toolName = decodeURIComponent(url.pathname.replace('/api/tools/', '').replace('/test', ''));
      const args = await parseBody<Record<string, unknown>>(req);
      try {
        const result = await codingToolHost.registry.testTool(toolName, args);
        sendJson(res, 200, { tool: toolName, result });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ── PATCH /api/tools/:name ──
    if (url.pathname.startsWith('/api/tools/') && req.method === 'PATCH') {
      const toolName = decodeURIComponent(url.pathname.replace('/api/tools/', ''));
      const { enabled } = await parseBody<{ enabled?: boolean }>(req);
      if (typeof enabled !== 'boolean') { sendJson(res, 400, { error: 'enabled field required' }); return; }
      const ok = codingToolHost.registry.setToolEnabled(toolName, enabled);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true, name: toolName, enabled } : { error: 'Tool not found' });
      return;
    }

    // ── GET /api/file/:path ──
    if (url.pathname.startsWith('/api/file/') && req.method === 'GET') {
      const filePath = decodeURIComponent(url.pathname.replace('/api/file/', ''));
      const absPath = join(workspaceService.getRootDir(), filePath);
      try {
        const content = await readFile(absPath, 'utf8');
        sendJson(res, 200, { path: filePath, content });
      } catch {
        sendJson(res, 404, { error: 'File not found' });
      }
      return;
    }

    // ── PUT /api/file ──
    if (url.pathname === '/api/file' && req.method === 'PUT') {
      const parsed = await parseBody<RequestContext>(req);
      const updated = await codingToolHost.mcp.callTool('write_file', {
        path: parsed.path ?? '',
        content: parsed.content ?? '',
      });

        if (
          !updated.success ||
          !updated.data ||
          typeof updated.data !== "object"
        ) {
          sendJson(res, 400, updated);
          return;
        }

        sendJson(res, 200, {
          ok: true,
          ...(updated.data as Record<string, unknown>),
        });
        return;
      }

      if (url.pathname === "/api/folder" && req.method === "PUT") {
        const parsed = await parseBody<RequestContext>(req);
        const created = await workspaceService.createFolder(parsed.path ?? "");
        sendJson(res, 200, created);
        return;
      }

    // ── PUT /api/folder ──
    if (url.pathname === '/api/folder' && req.method === 'PUT') {
      const parsed = await parseBody<RequestContext>(req);
      const created = await workspaceService.createFolder(parsed.path ?? '');
      sendJson(res, 200, created);
      return;
    }

    // ── POST /api/item/rename ──
    if (url.pathname === '/api/item/rename' && req.method === 'POST') {
      const parsed = await parseBody<RequestContext>(req);
      const renamed = await workspaceService.renameItem(parsed.path ?? '', parsed.nextName ?? '');
      sendJson(res, 200, renamed);
      return;
    }

    // ── POST /api/item/delete ──
    if (url.pathname === '/api/item/delete' && req.method === 'POST') {
      const parsed = await parseBody<RequestContext>(req);
      const deleted = await workspaceService.deleteItem(parsed.path ?? '');
      sendJson(res, 200, deleted);
      return;
    }

    // ── GET /api/command-whitelist ──
    if (url.pathname === '/api/command-whitelist' && req.method === 'GET') {
      const entries = await codingToolHost.commandWhitelist.list();
      sendJson(res, 200, { entries });
      return;
    }

    // ── POST /api/command-whitelist ──
    if (url.pathname === '/api/command-whitelist' && req.method === 'POST') {
      const parsed = await parseBody<WhitelistPayload>(req);
      if (!parsed.pattern?.trim()) {
        sendJson(res, 400, { error: 'pattern is required' });
        return;
      }
      if (parsed.matchType && !['exact', 'prefix', 'command'].includes(parsed.matchType)) {
        throw new HttpError(400, '非法白名单匹配类型');
      }
      const entry = await codingToolHost.commandWhitelist.add({
        pattern: parsed.pattern.trim(),
        matchType: parsed.matchType ?? 'exact',
        label: parsed.label,
      });
      sendJson(res, 200, { entry });
      return;
    }

    // ── DELETE /api/command-whitelist/:id ──
    if (url.pathname.startsWith('/api/command-whitelist/') && req.method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.replace('/api/command-whitelist/', ''));
      const ok = await codingToolHost.commandWhitelist.remove(id);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Entry not found' });
      return;
    }

    // ── POST /api/tool/run（仅白名单或无需确认的命令；其余请走 Agent 对话确认流）──
    if (url.pathname === '/api/tool/run' && req.method === 'POST') {
      const parsed = await parseBody<RequestContext>(req);
      const command = parsed.command ?? '';
      if (!command.trim()) {
        sendJson(res, 400, { error: 'command is required' });
        return;
      }

      const entries = await codingToolHost.commandWhitelist.list();
      const validation = validateCommand(command, entries);
      if (!validation.allowed) {
        sendJson(res, 403, { error: validation.reason, validation });
        return;
      }
      if (validation.needsConfirmation) {
        sendJson(res, 403, {
          error: '该命令需要用户确认，请通过 Agent 对话执行，或先将命令加入白名单',
          validation,
        });
        return;
      }

      const result = await codingToolHost.runCommand(command);
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === '/api/version/snapshot' && req.method === 'POST') {
      const parsed = await parseBody<RequestContext>(req);
      try {
        const result = await workspaceService.createSnapshot(parsed.name ?? '', parsed.description ?? '');
        sendJson(res, 200, result);
      } catch (error: unknown) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Failed to create snapshot' });
      }
      return;
    }

    if (url.pathname === '/api/version/restore' && req.method === 'POST') {
      const parsed = await parseBody<RequestContext>(req);
      try {
        const result = await workspaceService.restoreSnapshot(parsed.snapshotId ?? '');
        sendJson(res, 200, result);
      } catch (error: unknown) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Failed to restore snapshot' });
      }
      return;
    }

    // ── POST /api/agent/chat（主要 agent 接口，SSE）──
    if (url.pathname === '/api/agent/chat' && req.method === 'POST') {
      const { prompt, selectedFile, sessionId: reqSessionId } = await parseBody<ChatPayload>(req);

      let session: Session;
      if (reqSessionId) {
        session = await loadScopedSession(reqSessionId, requestWorkspaceScope);
      } else {
        session = await sessionRepository.createSession(requestWorkspaceScope);
      }
      const sessionRuntime = await runtimeForSession(session);

      res.writeHead(200, sseHeaders());

      const runController = new AbortController();
      let responseFinished = false;
      res.on('close', () => {
        if (!responseFinished) runController.abort('HTTP client disconnected');
      });

      const writer = createBoundedSseWriter(res, () => runController.abort('SSE consumer is too slow'));
      const writeEvent = (event: AgentEvent) => writer.write(event);

      writeEvent({ type: 'session', sessionId: session.sessionId, isNew: false });

      const taskId = `task-${Date.now()}`;
      const confirmHook = createConfirmHook(session.sessionId, taskId, writeEvent);
      const commandConfirmHook = createCommandConfirmHook(session.sessionId, taskId, writeEvent);
      const approvalHook = createToolApprovalHook(session.sessionId, taskId, writeEvent);

      try {
        await sessionRuntime.codingAgent.runTask(
          session.sessionId,
          prompt ?? '',
          selectedFile ?? null,
          writeEvent,
          { onConfirm: confirmHook, onCommandConfirm: commandConfirmHook, onApproval: approvalHook },
          { runId: taskId, signal: runController.signal },
        );
      } catch (error: unknown) {
        writeEvent({ type: 'error', message: error instanceof Error ? error.message : 'Unknown error' });
      }

      await writer.drain();
      res.write('data: [DONE]\n\n');
      responseFinished = true;
      res.end();
      return;
    }

    // ── POST /api/agent/confirm ──
    if (url.pathname === '/api/agent/confirm' && req.method === 'POST') {
      const { confirmId, answer } = await parseBody<ConfirmPayload>(req);
      if (!confirmId) {
        sendJson(res, 400, { error: 'confirmId is required' });
        return;
      }
      const pending = pendingConfirms.get(confirmId);
      if (!pending) {
        sendJson(res, 404, { error: 'Confirm request not found or expired' });
        return;
      }
      pendingConfirms.delete(confirmId);
      pending.resolve(answer ?? '');
      sendJson(res, 200, { ok: true });
      return;
    }

    // ── POST /api/agent/command-confirm ──
    if (url.pathname === '/api/agent/approval' && req.method === 'POST') {
      const { approvalId, decision, fingerprint } = await parseBody<ToolApprovalPayload>(req);
      if (!approvalId || !decision || !fingerprint) {
        throw new HttpError(400, 'approvalId、decision 和 fingerprint 为必填项');
      }
      if (!['allow_once', 'allow_whitelist', 'deny'].includes(decision)) {
        throw new HttpError(400, '非法批准决定');
      }
      const pending = pendingToolApprovals.get(approvalId);
      if (!pending) throw new HttpError(404, '批准请求不存在或已过期');
      if (pending.request.fingerprint !== fingerprint) {
        throw new HttpError(409, '批准 fingerprint 与待执行操作不匹配');
      }
      if (!pending.request.options.includes(decision)) {
        throw new HttpError(400, '批准决定不适用于当前操作');
      }
      await sessionRepository.recordApprovalResolved({
        sessionId: pending.sessionId,
        runId: pending.taskId,
        approvalId,
        decision,
      });
      pendingToolApprovals.delete(approvalId);
      pending.resolve({ decision, fingerprint });
      sendJson(res, 200, { ok: true, decision });
      return;
    }

    // ── POST /api/agent/command-confirm（兼容旧事件）──
    if (url.pathname === '/api/agent/command-confirm' && req.method === 'POST') {
      const { confirmId, decision } = await parseBody<CommandConfirmPayload>(req);
      if (!confirmId || !decision) {
        sendJson(res, 400, { error: 'confirmId and decision are required' });
        return;
      }
      if (!['allow_once', 'allow_whitelist', 'deny'].includes(decision)) {
        sendJson(res, 400, { error: 'invalid decision' });
        return;
      }
      const pending = pendingCommandConfirms.get(confirmId);
      if (!pending) {
        sendJson(res, 404, { error: 'Command confirm request not found or expired' });
        return;
      }
      pendingCommandConfirms.delete(confirmId);
      pending.resolve(decision);
      sendJson(res, 200, { ok: true, decision });
      return;
    }

    // ── POST /api/agent/preview（向后兼容）──
    if (url.pathname === '/api/agent/preview' && req.method === 'POST') {
      const parsed = await parseBody<ChatPayload>(req);

      res.writeHead(200, sseHeaders());

      const previewController = new AbortController();
      let previewFinished = false;
      res.on('close', () => {
        if (!previewFinished) previewController.abort('HTTP client disconnected');
      });

      const writer = createBoundedSseWriter(res, () => previewController.abort('SSE consumer is too slow'));
      const writeEvent = (event: AgentEvent) => writer.write(event);

      try {
        const result = await codingAgent.preview(parsed.prompt ?? '', parsed.selectedFile ?? null, (chunk) => {
          if (typeof chunk === 'string') {
            writeEvent({ type: 'chunk', chunk });
            return;
          }
          if (isAgentEvent(chunk)) writeEvent(chunk);
        }, { signal: previewController.signal });

        writeEvent({ type: 'result', result });
      } catch (error: unknown) {
        writeEvent({
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      await writer.drain();
      res.write('data: [DONE]\n\n');
      previewFinished = true;
      res.end();
      return;
    }

    // ── 项目模板列表 / 详情 ──
    if (url.pathname === '/api/templates' && req.method === 'GET') {
      const templates = templateGenerator.getTemplateList();
      sendJson(res, 200, { templates });
      return;
    }

    if (
      url.pathname.startsWith('/api/templates/category/') &&
      req.method === 'GET'
    ) {
      const category = decodeURIComponent(
        url.pathname.replace('/api/templates/category/', ''),
      );
      const templates = templateGenerator.getTemplatesByCategory(category);
      sendJson(res, 200, { category, templates });
      return;
    }

    if (url.pathname.startsWith('/api/templates/') && req.method === 'GET') {
      const templateId = decodeURIComponent(
        url.pathname.replace('/api/templates/', ''),
      );
      const template = templateGenerator.getTemplateDetail(templateId);
      if (!template) {
        sendJson(res, 404, { error: '模板不存在' });
        return;
      }
      sendJson(res, 200, template);
      return;
    }

    // ── 按模板生成项目骨架（SSE）──
    if (url.pathname === '/api/scaffold/generate' && req.method === 'POST') {
      const parsed = await parseBody<{
        projectName?: string;
        templateId?: string;
        author?: string;
        description?: string;
      }>(req);

      res.writeHead(200, sseHeaders());

      const writeEvent = (event: unknown) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      try {
        const projectParams = {
          projectName: parsed.projectName ?? 'my-project',
          templateId: parsed.templateId ?? 'vite-react-ts',
          author: parsed.author,
          description: parsed.description,
        };
        const generated = templateGenerator.generateProject(projectParams.templateId, projectParams);
        for (const file of generated.files) {
          await codingToolHost.writeFile(file.path, file.content);
          writeEvent({ type: 'tool', tool: 'write_file', summary: `Created file: ${file.path}` });
        }
        const result = createSuccessResponse({
          status: 'scaffold_ok',
          scaffoldInfo: generated.scaffoldInfo,
          files: generated.files.map((file) => ({ path: file.path })),
          output: generated.summary,
        });
        writeEvent({ type: 'result', result });
      } catch (error: unknown) {
        writeEvent({
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const content = await tryReadStaticFile(pathname);

    if (content) {
      const type = mimeTypes[extname(pathname)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type });
      res.end(content);
      return;
    }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/mcp')) {
      const index = await tryReadStaticFile('/index.html');
      if (index) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(index);
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    } catch (err) {
      const status = err instanceof HttpError
        ? err.status
        : err instanceof QueueMutationError
          ? err.code === 'NOT_FOUND' ? 404 : err.code === 'INVALID_ORDER' ? 400 : 409
          : 500;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[request error] ${req.method} ${url.pathname}:`, message);
      if (!(res as ServerResponse & { headersSent: boolean }).headersSent) {
        sendJson(res, status, { error: message });
      } else {
        res.end();
      }
    }
  });

  server.listen(port, () => {
    console.log(`DexCode running at http://localhost:${port}`);
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    (server as unknown as { close(callback?: () => void): void }).close();
    await Promise.allSettled([...workspaceRuntimes.values()].map((runtime) => runtime.managedMemory.drain({ timeoutMs: 60_000 })));
  };
  const runtimeProcess = process as unknown as { once(event: 'SIGINT' | 'SIGTERM', listener: () => void): void };
  runtimeProcess.once('SIGINT', () => { void shutdown(); });
  runtimeProcess.once('SIGTERM', () => { void shutdown(); });
  return { server, shutdown };
}
