import type { FileDiff } from '../shared/types.ts';

function extractContent(result: unknown): string | null {
  if (result === null || result === undefined) return null;
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);
  const value = (result as { content?: unknown }).content;
  return typeof value === 'string' ? value : null;
}

export async function readContent(
  readFile: (path: string) => Promise<unknown> | unknown,
  path: string,
): Promise<string | null> {
  try {
    return extractContent(await readFile(path));
  } catch {
    return null;
  }
}

export async function captureFileDiff(
  readFile: (path: string) => Promise<unknown> | unknown,
  path: string,
  action: () => Promise<unknown> | unknown,
): Promise<{ result: unknown; diff: FileDiff }> {
  const before = await readContent(readFile, path);
  const result = await action();
  const after = await readContent(readFile, path);
  return { result, diff: { path, before, after } };
}
