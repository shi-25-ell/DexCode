import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type WorkspaceRecord = {
  workspaceId: string;
  rootPath: string;
  canonicalRootPath: string;
  createdAt: string;
  updatedAt: string;
};

type RegistryDocument = {
  version: 1;
  workspaces: WorkspaceRecord[];
};

function comparablePath(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function createWorkspaceRegistry(options: { registryFile: string }) {
  const registryFile = resolve(options.registryFile);
  let pending: Promise<void> = Promise.resolve();

  async function withLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = pending;
    let release = () => {};
    pending = new Promise<void>((resolveLock) => { release = resolveLock; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async function readDocument(): Promise<RegistryDocument> {
    try {
      const parsed = JSON.parse(await readFile(registryFile, 'utf8')) as Partial<RegistryDocument>;
      if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) {
        throw new Error('Workspace registry has an unsupported schema');
      }
      return { version: 1, workspaces: parsed.workspaces };
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return { version: 1, workspaces: [] };
      if (error instanceof SyntaxError) throw new Error('Workspace registry is corrupt', { cause: error });
      throw error;
    }
  }

  async function writeDocument(document: RegistryDocument): Promise<void> {
    await mkdir(dirname(registryFile), { recursive: true });
    const temporary = `${registryFile}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    try {
      await rename(temporary, registryFile);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async function canonicalize(rootPath: string): Promise<string> {
    const resolved = resolve(rootPath);
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error(`Workspace root is not a directory: ${resolved}`);
    return resolve(await realpath(resolved));
  }

  async function register(rootPath: string): Promise<WorkspaceRecord> {
    const canonicalRootPath = await canonicalize(rootPath);
    return withLock(async () => {
      const document = await readDocument();
      const existing = document.workspaces.find(
        (workspace) => comparablePath(workspace.canonicalRootPath) === comparablePath(canonicalRootPath),
      );
      const now = new Date().toISOString();
      if (existing) {
        const touched = { ...existing, updatedAt: now };
        await writeDocument({
          version: 1,
          workspaces: document.workspaces.map((workspace) => workspace.workspaceId === existing.workspaceId ? touched : workspace),
        });
        return touched;
      }
      const workspace: WorkspaceRecord = {
        workspaceId: `workspace-${crypto.randomUUID()}`,
        rootPath: canonicalRootPath,
        canonicalRootPath,
        createdAt: now,
        updatedAt: now,
      };
      await writeDocument({ version: 1, workspaces: [...document.workspaces, workspace] });
      return workspace;
    });
  }

  async function get(workspaceId: string): Promise<WorkspaceRecord | null> {
    const document = await readDocument();
    return document.workspaces.find((workspace) => workspace.workspaceId === workspaceId) ?? null;
  }

  async function resolveAvailable(workspaceId: string): Promise<WorkspaceRecord> {
    const workspace = await get(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const canonicalRootPath = await canonicalize(workspace.rootPath);
    if (comparablePath(canonicalRootPath) !== comparablePath(workspace.canonicalRootPath)) {
      throw new Error(`Workspace identity changed at path: ${workspace.rootPath}`);
    }
    return workspace;
  }

  async function list(): Promise<WorkspaceRecord[]> {
    return (await readDocument()).workspaces;
  }

  return { registryFile, register, get, resolveAvailable, list };
}
