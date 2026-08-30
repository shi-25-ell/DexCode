import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { inferCapabilities } from './capability.ts';
import { inferDescription, inferSkillName, parseSkillMarkdown } from './parser.ts';

export type SkillImportMode = 'local_path' | 'workspace_path' | 'inline_markdown';

export type SkillImportRequest = {
  mode?: SkillImportMode;
  path?: string;
  name?: string;
  content?: string;
  confirm?: boolean;
  overwrite?: boolean;
};

export type SkillImportReport = {
  recognized: boolean;
  format: string;
  name: string;
  description: string;
  sourceMode: SkillImportMode;
  targetPath: string;
  allowImplicitInvocation: boolean;
  userInvocable: boolean;
  requiredCapabilities: string[];
  optionalCapabilities: string[];
  missingCapabilities: string[];
  resources: string[];
  scripts: string[];
  warnings: string[];
  conflicts: string[];
};

export type SkillImportPreviewResult =
  | { ok: true; report: SkillImportReport; sourceRoot?: string; content?: string }
  | { ok: false; error: string };

function slugifySkillName(value: string): string {
  return value.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
}

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

async function listDirNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.flatMap((entry) => {
      if (typeof entry === 'string' || !entry.isDirectory()) return [];
      return [entry.name];
    });
  } catch {
    return [];
  }
}

async function listScriptFiles(path: string): Promise<string[]> {
  const scriptsDir = join(path, 'scripts');
  try {
    const entries = await readdir(scriptsDir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      if (typeof entry === 'string' || entry.isDirectory()) return [];
      return [`scripts/${entry.name}`];
    });
  } catch {
    return [];
  }
}

async function buildReport(options: {
  mode: SkillImportMode;
  workspaceRoot: string;
  skillFilePath: string;
  sourceRoot?: string;
  content: string;
  requestedName?: string;
  overwrite?: boolean;
}): Promise<SkillImportReport> {
  const parsed = parseSkillMarkdown(options.content);
  const inferredName = inferSkillName(options.skillFilePath, parsed.frontmatter.name || options.requestedName);
  const name = slugifySkillName(inferredName);
  const description = parsed.frontmatter.description || inferDescription(parsed.body);
  const allowImplicitInvocation = parsed.frontmatter.allowImplicitInvocation ?? !parsed.frontmatter.disableModelInvocation;
  const userInvocable = parsed.frontmatter.userInvocable ?? true;
  const capabilities = inferCapabilities(options.content, parsed.frontmatter.allowedTools ?? []);
  const targetPath = join('.aicoding', 'skills', name);
  const targetAbs = resolve(join(options.workspaceRoot, targetPath));
  const warnings: string[] = [];
  const conflicts: string[] = [];
  const sourceRoot = options.sourceRoot ?? dirname(options.skillFilePath);
  const resources = (await listDirNames(sourceRoot)).filter((item) => ['references', 'assets', 'templates'].includes(item));
  const scripts = await listScriptFiles(sourceRoot);

  if (scripts.length > 0) warnings.push('scripts will not be executed automatically');
  if (await pathExists(targetAbs) && !options.overwrite) conflicts.push(`target already exists: ${targetPath}`);

  return {
    recognized: true,
    format: 'SKILL.md',
    name,
    description,
    sourceMode: options.mode,
    targetPath,
    allowImplicitInvocation,
    userInvocable,
    ...capabilities,
    resources,
    scripts,
    warnings,
    conflicts,
  };
}

export async function previewSkillImport(workspaceRoot: string, request: SkillImportRequest): Promise<SkillImportPreviewResult> {
  const mode = request.mode;
  if (mode !== 'local_path' && mode !== 'workspace_path' && mode !== 'inline_markdown') {
    return { ok: false, error: 'Invalid import mode' };
  }

  const root = resolve(workspaceRoot);

  if (mode === 'inline_markdown') {
    const content = request.content ?? '';
    if (!content.trim()) return { ok: false, error: 'content is required' };
    const virtualName = slugifySkillName(request.name ?? parseSkillMarkdown(content).frontmatter.name ?? 'imported-skill');
    if (!virtualName) return { ok: false, error: 'name is required' };
    const skillFilePath = resolve(join(root, '.aicoding', 'skills', virtualName, 'SKILL.md'));
    const report = await buildReport({
      mode,
      workspaceRoot: root,
      skillFilePath,
      content,
      requestedName: virtualName,
      overwrite: request.overwrite,
    });
    return { ok: true, report, content };
  }

  if (!request.path?.trim()) return { ok: false, error: 'path is required' };

  const sourceRoot = mode === 'workspace_path'
    ? resolve(join(root, request.path))
    : resolve(request.path);

  if (mode === 'workspace_path' && !isInside(sourceRoot, root)) {
    return { ok: false, error: 'workspace path must stay inside the workspace' };
  }

  const skillFilePath = resolve(join(sourceRoot, 'SKILL.md'));
  if (!(await pathExists(skillFilePath))) {
    return { ok: false, error: 'SKILL.md not found' };
  }

  const content = await readFile(skillFilePath, 'utf8');
  const report = await buildReport({
    mode,
    workspaceRoot: root,
    skillFilePath,
    sourceRoot,
    content,
    requestedName: request.name,
    overwrite: request.overwrite,
  });
  return { ok: true, report, sourceRoot, content };
}

export async function importSkill(workspaceRoot: string, request: SkillImportRequest) {
  if (!request.confirm) return { ok: false, error: 'confirm is required' };
  const preview = await previewSkillImport(workspaceRoot, request);
  if (!preview.ok) return preview;
  if (preview.report.conflicts.length > 0 && !request.overwrite) {
    return { ok: false, error: preview.report.conflicts[0], report: preview.report };
  }

  const targetAbs = resolve(join(workspaceRoot, preview.report.targetPath));
  if (!isInside(targetAbs, resolve(join(workspaceRoot, '.aicoding', 'skills')))) {
    return { ok: false, error: 'target path is outside .aicoding/skills' };
  }

  await mkdir(dirname(targetAbs), { recursive: true });

  if (request.mode === 'inline_markdown') {
    await mkdir(targetAbs, { recursive: true });
    await writeFile(join(targetAbs, 'SKILL.md'), preview.content ?? '', 'utf8');
  } else {
    if (!preview.sourceRoot) return { ok: false, error: 'source root missing' };
    await cp(preview.sourceRoot, targetAbs, { recursive: true, force: !!request.overwrite });
  }

  return {
    ok: true,
    skill: preview.report.name,
    targetPath: preview.report.targetPath,
    report: preview.report,
  };
}
