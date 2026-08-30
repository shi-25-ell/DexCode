import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WhitelistEntry } from './command-safety.ts';
import { suggestWhitelistPattern } from './command-safety.ts';

type WhitelistFile = {
  version: 1;
  entries: WhitelistEntry[];
  updatedAt: string;
};

const DEFAULT_ENTRIES: WhitelistEntry[] = [
  {
    id: 'default-npm-test',
    pattern: 'npm test',
    matchType: 'prefix',
    label: 'npm test（内置）',
    addedAt: '1970-01-01T00:00:00.000Z',
  },
  {
    id: 'default-npm-run',
    pattern: 'npm run',
    matchType: 'prefix',
    label: 'npm run *（内置）',
    addedAt: '1970-01-01T00:00:00.000Z',
  },
  {
    id: 'default-git-status',
    pattern: 'git status',
    matchType: 'prefix',
    label: 'git status（内置）',
    addedAt: '1970-01-01T00:00:00.000Z',
  },
];

function newId(): string {
  return `wl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createCommandWhitelistStore(projectDir: string) {
  const filePath = join(projectDir, 'command-whitelist.json');

  async function load(): Promise<WhitelistEntry[]> {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as WhitelistFile;
      if (!Array.isArray(parsed.entries)) return [...DEFAULT_ENTRIES];
      return parsed.entries;
    } catch {
      return [...DEFAULT_ENTRIES];
    }
  }

  async function save(entries: WhitelistEntry[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const payload: WhitelistFile = {
      version: 1,
      entries,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  return {
    filePath,
    list: load,
    async add(entry: Omit<WhitelistEntry, 'id' | 'addedAt'> & { id?: string; addedAt?: string }) {
      const entries = await load();
      const duplicate = entries.find(
        (e) => e.pattern === entry.pattern && e.matchType === entry.matchType,
      );
      if (duplicate) return duplicate;

      const created: WhitelistEntry = {
        id: entry.id ?? newId(),
        pattern: entry.pattern,
        matchType: entry.matchType,
        label: entry.label,
        addedAt: entry.addedAt ?? new Date().toISOString(),
      };
      entries.push(created);
      await save(entries);
      return created;
    },
    async addFromCommand(command: string, matchType?: WhitelistEntry['matchType']) {
      const suggestion = suggestWhitelistPattern(command);
      const resolvedType = matchType ?? suggestion.matchType;
      return this.add({
        pattern: resolvedType === 'exact' ? command.trim() : suggestion.pattern,
        matchType: resolvedType,
        label: suggestion.label,
      });
    },
    async remove(id: string): Promise<boolean> {
      const entries = await load();
      const next = entries.filter((e) => e.id !== id);
      if (next.length === entries.length) return false;
      await save(next);
      return true;
    },
    async resetToDefaults() {
      await save([...DEFAULT_ENTRIES]);
      return [...DEFAULT_ENTRIES];
    },
  };
}

export type CommandWhitelistStore = ReturnType<typeof createCommandWhitelistStore>;
