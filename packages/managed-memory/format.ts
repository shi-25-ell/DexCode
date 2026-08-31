import { createHash } from 'node:crypto';
import {
  MANAGED_MEMORY_LIMITS,
  MANAGED_MEMORY_TYPES,
  type ManagedMemoryType,
} from './contracts.ts';

export class ManagedMemoryValidationError extends Error {
  readonly code = 'MEMORY_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'ManagedMemoryValidationError';
  }
}

export function sha256(content: string): string {
  return `sha256-${createHash('sha256').update(content).digest('hex')}`;
}

export function utf8Bytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

export function normalizeLf(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

function scalar(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

export function parseTopic(rawInput: string): {
  name: string;
  description: string;
  type: ManagedMemoryType;
  body: string;
} {
  const raw = normalizeLf(rawInput);
  if (!raw.startsWith('---\n')) throw new ManagedMemoryValidationError('Topic frontmatter is required');
  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) throw new ManagedMemoryValidationError('Topic frontmatter is not closed');
  const lines = raw.slice(4, end).split('\n');
  if (lines.length > MANAGED_MEMORY_LIMITS.frontmatterLines) {
    throw new ManagedMemoryValidationError('Topic frontmatter exceeds 30 lines');
  }
  const values = new Map<string, string>();
  for (const line of lines) {
    const match = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) throw new ManagedMemoryValidationError(`Invalid frontmatter line: ${line.slice(0, 80)}`);
    const key = match[1]!.toLowerCase();
    if (!['name', 'description', 'type'].includes(key)) throw new ManagedMemoryValidationError(`Unknown frontmatter field: ${key}`);
    if (values.has(key)) throw new ManagedMemoryValidationError(`Duplicate frontmatter field: ${key}`);
    values.set(key, match[2]!.trim());
  }
  const name = values.get('name') ?? '';
  const description = values.get('description') ?? '';
  const type = values.get('type') ?? '';
  if (!name || !description || !type) throw new ManagedMemoryValidationError('name, description and type are required');
  if (!MANAGED_MEMORY_TYPES.includes(type as ManagedMemoryType)) throw new ManagedMemoryValidationError(`Unsupported memory type: ${type}`);
  if (description.includes('\n') || description.length > 1_000) throw new ManagedMemoryValidationError('description must be one bounded line');
  return { name, description, type: type as ManagedMemoryType, body: raw.slice(end + 5).replace(/^\n+/, '') };
}

export function serializeTopic(input: { name: string; description: string; type: ManagedMemoryType; body: string }): string {
  const name = scalar(input.name);
  const description = scalar(input.description);
  if (!name || !description) throw new ManagedMemoryValidationError('name and description are required');
  if (!MANAGED_MEMORY_TYPES.includes(input.type)) throw new ManagedMemoryValidationError(`Unsupported memory type: ${input.type}`);
  const raw = `---\nname: ${name}\ndescription: ${description}\ntype: ${input.type}\n---\n\n${normalizeLf(input.body).trim()}\n`;
  if (utf8Bytes(raw) > MANAGED_MEMORY_LIMITS.maxTopicBytes) {
    throw new ManagedMemoryValidationError('Topic exceeds 64 KiB; split it into smaller semantic topics');
  }
  parseTopic(raw);
  return raw;
}

export function truncateUtf8AtLine(contentInput: string, maxLines: number, maxBytes: number): {
  content: string;
  truncated: boolean;
  lineTruncated: boolean;
  byteTruncated: boolean;
} {
  const normalized = normalizeLf(contentInput);
  const lines = normalized.split('\n');
  const lineTruncated = lines.length > maxLines;
  let content = lineTruncated ? lines.slice(0, maxLines).join('\n') : normalized;
  let byteTruncated = utf8Bytes(content) > maxBytes;
  if (byteTruncated) {
    const buffer = new TextEncoder().encode(content).slice(0, maxBytes);
    content = new TextDecoder('utf-8', { fatal: false }).decode(buffer).replace(/\uFFFD+$/g, '');
    const newline = content.lastIndexOf('\n');
    if (newline > 0) content = content.slice(0, newline);
  }
  byteTruncated = byteTruncated || utf8Bytes(normalized) > maxBytes;
  return { content, truncated: lineTruncated || byteTruncated, lineTruncated, byteTruncated };
}

export function truncateIndexForRead(raw: string) {
  const result = truncateUtf8AtLine(raw, MANAGED_MEMORY_LIMITS.maxIndexLines, MANAGED_MEMORY_LIMITS.maxIndexBytes);
  const warnings = [
    result.lineTruncated ? `index exceeded ${MANAGED_MEMORY_LIMITS.maxIndexLines} lines` : '',
    result.byteTruncated ? `index exceeded ${MANAGED_MEMORY_LIMITS.maxIndexBytes} bytes` : '',
  ].filter(Boolean);
  return {
    ...result,
    content: warnings.length > 0 ? `${result.content.trimEnd()}\n\n> Warning: ${warnings.join(' and ')}; the injected view was truncated.` : result.content,
    warning: warnings.join('; ') || undefined,
  };
}

export function validateIndexForWrite(rawInput: string): string {
  const raw = normalizeLf(rawInput).trimEnd() + '\n';
  const lines = raw.split('\n');
  if (lines.length - 1 > MANAGED_MEMORY_LIMITS.maxIndexLines) throw new ManagedMemoryValidationError('MEMORY.md exceeds 200 lines');
  if (utf8Bytes(raw) > MANAGED_MEMORY_LIMITS.maxIndexBytes) throw new ManagedMemoryValidationError('MEMORY.md exceeds 25,000 bytes');
  for (const line of lines) {
    if (line.length > MANAGED_MEMORY_LIMITS.maxIndexLineChars) throw new ManagedMemoryValidationError('MEMORY.md contains a line over 200 characters');
  }
  if (/^---\s*$/m.test(raw)) throw new ManagedMemoryValidationError('MEMORY.md must not contain frontmatter');
  return raw;
}

const HIGH_CONFIDENCE_SECRETS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{24,}/i,
  /\b(?:ghp|github_pat|sk-proj|sk-live)_[A-Za-z0-9_\-]{20,}\b/i,
  /\bCookie\s*:\s*[^\n]{20,}/i,
];

export function assertNoHighConfidenceSecret(content: string): void {
  if (HIGH_CONFIDENCE_SECRETS.some((pattern) => pattern.test(content))) {
    throw new ManagedMemoryValidationError('High-confidence credential detected; save a non-sensitive pointer instead');
  }
}

export function indexEntry(path: string, title: string, hook: string): string {
  const line = `- [${scalar(title)}](${path}) — ${scalar(hook)}`;
  if (line.length > MANAGED_MEMORY_LIMITS.maxIndexLineChars) throw new ManagedMemoryValidationError('Index entry exceeds 200 characters');
  return line;
}

export function upsertIndexEntry(rawInput: string, path: string, line: string): string {
  const raw = normalizeLf(rawInput || '# Managed Memory\n');
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`^\\s*-\\s*\\[[^\\]]*\\]\\(${escaped}\\).*$`, 'i');
  const lines = raw.split('\n').filter((value) => !matcher.test(value));
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  if (lines.length === 0) lines.push('# Managed Memory');
  lines.push('', line);
  return validateIndexForWrite(lines.join('\n'));
}

export function removeIndexEntry(rawInput: string, path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`^\\s*-\\s*\\[[^\\]]*\\]\\(${escaped}\\).*$`, 'i');
  const lines = normalizeLf(rawInput || '# Managed Memory\n').split('\n').filter((line) => !matcher.test(line));
  return validateIndexForWrite(lines.join('\n'));
}
