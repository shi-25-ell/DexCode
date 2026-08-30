import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { executeCommand } from './run-command.ts';
import { isTrustedReadonlyCommand } from './command-safety.ts';

export type LintIssue = {
  file: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
};

export type ReadLintsResult = {
  path?: string;
  issues: LintIssue[];
  checksRun: string[];
  hints: string[];
  error?: string;
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageScripts(workspaceRoot: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(workspaceRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

function parseTscOutput(stderr: string, stdout: string, basePath?: string): LintIssue[] {
  const text = `${stdout}\n${stderr}`;
  const issues: LintIssue[] = [];
  const re = /(.+)\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const file = match[1].replace(/\\/g, '/');
    issues.push({
      file: basePath && !file.includes('/') ? join(basePath, file).replace(/\\/g, '/') : file,
      line: Number(match[2]),
      column: Number(match[3]),
      severity: 'error',
      message: match[4].trim(),
      source: 'typescript',
    });
  }
  return issues;
}

async function runTrustedCheck(
  command: string,
  cwd: string,
): Promise<{ issues: LintIssue[]; check: string } | null> {
  if (!isTrustedReadonlyCommand(command)) return null;
  const result = await executeCommand(command, cwd, 120_000);
  if (command.includes('tsc')) {
    return {
      check: command,
      issues: parseTscOutput(result.stderr ?? '', result.stdout ?? ''),
    };
  }
  return {
    check: command,
    issues: result.status === 'failed' && result.stderr
      ? [{
          file: '.',
          line: 1,
          severity: 'error',
          message: result.stderr.slice(0, 500),
          source: 'lint',
        }]
      : [],
  };
}

export async function readLints(options: {
  workspaceRoot: string;
  path?: string;
}): Promise<ReadLintsResult> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const relPath = options.path?.replace(/\\/g, '/').replace(/^\/+/, '');
  const targetPath = relPath ? resolve(join(workspaceRoot, relPath)) : workspaceRoot;

  if (!targetPath.startsWith(workspaceRoot)) {
    return { issues: [], checksRun: [], hints: [], error: '路径越界' };
  }

  const issues: LintIssue[] = [];
  const checksRun: string[] = [];
  const hints: string[] = [];

  const scripts = await readPackageScripts(workspaceRoot);
  if (scripts.lint && !relPath) {
    hints.push('项目定义了 npm run lint，可通过 run_command 执行（需确认）');
  }

  const tsconfig = await fileExists(join(workspaceRoot, 'tsconfig.json'));
  if (tsconfig) {
    const cmd = relPath
      ? `npx tsc --noEmit ${relPath}`
      : 'npx tsc --noEmit';
    const run = await runTrustedCheck(cmd, workspaceRoot);
    if (run) {
      checksRun.push(run.check);
      issues.push(...run.issues);
    }
  } else if (relPath?.match(/\.tsx?$/i)) {
    hints.push('未找到 tsconfig.json，无法进行 TypeScript 检查');
  }

  if (relPath && await fileExists(targetPath)) {
    try {
      const content = await readFile(targetPath, 'utf8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (/\bconsole\.log\(/.test(line) && !line.trim().startsWith('//')) {
          issues.push({
            file: relPath,
            line: idx + 1,
            severity: 'warning',
            message: '包含 console.log，提交前建议移除',
            source: 'heuristic',
          });
        }
        if (/TODO|FIXME/i.test(line)) {
          issues.push({
            file: relPath,
            line: idx + 1,
            severity: 'info',
            message: '包含待办标记',
            source: 'heuristic',
          });
        }
      });
      if (issues.length === 0) {
        checksRun.push('heuristic-scan');
      }
    } catch {
      return { path: relPath, issues: [], checksRun, hints, error: '无法读取文件' };
    }
  }

  return {
    path: relPath,
    issues,
    checksRun,
    hints,
  };
}
