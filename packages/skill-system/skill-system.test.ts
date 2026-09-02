import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSkillRegistry, importSkill, previewSkillImport } from './index.ts';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('imports a Skill into the global user directory and exposes it to every workspace', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dexcode-global-skill-'));
  const workspaceA = join(temporary, 'workspace-a');
  const workspaceB = join(temporary, 'workspace-b');
  const sourceRoot = join(temporary, 'source-skill');
  const userSkillsRoot = join(temporary, 'user', '.dexcode', 'skills');
  const configPath = join(temporary, 'skill-config.json');
  const skillContent = '---\nname: shared-skill\ndescription: Shared by every workspace.\n---\n\n# Shared Skill\n';

  try {
    await Promise.all([
      mkdir(workspaceA, { recursive: true }),
      mkdir(workspaceB, { recursive: true }),
      mkdir(sourceRoot, { recursive: true }),
    ]);
    await writeFile(join(sourceRoot, 'SKILL.md'), skillContent, 'utf8');

    const importOptions = { targetRoot: userSkillsRoot, targetLabel: '~/.dexcode/skills' };
    const preview = await previewSkillImport(workspaceA, { mode: 'local_path', path: sourceRoot }, importOptions);
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    assert.equal(preview.report.targetPath, '~/.dexcode/skills/shared-skill');

    const imported = await importSkill(workspaceA, { mode: 'local_path', path: sourceRoot, confirm: true }, importOptions);
    assert.equal(imported.ok, true);
    assert.equal(await readFile(join(userSkillsRoot, 'shared-skill', 'SKILL.md'), 'utf8'), skillContent);
    assert.equal(await exists(join(workspaceA, '.aicoding', 'skills', 'shared-skill')), false);

    const registryA = createSkillRegistry({ workspaceRoot: workspaceA, userSkillsRoot, configPath });
    const registryB = createSkillRegistry({ workspaceRoot: workspaceB, userSkillsRoot, configPath });
    await Promise.all([registryA.loadAll(), registryB.loadAll()]);
    assert.equal(registryA.getSkill('shared-skill')?.source, 'user');
    assert.equal(registryB.getSkill('shared-skill')?.source, 'user');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('deletes a managed global user Skill', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dexcode-delete-global-skill-'));
  const workspaceRoot = join(temporary, 'workspace');
  const userSkillsRoot = join(temporary, 'user', '.dexcode', 'skills');
  const skillRoot = join(userSkillsRoot, 'shared-skill');

  try {
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(skillRoot, { recursive: true }),
    ]);
    await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: shared-skill\ndescription: Shared skill.\n---\n', 'utf8');
    const registry = createSkillRegistry({
      workspaceRoot,
      userSkillsRoot,
      configPath: join(temporary, 'skill-config.json'),
    });
    await registry.loadAll();

    const result = await registry.deleteSkill('shared-skill', skillRoot);

    assert.deepEqual(result, { ok: true, name: 'shared-skill' });
    assert.equal(await exists(skillRoot), false);
    assert.equal(registry.getSkill('shared-skill'), null);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
