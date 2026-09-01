import { execFile, spawn } from 'node:child_process';
import type { CommandValidation } from './command-safety.ts';
import { resolveShellCapabilities, type ResolvedShellRuntime, type ShellResolverOptions } from './shell/shell-resolver.ts';

export type RunCommandResult = {
  command: string;
  shell?: string;
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
  readonly shell: ResolvedShellRuntime;
  run(command: string, cwd: string, options: CommandRunOptions): Promise<RunCommandResult>;
  read(taskId: string, waitMs?: number): Promise<RunCommandResult>;
  stop(taskId: string): Promise<RunCommandResult>;
};

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;

export function terminateProcessTree(child: { kill: () => boolean | void; pid?: number }): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else child.kill();
}

type BackgroundTask = {
  taskId: string;
  command: string;
  shell: ResolvedShellRuntime;
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

function shellScript(shell: ResolvedShellRuntime, command: string): string {
  if (shell.kind === 'powershell') {
    return `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()\n${command}`;
  }
  return command;
}

export function createCommandRunner(options: { shell?: ResolvedShellRuntime; resolver?: ShellResolverOptions } = {}): CommandRunner {
  const shell = options.shell ?? resolveShellCapabilities(options.resolver).selected;
  const tasks = new Map<string, BackgroundTask>();

  const snapshot = (task: BackgroundTask): RunCommandResult => ({
    taskId: task.taskId,
    command: task.command,
    shell: task.shell.kind,
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
    shell: shell.kind,
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
    if (!command.trim()) return { command, shell: shell.kind, status: 'blocked', error: '命令不能为空' };
    const child = spawn(shell.executable, shell.args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    child.stdin.on('error', () => {});
    child.stdin.write(shellScript(shell, command));
    child.stdin.end();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
    const task: BackgroundTask = {
      taskId: `command-${crypto.randomUUID()}`,
      command,
      shell,
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
      const bytes = Buffer.from(chunk.toString('utf8'), 'utf8');
      const remaining = MAX_OUTPUT_BYTES - task.outputBytes;
      if (remaining <= 0) { task.truncated = true; return; }
      const kept = bytes.subarray(0, remaining);
      task[field] += kept.toString('utf8');
      task.outputBytes += kept.byteLength;
      if (kept.byteLength < bytes.byteLength) task.truncated = true;
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.on('error', (error) => task.finish('failed', { code: 1, error: `Unable to start ${shell.kind}: ${error.message}` }));
    child.on('exit', (code, signal) => task.finish(code === 0 ? 'success' : 'failed', {
      code: code ?? 1,
      ...(signal ? { error: `Command terminated by ${signal}` } : {}),
    }));
    runtimeTimer = setTimeout(() => {
      terminateProcessTree(child);
      task.finish('failed', { code: 124, error: `后台命令超过最大运行时间（${maxRuntimeMs}ms）` });
    }, maxRuntimeMs);
    tasks.set(task.taskId, task);
    prune();
    return task;
  }

  return {
    shell,
    async run(command, cwd, runOptions) {
      if (runOptions.signal?.aborted) return { command, shell: shell.kind, status: 'cancelled', error: '命令执行已取消' };
      const started = start(command, cwd, runOptions.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);
      if (!('completion' in started)) return started;
      if (runOptions.runInBackground) return snapshot(started);

      let foregroundTimer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const outcome = await Promise.race([
        started.completion.then(() => 'completed' as const),
        new Promise<'timeout'>((resolve) => {
          foregroundTimer = setTimeout(() => resolve('timeout'), runOptions.foregroundTimeoutMs);
        }),
        new Promise<'aborted'>((resolve) => {
          onAbort = () => resolve('aborted');
          runOptions.signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      if (foregroundTimer) clearTimeout(foregroundTimer);
      if (onAbort) runOptions.signal?.removeEventListener('abort', onAbort);
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
          new Promise<void>((resolve) => setTimeout(resolve, Math.min(60_000, waitMs))),
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

export type CommandConfirmDecision = 'allow_once' | 'allow_whitelist' | 'deny';
export type CommandConfirmRequest = { command: string; cwd: string; validation: CommandValidation };
export type CommandConfirmHook = (request: CommandConfirmRequest) => Promise<CommandConfirmDecision>;
