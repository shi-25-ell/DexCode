import { execFile } from 'node:child_process';
import type { CommandValidation } from './command-safety.ts';

export type RunCommandResult = {
  command: string;
  status: 'success' | 'failed' | 'denied' | 'blocked';
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  risk?: string;
  confirmed?: boolean;
  whitelisted?: boolean;
};

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

type ExecFileOpts = {
  cwd: string;
  maxBuffer: number;
  windowsHide: boolean;
};

export function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
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
  const options: ExecFileOpts = {
    cwd,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RunCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = execFile(
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
    ) as unknown as { kill: () => void };

    const timer = setTimeout(() => {
      child.kill();
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
