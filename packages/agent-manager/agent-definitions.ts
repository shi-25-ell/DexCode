import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertValidAgentDefinition, type AgentContextMode, type AgentDefinition, type AgentIsolation } from './contracts.ts';

const READONLY_TOOLS = ['read_file', 'find', 'ls', 'list_workspace', 'grep'];
const FILE_WRITE_TOOLS = ['write_file', 'patch_file'];
const VISIBLE_BUILTIN_NAMES = new Set(['general-purpose', 'researcher', 'reviewer']);
const RESERVED_AGENT_NAMES = new Set(['general-purpose', 'assistant', 'researcher', 'reviewer']);
const AGENT_STATE_FILE = '.agent-state.json';
export const MAX_VISIBLE_AGENT_DEFINITIONS = 10;
export const MAX_CUSTOM_AGENT_DEFINITIONS = MAX_VISIBLE_AGENT_DEFINITIONS - VISIBLE_BUILTIN_NAMES.size;

export type AgentFilePermission = 'read_only' | 'write_files';
export type ManagedAgentContextMode = 'fork' | 'fresh';
export type ManagedAgentDefinitionInput = {
  name: string;
  description: string;
  instructions: string;
  filePermission: AgentFilePermission;
  contextMode: ManagedAgentContextMode;
};
export type ManagedAgentDefinition = ManagedAgentDefinitionInput & {
  source: 'builtin' | 'user' | 'workspace';
  enabled: boolean;
  editable: boolean;
  toggleable: boolean;
  deletable: boolean;
};

export class AgentDefinitionMutationError extends Error {
  readonly code: 'invalid' | 'not_found' | 'conflict' | 'capacity' | 'forbidden';
  constructor(code: 'invalid' | 'not_found' | 'conflict' | 'capacity' | 'forbidden', message: string) {
    super(message);
    this.name = 'AgentDefinitionMutationError';
    this.code = code;
  }
}

export const BUILTIN_AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  {
    name: 'general-purpose',
    description: 'Default general-purpose child agent for bounded delegated tasks, including workspace file edits.',
    systemPrompt: 'Complete the assigned task as a general-purpose child agent. Use available workspace tools when needed, edit files when the task requires it, and return a concise result to the parent agent.',
    toolPolicy: { allow: [...READONLY_TOOLS, ...FILE_WRITE_TOOLS], allowExternalMcp: false, allowSkills: false, allowOrchestration: false },
    defaultContextMode: 'fork', allowedContextModes: ['fresh', 'fork'],
    budget: { maxModelTurns: 64, maxModelAttempts: 80, maxRetriesPerTurn: 1, maxOutputTokens: 16_384, maxResultBytes: 64 * 1024, modelRequestTimeoutMs: 300_000, maxRunDurationMs: 900_000, maxTotalTokens: 1_500_000 },
    memoryPolicy: { read: true, write: false, automaticExtraction: false },
    isolationPolicy: { default: 'shared', allowed: ['shared'] },
  },
  {
    name: 'assistant',
    description: 'Compatibility alias for the general-purpose child agent.',
    systemPrompt: 'Complete the assigned task as a child agent. Use available read-only tools when needed and return a concise result to the parent agent.',
    toolPolicy: { allow: [...READONLY_TOOLS], allowExternalMcp: false, allowSkills: false, allowOrchestration: false },
    defaultContextMode: 'fork', allowedContextModes: ['fresh', 'fork'],
    budget: { maxModelTurns: 64, maxModelAttempts: 80, maxRetriesPerTurn: 1, maxOutputTokens: 16_384, maxResultBytes: 64 * 1024, modelRequestTimeoutMs: 300_000, maxRunDurationMs: 900_000, maxTotalTokens: 1_500_000 },
    memoryPolicy: { read: true, write: false, automaticExtraction: false },
    isolationPolicy: { default: 'shared', allowed: ['shared'] },
  },
  {
    name: 'researcher',
    description: 'Read-only investigation agent for source-grounded findings.',
    systemPrompt: 'Investigate the assigned task using only read-only tools. Return concise, source-grounded findings and call out uncertainty.',
    toolPolicy: { allow: [...READONLY_TOOLS], allowExternalMcp: false, allowSkills: false, allowOrchestration: false },
    defaultContextMode: 'fresh', allowedContextModes: ['fresh', 'fork'],
    budget: { maxModelTurns: 64, maxModelAttempts: 80, maxRetriesPerTurn: 1, maxOutputTokens: 16_384, maxResultBytes: 64 * 1024, modelRequestTimeoutMs: 300_000, maxRunDurationMs: 900_000, maxTotalTokens: 1_500_000 },
    memoryPolicy: { read: true, write: false, automaticExtraction: false },
    isolationPolicy: { default: 'shared', allowed: ['shared'] },
  },
  {
    name: 'reviewer',
    description: 'Read-only review agent focused on correctness and regressions.',
    systemPrompt: 'Review the assigned scope. Inspect the actual source and report actionable correctness or regression risks with evidence.',
    toolPolicy: { allow: [...READONLY_TOOLS], allowExternalMcp: false, allowSkills: false, allowOrchestration: false },
    defaultContextMode: 'fork', allowedContextModes: ['fresh', 'fork'],
    budget: { maxModelTurns: 64, maxModelAttempts: 80, maxRetriesPerTurn: 1, maxOutputTokens: 16_384, maxResultBytes: 64 * 1024, modelRequestTimeoutMs: 300_000, maxRunDurationMs: 900_000, maxTotalTokens: 1_500_000 },
    memoryPolicy: { read: true, write: false, automaticExtraction: false },
    isolationPolicy: { default: 'shared', allowed: ['shared'] },
  },
] as const;

export type AgentDefinitionDiagnostic = { path: string; severity: 'error'; message: string };

function digest(definition: AgentDefinition): string {
  return `sha256-${createHash('sha256').update(JSON.stringify(definition)).digest('hex')}`;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string; } catch { throw new Error('Invalid quoted string'); }
  }
  return ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) ? trimmed.slice(1, -1) : trimmed;
}
function list(value: string): string[] {
  const body = value.trim();
  if (!body.startsWith('[') || !body.endsWith(']')) throw new Error('Lists must use [a, b] syntax');
  return body.slice(1, -1).split(',').map(scalar).map((item) => item.trim()).filter(Boolean);
}
function integer(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${key} must be an integer`);
  return parsed;
}
function bool(value: string, key: string): boolean {
  if (value.trim() === 'true') return true;
  if (value.trim() === 'false') return false;
  throw new Error(`${key} must be true or false`);
}

const KEYS = new Set([
  'name', 'description', 'default-context-mode', 'allowed-context-modes', 'allowed-tools', 'denied-tools', 'allow-external-mcp', 'allow-skills',
  'max-model-turns', 'max-model-attempts', 'max-retries-per-turn', 'max-output-tokens', 'max-result-bytes', 'max-run-duration-ms', 'model-request-timeout-ms', 'max-total-tokens', 'model',
  'memory-read', 'memory-write', 'automatic-extraction', 'default-isolation', 'allowed-isolation',
]);

export function parseAgentDefinitionMarkdown(content: string): AgentDefinition {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) throw new Error('Agent definition requires YAML frontmatter');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('Agent definition frontmatter is not closed');
  const values = new Map<string, string>();
  for (const raw of normalized.slice(4, end).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`Invalid frontmatter line: ${line}`);
    const key = line.slice(0, colon).trim().toLowerCase().replace(/_/g, '-');
    if (!KEYS.has(key)) throw new Error(`Unknown Agent definition field: ${key}`);
    if (values.has(key)) throw new Error(`Duplicate Agent definition field: ${key}`);
    values.set(key, line.slice(colon + 1).trim());
  }
  const required = (key: string) => { const value = values.get(key); if (!value) throw new Error(`${key} is required`); return scalar(value); };
  const contexts = (values.has('allowed-context-modes') ? list(values.get('allowed-context-modes')!) : ['fresh', 'fork']) as AgentContextMode[];
  const isolations = (values.has('allowed-isolation') ? list(values.get('allowed-isolation')!) : ['shared']) as AgentIsolation[];
  if (contexts.some((item) => item !== 'fresh' && item !== 'fork')) throw new Error('allowed-context-modes contains an invalid value');
  if (isolations.some((item) => item !== 'shared' && item !== 'worktree')) throw new Error('allowed-isolation contains an invalid value');
  const definition: AgentDefinition = {
    name: required('name'), description: required('description'), systemPrompt: normalized.slice(end + 5).trim(),
    toolPolicy: {
      allow: values.has('allowed-tools') ? list(values.get('allowed-tools')!) : [],
      deny: values.has('denied-tools') ? list(values.get('denied-tools')!) : [],
      allowExternalMcp: values.has('allow-external-mcp') ? bool(values.get('allow-external-mcp')!, 'allow-external-mcp') : false,
      allowSkills: values.has('allow-skills') ? bool(values.get('allow-skills')!, 'allow-skills') : false,
      allowOrchestration: false,
    },
    defaultContextMode: (values.get('default-context-mode') ? scalar(values.get('default-context-mode')!) : 'fresh') as AgentContextMode,
    allowedContextModes: contexts,
    budget: {
      maxModelTurns: integer(values.get('max-model-turns') ?? '64', 'max-model-turns'),
      ...(values.has('max-model-attempts') ? { maxModelAttempts: integer(values.get('max-model-attempts')!, 'max-model-attempts') } : {}),
      ...(values.has('max-retries-per-turn') ? { maxRetriesPerTurn: integer(values.get('max-retries-per-turn')!, 'max-retries-per-turn') } : {}),
      ...(values.has('max-output-tokens') ? { maxOutputTokens: integer(values.get('max-output-tokens')!, 'max-output-tokens') } : {}),
      ...(values.has('max-result-bytes') ? { maxResultBytes: integer(values.get('max-result-bytes')!, 'max-result-bytes') } : {}),
      ...(values.has('max-run-duration-ms') ? { maxRunDurationMs: integer(values.get('max-run-duration-ms')!, 'max-run-duration-ms') } : {}),
      ...(values.has('model-request-timeout-ms') ? { modelRequestTimeoutMs: integer(values.get('model-request-timeout-ms')!, 'model-request-timeout-ms') } : {}),
      ...(values.has('max-total-tokens') ? { maxTotalTokens: integer(values.get('max-total-tokens')!, 'max-total-tokens') } : {}),
    },
    ...(values.has('model') ? { model: scalar(values.get('model')!) } : {}),
    memoryPolicy: {
      read: values.has('memory-read') ? bool(values.get('memory-read')!, 'memory-read') : true,
      write: values.has('memory-write') ? bool(values.get('memory-write')!, 'memory-write') : false,
      automaticExtraction: false,
    },
    isolationPolicy: { default: (values.get('default-isolation') ? scalar(values.get('default-isolation')!) : 'shared') as AgentIsolation, allowed: isolations },
  };
  if (values.has('automatic-extraction') && bool(values.get('automatic-extraction')!, 'automatic-extraction')) throw new Error('automatic-extraction must be false');
  assertValidAgentDefinition(definition);
  return definition;
}

type LoadedDefinition = { definition: AgentDefinition; source: 'user' | 'workspace'; path: string };
type AgentDefinitionState = { version: 1; disabled: string[] };

async function loadRootWithSource(root: string | undefined, source: LoadedDefinition['source'], diagnostics: AgentDefinitionDiagnostic[]): Promise<LoadedDefinition[]> {
  if (!root) return [];
  try { if (!(await stat(root)).isDirectory()) return []; } catch { return []; }
  const loaded: LoadedDefinition[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (typeof entry === 'string' || !entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const path = resolve(join(root, entry.name));
    try { loaded.push({ definition: parseAgentDefinitionMarkdown(await readFile(path, 'utf8')), source, path }); }
    catch (error) { diagnostics.push({ path, severity: 'error', message: error instanceof Error ? error.message : String(error) }); }
  }
  return loaded;
}

function validateManagedInput(input: ManagedAgentDefinitionInput): ManagedAgentDefinitionInput {
  const normalized = {
    name: input.name?.trim(),
    description: input.description?.trim(),
    instructions: input.instructions?.trim(),
    filePermission: input.filePermission,
    contextMode: input.contextMode,
  };
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(normalized.name)) throw new AgentDefinitionMutationError('invalid', '名称需以小写字母开头，只能包含小写字母、数字、连字符或下划线，最长 64 个字符');
  if (!normalized.description || normalized.description.length > 500) throw new AgentDefinitionMutationError('invalid', '使用场景描述不能为空且不能超过 500 个字符');
  if (!normalized.instructions || normalized.instructions.length > 20_000) throw new AgentDefinitionMutationError('invalid', '子智能体指令不能为空且不能超过 20000 个字符');
  if (normalized.filePermission !== 'read_only' && normalized.filePermission !== 'write_files') throw new AgentDefinitionMutationError('invalid', '文件权限无效');
  if (normalized.contextMode !== 'fresh' && normalized.contextMode !== 'fork') throw new AgentDefinitionMutationError('invalid', '上下文策略无效');
  return normalized;
}

function customDefinition(input: ManagedAgentDefinitionInput): AgentDefinition {
  const normalized = validateManagedInput(input);
  return {
    name: normalized.name,
    description: normalized.description,
    systemPrompt: normalized.instructions,
    toolPolicy: {
      allow: normalized.filePermission === 'write_files' ? [...READONLY_TOOLS, ...FILE_WRITE_TOOLS] : [...READONLY_TOOLS],
      allowExternalMcp: false,
      allowSkills: false,
      allowOrchestration: false,
    },
    defaultContextMode: normalized.contextMode,
    allowedContextModes: [normalized.contextMode],
    budget: { maxModelTurns: 64, maxModelAttempts: 80, maxRetriesPerTurn: 1, maxOutputTokens: 16_384, maxResultBytes: 64 * 1024, modelRequestTimeoutMs: 300_000, maxRunDurationMs: 900_000, maxTotalTokens: 1_500_000 },
    memoryPolicy: { read: true, write: false, automaticExtraction: false },
    isolationPolicy: { default: 'shared', allowed: ['shared'] },
  };
}

function serializeManagedDefinition(input: ManagedAgentDefinitionInput): string {
  const definition = customDefinition(input);
  return [
    '---',
    `name: ${JSON.stringify(definition.name)}`,
    `description: ${JSON.stringify(definition.description)}`,
    `default-context-mode: ${definition.defaultContextMode}`,
    `allowed-context-modes: [${definition.defaultContextMode}]`,
    `allowed-tools: [${(definition.toolPolicy.allow ?? []).join(', ')}]`,
    'allow-external-mcp: false',
    'allow-skills: false',
    'memory-read: true',
    'memory-write: false',
    'automatic-extraction: false',
    'default-isolation: shared',
    'allowed-isolation: [shared]',
    '---',
    definition.systemPrompt,
    '',
  ].join('\n');
}

function filePermission(definition: AgentDefinition): AgentFilePermission {
  return FILE_WRITE_TOOLS.some((tool) => (definition.toolPolicy.allow ?? []).includes(tool)) ? 'write_files' : 'read_only';
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  try { await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export function createAgentDefinitionRegistry(options: { userRoot?: string; workspaceRoot?: string } = {}) {
  let definitions = new Map(BUILTIN_AGENT_DEFINITIONS.map((item) => [item.name, structuredClone(item)]));
  let sources = new Map<string, ManagedAgentDefinition['source']>(BUILTIN_AGENT_DEFINITIONS.map((item) => [item.name, 'builtin']));
  let disabled = new Set<string>();
  let diagnostics: AgentDefinitionDiagnostic[] = [];
  let mutations = Promise.resolve();

  async function readState(nextDiagnostics: AgentDefinitionDiagnostic[]): Promise<Set<string>> {
    if (!options.userRoot) return new Set();
    const path = join(options.userRoot, AGENT_STATE_FILE);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<AgentDefinitionState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.disabled) || parsed.disabled.some((name) => typeof name !== 'string')) throw new Error('Invalid Agent state file');
      return new Set(parsed.disabled.filter((name) => name !== 'general-purpose' && name !== 'assistant'));
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') nextDiagnostics.push({ path, severity: 'error', message: error instanceof Error ? error.message : String(error) });
      return new Set();
    }
  }

  async function reload() {
    const nextDiagnostics: AgentDefinitionDiagnostic[] = [];
    const user = await loadRootWithSource(options.userRoot, 'user', nextDiagnostics);
    const workspace = await loadRootWithSource(options.workspaceRoot, 'workspace', nextDiagnostics);
    const next = new Map(BUILTIN_AGENT_DEFINITIONS.map((item) => [item.name, structuredClone(item)]));
    const nextSources = new Map<string, ManagedAgentDefinition['source']>(BUILTIN_AGENT_DEFINITIONS.map((item) => [item.name, 'builtin']));
    let customCount = 0;
    for (const item of [...user, ...workspace]) {
      if (RESERVED_AGENT_NAMES.has(item.definition.name)) {
        nextDiagnostics.push({ path: item.path, severity: 'error', message: `内置子智能体 ${item.definition.name} 不可覆盖` });
        continue;
      }
      let candidate = item.definition;
      if (item.source === 'user') {
        try {
          candidate = customDefinition({
            name: item.definition.name,
            description: item.definition.description,
            instructions: item.definition.systemPrompt,
            filePermission: filePermission(item.definition),
            contextMode: item.definition.defaultContextMode,
          });
        } catch (error) {
          nextDiagnostics.push({ path: item.path, severity: 'error', message: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }
      if (!next.has(candidate.name)) {
        if (customCount >= MAX_CUSTOM_AGENT_DEFINITIONS) {
          nextDiagnostics.push({ path: item.path, severity: 'error', message: `最多允许 ${MAX_CUSTOM_AGENT_DEFINITIONS} 个自定义子智能体` });
          continue;
        }
        customCount += 1;
      }
      next.set(candidate.name, candidate);
      nextSources.set(candidate.name, item.source);
    }
    definitions = next;
    sources = nextSources;
    disabled = await readState(nextDiagnostics);
    diagnostics = nextDiagnostics;
    return { definitions: listEnabled(), diagnostics: [...diagnostics] };
  }

  function listEnabled() {
    return [...definitions.values()].filter((item) => !disabled.has(item.name)).map((item) => structuredClone(item));
  }

  function managedList(): ManagedAgentDefinition[] {
    return [...definitions.values()]
      .filter((definition) => definition.name !== 'assistant')
      .map((definition) => {
        const source = sources.get(definition.name) ?? 'user';
        const builtin = source === 'builtin';
        return {
          name: definition.name,
          description: definition.description,
          instructions: definition.systemPrompt,
          filePermission: filePermission(definition),
          contextMode: definition.defaultContextMode,
          source,
          enabled: !disabled.has(definition.name),
          editable: !builtin,
          toggleable: definition.name !== 'general-purpose' && definition.name !== 'assistant',
          deletable: !builtin,
        };
      });
  }

  async function persistState(): Promise<void> {
    if (!options.userRoot) throw new AgentDefinitionMutationError('forbidden', '未配置全局子智能体目录');
    await mkdir(options.userRoot, { recursive: true });
    const state: AgentDefinitionState = { version: 1, disabled: [...disabled].sort() };
    await atomicWrite(join(options.userRoot, AGENT_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  }

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutations.then(operation, operation);
    mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    reload,
    list: listEnabled,
    managedList,
    diagnostics: () => [...diagnostics],
    resolve(name: string) {
      if (disabled.has(name)) return null;
      const definition = definitions.get(name);
      return definition ? { definition: structuredClone(definition), digest: digest(definition) } : null;
    },
    create(input: ManagedAgentDefinitionInput) {
      return mutate(async () => {
        const normalized = validateManagedInput(input);
        if (RESERVED_AGENT_NAMES.has(normalized.name) || definitions.has(normalized.name)) throw new AgentDefinitionMutationError('conflict', '子智能体名称已存在或为内置保留名称');
        if ([...sources.values()].filter((source) => source !== 'builtin').length >= MAX_CUSTOM_AGENT_DEFINITIONS) throw new AgentDefinitionMutationError('capacity', `最多允许 ${MAX_CUSTOM_AGENT_DEFINITIONS} 个自定义子智能体`);
        if (!options.userRoot) throw new AgentDefinitionMutationError('forbidden', '未配置全局子智能体目录');
        await mkdir(options.userRoot, { recursive: true });
        await atomicWrite(join(options.userRoot, `${normalized.name}.md`), serializeManagedDefinition(normalized));
        disabled.delete(normalized.name);
        await reload();
        return managedList().find((item) => item.name === normalized.name)!;
      });
    },
    update(name: string, input: ManagedAgentDefinitionInput) {
      return mutate(async () => {
        const normalized = validateManagedInput(input);
        if (normalized.name !== name) throw new AgentDefinitionMutationError('invalid', '当前版本不支持修改子智能体名称');
        if (sources.get(name) !== 'user') throw new AgentDefinitionMutationError(sources.has(name) ? 'forbidden' : 'not_found', sources.has(name) ? '内置子智能体不可编辑' : '子智能体不存在');
        if (!options.userRoot) throw new AgentDefinitionMutationError('forbidden', '未配置全局子智能体目录');
        await atomicWrite(join(options.userRoot, `${name}.md`), serializeManagedDefinition(normalized));
        await reload();
        return managedList().find((item) => item.name === name)!;
      });
    },
    setEnabled(name: string, enabled: boolean) {
      return mutate(async () => {
        if (!definitions.has(name) || name === 'assistant') throw new AgentDefinitionMutationError('not_found', '子智能体不存在');
        if (name === 'general-purpose') throw new AgentDefinitionMutationError('forbidden', 'general-purpose 始终启用');
        if (enabled) disabled.delete(name); else disabled.add(name);
        await persistState();
        return managedList().find((item) => item.name === name)!;
      });
    },
    remove(name: string) {
      return mutate(async () => {
        if (sources.get(name) !== 'user') throw new AgentDefinitionMutationError(sources.has(name) ? 'forbidden' : 'not_found', sources.has(name) ? '内置子智能体不可删除' : '子智能体不存在');
        if (!options.userRoot) throw new AgentDefinitionMutationError('forbidden', '未配置全局子智能体目录');
        await rm(join(options.userRoot, `${name}.md`), { force: true });
        disabled.delete(name);
        await persistState();
        await reload();
      });
    },
  };
}

export type AgentDefinitionRegistry = ReturnType<typeof createAgentDefinitionRegistry>;
