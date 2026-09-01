import { execFile, spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { ensureRg, type EnsureRgOptions } from './managed-tools/ensure-rg.ts';
import { resolveWorkspacePath } from './directory-walker.ts';
import { GREP_LIMITS } from './tool-limits.ts';

export { GREP_LIMITS } from './tool-limits.ts';

export type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
};

export type GrepResult = {
  ok: true;
  action: 'searched';
  pattern: string;
  path: string;
  glob?: string;
  match_count: number;
  output: string;
  details: {
    matchLimitReached?: number;
    truncation: { truncated: boolean; maxBytes: number };
    linesTruncated: boolean;
  };
};

type RawMatch = { absolutePath: string; line: number; text: string };
const NOTICE_RESERVE_BYTES = 512;

function terminate(child: { pid?: number; kill(): boolean | void }): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else child.kill();
}

function displayPath(searchPath: string, absolutePath: string, searchIsFile: boolean): string {
  return (searchIsFile ? basename(absolutePath) : relative(searchPath, absolutePath)).replace(/\\/g, '/');
}

function trimLine(line: string): { line: string; truncated: boolean } {
  const normalized = line.replace(/[\r\n]+$/g, '');
  return normalized.length > GREP_LIMITS.maxLineChars
    ? { line: `${normalized.slice(0, GREP_LIMITS.maxLineChars - 1)}…`, truncated: true }
    : { line: normalized, truncated: false };
}

export async function grepWorkspace(
  root: string,
  input: GrepInput,
  options: EnsureRgOptions,
  signal?: AbortSignal,
): Promise<GrepResult> {
  if (signal?.aborted) throw new Error('Operation aborted');
  const searchPath = await resolveWorkspacePath(root, input.path ?? '.');
  const searchIsFile = (await stat(searchPath)).isFile();
  const executable = await ensureRg(options);
  const limit = Math.max(1, Math.min(GREP_LIMITS.maxMatches, Math.floor(input.limit ?? GREP_LIMITS.defaultMatches)));
  const context = Math.max(0, Math.min(GREP_LIMITS.maxContextLines, Math.floor(input.context ?? 0)));
  const args = ['--json', '--line-number', '--color=never', '--hidden'];
  if (input.ignoreCase) args.push('--ignore-case');
  if (input.literal) args.push('--fixed-strings');
  if (input.glob) args.push('--glob', input.glob);
  args.push('--', input.pattern, searchPath);

  const matches: RawMatch[] = [];
  let stderr = '';
  let limitReached = false;
  await new Promise<void>((resolveSearch, rejectSearch) => {
    let settled = false;
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    const cleanup = () => {
      lines.close();
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? rejectSearch(error) : resolveSearch();
    };
    const onAbort = () => {
      terminate(child);
      settle(new Error('Operation aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    lines.on('line', (line) => {
      let event: { type?: string; data?: Record<string, unknown> };
      try { event = JSON.parse(line); } catch { return; }
      if (event.type !== 'match' || !event.data) return;
      const path = event.data.path as { text?: unknown } | undefined;
      const content = event.data.lines as { text?: unknown } | undefined;
      const lineNumber = Number(event.data.line_number);
      if (typeof path?.text !== 'string' || typeof content?.text !== 'string' || !Number.isFinite(lineNumber)) return;
      if (matches.length >= limit) return;
      matches.push({ absolutePath: path.text, line: lineNumber, text: content.text });
      if (matches.length >= limit) {
        limitReached = true;
        terminate(child);
      }
    });
    child.on('error', (error) => settle(new Error(`Failed to start ripgrep: ${error.message}`)));
    child.on('close', (code) => {
      if (signal?.aborted) return settle(new Error('Operation aborted'));
      if (!limitReached && code !== 0 && code !== 1) return settle(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
      settle();
    });
  });

  const fileCache = new Map<string, string[]>();
  const rendered: string[] = [];
  let totalBytes = 0;
  let outputTruncated = false;
  let linesTruncated = false;
  const append = (value: string): boolean => {
    const trimmed = trimLine(value);
    linesTruncated ||= trimmed.truncated;
    const bytes = Buffer.byteLength(`${trimmed.line}\n`, 'utf8');
    if (totalBytes + bytes > GREP_LIMITS.maxBytes - NOTICE_RESERVE_BYTES) { outputTruncated = true; return false; }
    rendered.push(trimmed.line);
    totalBytes += bytes;
    return true;
  };

  for (const match of matches) {
    const shownPath = displayPath(searchPath, match.absolutePath, searchIsFile);
    if (context > 0) {
      let fileLines = fileCache.get(match.absolutePath);
      if (!fileLines) {
        try {
          fileLines = (await readFile(match.absolutePath, 'utf8')).replace(/\r\n?/g, '\n').split('\n');
        } catch {
          fileLines = [];
        }
        fileCache.set(match.absolutePath, fileLines);
      }
      const first = Math.max(1, match.line - context);
      for (let lineNumber = first; lineNumber < match.line; lineNumber += 1) {
        if (!append(`${shownPath}-${lineNumber}- ${fileLines[lineNumber - 1] ?? '(unable to read file)'}`)) break;
      }
    }
    if (outputTruncated || !append(`${shownPath}:${match.line}: ${match.text.replace(/[\r\n]+$/g, '')}`)) break;
    if (context > 0) {
      const fileLines = fileCache.get(match.absolutePath) ?? [];
      for (let lineNumber = match.line + 1; lineNumber <= match.line + context; lineNumber += 1) {
        if (lineNumber > fileLines.length) break;
        if (!append(`${shownPath}-${lineNumber}- ${fileLines[lineNumber - 1]}`)) break;
      }
    }
    if (outputTruncated) break;
  }

  if (rendered.length === 0) rendered.push('No matches found');
  const notices: string[] = [];
  if (limitReached) notices.push(`match limit ${limit} reached; narrow path, glob, or pattern`);
  if (outputTruncated) notices.push(`output truncated at ${GREP_LIMITS.maxBytes} bytes`);
  if (linesTruncated) notices.push(`lines longer than ${GREP_LIMITS.maxLineChars} characters were truncated`);
  if (notices.length > 0) rendered.push('', `[${notices.join('. ')}]`);

  return {
    ok: true,
    action: 'searched',
    pattern: input.pattern,
    path: input.path ?? '.',
    ...(input.glob ? { glob: input.glob } : {}),
    match_count: matches.length,
    output: rendered.join('\n'),
    details: {
      ...(limitReached ? { matchLimitReached: limit } : {}),
      truncation: { truncated: outputTruncated, maxBytes: GREP_LIMITS.maxBytes },
      linesTruncated,
    },
  };
}
