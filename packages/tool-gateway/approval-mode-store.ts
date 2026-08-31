import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ApprovalMode, ApprovalModeState } from '../shared/types.ts';

const MODES = new Set<ApprovalMode>(['read_only', 'allowlist', 'full_access']);

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && MODES.has(value as ApprovalMode);
}

function validState(value: unknown): value is ApprovalModeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<ApprovalModeState>;
  return state.version === 1
    && isApprovalMode(state.mode)
    && Number.isSafeInteger(state.revision)
    && Number(state.revision) >= 0
    && typeof state.updatedAt === 'string'
    && !Number.isNaN(Date.parse(state.updatedAt));
}

export type ApprovalModeStore = {
  getMode(): ApprovalMode;
  getState(): ApprovalModeState;
  getDiagnostic(): string | undefined;
  setMode(mode: ApprovalMode): Promise<ApprovalModeState>;
};

export async function createApprovalModeStore(options: {
  file: string;
  now?: () => Date;
}): Promise<ApprovalModeStore> {
  const file = resolve(options.file);
  const now = options.now ?? (() => new Date());
  let state: ApprovalModeState;
  let diagnostic: string | undefined;
  let pending: Promise<void> = Promise.resolve();

  async function persist(next: ApprovalModeState): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    try {
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (!validState(parsed)) throw new Error('批准模式配置 schema 非法');
    state = parsed;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      state = { version: 1, mode: 'allowlist', revision: 0, updatedAt: now().toISOString() };
      await persist(state);
    } else {
      state = { version: 1, mode: 'read_only', revision: 0, updatedAt: now().toISOString() };
      diagnostic = `批准模式配置损坏，已按逐次批准启动：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return {
    getMode: () => state.mode,
    getState: () => ({ ...state }),
    getDiagnostic: () => diagnostic,
    async setMode(mode) {
      if (!isApprovalMode(mode)) throw new Error('非法批准模式');
      const previous = pending;
      let release = () => {};
      pending = new Promise<void>((resolveLock) => { release = resolveLock; });
      await previous;
      try {
        if (state.mode === mode) return { ...state };
        const next: ApprovalModeState = {
          version: 1,
          mode,
          revision: state.revision + 1,
          updatedAt: now().toISOString(),
        };
        await persist(next);
        state = next;
        diagnostic = undefined;
        return { ...state };
      } finally {
        release();
      }
    },
  };
}
