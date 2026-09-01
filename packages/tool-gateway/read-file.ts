import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { toolFailure, type ToolResult } from '../shared/tool-result.ts';
import { resolveWorkspacePath } from './directory-walker.ts';
import { READ_FILE_LIMITS } from './tool-limits.ts';

export { READ_FILE_LIMITS } from './tool-limits.ts';

export type ReadFileInput = {
  path: string;
  offset?: number;
  limit?: number;
};

export type ReadFileSuccess = {
  path: string;
  content: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  output_lines: number;
  output_bytes: number;
  truncated: boolean;
  truncation_reason?: 'requested_limit' | 'line_limit' | 'byte_limit';
  next_offset?: number;
};

export type ReadFileResult = ReadFileSuccess | ToolResult<never>;

function logicalLines(content: string): string[] {
  if (!content) return [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (content.endsWith('\n') || content.endsWith('\r')) lines.pop();
  return lines;
}

function pathFailure(path: string, error: unknown): ToolResult<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (/escapes the root|outside the root/i.test(message)) {
    return toolFailure('blocked', 'PATH_OUTSIDE_WORKSPACE', message, { path });
  }
  if (/not found/i.test(message) || (error as { code?: string }).code === 'ENOENT') {
    return toolFailure('failed', 'NOT_FOUND', `File not found: ${path}`, { path });
  }
  return toolFailure('failed', 'EXECUTION_FAILED', message, { path });
}

export async function readWorkspaceFile(root: string, input: ReadFileInput, signal?: AbortSignal): Promise<ReadFileResult> {
  const cancelled = () => signal?.aborted
    ? toolFailure('cancelled', 'CANCELLED', 'read_file was cancelled', { path: input.path })
    : undefined;
  const initialCancellation = cancelled();
  if (initialCancellation) return initialCancellation;
  if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 1)) {
    return toolFailure('invalid_arguments', 'INVALID_ARGUMENTS', 'offset must be an integer greater than or equal to 1', { path: input.path, offset: input.offset });
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > READ_FILE_LIMITS.maxLines)) {
    return toolFailure('invalid_arguments', 'INVALID_ARGUMENTS', `limit must be an integer between 1 and ${READ_FILE_LIMITS.maxLines}`, { path: input.path, limit: input.limit });
  }
  let absolutePath: string;
  try {
    absolutePath = await resolveWorkspacePath(root, input.path);
    const pathCancellation = cancelled();
    if (pathCancellation) return pathCancellation;
    if (!(await stat(absolutePath)).isFile()) {
      return toolFailure('failed', 'NOT_FOUND', `Not a file: ${input.path}`, { path: input.path });
    }
  } catch (error) {
    return pathFailure(input.path, error);
  }

  let content: string;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch (error) {
    return pathFailure(input.path, error);
  }
  const readCancellation = cancelled();
  if (readCancellation) return readCancellation;
  if (content.includes('\0')) {
    return toolFailure('failed', 'EXECUTION_FAILED', `Binary files are not supported by read_file: ${input.path}`, { path: input.path });
  }

  const lines = logicalLines(content);
  const offset = Math.floor(input.offset ?? 1);
  const requestedLimit = Math.floor(input.limit ?? READ_FILE_LIMITS.defaultLines);
  if (offset > Math.max(1, lines.length)) {
    return toolFailure(
      'invalid_arguments',
      'INVALID_ARGUMENTS',
      `offset ${offset} is beyond the end of the file (${lines.length} lines)`,
      { path: input.path, offset, total_lines: lines.length },
    );
  }
  if (lines.length === 0) {
    return {
      path: relative(root, absolutePath).replace(/\\/g, '/'),
      content: '',
      start_line: 1,
      end_line: 0,
      total_lines: 0,
      output_lines: 0,
      output_bytes: 0,
      truncated: false,
    };
  }

  const startIndex = offset - 1;
  const selected: string[] = [];
  let outputBytes = 0;
  let byteLimited = false;
  for (let index = startIndex; index < lines.length && selected.length < requestedLimit; index += 1) {
    const line = lines[index];
    const nextBytes = Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0);
    if (outputBytes + nextBytes > READ_FILE_LIMITS.maxBytes) {
      byteLimited = true;
      break;
    }
    selected.push(line);
    outputBytes += nextBytes;
  }
  if (selected.length === 0 && byteLimited) {
    return toolFailure(
      'failed',
      'EXECUTION_FAILED',
      `Line ${offset} exceeds the ${READ_FILE_LIMITS.maxBytes}-byte read_file output limit`,
      { path: input.path, offset, max_bytes: READ_FILE_LIMITS.maxBytes },
    );
  }

  const endIndex = startIndex + selected.length;
  const truncated = endIndex < lines.length;
  const truncationReason = truncated
    ? byteLimited
      ? 'byte_limit' as const
      : input.limit === undefined
        ? 'line_limit' as const
        : 'requested_limit' as const
    : undefined;
  return {
    path: relative(root, absolutePath).replace(/\\/g, '/'),
    content: selected.join('\n'),
    start_line: offset,
    end_line: endIndex,
    total_lines: lines.length,
    output_lines: selected.length,
    output_bytes: outputBytes,
    truncated,
    ...(truncationReason ? { truncation_reason: truncationReason } : {}),
    ...(truncated ? { next_offset: endIndex + 1 } : {}),
  };
}
