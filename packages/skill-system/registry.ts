import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadSkillsFromRoot } from './loader.ts';
import type { SkillActivationResult, SkillConfig, SkillDefinition, SkillReadResult, SkillSummary, SkillTrigger, SkillUsage } from './types.ts';

const SOURCE_PRIORITY: Record<string, number> = {
  project: 4,
  user: 3,
  imported: 2,
  builtin: 1,
};

type RegistryOptions = {
  workspaceRoot: string;
  projectId?: string;
  configPath?: string;
};

const builtinSkillsRoot = join(process.cwd(), 'packages', 'skill-system', 'builtin-skills');

async function readConfig(configPath: string): Promise<SkillConfig> {
  try {
    return JSON.parse(await readFile(configPath, 'utf8')) as SkillConfig;
  } catch {
    return {};
  }
}

async function writeConfig(configPath: string, config: SkillConfig) {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function toSummary(skill: SkillDefinition): SkillSummary {
  const { content: _content, ...summary } = skill;
  return summary;
}

function isInside(child: string, parent: string): boolean {
  const normalizedChild = resolve(child);
  const normalizedParent = resolve(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}\\`) || normalizedChild.startsWith(`${normalizedParent}/`);
}

export function createSkillRegistry(options: RegistryOptions) {
  let workspaceRoot = resolve(options.workspaceRoot);
  const projectId = options.projectId ?? 'demo-project';
  const configPath = options.configPath ?? join(process.cwd(), 'workspaces', projectId, 'skill-config.json');
  let skills = new Map<string, SkillDefinition>();
  let usages: SkillUsage[] = [];

  async function loadAll() {
    const config = await readConfig(configPath);
    const disabledSkills = new Set(config.disabledSkills ?? []);

    const roots = [
      { root: builtinSkillsRoot, source: 'builtin' as const },
      { root: join(workspaceRoot, '.aicoding', 'skills'), source: 'project' as const },
      { root: join(workspaceRoot, '.claude', 'skills'), source: 'project' as const },
      { root: join(workspaceRoot, '.agents', 'skills'), source: 'project' as const },
    ];

    const loaded = (await Promise.all(
      roots.map(({ root, source }) => loadSkillsFromRoot(root, source, disabledSkills)),
    )).flat();

    loaded.sort((a, b) => (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0));

    const next = new Map<string, SkillDefinition>();
    for (const skill of loaded) {
      const existing = next.get(skill.name);
      if (!existing) {
        const previous = skills.get(skill.name);
        next.set(skill.name, {
          ...skill,
          usage: previous?.usage ?? skill.usage,
        });
      } else {
        skill.shadowed = true;
      }
    }
    skills = next;
  }

  function listSkills(): SkillSummary[] {
    return [...skills.values()].map(toSummary).sort((a, b) => a.name.localeCompare(b.name));
  }

  function listImplicitCandidates(): SkillSummary[] {
    return listSkills().filter((skill) => skill.enabled && skill.allowImplicitInvocation && !skill.shadowed);
  }

  function getSkill(name: string): SkillDefinition | null {
    return skills.get(name) ?? null;
  }

  function readSkill(name: string): SkillReadResult {
    const skill = getSkill(name);
    if (!skill) return { ok: false, error: `Skill not found: ${name}` };
    if (!skill.enabled) return { ok: false, error: `Skill is disabled: ${name}` };

    skill.usage.readCount++;
    skill.usage.lastUsedAt = new Date().toISOString();
    return {
      ok: true,
      skill: {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        content: skill.content,
        rootPath: skill.rootPath,
        skillFilePath: skill.skillFilePath,
      },
    };
  }

  function activateSkill(name: string, trigger: SkillTrigger, reason?: string): SkillActivationResult {
    const skill = getSkill(name);
    if (!skill) return { ok: false, error: `Skill not found: ${name}` };
    if (!skill.enabled) return { ok: false, error: `Skill is disabled: ${name}` };

    skill.usage.activationCount++;
    skill.usage.lastUsedAt = new Date().toISOString();
    usages.push({ name, trigger, action: 'activated', reason, at: skill.usage.lastUsedAt });
    return { ok: true, skill: name, trigger, reason };
  }

  function deactivateSkill(name: string, reason?: string): SkillActivationResult {
    const skill = getSkill(name);
    if (!skill) return { ok: false, error: `Skill not found: ${name}` };
    usages.push({ name, trigger: 'explicit', action: 'deactivated', reason, at: new Date().toISOString() });
    return { ok: true, skill: name, trigger: 'explicit', reason };
  }

  async function setEnabled(name: string, enabled: boolean): Promise<boolean> {
    const skill = getSkill(name);
    if (!skill) return false;
    const config = await readConfig(configPath);
    const disabled = new Set(config.disabledSkills ?? []);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await writeConfig(configPath, { ...config, disabledSkills: [...disabled].sort() });
    skill.enabled = enabled;
    return true;
  }

  async function deleteSkill(name: string, expectedRootPath?: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
    const skill = getSkill(name);
    if (!skill) return { ok: false, error: `Skill not found: ${name}` };
    if (skill.source === 'builtin' || skill.source === 'user') {
      return { ok: false, error: `Skill source cannot be deleted: ${skill.source}` };
    }

    if (expectedRootPath && resolve(expectedRootPath) !== resolve(skill.rootPath)) {
      return { ok: false, error: 'Skill path does not match registry record' };
    }

    const allowedRoots = [
      resolve(join(workspaceRoot, '.aicoding', 'skills')),
      resolve(join(workspaceRoot, '.claude', 'skills')),
      resolve(join(workspaceRoot, '.agents', 'skills')),
    ];
    if (!allowedRoots.some((root) => isInside(skill.rootPath, root))) {
      return { ok: false, error: 'Only project/imported skills inside the current workspace can be deleted' };
    }

    await rm(skill.rootPath, { recursive: true, force: true });
    skills.delete(name);
    await loadAll();
    return { ok: true, name };
  }

  function getUsages() {
    return [...usages];
  }

  function clearUsages() {
    usages = [];
  }

  return {
    setWorkspaceRoot(nextRoot: string) {
      workspaceRoot = resolve(nextRoot);
    },
    loadAll,
    reload: loadAll,
    listSkills,
    listImplicitCandidates,
    getSkill,
    readSkill,
    activateSkill,
    deactivateSkill,
    setEnabled,
    deleteSkill,
    getUsages,
    clearUsages,
  };
}
