import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeCommit, decodeHeader, encodeCommit, encodeHeader, SessionJournalDecodeError } from './journal-codec.ts';
import { applyCommit, projectionFromHeader, SessionJournalInvariantError } from './journal-reducer.ts';
import type { Session } from '../shared/types.ts';
import type { SessionJournalCommit, SessionJournalHeader } from './journal-types.ts';

type DirectoryEntry = { name: string; isDirectory(): boolean; isFile(): boolean };

export class SessionJournalFileError extends Error {
  readonly path: string;
  readonly line: number;

  constructor(path: string, line: number, message: string, options?: ErrorOptions) {
    super(`Session journal ${path}:${line}: ${message}`, options);
    this.name = 'SessionJournalFileError';
    this.path = path;
    this.line = line;
  }
}

function sessionId(sessionId: string): string {
  if (!/^session-[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error('Invalid session id');
  return sessionId;
}

export function createJsonlFilesystem(sessionsDir: string) {
  function shard(id: string): string {
    return sessionId(id).slice('session-'.length, 'session-'.length + 2).toLowerCase().padEnd(2, '_');
  }

  function journalPath(id: string): string {
    return join(sessionsDir, shard(id), `${sessionId(id)}.jsonl`);
  }

  function metaPath(id: string): string {
    return join(sessionsDir, shard(id), `${sessionId(id)}.meta.json`);
  }

  function artifactRoot(id: string): string {
    return join(sessionsDir, shard(id), sessionId(id), 'artifacts');
  }

  async function ensureSessionDir(id: string): Promise<void> {
    await mkdir(join(sessionsDir, shard(id)), { recursive: true });
  }

  async function publish(path: string, content: string): Promise<void> {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temporary, path);
          break;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY')) throw error;
          await new Promise((resolveWait) => setTimeout(resolveWait, 5 * (attempt + 1)));
        }
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async function create(header: SessionJournalHeader): Promise<number> {
    await ensureSessionDir(header.sessionId);
    const encoded = encodeHeader(header);
    await writeFile(journalPath(header.sessionId), encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return new TextEncoder().encode(encoded).byteLength;
  }

  async function append(commit: SessionJournalCommit): Promise<number> {
    const encoded = encodeCommit(commit);
    await appendFile(journalPath(commit.sessionId), encoded, { encoding: 'utf8', mode: 0o600 });
    return new TextEncoder().encode(encoded).byteLength;
  }

  async function load(id: string): Promise<{ session: Session; journalBytes: number } | null> {
    const path = journalPath(id);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
    const terminated = content.endsWith('\n');
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (!lines[0]) throw new SessionJournalFileError(path, 1, 'header is missing');
    let header: SessionJournalHeader;
    try {
      header = decodeHeader(lines[0]);
    } catch (error) {
      throw new SessionJournalFileError(path, 1, error instanceof Error ? error.message : String(error), { cause: error });
    }
    if (header.sessionId !== id) throw new SessionJournalFileError(path, 1, 'header Session id does not match file name');
    let projection = projectionFromHeader(header);
    const seen = new Set<string>();
    for (let index = 1; index < lines.length; index += 1) {
      try {
        projection = applyCommit(projection, decodeCommit(lines[index]!), seen);
      } catch (error) {
        const tornTail = index === lines.length - 1
          && !terminated
          && error instanceof SessionJournalDecodeError
          && error.kind === 'syntax';
        if (tornTail) {
          const prefix = `${lines.slice(0, index).join('\n')}\n`;
          await publish(path, prefix);
          return { session: projection, journalBytes: new TextEncoder().encode(prefix).byteLength };
        }
        if (error instanceof SessionJournalDecodeError || error instanceof SessionJournalInvariantError) {
          throw new SessionJournalFileError(path, index + 1, error.message, { cause: error });
        }
        throw error;
      }
    }
    if (!terminated) {
      await appendFile(path, '\n', { encoding: 'utf8', mode: 0o600 });
      content += '\n';
    }
    return { session: projection, journalBytes: new TextEncoder().encode(content).byteLength };
  }

  async function journalSize(id: string): Promise<number | null> {
    try {
      return (await stat(journalPath(id))).size;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }

  async function listMetaPaths(): Promise<string[]> {
    let shards: DirectoryEntry[];
    try {
      shards = await readdir(sessionsDir, { withFileTypes: true }) as DirectoryEntry[];
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
    const paths = await Promise.all(shards.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const dir = join(sessionsDir, entry.name);
      const files = await readdir(dir, { withFileTypes: true }) as DirectoryEntry[];
      return files.filter((file) => file.isFile() && file.name.endsWith('.meta.json')).map((file) => join(dir, file.name));
    }));
    return paths.flat();
  }

  async function listJournalIds(): Promise<string[]> {
    let shards: DirectoryEntry[];
    try {
      shards = await readdir(sessionsDir, { withFileTypes: true }) as DirectoryEntry[];
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
    const ids = await Promise.all(shards.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const files = await readdir(join(sessionsDir, entry.name), { withFileTypes: true }) as DirectoryEntry[];
      return files.filter((file) => file.isFile() && /^session-[a-zA-Z0-9-]+\.jsonl$/.test(file.name)).map((file) => file.name.slice(0, -'.jsonl'.length));
    }));
    return ids.flat();
  }

  async function removeSession(id: string): Promise<void> {
    await rm(journalPath(id), { force: true });
    await rm(metaPath(id), { force: true });
    await rm(join(sessionsDir, shard(id), sessionId(id)), { recursive: true, force: true });
  }

  return {
    sessionsDir,
    journalPath,
    metaPath,
    artifactRoot,
    ensureSessionDir,
    publish,
    create,
    append,
    load,
    journalSize,
    listMetaPaths,
    listJournalIds,
    removeSession,
    readJournal: (id: string) => readFile(journalPath(id), 'utf8'),
  };
}
