import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_PROJECT_ID } from '../shared/index.ts';
import type {
  ChatMessage,
  CompactionCheckpoint,
  ContextManifest,
  RunReport,
  RunContext,
  Session,
  SessionLedgerRecord,
  SessionMeta,
  SessionScope,
  TaskSummary,
} from '../shared/types.ts';

export type { Session, TaskSummary, ChatMessage };

export function createSessionRepository(options: { projectId?: string } = {}) {
  const projectId = options.projectId ?? DEFAULT_PROJECT_ID;
  const projectDir = join(process.cwd(), 'workspaces', projectId);
  const sessionsDir = join(process.cwd(), 'workspaces', projectId, 'sessions');
  const currentFile = join(sessionsDir, 'current.json');
  const memoryFile = join(projectDir, 'project-memory.md');
  const workspaceDataDir = join(projectDir, 'workspace-data');
  const locks = new Map<string, Promise<void>>();
  const activeRuns = new Set<string>();
  let currentLock: Promise<void> = Promise.resolve();

  const defaultProjectMemory = `# 项目记忆

## 编码规范
- 使用 TypeScript 严格模式

## 技术决策
- 待记录

## 常见问题
- 待记录

## 用户偏好
- 待记录

## Agent 任务经验
- 待记录
`;

  async function ensureDir() {
    await mkdir(sessionsDir, { recursive: true });
  }

  async function ensureProjectDir() {
    await mkdir(projectDir, { recursive: true });
  }

  function sessionPath(sessionId: string) {
    if (!/^session-[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error('Invalid session id');
    return join(sessionsDir, `${sessionId}.json`);
  }

  function normalizeScope(scope: SessionScope | undefined): SessionScope {
    if (!scope) return { kind: 'general' };
    if (scope.kind === 'general') return { kind: 'general' };
    if (scope.kind === 'workspace' && /^workspace-[a-zA-Z0-9-]+$/.test(scope.workspaceId)) {
      return { kind: 'workspace', workspaceId: scope.workspaceId };
    }
    throw new Error('Session has an invalid scope');
  }

  function normalized(session: Session): Session {
    return {
      ...session,
      scope: normalizeScope(session.scope),
      revision: session.revision ?? 0,
      ledger: session.ledger ?? [],
      runReports: session.runReports ?? [],
      contextManifests: session.contextManifests ?? [],
      compactionCheckpoints: session.compactionCheckpoints ?? [],
    };
  }

  function scopeKey(scope: SessionScope): string {
    return scope.kind === 'general' ? 'general' : `workspace:${scope.workspaceId}`;
  }

  function sameScope(left: SessionScope, right: SessionScope): boolean {
    return scopeKey(left) === scopeKey(right);
  }

  function isMaterialized(session: Session): boolean {
    return session.messages.length > 0
      || session.taskSummaries.length > 0
      || (session.ledger?.some((record) => record.type === 'run_started') ?? false)
      || (session.runReports?.length ?? 0) > 0;
  }

  function memoryPath(workspaceId?: string): string {
    if (!workspaceId) return memoryFile;
    if (!/^workspace-[a-zA-Z0-9-]+$/.test(workspaceId)) throw new Error('Invalid workspace id');
    return join(workspaceDataDir, workspaceId, 'project-memory.md');
  }

  async function withSessionLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(sessionId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    locks.set(sessionId, previous.then(() => current));
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async function loadRaw(sessionId: string): Promise<Session | null> {
    try {
      const raw = await readFile(sessionPath(sessionId), 'utf8');
      return normalized(JSON.parse(raw) as Session);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new Error(`Session is corrupt: ${sessionId}`, { cause: error });
      throw error;
    }
  }

  async function saveUnlocked(session: Session): Promise<Session> {
    await ensureDir();
    const updated = normalized({ ...session, updatedAt: new Date().toISOString() });
    const target = sessionPath(session.sessionId);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(updated, null, 2), 'utf8');
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return updated;
  }

  async function readCurrentSessions(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(currentFile, 'utf8');
      const data = JSON.parse(raw) as { currentSessionId?: string; currentSessionByScope?: Record<string, string> };
      if (data.currentSessionByScope) return data.currentSessionByScope;
      return data.currentSessionId ? { general: data.currentSessionId } : {};
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return {};
      if (error instanceof SyntaxError) throw new Error('Current Session index is corrupt', { cause: error });
      throw error;
    }
  }

  async function getCurrentSessionId(scope: SessionScope = { kind: 'general' }): Promise<string | null> {
    return (await readCurrentSessions())[scopeKey(scope)] ?? null;
  }

  async function setCurrentSessionId(sessionId: string | null, scope: SessionScope = { kind: 'general' }) {
    const previous = currentLock;
    let release = () => {};
    currentLock = new Promise<void>((resolveLock) => { release = resolveLock; });
    await previous;
    try {
      await ensureDir();
      const currentSessionByScope = await readCurrentSessions();
      if (sessionId) currentSessionByScope[scopeKey(scope)] = sessionId;
      else delete currentSessionByScope[scopeKey(scope)];
      const temporary = `${currentFile}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 2, currentSessionByScope }, null, 2), 'utf8');
      try {
        await rename(temporary, currentFile);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    } finally {
      release();
    }
  }

  async function loadSession(sessionId: string): Promise<Session | null> {
    return withSessionLock(sessionId, async () => {
      const session = await loadRaw(sessionId);
      if (!session?.activeTaskId || activeRuns.has(`${sessionId}:${session.activeTaskId}`)) return session;
      const runId = session.activeTaskId;
      const completedAt = new Date().toISOString();
      const started = session.ledger?.find(
        (record): record is Extract<SessionLedgerRecord, { type: 'run_started' }> =>
          record.runId === runId && record.type === 'run_started',
      );
      const report: RunReport = {
        version: 1,
        runId,
        ...(started?.context ? { context: started.context } : {}),
        status: 'failed',
        terminationReason: 'recovered_interruption',
        startedAt: started?.at ?? session.updatedAt,
        completedAt,
        modelTurnCount: 0,
        modelAttemptCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, unknown: 0 },
        toolsUsed: [],
        filesModified: [],
        error: { code: 'RECOVERED_INTERRUPTION', message: 'Previous Run was interrupted before terminal commit' },
      };
      const nextSeq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      return saveUnlocked({
        ...session,
        activeTaskId: null,
        revision: (session.revision ?? 0) + 1,
        runReports: [...(session.runReports ?? []), report],
        ledger: [
          ...(session.ledger ?? []),
          { seq: nextSeq, at: completedAt, runId, type: 'recovery', reason: 'interrupted' },
          { seq: nextSeq + 1, at: completedAt, runId, type: 'run_terminal', report },
        ],
      });
    });
  }

  async function saveSession(session: Session): Promise<Session> {
    return withSessionLock(session.sessionId, () => saveUnlocked(session));
  }

  async function createSession(scope: SessionScope = { kind: 'general' }): Promise<Session> {
    scope = normalizeScope(scope);
    const sessionId = `session-${crypto.randomUUID()}`;
    const session: Session = {
      sessionId,
      scope,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      taskSummaries: [],
      activeTaskId: null,
      revision: 0,
      ledger: [],
      runReports: [],
      contextManifests: [],
      compactionCheckpoints: [],
    };
    await withSessionLock(sessionId, async () => {
      if (await loadRaw(sessionId)) throw new Error(`Session already exists: ${sessionId}`);
      await saveUnlocked(session);
    });
    await setCurrentSessionId(sessionId, scope);
    return session;
  }

  async function getCurrentSession(scope: SessionScope = { kind: 'general' }): Promise<Session | null> {
    scope = normalizeScope(scope);
    const currentId = await getCurrentSessionId(scope);
    if (!currentId) return null;
    const existing = await loadSession(currentId);
    return existing && sameScope(existing.scope, scope) && isMaterialized(existing) ? existing : null;
  }

  async function appendMessages(sessionId: string, newMessages: ChatMessage[]): Promise<Session> {
    return withSessionLock(sessionId, async () => {
      const session = await loadRaw(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      const updated: Session = { ...session, messages: [...session.messages, ...newMessages] };
      if (!updated.title) {
        const firstUser = updated.messages.find((m) => m.role === 'user');
        if (firstUser && typeof firstUser.content === 'string') {
          const text = firstUser.content.trim();
          updated.title = text.length > 30 ? text.slice(0, 30) + '...' : text;
        }
      }
      return saveUnlocked({ ...updated, revision: (session.revision ?? 0) + 1 });
    });
  }

  async function appendTaskSummary(sessionId: string, summary: TaskSummary): Promise<Session> {
    return withSessionLock(sessionId, async () => {
      const session = await loadRaw(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      return saveUnlocked({ ...session, revision: (session.revision ?? 0) + 1, taskSummaries: [...session.taskSummaries, summary] });
    });
  }

  async function beginRun(input: { sessionId: string; runId: string; userMessage: ChatMessage; context: RunContext }): Promise<Session> {
    return withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId) throw new Error(`Session already has active Run: ${session.activeTaskId}`);
      if (!sameScope(session.scope, input.context.scope)) throw new Error('Run context does not match Session scope');
      if (session.scope.kind === 'workspace') {
        if (!input.context.workspace || input.context.workspace.workspaceId !== session.scope.workspaceId) {
          throw new Error('Run workspace does not match Session scope');
        }
      } else if (input.context.workspace) {
        throw new Error('General Session cannot start with a workspace');
      }
      const at = new Date().toISOString();
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      const next = await saveUnlocked({
        ...session,
        activeTaskId: input.runId,
        revision: (session.revision ?? 0) + 1,
        messages: [...session.messages, input.userMessage],
        ledger: [
          ...(session.ledger ?? []),
          { seq, at, runId: input.runId, type: 'run_started', context: input.context },
          { seq: seq + 1, at, runId: input.runId, type: 'message', message: input.userMessage },
        ],
      });
      activeRuns.add(`${input.sessionId}:${input.runId}`);
      return next;
    });
  }

  async function appendRunMessage(input: { sessionId: string; runId: string; message: ChatMessage }): Promise<Session> {
    return withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId !== input.runId) throw new Error(`Run is not active: ${input.runId}`);
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      return saveUnlocked({
        ...session,
        revision: (session.revision ?? 0) + 1,
        messages: [...session.messages, input.message],
        ledger: [...(session.ledger ?? []), { seq, at: new Date().toISOString(), runId: input.runId, type: 'message', message: input.message }],
      });
    });
  }

  async function markToolStarted(input: { sessionId: string; runId: string; callId: string; tool: string }): Promise<Session> {
    return withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId !== input.runId) throw new Error(`Run is not active: ${input.runId}`);
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      return saveUnlocked({
        ...session,
        revision: (session.revision ?? 0) + 1,
        ledger: [...(session.ledger ?? []), { seq, at: new Date().toISOString(), runId: input.runId, type: 'tool_started', callId: input.callId, tool: input.tool }],
      });
    });
  }

  async function commitContext(input: { sessionId: string; runId: string; manifest: ContextManifest; checkpoint?: CompactionCheckpoint }): Promise<Session> {
    return withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId !== input.runId) throw new Error(`Run is not active: ${input.runId}`);
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      return saveUnlocked({
        ...session,
        revision: (session.revision ?? 0) + 1,
        contextManifests: [...(session.contextManifests ?? []), input.manifest],
        compactionCheckpoints: input.checkpoint
          ? [...(session.compactionCheckpoints ?? []), input.checkpoint]
          : session.compactionCheckpoints,
        ledger: [...(session.ledger ?? []), {
          seq,
          at: new Date().toISOString(),
          runId: input.runId,
          type: 'context_committed',
          manifest: input.manifest,
          ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
        }],
      });
    });
  }

  async function finishRun(input: { sessionId: string; report: RunReport; summary: TaskSummary }) {
    return withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      const existing = session.runReports?.find((report) => report.runId === input.report.runId);
      if (existing) return { session, report: existing, committed: false };
      if (session.activeTaskId !== input.report.runId) throw new Error(`Run is not active: ${input.report.runId}`);
      const started = session.ledger?.find(
        (record): record is Extract<SessionLedgerRecord, { type: 'run_started' }> =>
          record.runId === input.report.runId && record.type === 'run_started',
      );
      if (!started?.context) throw new Error(`Run context is missing: ${input.report.runId}`);
      if (input.report.context && JSON.stringify(input.report.context) !== JSON.stringify(started.context)) {
        throw new Error('Terminal Run context does not match its start context');
      }
      const report: RunReport = { ...input.report, context: started.context };
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      const next = await saveUnlocked({
        ...session,
        activeTaskId: null,
        revision: (session.revision ?? 0) + 1,
        taskSummaries: [...session.taskSummaries, input.summary],
        runReports: [...(session.runReports ?? []), report],
        ledger: [...(session.ledger ?? []), { seq, at: report.completedAt, runId: report.runId, type: 'run_terminal', report }],
      });
      activeRuns.delete(`${input.sessionId}:${report.runId}`);
      return { session: next, report, committed: true };
    });
  }

  async function readProjectMemory(workspaceId?: string): Promise<string> {
    try {
      return await readFile(memoryPath(workspaceId), 'utf8');
    } catch {
      return '';
    }
  }

  async function getProjectMemory(workspaceId?: string): Promise<{ content: string; path: string; exists: boolean; template: string }> {
    const target = memoryPath(workspaceId);
    try {
      return {
        content: await readFile(target, 'utf8'),
        path: target,
        exists: true,
        template: defaultProjectMemory,
      };
    } catch {
      return {
        content: '',
        path: target,
        exists: false,
        template: defaultProjectMemory,
      };
    }
  }

  async function writeProjectMemory(content: string, workspaceId?: string): Promise<{ content: string; path: string; updatedAt: string }> {
    const target = memoryPath(workspaceId);
    await ensureProjectDir();
    await mkdir(dirname(target), { recursive: true });
    const normalized = content.replace(/\r\n/g, '\n').trimEnd();
    const updatedAt = new Date().toISOString();
    await writeFile(target, `${normalized}\n`, 'utf8');
    return { content: `${normalized}\n`, path: target, updatedAt };
  }

  async function appendProjectMemory(entry: string, section = 'Agent 任务经验', workspaceId?: string): Promise<{ content: string; path: string; updatedAt: string }> {
    const trimmed = entry.trim();
    if (!trimmed) throw new Error('Project memory entry is empty');

    const current = (await readProjectMemory(workspaceId)).trimEnd() || defaultProjectMemory.trimEnd();
    const heading = `## ${section}`;
    const datedEntry = `- ${new Date().toISOString().slice(0, 10)}: ${trimmed.replace(/\s+/g, ' ')}`;
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionPattern = new RegExp(`(^##\\s+${escaped}\\s*$)`, 'm');
    const next = sectionPattern.test(current)
      ? current.replace(sectionPattern, `$1\n${datedEntry}`)
      : `${current}\n\n${heading}\n${datedEntry}`;

    return writeProjectMemory(next, workspaceId);
  }

  async function listSessions(scope?: SessionScope): Promise<Array<{
    sessionId: string;
    scope: SessionScope;
    createdAt: string;
    updatedAt: string;
    title: string;
    archived: boolean;
    messageCount: number;
    taskCount: number;
    lastMessage: string;
  }>> {
    await ensureDir();
    let files: string[];
    try {
      files = await readdir(sessionsDir) as string[];
    } catch {
      return [];
    }
    const results = await Promise.all(
      files
        .filter((f) => f.endsWith('.json') && f !== 'current.json')
        .map(async (f) => {
          try {
            const raw = await readFile(join(sessionsDir, f), 'utf8');
            const s = JSON.parse(raw) as Session;
            const normalizedSession = normalized(s);
            if (!isMaterialized(normalizedSession)) return null;
            const lastUser = [...s.messages].reverse().find((m) => m.role === 'user');
            const lastMsg = typeof lastUser?.content === 'string' ? lastUser.content : '';
            if (scope && !sameScope(normalizedSession.scope, scope)) return null;
            return {
              sessionId: s.sessionId,
              scope: normalizedSession.scope,
              createdAt: s.createdAt,
              updatedAt: s.updatedAt,
              title: s.title ?? '',
              archived: s.archived ?? false,
              messageCount: s.messages.length,
              taskCount: s.taskSummaries.length,
              lastMessage: lastMsg.slice(0, 60),
            };
          } catch {
            return null;
          }
        }),
    );
    return results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function switchSession(sessionId: string, expectedScope?: SessionScope): Promise<Session> {
    const session = await loadSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (expectedScope && !sameScope(session.scope, expectedScope)) {
      throw new Error('Session does not belong to the active workspace');
    }
    await setCurrentSessionId(sessionId, session.scope);
    return session;
  }

  async function deleteSession(sessionId: string): Promise<boolean> {
    const session = await loadRaw(sessionId);
    if (!session) return false;
    if (session.activeTaskId) throw new Error(`Cannot delete Session with active Run: ${session.activeTaskId}`);
    await rm(sessionPath(sessionId), { force: true });
    const currentId = await getCurrentSessionId(session.scope);
    if (currentId === sessionId) {
      await setCurrentSessionId(null, session.scope);
    }
    return true;
  }

  async function updateSessionMeta(sessionId: string, meta: SessionMeta): Promise<Session> {
    const session = await loadSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (meta.title !== undefined) session.title = meta.title;
    if (meta.archived !== undefined) session.archived = meta.archived;
    return saveSession(session);
  }

  async function searchSessions(query: string, scope?: SessionScope): Promise<Array<{
    sessionId: string;
    scope: SessionScope;
    createdAt: string;
    updatedAt: string;
    title: string;
    archived: boolean;
    messageCount: number;
    taskCount: number;
    lastMessage: string;
  }>> {
    const sessions = await listSessions(scope);
    if (!query.trim()) return sessions;
    const lower = query.toLowerCase();
    return sessions.filter(
      (s) => s.title.toLowerCase().includes(lower) || s.lastMessage.toLowerCase().includes(lower),
    ).slice(0, 20);
  }

  async function exportSession(sessionId: string): Promise<Session> {
    const session = await loadSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  return {
    sessionsDir,
    getCurrentSessionId,
    setCurrentSessionId,
    createSession,
    getCurrentSession,
    loadSession,
    saveSession,
    appendMessages,
    appendTaskSummary,
    beginRun,
    appendRunMessage,
    markToolStarted,
    commitContext,
    finishRun,
    readProjectMemory,
    getProjectMemory,
    writeProjectMemory,
    appendProjectMemory,
    listSessions,
    switchSession,
    deleteSession,
    updateSessionMeta,
    searchSessions,
    exportSession,
  };
}
