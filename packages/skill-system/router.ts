import type { ExplicitSkillInvocation, SkillSummary } from './types.ts';

const EXPLICIT_SKILL_PATTERN = /(?:^|\s)([$/])([a-zA-Z0-9][a-zA-Z0-9_-]*)([^\n]*)?/g;

export function parseExplicitInvocations(prompt: string, skills: SkillSummary[]): ExplicitSkillInvocation[] {
  const names = new Set(skills.map((skill) => skill.name));
  const invocations: ExplicitSkillInvocation[] = [];
  for (const match of prompt.matchAll(EXPLICIT_SKILL_PATTERN)) {
    const rawName = match[2] ?? '';
    const name = rawName.toLowerCase();
    if (!names.has(name)) continue;
    invocations.push({
      name,
      raw: `${match[1]}${rawName}`,
      argumentsText: (match[3] ?? '').trim(),
    });
  }
  return invocations;
}

export function buildAvailableSkillsBlock(skills: SkillSummary[], explicitInvocations: ExplicitSkillInvocation[], maxChars = 8000): string {
  const explicitNames = new Set(explicitInvocations.map((item) => item.name));
  const lines = [
    '## Available Skills',
    '',
    'Before using ordinary tools, check this list. If any skill description directly matches the user task, you must call read_skill for that skill first. After reading it, call activate_skill with a short reason if it applies, then follow SKILL.md. Only skip skills when no listed description matches the task. Do not use disabled or unlisted skills.',
  ];

  if (explicitNames.size > 0) {
    lines.push('', 'Explicitly requested skills:');
    for (const name of explicitNames) {
      lines.push(`- ${name}`);
    }
  }

  lines.push('', 'Implicitly available skills:');
  for (const skill of skills) {
    const missing = skill.missingCapabilities.length > 0 ? ` Missing capabilities: ${skill.missingCapabilities.join(', ')}.` : '';
    const line = `- ${skill.name}: ${skill.description}${missing}`;
    const next = [...lines, line].join('\n');
    if (next.length > maxChars) {
      lines.push('- (additional skills omitted because of context budget)');
      break;
    }
    lines.push(line);
  }

  return lines.join('\n');
}
