import { dirname } from 'node:path';
import type { SkillFrontmatter } from './types.ts';

type ParsedSkillFile = {
  frontmatter: SkillFrontmatter;
  body: string;
};

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/_/g, '-');
}

function parseBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function parseStringValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseStringList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => parseStringValue(item))
      .filter(Boolean);
  }
  return trimmed
    .split(/[,\s]+/)
    .map((item) => parseStringValue(item))
    .filter(Boolean);
}

export function parseSkillMarkdown(content: string): ParsedSkillFile {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return { frontmatter: {}, body: normalized.trim() };

  const rawFrontmatter = normalized.slice(4, end).trim();
  const body = normalized.slice(end + 4).trim();
  const frontmatter: SkillFrontmatter = {};

  for (const line of rawFrontmatter.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx < 0) continue;

    const key = normalizeKey(trimmed.slice(0, idx));
    const rawValue = trimmed.slice(idx + 1).trim();

    if (key === 'name') frontmatter.name = parseStringValue(rawValue);
    else if (key === 'description') frontmatter.description = parseStringValue(rawValue);
    else if (key === 'disable-model-invocation') frontmatter.disableModelInvocation = parseBoolean(rawValue);
    else if (key === 'allow-implicit-invocation') frontmatter.allowImplicitInvocation = parseBoolean(rawValue);
    else if (key === 'user-invocable') frontmatter.userInvocable = parseBoolean(rawValue);
    else if (key === 'allowed-tools') frontmatter.allowedTools = parseStringList(rawValue);
    else if (key === 'disallowed-tools') frontmatter.disallowedTools = parseStringList(rawValue);
    else if (key === 'paths') frontmatter.paths = parseStringList(rawValue);
    else if (key === 'tags') frontmatter.tags = parseStringList(rawValue);
  }

  return { frontmatter, body };
}

export function inferSkillName(skillFilePath: string, frontmatterName?: string): string {
  const skillDir = dirname(skillFilePath).replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'skill';
  const name = frontmatterName?.trim() || skillDir;
  return name.replace(/\s+/g, '-').toLowerCase();
}

export function inferDescription(body: string): string {
  const firstParagraph = body
    .split(/\n\s*\n/)
    .map((block) => block.replace(/^#+\s*/gm, '').trim())
    .find(Boolean);
  return firstParagraph?.slice(0, 500) || 'No description provided.';
}
