import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WhitelistEntry, WhitelistMatchType } from './command-safety.ts';
import { normalizeCommand, suggestWhitelistPattern } from './command-safety.ts';

type WhitelistFile = {
  version: 1;
  entries: WhitelistEntry[];
  updatedAt: string;
};

const LEGACY_WIDE_BUILTIN_IDS = new Set(['default-npm-test', 'default-npm-run']);
const MATCH_TYPES = new Set<WhitelistMatchType>(['exact', 'prefix', 'command']);
const DEFAULT_ENTRIES: WhitelistEntry[] = [
  {
    id: 'builtin-git-status',
    pattern: 'git status',
    matchType: 'prefix',
    label: 'git status（内置）',
    addedAt: '1970-01-01T00:00:00.000Z',
    source: 'builtin',
  },
];

function newId(): string {
  return `wl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function validEntry(value: unknown): value is WhitelistEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<WhitelistEntry>;
  return typeof entry.id === 'string' && Boolean(entry.id)
    && typeof entry.pattern === 'string' && Boolean(entry.pattern.trim())
    && MATCH_TYPES.has(entry.matchType as WhitelistMatchType)
    && typeof entry.addedAt === 'string'
    && (entry.label === undefined || typeof entry.label === 'string')
    && (entry.source === undefined || entry.source === 'builtin' || entry.source === 'user');
}

function migrateEntries(entries: WhitelistEntry[]): { entries: WhitelistEntry[]; changed: boolean } {
  let changed = false;
  const migrated: WhitelistEntry[] = entries.flatMap((entry): WhitelistEntry[] => {
    if (LEGACY_WIDE_BUILTIN_IDS.has(entry.id)) {
      changed = true;
      return [];
    }
    const source = entry.source ?? (entry.id === 'default-git-status' ? 'builtin' : 'user');
    const id = entry.id === 'default-git-status' ? 'builtin-git-status' : entry.id;
    if (source !== entry.source || id !== entry.id) changed = true;
    return [{ ...entry, id, pattern: entry.pattern.trim(), source }];
  });
  if (!migrated.some((entry) => entry.id === 'builtin-git-status')) {
    migrated.unshift({ ...DEFAULT_ENTRIES[0]!, source: 'builtin' });
    changed = true;
  }
  return { entries: migrated, changed };
}

export function createCommandWhitelistStore(projectDir: string) {
  const filePath = join(projectDir, 'command-whitelist.json');
  let pending: Promise<void> = Promise.resolve();

  async function save(entries: WhitelistEntry[]): Promise<void> {
    const previous = pending;
    let release = () => {};
    pending = new Promise<void>((resolveLock) => { release = resolveLock; });
    await previous;
    try {
      await mkdir(dirname(filePath), { recursive: true });
      const payload: WhitelistFile = { version: 1, entries, updatedAt: new Date().toISOString() };
      const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      try {
        await rename(temporary, filePath);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    } finally {
      release();
    }
  }

  async function load(): Promise<WhitelistEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<WhitelistFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries) || !parsed.entries.every(validEntry)) {
        throw new Error('命令白名单 schema 非法');
      }
      const migrated = migrateEntries(parsed.entries);
      if (migrated.changed) await save(migrated.entries);
      return migrated.entries;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return DEFAULT_ENTRIES.map((entry) => ({ ...entry }));
      throw new Error(`命令白名单配置损坏：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  return {
    filePath,
    list: load,
    async add(entry: Omit<WhitelistEntry, 'id' | 'addedAt' | 'source'> & { id?: string; addedAt?: string; source?: WhitelistEntry['source'] }) {
      const entries = await load();
      const pattern = entry.matchType === 'command'
        ? entry.pattern.trim().toLowerCase()
        : normalizeCommand(entry.pattern);
      const duplicate = entries.find((candidate) => candidate.pattern === pattern && candidate.matchType === entry.matchType);
      if (duplicate) return duplicate;
      const created: WhitelistEntry = {
        id: entry.id ?? newId(),
        pattern,
        matchType: entry.matchType,
        label: entry.label,
        addedAt: entry.addedAt ?? new Date().toISOString(),
        source: entry.source ?? 'user',
      };
      entries.push(created);
      await save(entries);
      return created;
    },
    async addFromCommand(command: string, matchType: WhitelistEntry['matchType'] = 'exact') {
      const suggestion = suggestWhitelistPattern(command);
      return this.add({
        pattern: matchType === 'exact' ? normalizeCommand(command) : suggestion.pattern,
        matchType,
        label: matchType === 'exact' ? normalizeCommand(command) : suggestion.label,
      });
    },
    async remove(id: string): Promise<boolean> {
      const entries = await load();
      const target = entries.find((entry) => entry.id === id);
      if (target?.source === 'builtin') return false;
      const next = entries.filter((entry) => entry.id !== id);
      if (next.length === entries.length) return false;
      await save(next);
      return true;
    },
    async resetToDefaults() {
      const defaults = DEFAULT_ENTRIES.map((entry) => ({ ...entry }));
      await save(defaults);
      return defaults;
    },
  };
}

export type CommandWhitelistStore = ReturnType<typeof createCommandWhitelistStore>;
