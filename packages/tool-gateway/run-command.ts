import { execFile, spawn } from 'node:child_process';
import type { CommandValidation } from './command-safety.ts';

export type RunCommandResult = {
  command: string;
  status: 'success' | 'failed' | 'denied' | 'blocked' | 'cancelled' | 'background';
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  risk?: string;
  confirmed?: boolean;
  whitelisted?: boolean;
  taskId?: string;
  running?: boolean;
  startedAt?: string;
  completedAt?: string;
  truncated?: boolean;
};

export type CommandRunOptions = {
  foregroundTimeoutMs: number;
  runInBackground?: boolean;
  maxRuntimeMs?: number;
  signal?: AbortSignal;
};

export type CommandRunner = {
  run(command: string, cwd: string, options: CommandRunOptions): Promise<RunCommandResult>;
  read(taskId: string, waitMs?: number): Promise<RunCommandResult>;
  stop(taskId: string): Promise<RunCommandResult>;
};

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;

function splitCommand(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) return [];

  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function terminateProcessTree(child: { kill: () => void; pid?: number }): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    child.kill();
  }
}

type BackgroundTask = {
  taskId: string;
  command: string;
  child: ReturnType<typeof spawn>;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  code?: number;
  stdout: string;
  stderr: string;
  outputBytes: number;
  truncated: boolean;
  error?: string;
  startedAt: string;
  completedAt?: string;
  completion: Promise<void>;
  finish: (status: Exclude<BackgroundTask['status'], 'running'>, details?: { code?: number; error?: string }) => void;
};

export function createCommandRunner(): CommandRunner {
  const tasks = new Map<string, BackgroundTask>();

  const snapshot = (task: BackgroundTask): RunCommandResult => ({
    taskId: task.taskId,
    command: task.command,
    status: task.status === 'running' ? 'background' : task.status,
    running: task.status === 'running',
    ...(task.code !== undefined ? { code: task.code } : {}),
    ...(task.stdout ? { stdout: task.stdout.trim() } : {}),
    ...(task.stderr ? { stderr: task.stderr.trim() } : {}),
    ...(task.error ? { error: task.error } : {}),
    startedAt: task.startedAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.truncated ? { truncated: true } : {}),
  });

  const missing = (taskId: string): RunCommandResult => ({
    taskId,
    command: '',
    status: 'failed',
    error: `后台命令不存在或已过期：${taskId}`,
  });

  function prune(): void {
    if (tasks.size <= 100) return;
    const completed = [...tasks.values()]
      .filter((task) => task.status !== 'running')
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    for (const task of completed.slice(0, tasks.size - 100)) tasks.delete(task.taskId);
  }

  function start(command: string, cwd: string, maxRuntimeMs: number): BackgroundTask | RunCommandResult {
    const parts = splitCommand(command);
    if (parts.length === 0) return { command, status: 'blocked', error: '无法解析命令' };
    const [cmd, ...args] = parts;
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
    const task: BackgroundTask = {
      taskId: `command-${crypto.randomUUID()}`,
      command,
      child,
      status: 'running',
      stdout: '',
      stderr: '',
      outputBytes: 0,
      truncated: false,
      startedAt: new Date().toISOString(),
      completion,
      finish(status, details = {}) {
        if (task.status !== 'running') return;
        task.status = status;
        task.code = details.code;
        task.error = details.error;
        task.completedAt = new Date().toISOString();
        if (runtimeTimer) clearTimeout(runtimeTimer);
        resolveCompletion();
      },
    };
    const append = (field: 'stdout' | 'stderr', chunk: { toString(encoding?: string): string }) => {
      const bytes = new TextEncoder().encode(chunk.toString('utf8'));
      const remaining = MAX_OUTPUT_BYTES - task.outputBytes;
      if (remaining <= 0) { task.truncated = true; return; }
      const kept = bytes.slice(0, remaining);
      task[field] += new TextDecoder().decode(kept);
      task.outputBytes += kept.byteLength;
      if (kept.byteLength < bytes.byteLength) task.truncated = true;
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.on('error', (error) => task.finish('failed', { code: 1, error: error.message }));
    child.on('exit', (code) => task.finish(code === 0 ? 'success' : 'failed', { code: code ?? 1 }));
    runtimeTimer = setTimeout(() => {
      terminateProcessTree(child);
      task.finish('failed', { code: 124, error: `后台命令超过最大运行时间（${maxRuntimeMs}ms）` });
    }, maxRuntimeMs);
    tasks.set(task.taskId, task);
    prune();
    return task;
  }

  return {
    async run(command, cwd, options) {
      if (options.signal?.aborted) return { command, status: 'cancelled', error: '命令执行已取消' };
      const started = start(command, cwd, options.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);
      if (!('completion' in started)) return started;
      if (options.runInBackground) return snapshot(started);

      let foregroundTimer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const outcome = await Promise.race([
        started.completion.then(() => 'completed' as const),
        new Promise<'timeout'>((resolve) => {
          foregroundTimer = setTimeout(() => resolve('timeout'), options.foregroundTimeoutMs);
        }),
        new Promise<'aborted'>((resolve) => {
          onAbort = () => resolve('aborted');
          options.signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      if (foregroundTimer) clearTimeout(foregroundTimer);
      if (onAbort) options.signal?.removeEventListener('abort', onAbort);
      if (outcome === 'aborted') {
        terminateProcessTree(started.child);
        started.finish('cancelled', { error: '命令执行已取消' });
      }
      return snapshot(started);
    },

    async read(taskId, waitMs = 0) {
      const task = tasks.get(taskId);
      if (!task) return missing(taskId);
      if (task.status === 'running' && waitMs > 0) {
        await Promise.race([
          task.completion,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.min(60_000, waitMs));
          }),
        ]);
      }
      return snapshot(task);
    },

    async stop(taskId) {
      const task = tasks.get(taskId);
      if (!task) return missing(taskId);
      if (task.status === 'running') {
        terminateProcessTree(task.child);
        task.finish('cancelled', { error: '后台命令已停止' });
      }
      return snapshot(task);
    },
  };
}

type ExecFileOpts = {
  cwd: string;
  maxBuffer: number;
  windowsHide: boolean;
};

export function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunCommandResult> {
  const parts = splitCommand(command);
  if (parts.length === 0) {
    return Promise.resolve({
      command,
      status: 'blocked',
      error: '无法解析命令',
    });
  }

  const [cmd, ...args] = parts;
  if (signal?.aborted) {
    return Promise.resolve({ command, status: 'cancelled', error: '命令执行已取消' });
  }
  const options: ExecFileOpts = {
    cwd,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  };

  return new Promise((resolve) => {
    let settled = false;
    let child: { kill: () => void; pid?: number } | undefined;
    const terminateTree = () => { if (child) terminateProcessTree(child); };
    const onAbort = () => {
      terminateTree();
      finish({ command, status: 'cancelled', error: '命令执行已取消' });
    };
    const finish = (result: RunCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    child = execFile(
      cmd,
      args,
      options as Parameters<typeof execFile>[2],
      (error, stdout, stderr) => {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? Number((error as { code?: number }).code ?? 1)
            : 0;
        finish({
          command,
          status: error ? 'failed' : 'success',
          code,
          stdout: String(stdout ?? '').trim(),
          stderr: String(stderr ?? '').trim(),
          ...(error && !stdout && !stderr
            ? { error: error instanceof Error ? error.message : String(error) }
            : {}),
        });
      },
    ) as unknown as { kill: () => void; pid?: number };

    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      terminateTree();
      finish({
        command,
        status: 'failed',
        code: 124,
        error: `命令执行超时（${timeoutMs}ms）`,
      });
    }, timeoutMs);
  });
}

export type CommandConfirmDecision = 'allow_once' | 'allow_whitelist' | 'deny';

export type CommandConfirmRequest = {
  command: string;
  cwd: string;
  validation: CommandValidation;
};

export type CommandConfirmHook = (request: CommandConfirmRequest) => Promise<CommandConfirmDecision>;
