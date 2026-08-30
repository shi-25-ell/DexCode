import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inferCapabilities } from './capability.ts';
import { inferDescription, inferSkillName, parseSkillMarkdown } from './parser.ts';
import type { SkillDefinition, SkillSource } from './types.ts';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isInside(child: string, parent: string): boolean {
  const normalizedChild = resolve(child);
  const normalizedParent = resolve(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}\\`) || normalizedChild.startsWith(`${normalizedParent}/`);
}

export async function loadSkillsFromRoot(rootPath: string, source: SkillSource, disabledSkills: Set<string>): Promise<SkillDefinition[]> {
  const root = resolve(rootPath);
  if (!(await pathExists(root))) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const skills: SkillDefinition[] = [];

  for (const entry of entries) {
    if (typeof entry === 'string') continue;
    if (!entry.isDirectory()) continue;
    const skillRoot = resolve(join(root, entry.name));
    const skillFilePath = resolve(join(skillRoot, 'SKILL.md'));
    if (!isInside(skillFilePath, root) || !(await pathExists(skillFilePath))) continue;

    const content = await readFile(skillFilePath, 'utf8');
    const parsed = parseSkillMarkdown(content);
    const name = inferSkillName(skillFilePath, parsed.frontmatter.name);
    const description = parsed.frontmatter.description || inferDescription(parsed.body);
    const allowImplicitInvocation = parsed.frontmatter.allowImplicitInvocation ?? !parsed.frontmatter.disableModelInvocation;
    const userInvocable = parsed.frontmatter.userInvocable ?? true;
    const capabilities = inferCapabilities(content, parsed.frontmatter.allowedTools ?? []);

    skills.push({
      name,
      description,
      source,
      rootPath: skillRoot,
      skillFilePath,
      content,
      enabled: !disabledSkills.has(name),
      allowImplicitInvocation,
      userInvocable,
      allowedTools: parsed.frontmatter.allowedTools ?? [],
      disallowedTools: parsed.frontmatter.disallowedTools ?? [],
      tags: parsed.frontmatter.tags ?? [],
      filePatterns: parsed.frontmatter.paths ?? [],
      ...capabilities,
      shadowed: false,
      usage: {
        readCount: 0,
        activationCount: 0,
        lastUsedAt: null,
      },
    });
  }

  return skills;
}
