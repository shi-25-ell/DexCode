import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PROJECT_ID } from '../shared/index.ts';
import type { Session, SessionMeta, TaskSummary, ChatMessage } from '../shared/types.ts';

export type { Session, TaskSummary, ChatMessage };

export function createSessionRepository(options: { projectId?: string } = {}) {
  const projectId = options.projectId ?? DEFAULT_PROJECT_ID;
  const projectDir = join(process.cwd(), 'workspaces', projectId);
  const sessionsDir = join(process.cwd(), 'workspaces', projectId, 'sessions');
  const currentFile = join(sessionsDir, 'current.json');
  const memoryFile = join(projectDir, 'project-memory.md');

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
    return join(sessionsDir, `${sessionId}.json`);
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
    try {
      const raw = await readFile(sessionPath(sessionId), 'utf8');
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }

  async function saveSession(session: Session): Promise<Session> {
    await ensureDir();
    const updated: Session = { ...session, updatedAt: new Date().toISOString() };
    await writeFile(sessionPath(session.sessionId), JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  }

  async function createSession(): Promise<Session> {
    const sessionId = `session-${Date.now()}`;
    const session: Session = {
      sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      taskSummaries: [],
      activeTaskId: null,
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
    const session = await loadSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const updated: Session = { ...session, messages: [...session.messages, ...newMessages] };
    if (!updated.title) {
      const firstUser = updated.messages.find((m) => m.role === 'user');
      if (firstUser && typeof firstUser.content === 'string') {
        const text = firstUser.content.trim();
        updated.title = text.length > 30 ? text.slice(0, 30) + '...' : text;
      }
    }
    return saveSession(updated);
  }

  async function appendTaskSummary(sessionId: string, summary: TaskSummary): Promise<Session> {
    const session = await loadSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return saveSession({ ...session, taskSummaries: [...session.taskSummaries, summary] });
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
