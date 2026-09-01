import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertValidAgentDefinition, type AgentContextMode, type AgentDefinition, type AgentIsolation } from './contracts.ts';

const READONLY_TOOLS = ['read_file', 'find', 'ls', 'list_workspace', 'grep'];
const FILE_WRITE_TOOLS = ['write_file', 'patch_file'];

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

async function loadRoot(root: string | undefined, diagnostics: AgentDefinitionDiagnostic[]): Promise<AgentDefinition[]> {
  if (!root) return [];
  try { if (!(await stat(root)).isDirectory()) return []; } catch { return []; }
  const definitions: AgentDefinition[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (typeof entry === 'string') continue;
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const path = resolve(join(root, entry.name));
    try { definitions.push(parseAgentDefinitionMarkdown(await readFile(path, 'utf8'))); }
    catch (error) { diagnostics.push({ path, severity: 'error', message: error instanceof Error ? error.message : String(error) }); }
  }
  return definitions;
}

export function createAgentDefinitionRegistry(options: { userRoot?: string; workspaceRoot?: string } = {}) {
  let definitions = new Map(BUILTIN_AGENT_DEFINITIONS.map((item) => [item.name, structuredClone(item)]));
  let diagnostics: AgentDefinitionDiagnostic[] = [];
  async function reload() {
    const nextDiagnostics: AgentDefinitionDiagnostic[] = [];
    const user = await loadRoot(options.userRoot, nextDiagnostics);
    const workspace = await loadRoot(options.workspaceRoot, nextDiagnostics);
    const next = new Map(BUILTIN_AGENT_DEFINITIONS.map((item) => [item.name, structuredClone(item)]));
    for (const item of user) next.set(item.name, item);
    for (const item of workspace) next.set(item.name, item);
    definitions = next;
    diagnostics = nextDiagnostics;
    return { definitions: [...definitions.values()].map((item) => structuredClone(item)), diagnostics: [...diagnostics] };
  }
  return {
    reload,
    list: () => [...definitions.values()].map((item) => structuredClone(item)),
    diagnostics: () => [...diagnostics],
    resolve(name: string) {
      const definition = definitions.get(name);
      return definition ? { definition: structuredClone(definition), digest: digest(definition) } : null;
    },
  };
}

export type AgentDefinitionRegistry = ReturnType<typeof createAgentDefinitionRegistry>;
