import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { DEFAULT_PROJECT_ID } from '../shared/index.ts';
import { conversationTitle } from '../conversation-view/title.ts';
import type {
  ChatMessage,
  CompactionCheckpoint,
  ContextActivity,
  ContextArtifactRef,
  ContextManifest,
  ContextManifestV2,
  ContextPresentation,
  ContextSummaryRecord,
  ContextUsageSnapshot,
  RunReport,
  RunContext,
  Session,
  SessionLedgerRecord,
  SessionMeta,
  SessionScope,
  TaskSummary,
  ToolPresentation,
  ToolApprovalRequest,
  ApprovalOption,
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
  let materializationLock: Promise<void> = Promise.resolve();

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

  function artifactRoot(sessionId: string) {
    sessionPath(sessionId);
    return join(sessionsDir, sessionId, 'artifacts');
  }

  function contained(root: string, target: string): boolean {
    const rel = relative(resolve(root), resolve(target));
    return rel === '' || (!rel.startsWith('..') && !rel.includes(':'));
  }

  function safeArtifactPart(value: string): string {
    return value.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 48) || 'context';
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
      contextSummaries: session.contextSummaries ?? [],
      contextArtifacts: session.contextArtifacts ?? [],
      clientRequestIds: session.clientRequestIds ?? [],
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

  async function withMaterializationLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = materializationLock;
    let release = () => {};
    materializationLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
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

  async function materializeRun(input: {
    scope: SessionScope;
    clientRequestId: string;
    runId: string;
    userMessage: ChatMessage;
    context: RunContext;
  }): Promise<{ session: Session; created: boolean }> {
    const scope = normalizeScope(input.scope);
    if (!input.clientRequestId.trim()) throw new Error('clientRequestId is required');
    if (!sameScope(scope, input.context.scope)) throw new Error('Run context does not match Session scope');
    return withMaterializationLock(async () => {
      await ensureDir();
      let files: string[] = [];
      try {
        files = await readdir(sessionsDir) as string[];
      } catch {
        files = [];
      }
      for (const file of files) {
        if (!file.endsWith('.json') || file === 'current.json') continue;
        try {
          const candidate = normalized(JSON.parse(await readFile(join(sessionsDir, file), 'utf8')) as Session);
          if (sameScope(candidate.scope, scope) && candidate.clientRequestIds?.includes(input.clientRequestId)) {
            return { session: candidate, created: false };
          }
        } catch {
          continue;
        }
      }

      const sessionId = `session-${crypto.randomUUID()}`;
      const at = new Date().toISOString();
      const content = input.userMessage.role === 'user' ? input.userMessage.content : '';
      const session: Session = {
        sessionId,
        scope,
        createdAt: at,
        updatedAt: at,
        title: conversationTitle(content),
        messages: [input.userMessage],
        taskSummaries: [],
        activeTaskId: input.runId,
        revision: 1,
        ledger: [
          { seq: 1, at, runId: input.runId, type: 'run_started', context: input.context, clientRequestId: input.clientRequestId },
          { seq: 2, at, runId: input.runId, type: 'message', message: input.userMessage },
        ],
        runReports: [],
        contextManifests: [],
        compactionCheckpoints: [],
        contextSummaries: [],
        contextArtifacts: [],
        clientRequestIds: [input.clientRequestId],
      };
      const saved = await withSessionLock(sessionId, () => saveUnlocked(session));
      activeRuns.add(`${sessionId}:${input.runId}`);
      await setCurrentSessionId(sessionId, scope);
      return { session: saved, created: true };
    });
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
      contextSummaries: [],
      contextArtifacts: [],
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

  async function beginRun(input: { sessionId: string; runId: string; userMessage: ChatMessage; context: RunContext; clientRequestId?: string }): Promise<Session> {
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
      const title = session.title?.trim()
        || (input.userMessage.role === 'user' ? conversationTitle(input.userMessage.content) : '恢复的会话');
      const clientRequestIds = input.clientRequestId
        ? [...new Set([...(session.clientRequestIds ?? []), input.clientRequestId])]
        : session.clientRequestIds;
      const next = await saveUnlocked({
        ...session,
        title,
        clientRequestIds,
        activeTaskId: input.runId,
        revision: (session.revision ?? 0) + 1,
        messages: [...session.messages, input.userMessage],
        ledger: [
          ...(session.ledger ?? []),
          {
            seq,
            at,
            runId: input.runId,
            type: 'run_started',
            context: input.context,
            ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
          },
          { seq: seq + 1, at, runId: input.runId, type: 'message', message: input.userMessage },
        ],
      });
      activeRuns.add(`${input.sessionId}:${input.runId}`);
      return next;
    });
  }

  async function appendRunMessage(input: { sessionId: string; runId: string; message: ChatMessage; messageId?: string; turn?: number }): Promise<Session> {
    return withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId !== input.runId) throw new Error(`Run is not active: ${input.runId}`);
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      return saveUnlocked({
        ...session,
        revision: (session.revision ?? 0) + 1,
        messages: [...session.messages, input.message],
        ledger: [...(session.ledger ?? []), {
          seq,
          at: new Date().toISOString(),
          runId: input.runId,
          type: 'message',
          message: input.message,
          ...(input.messageId ? { messageId: input.messageId } : {}),
          ...(input.turn !== undefined ? { turn: input.turn } : {}),
        }],
      });
    });
  }

  async function markToolStarted(input: { sessionId: string; runId: string; callId: string; tool: string; input?: Record<string, unknown> }): Promise<Session> {
    return withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId !== input.runId) throw new Error(`Run is not active: ${input.runId}`);
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      return saveUnlocked({
        ...session,
        revision: (session.revision ?? 0) + 1,
        ledger: [...(session.ledger ?? []), {
          seq,
          at: new Date().toISOString(),
          runId: input.runId,
          type: 'tool_started',
          callId: input.callId,
          tool: input.tool,
          ...(input.input ? { input: input.input } : {}),
        }],
      });
    });
  }

  async function commitToolOutcome(input: {
    sessionId: string;
    runId: string;
    message: ChatMessage;
    presentation: ToolPresentation;
  }): Promise<Session> {
    return withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId !== input.runId) throw new Error(`Run is not active: ${input.runId}`);
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      const at = new Date().toISOString();
      return saveUnlocked({
        ...session,
        revision: (session.revision ?? 0) + 1,
        messages: [...session.messages, input.message],
        ledger: [
          ...(session.ledger ?? []),
          { seq, at, runId: input.runId, type: 'message', message: input.message },
          { seq: seq + 1, at, runId: input.runId, type: 'tool_completed', callId: input.presentation.callRef, presentation: input.presentation },
        ],
      });
    });
  }

  async function recordApprovalRequested(input: {
    sessionId: string;
    runId: string;
    approvalId: string;
    request: ToolApprovalRequest;
  }): Promise<Session> {
    return withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId !== input.runId) throw new Error(`Run is not active: ${input.runId}`);
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      return saveUnlocked({
        ...session,
        revision: (session.revision ?? 0) + 1,
        ledger: [...(session.ledger ?? []), {
          seq,
          at: new Date().toISOString(),
          runId: input.runId,
          type: 'approval_requested',
          approvalId: input.approvalId,
          request: input.request,
        }],
      });
    });
  }

  async function recordApprovalResolved(input: {
    sessionId: string;
    runId: string;
    approvalId: string;
    decision: ApprovalOption;
  }): Promise<Session> {
    return withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId !== input.runId) throw new Error(`Run is not active: ${input.runId}`);
      const requested = session.ledger?.some((record) => record.type === 'approval_requested' && record.approvalId === input.approvalId);
      if (!requested) throw new Error(`Approval request not found: ${input.approvalId}`);
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      return saveUnlocked({
        ...session,
        revision: (session.revision ?? 0) + 1,
        ledger: [...(session.ledger ?? []), {
          seq,
          at: new Date().toISOString(),
          runId: input.runId,
          type: 'approval_resolved',
          approvalId: input.approvalId,
          decision: input.decision,
        }],
      });
    });
  }

  async function commitContext(input: {
    sessionId: string;
    runId: string;
    manifest: ContextManifest;
    checkpoint?: CompactionCheckpoint;
    summaryRecord?: ContextSummaryRecord;
    activity?: ContextActivity;
  }): Promise<Session> {
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
        contextSummaries: input.summaryRecord
          ? [...(session.contextSummaries ?? []), input.summaryRecord]
          : session.contextSummaries,
        ledger: input.manifest.version === 2
          ? [
              ...(session.ledger ?? []),
              { seq, at: new Date().toISOString(), runId: input.runId, type: 'context_prepare_committed', manifest: input.manifest },
              ...(input.activity ? [{
                seq: seq + 1,
                at: new Date().toISOString(),
                runId: input.runId,
                type: 'context_compaction_completed' as const,
                presentation: {
                  operationRef: input.activity.operationRef,
                  status: 'completed' as const,
                  beforeTokens: input.activity.beforeTokens,
                  afterTokens: input.activity.afterTokens,
                  breakdown: input.activity.afterBreakdown,
                  externalizedToolResults: input.activity.externalizedToolResults,
                  archivedMessages: input.activity.archivedMessages,
                  archivedConversationSegments: input.activity.archivedConversationSegments,
                  compactedToolResults: input.activity.compactedToolResults,
                  summarizedMessages: input.activity.summarizedMessages,
                  retainedConversationSegments: input.activity.retainedConversationSegments,
                  retainedMessageCount: input.activity.retainedMessageCount,
                },
                ...(input.summaryRecord ? { summaryRecordId: input.summaryRecord.id } : {}),
              }] : []),
            ]
          : [...(session.ledger ?? []), {
              seq,
              at: new Date().toISOString(),
              runId: input.runId,
              type: 'context_committed' as const,
              manifest: input.manifest,
              ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
            }],
      });
    });
  }

  async function beginContextCompaction(input: { sessionId: string; runId: string; operationRef: string }): Promise<void> {
    await withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId !== input.runId) throw new Error(`Run is not active: ${input.runId}`);
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      await saveUnlocked({
        ...session,
        revision: (session.revision ?? 0) + 1,
        ledger: [...(session.ledger ?? []), {
          seq,
          at: new Date().toISOString(),
          runId: input.runId,
          type: 'context_compaction_started',
          operationRef: input.operationRef,
        }],
      });
    });
  }

  async function failContextCompaction(input: {
    sessionId: string;
    runId: string;
    operationRef: string;
    reason: NonNullable<ContextPresentation['reason']>;
  }): Promise<void> {
    await withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId !== input.runId) throw new Error(`Run is not active: ${input.runId}`);
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      await saveUnlocked({
        ...session,
        revision: (session.revision ?? 0) + 1,
        ledger: [...(session.ledger ?? []), {
          seq,
          at: new Date().toISOString(),
          runId: input.runId,
          type: 'context_compaction_failed',
          operationRef: input.operationRef,
          reason: input.reason,
        }],
      });
    });
  }

  async function recordContextProviderUsage(input: {
    sessionId: string;
    runId: string;
    manifestId: string;
    actualInputTokens: number;
    usage: ContextUsageSnapshot;
  }): Promise<void> {
    await withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId !== input.runId) throw new Error(`Run is not active: ${input.runId}`);
      let found = false;
      const manifests = (session.contextManifests ?? []).map((manifest) => {
        if (manifest.version !== 2 || manifest.id !== input.manifestId) return manifest;
        found = true;
        return {
          ...manifest,
          actualInputTokens: input.actualInputTokens,
          tokenSource: 'provider' as const,
          breakdown: input.usage.breakdown ?? manifest.breakdown,
        } satisfies ContextManifestV2;
      });
      if (!found) throw new Error('Context manifest not found for provider usage');
      const seq = (session.ledger?.at(-1)?.seq ?? 0) + 1;
      await saveUnlocked({
        ...session,
        revision: (session.revision ?? 0) + 1,
        contextManifests: manifests,
        ledger: [...(session.ledger ?? []), {
          seq,
          at: new Date().toISOString(),
          runId: input.runId,
          type: 'context_usage_observed',
          manifestId: input.manifestId,
          usage: input.usage,
        }],
      });
    });
  }

  async function putContextArtifact(input: {
    sessionId: string;
    runId: string;
    kind: ContextArtifactRef['kind'];
    sourceRef: string;
    content: string;
  }): Promise<ContextArtifactRef> {
    return withSessionLock(input.sessionId, async () => {
      const session = await loadRaw(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      if (session.activeTaskId !== input.runId) throw new Error(`Run is not active: ${input.runId}`);
      const digest = createHash('sha256').update(input.content).digest('hex');
      const id = `artifact-${createHash('sha256').update(`${input.sessionId}:${input.kind}:${digest}`).digest('hex').slice(0, 24)}`;
      const existing = session.contextArtifacts?.find((artifact) => artifact.id === id);
      if (existing) return existing;
      const folder = input.kind === 'tool-result' ? 'tool-results' : 'transcripts';
      const storageKey = `${folder}/${safeArtifactPart(input.runId)}-${safeArtifactPart(input.sourceRef)}-${digest.slice(0, 20)}.txt`;
      const root = artifactRoot(input.sessionId);
      const target = resolve(root, storageKey);
      if (!contained(root, target)) throw new Error('Artifact path escapes the Session scope');
      await mkdir(dirname(target), { recursive: true });
      let alreadyWritten = false;
      try {
        alreadyWritten = await readFile(target, 'utf8').then((value) => value === input.content);
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
      if (!alreadyWritten) {
        const temporary = `${target}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, input.content, 'utf8');
        try {
          await rename(temporary, target);
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
      }
      const ref: ContextArtifactRef = {
        version: 1,
        id,
        sessionId: input.sessionId,
        kind: input.kind,
        digest: `sha256-${digest}`,
        chars: input.content.length,
        createdAt: new Date().toISOString(),
        storageKey,
      };
      await saveUnlocked({
        ...session,
        revision: (session.revision ?? 0) + 1,
        contextArtifacts: [...(session.contextArtifacts ?? []), ref],
      });
      return ref;
    });
  }

  async function readContextArtifact(input: { sessionId: string; ref: string; offset?: number; limit?: number }) {
    const session = await loadRaw(input.sessionId);
    if (!session) throw new Error(`Session not found: ${input.sessionId}`);
    const artifact = session.contextArtifacts?.find((candidate) => candidate.id === input.ref && candidate.sessionId === input.sessionId);
    if (!artifact?.storageKey) throw new Error('Artifact ref is invalid for this Session');
    const root = artifactRoot(input.sessionId);
    const target = resolve(root, artifact.storageKey);
    if (!contained(root, target)) throw new Error('Artifact path escapes the Session scope');
    const content = await readFile(target, 'utf8');
    const actualDigest = `sha256-${createHash('sha256').update(content).digest('hex')}`;
    if (actualDigest !== artifact.digest) throw new Error('Artifact integrity check failed');
    const offset = Math.max(0, Math.min(content.length, Math.floor(input.offset ?? 0)));
    const limit = Math.max(1, Math.min(32_000, Math.floor(input.limit ?? 8_000)));
    const end = Math.min(content.length, offset + limit);
    return {
      ref: artifact.id,
      content: content.slice(offset, end),
      offset,
      ...(end < content.length ? { nextOffset: end } : {}),
      totalChars: content.length,
    };
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
    await rm(join(sessionsDir, sessionId), { recursive: true, force: true });
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
    materializeRun,
    getCurrentSession,
    loadSession,
    saveSession,
    appendMessages,
    appendTaskSummary,
    beginRun,
    appendRunMessage,
    markToolStarted,
    commitToolOutcome,
    recordApprovalRequested,
    recordApprovalResolved,
    commitContext,
    beginContextCompaction,
    failContextCompaction,
    recordContextProviderUsage,
    putContextArtifact,
    readContextArtifact,
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
