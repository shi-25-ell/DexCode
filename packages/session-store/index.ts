import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PROJECT_ID } from '../shared/index.ts';
import type {
  ChatMessage,
  RunReport,
  Session,
  SessionLedgerRecord,
  SessionMeta,
  TaskSummary,
} from '../shared/types.ts';

export type { Session, TaskSummary, ChatMessage };

export function createSessionRepository(options: { projectId?: string } = {}) {
  const projectId = options.projectId ?? DEFAULT_PROJECT_ID;
  const projectDir = join(process.cwd(), 'workspaces', projectId);
  const sessionsDir = join(process.cwd(), 'workspaces', projectId, 'sessions');
  const currentFile = join(sessionsDir, 'current.json');
  const memoryFile = join(projectDir, 'project-memory.md');
  const locks = new Map<string, Promise<void>>();
  const activeRuns = new Set<string>();

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

  function normalized(session: Session): Session {
    return {
      ...session,
      revision: session.revision ?? 0,
      ledger: session.ledger ?? [],
      runReports: session.runReports ?? [],
    };
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

  async function getCurrentSessionId(): Promise<string | null> {
    try {
      const raw = await readFile(currentFile, 'utf8');
      const data = JSON.parse(raw) as { currentSessionId?: string };
      return data.currentSessionId ?? null;
    } catch {
      return null;
    }
  }

  async function setCurrentSessionId(sessionId: string) {
    await ensureDir();
    await writeFile(currentFile, JSON.stringify({ currentSessionId: sessionId }, null, 2), 'utf8');
  }

  async function loadSession(sessionId: string): Promise<Session | null> {
    return withSessionLock(sessionId, async () => {
      const session = await loadRaw(sessionId);
      if (!session?.activeTaskId || activeRuns.has(`${sessionId}:${session.activeTaskId}`)) return session;
      const runId = session.activeTaskId;
      const completedAt = new Date().toISOString();
      const started = session.ledger?.find((record) => record.runId === runId && record.type === 'run_started');
      const report: RunReport = {
        version: 1,
        runId,
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

  async function createSession(): Promise<Session> {
    const sessionId = `session-${crypto.randomUUID()}`;
    const session: Session = {
      sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      taskSummaries: [],
      activeTaskId: null,
      revision: 0,
      ledger: [],
      runReports: [],
    };
    await saveSession(session);
    await setCurrentSessionId(sessionId);
    return session;
  }

  async function getOrCreateCurrentSession(): Promise<Session> {
    const currentId = await getCurrentSessionId();
    if (currentId) {
      const existing = await loadSession(currentId);
      if (existing) return existing;
    }
    return createSession();
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

  async function beginRun(input: { sessionId: string; runId: string; userMessage: ChatMessage }): Promise<Session> {
    return withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId) throw new Error(`Session already has active Run: ${session.activeTaskId}`);
      const at = new Date().toISOString();
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      const next = await saveUnlocked({
        ...session,
        activeTaskId: input.runId,
        revision: (session.revision ?? 0) + 1,
        messages: [...session.messages, input.userMessage],
        ledger: [
          ...(session.ledger ?? []),
          { seq, at, runId: input.runId, type: 'run_started' },
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

  async function finishRun(input: { sessionId: string; report: RunReport; summary: TaskSummary }) {
    return withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      const existing = session.runReports?.find((report) => report.runId === input.report.runId);
      if (existing) return { session, report: existing, committed: false };
      if (session.activeTaskId !== input.report.runId) throw new Error(`Run is not active: ${input.report.runId}`);
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      const next = await saveUnlocked({
        ...session,
        activeTaskId: null,
        revision: (session.revision ?? 0) + 1,
        taskSummaries: [...session.taskSummaries, input.summary],
        runReports: [...(session.runReports ?? []), input.report],
        ledger: [...(session.ledger ?? []), { seq, at: input.report.completedAt, runId: input.report.runId, type: 'run_terminal', report: input.report }],
      });
      activeRuns.delete(`${input.sessionId}:${input.report.runId}`);
      return { session: next, report: input.report, committed: true };
    });
  }

  async function readProjectMemory(): Promise<string> {
    try {
      return await readFile(memoryFile, 'utf8');
    } catch {
      return '';
    }
  }

  async function getProjectMemory(): Promise<{ content: string; path: string; exists: boolean; template: string }> {
    try {
      return {
        content: await readFile(memoryFile, 'utf8'),
        path: memoryFile,
        exists: true,
        template: defaultProjectMemory,
      };
    } catch {
      return {
        content: '',
        path: memoryFile,
        exists: false,
        template: defaultProjectMemory,
      };
    }
  }

  async function writeProjectMemory(content: string): Promise<{ content: string; path: string; updatedAt: string }> {
    await ensureProjectDir();
    const normalized = content.replace(/\r\n/g, '\n').trimEnd();
    const updatedAt = new Date().toISOString();
    await writeFile(memoryFile, `${normalized}\n`, 'utf8');
    return { content: `${normalized}\n`, path: memoryFile, updatedAt };
  }

  async function appendProjectMemory(entry: string, section = 'Agent 任务经验'): Promise<{ content: string; path: string; updatedAt: string }> {
    const trimmed = entry.trim();
    if (!trimmed) throw new Error('Project memory entry is empty');

    const current = (await readProjectMemory()).trimEnd() || defaultProjectMemory.trimEnd();
    const heading = `## ${section}`;
    const datedEntry = `- ${new Date().toISOString().slice(0, 10)}: ${trimmed.replace(/\s+/g, ' ')}`;
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionPattern = new RegExp(`(^##\\s+${escaped}\\s*$)`, 'm');
    const next = sectionPattern.test(current)
      ? current.replace(sectionPattern, `$1\n${datedEntry}`)
      : `${current}\n\n${heading}\n${datedEntry}`;

    return writeProjectMemory(next);
  }

  async function listSessions(): Promise<Array<{
    sessionId: string;
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
            const lastUser = [...s.messages].reverse().find((m) => m.role === 'user');
            const lastMsg = typeof lastUser?.content === 'string' ? lastUser.content : '';
            return {
              sessionId: s.sessionId,
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

  async function switchSession(sessionId: string): Promise<Session> {
    const session = await loadSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    await setCurrentSessionId(sessionId);
    return session;
  }

  async function deleteSession(sessionId: string): Promise<boolean> {
    try {
      await rm(sessionPath(sessionId), { force: true });
      const currentId = await getCurrentSessionId();
      if (currentId === sessionId) {
        await writeFile(currentFile, JSON.stringify({ currentSessionId: null }, null, 2), 'utf8');
      }
      return true;
    } catch {
      return false;
    }
  }

  async function updateSessionMeta(sessionId: string, meta: SessionMeta): Promise<Session> {
    const session = await loadSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (meta.title !== undefined) session.title = meta.title;
    if (meta.archived !== undefined) session.archived = meta.archived;
    return saveSession(session);
  }

  async function searchSessions(query: string): Promise<Array<{
    sessionId: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    archived: boolean;
    messageCount: number;
    taskCount: number;
    lastMessage: string;
  }>> {
    const sessions = await listSessions();
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
    loadSession,
    saveSession,
    getOrCreateCurrentSession,
    appendMessages,
    appendTaskSummary,
    beginRun,
    appendRunMessage,
    markToolStarted,
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
