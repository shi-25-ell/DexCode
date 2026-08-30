import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ExternalMcpServerConfig } from './index.ts';

type ConfigDocument = {
  version: 1;
  servers: ExternalMcpServerConfig[];
};

export function createExternalMcpConfigStore(options: { file: string }) {
  const file = resolve(options.file);
  let pending: Promise<void> = Promise.resolve();

  async function read(fallback: ExternalMcpServerConfig[] = []): Promise<ExternalMcpServerConfig[]> {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<ConfigDocument>;
      if (parsed.version !== 1 || !Array.isArray(parsed.servers)) throw new Error('External MCP config has an unsupported schema');
      return parsed.servers;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return fallback;
      if (error instanceof SyntaxError) throw new Error('External MCP config is corrupt', { cause: error });
      throw error;
    }
  }

  async function write(servers: ExternalMcpServerConfig[]): Promise<void> {
    const previous = pending;
    let release = () => {};
    pending = new Promise<void>((resolveLock) => { release = resolveLock; });
    await previous;
    try {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, servers }, null, 2)}\n`, 'utf8');
      try {
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    } finally {
      release();
    }
  }

  return { read, write };
}
