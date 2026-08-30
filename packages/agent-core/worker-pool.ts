export type ReadOnlyTool = 'read_file' | 'search_in_workspace' | 'list_workspace';

export type WorkerTask = {
  tool: ReadOnlyTool;
  params: Record<string, unknown>;
};

export type WorkerResult = {
  tool: string;
  params: Record<string, unknown>;
  output: string;
  durationMs: number;
  error?: string;
};

type ReadOnlyGateway = {
  readFile: (path: string) => Promise<unknown> | unknown;
  searchInWorkspace: (query: string, path?: string) => Promise<unknown> | unknown;
  listWorkspace: () => Promise<unknown> | unknown;
};

const ALLOWED_TOOLS = new Set(['read_file', 'search_in_workspace', 'list_workspace']);

function stringifyOutput(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function runOne(
  gateway: ReadOnlyGateway,
  task: WorkerTask,
  timeoutMs: number,
): Promise<WorkerResult> {
  const start = Date.now();
  if (!ALLOWED_TOOLS.has(task.tool)) {
    return { tool: task.tool, params: task.params, output: '', durationMs: 0, error: 'tool not allowed' };
  }

  try {
    const work = Promise.resolve().then(() => {
      if (task.tool === 'read_file') return gateway.readFile(String(task.params.path ?? ''));
      if (task.tool === 'search_in_workspace') {
        return gateway.searchInWorkspace(String(task.params.query ?? ''), task.params.path as string | undefined);
      }
      return gateway.listWorkspace();
    });
    const output = await withTimeout(work, timeoutMs);
    return { tool: task.tool, params: task.params, output: stringifyOutput(output), durationMs: Date.now() - start };
  } catch (error) {
    return {
      tool: task.tool,
      params: task.params,
      output: '',
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runWorkerPool(
  gateway: ReadOnlyGateway,
  tasks: WorkerTask[],
  concurrency = 3,
  timeoutMs = 10_000,
): Promise<WorkerResult[]> {
  const results: WorkerResult[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await runOne(gateway, tasks[index], timeoutMs);
    }
  }

  const count = Math.min(Math.max(1, concurrency), tasks.length);
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}
