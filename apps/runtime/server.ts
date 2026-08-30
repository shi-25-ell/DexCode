import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { createCodingAgent } from '../../packages/agent-core/index.ts';
import { createContextManager } from '../../packages/context-builder/index.ts';
import { createModelClient } from '../../packages/llm-client/index.ts';
import { createCodingToolHost } from '../../packages/tool-gateway/index.ts';
import { createWorkspaceRegistry, createWorkspaceService, type WorkspaceRecord } from '../../packages/workspace-manager/index.ts';
import { createSessionRepository } from '../../packages/session-store/index.ts';
import type { AgentEvent, PendingConfirm, PendingCommandConfirm, Session, SessionScope } from '../../packages/shared/types.ts';
import { validateCommand } from '../../packages/tool-gateway/command-safety.ts';
import type { CommandConfirmHook } from '../../packages/tool-gateway/run-command.ts';
import type { McpJsonRpcRequest } from '../../packages/mcp-server/index.ts';
import { createExternalMcpRegistry, type ExternalMcpServerConfig } from '../../packages/mcp-client/index.ts';
import { createSkillRegistry, importSkill, previewSkillImport, type SkillImportRequest } from '../../packages/skill-system/index.ts';
import { createTemplateGenerator } from '../../packages/template-generator/index.ts';
import { createSuccessResponse } from '../../packages/shared/index.ts';

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

function createCommandConfirmHook(
  sessionId: string,
  taskId: string,
  onEvent: (event: AgentEvent) => void,
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

      setTimeout(() => {
        if (pendingCommandConfirms.has(confirmId)) {
          pendingCommandConfirms.delete(confirmId);
          reject(new Error(`命令确认超时：${confirmId}`));
        }
      }, CONFIRM_TIMEOUT_MS);
    });
  };
}

function createConfirmHook(
  sessionId: string,
  taskId: string,
  onEvent: (event: AgentEvent) => void,
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

      setTimeout(() => {
        if (pendingConfirms.has(confirmId)) {
          pendingConfirms.delete(confirmId);
          reject(new Error(`确认请求超时：${confirmId}`));
        }
      }, CONFIRM_TIMEOUT_MS);
    });
  };
}

// ── 模块级初始化 ──
const modelClient = createModelClient();
const sessionRepository: SessionRepository = createSessionRepository();
const workspaceRegistry = createWorkspaceRegistry({
  registryFile: join(process.cwd(), 'workspaces', 'workspace-registry.json'),
});
const externalMcpConfigs: ExternalMcpServerConfig[] = (() => {
  const raw = process.env.EXTERNAL_MCP_SERVERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ExternalMcpServerConfig[] : [];
  } catch {
    return [];
  }
})();
const externalMcpRegistry = createExternalMcpRegistry(externalMcpConfigs);
const templateGenerator = createTemplateGenerator();

type WorkspaceRuntime = {
  workspace: WorkspaceRecord;
  workspaceService: WorkspaceService;
  codingToolHost: CodingToolHost;
  skillRegistry: SkillRegistry;
  codingAgent: CodingAgent;
};

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
  const nextCodingToolHost = createCodingToolHost(nextWorkspaceService);
  const nextContextManager = createContextManager(nextCodingToolHost);
  const nextSkillRegistry = createSkillRegistry({ workspaceRoot: workspace.canonicalRootPath });
  await nextSkillRegistry.loadAll();
  const nextCodingAgent = createCodingAgent(
    nextContextManager,
    nextCodingToolHost,
    modelClient,
    sessionRepository,
    externalMcpRegistry,
    nextSkillRegistry,
    { scope: { kind: 'workspace', workspaceId: workspace.workspaceId }, rootPath: workspace.canonicalRootPath },
  );
  const runtime = {
    workspace,
    workspaceService: nextWorkspaceService,
    codingToolHost: nextCodingToolHost,
    skillRegistry: nextSkillRegistry,
    codingAgent: nextCodingAgent,
  };
  workspaceRuntimes.set(workspace.workspaceId, runtime);
  return runtime;
}

async function runtimeForSession(session: Session): Promise<WorkspaceRuntime> {
  if (session.scope.kind !== 'workspace') throw new HttpError(409, 'WORKSPACE_REQUIRED');
  const cached = workspaceRuntimes.get(session.scope.workspaceId);
  if (cached) return cached;
  const workspace = await workspaceRegistry.resolveAvailable(session.scope.workspaceId);
  return loadWorkspaceRuntime(workspace.canonicalRootPath);
}

let activeRuntime = await loadWorkspaceRuntime(process.env.WORKSPACE_DIR, { allowCreate: true });
let workspaceService = activeRuntime.workspaceService;
let codingToolHost = activeRuntime.codingToolHost;
let skillRegistry = activeRuntime.skillRegistry;
let codingAgent = activeRuntime.codingAgent;

function activeScope(): SessionScope {
  return { kind: 'workspace', workspaceId: activeRuntime.workspace.workspaceId };
}

function isActiveSession(session: Session): boolean {
  return session.scope.kind === 'workspace'
    && session.scope.workspaceId === activeRuntime.workspace.workspaceId;
}

async function loadActiveSession(sessionId: string): Promise<Session> {
  const session = await sessionRepository.loadSession(sessionId);
  if (!session || !isActiveSession(session)) {
    throw new HttpError(404, 'Session not found in the active workspace');
  }
  return session;
}

function activateRuntime(runtime: WorkspaceRuntime): void {
  activeRuntime = runtime;
  workspaceService = runtime.workspaceService;
  codingToolHost = runtime.codingToolHost;
  skillRegistry = runtime.skillRegistry;
  codingAgent = runtime.codingAgent;
}

await sessionRepository.getCurrentSession(activeScope());

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

export function startRuntimeServer() {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    try {
    if (url.pathname === '/api/external-mcp/tools' && req.method === 'GET') {
      try {
        sendJson(res, 200, { tools: await externalMcpRegistry.listTools() });
      } catch (error: unknown) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' });
      }
      return;
    }

    // ── POST /api/external-mcp/servers（注册/同步外部 MCP 服务器）──
    if (url.pathname === '/api/external-mcp/servers' && req.method === 'POST') {
      try {
        const { servers } = await parseBody<{ servers?: ExternalMcpServerConfig[] }>(req);
        if (!Array.isArray(servers)) { sendJson(res, 400, { error: 'servers array required' }); return; }
        for (const server of servers) {
          if (server.enabled !== false && server.name) {
            externalMcpRegistry.addServer(server);
          }
        }
        const currentNames = new Set(servers.map((s) => s.name));
        for (const server of externalMcpRegistry.listServers()) {
          if (!currentNames.has(server.name)) {
            externalMcpRegistry.removeServer(server.name);
          }
        }
        sendJson(res, 200, { ok: true, servers: externalMcpRegistry.listServers() });
      } catch (error: unknown) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'Unknown error' });
      }
      return;
    }

    // ── DELETE /api/external-mcp/servers/:name ──
    if (url.pathname.startsWith('/api/external-mcp/servers/') && req.method === 'DELETE') {
      const name = decodeURIComponent(url.pathname.replace('/api/external-mcp/servers/', ''));
      externalMcpRegistry.removeServer(name);
      sendJson(res, 200, { ok: true, name, servers: externalMcpRegistry.listServers() });
      return;
    }

    // ── GET /api/external-mcp/servers ──
    if (url.pathname === '/api/external-mcp/servers' && req.method === 'GET') {
      sendJson(res, 200, { servers: externalMcpRegistry.listServers() });
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
      const response = await codingToolHost.mcp.jsonRpc(parsed);
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
      const session = await sessionRepository.getCurrentSession(activeScope());
      sendJson(res, 200, {
        appName: 'DexCode',
        llmEnabled: modelClient.model !== 'mock',
        provider: modelClient.model === 'mock' ? 'mock' : (process.env.LLM_PROVIDER || 'openai-compat'),
        sessionId: session?.sessionId ?? null,
        workspaceId: activeRuntime.workspace.workspaceId,
      });
      return;
    }

    // ── GET /api/session ──
    if (url.pathname === '/api/session' && req.method === 'GET') {
      const session = await sessionRepository.getCurrentSession(activeScope());
      sendJson(res, 200, {
        sessionId: session?.sessionId ?? null,
        scope: session?.scope ?? activeScope(),
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
      const scope = kind === 'general' ? { kind: 'general' } as const : activeScope();
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
      const scope = url.searchParams.get('scope') === 'general' ? { kind: 'general' } as const : activeScope();
      const sessions = await sessionRepository.listSessions(scope);
      sendJson(res, 200, { sessions });
      return;
    }

    // ── POST /api/session/switch（切换会话）──
    if (url.pathname === '/api/session/switch' && req.method === 'POST') {
      const { sessionId } = await parseBody<{ sessionId?: string }>(req);
      if (!sessionId) { sendJson(res, 400, { error: 'sessionId is required' }); return; }
      try {
        const session = await sessionRepository.switchSession(sessionId, activeScope());
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
      const session = await loadActiveSession(sessionId);
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
        await loadActiveSession(sessionId);
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
        await loadActiveSession(sessionId);
        const session = await sessionRepository.exportSession(sessionId);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${sessionId}.json"`,
        });
        res.end(JSON.stringify(session, null, 2));
      } catch (err) {
        sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ── GET /api/sessions/search ──
    if (url.pathname === '/api/sessions/search' && req.method === 'GET') {
      const query = url.searchParams.get('q') ?? '';
      const results = await sessionRepository.searchSessions(query, activeScope());
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
      sendJson(res, 200, await sessionRepository.getProjectMemory(activeRuntime.workspace.workspaceId));
      return;
    }

    if (url.pathname === '/api/project-memory' && req.method === 'PUT') {
      const { content } = await parseBody<RequestContext>(req);
      const updated = await sessionRepository.writeProjectMemory(content ?? '', activeRuntime.workspace.workspaceId);
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
        const updated = await sessionRepository.appendProjectMemory(entry, section, activeRuntime.workspace.workspaceId);
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
        activateRuntime(runtime);
        const tree = workspaceService.listTree();
        sendJson(res, 200, {
          ok: true,
          workspaceId: activeRuntime.workspace.workspaceId,
          rootDir: workspaceService.getRootDir(),
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
          .filter((entry): entry is { name: string; isDirectory: () => boolean } => {
            return typeof entry !== 'string' && entry.isDirectory() && !entry.name.startsWith('.') && entry.name.startsWith(partial);
          })
          .slice(0, 10)
          .map((entry) => join(dir, entry.name) + '/');
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
      sendJson(res, 200, { tools: [...localTools, ...externalTools] });
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
        session = await loadActiveSession(reqSessionId);
      } else {
        session = await sessionRepository.createSession(activeScope());
      }
      if (!isActiveSession(session)) throw new HttpError(409, 'SESSION_WORKSPACE_MISMATCH');
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

      try {
        await sessionRuntime.codingAgent.runTask(
          session.sessionId,
          prompt ?? '',
          selectedFile ?? null,
          writeEvent,
          { onConfirm: confirmHook, onCommandConfirm: commandConfirmHook },
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

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
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
}
