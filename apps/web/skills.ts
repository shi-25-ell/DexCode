/**
 * Skill 管理子页:列表 / 启用切换 / 删除项目级 Skill / 导入(预检查 + 确认)。
 */
import { showToast, fetchJson, escapeHtml, formatLocalTime } from './shared.js';

type SkillSource = 'builtin' | 'project' | 'user' | 'imported';

type SkillInfo = {
  name: string;
  description: string;
  source: SkillSource;
  rootPath: string;
  skillFilePath: string;
  enabled: boolean;
  allowImplicitInvocation: boolean;
  userInvocable: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  tags: string[];
  filePatterns: string[];
  requiredCapabilities: string[];
  optionalCapabilities: string[];
  missingCapabilities: string[];
  shadowed: boolean;
  usage: {
    readCount: number;
    activationCount: number;
    lastUsedAt: string | null;
  };
};

type SkillImportMode = 'local_path' | 'workspace_path' | 'inline_markdown';

type SkillImportReport = {
  recognized: boolean;
  format: string;
  name: string;
  description: string;
  targetPath: string;
  sourceMode: SkillImportMode;
  allowImplicitInvocation: boolean;
  requiredCapabilities: string[];
  missingCapabilities: string[];
  resources: string[];
  scripts: string[];
  warnings: string[];
  conflicts: string[];
};

const list = document.querySelector<HTMLElement>('#skillList')!;
const status = document.querySelector<HTMLElement>('#skillStatus')!;
const refreshBtn = document.querySelector<HTMLButtonElement>('#refreshSkillsBtn')!;
const importBtn = document.querySelector<HTMLButtonElement>('#importSkillBtn')!;
const overlay = document.querySelector<HTMLElement>('#skillImportOverlay')!;
const pathField = document.querySelector<HTMLElement>('#skillImportPathField')!;
const nameField = document.querySelector<HTMLElement>('#skillImportNameField')!;
const contentField = document.querySelector<HTMLElement>('#skillImportContentField')!;
const pathInput = document.querySelector<HTMLInputElement>('#skillImportPathInput')!;
const nameInput = document.querySelector<HTMLInputElement>('#skillImportNameInput')!;
const contentInput = document.querySelector<HTMLTextAreaElement>('#skillImportContentInput')!;
const reportEl = document.querySelector<HTMLElement>('#skillImportReport')!;
const previewBtn = document.querySelector<HTMLButtonElement>('#skillImportPreviewBtn')!;
const confirmBtn = document.querySelector<HTMLButtonElement>('#skillImportConfirmBtn')!;
const closeBtn = document.querySelector<HTMLButtonElement>('#skillImportCloseBtn')!;

let cache: SkillInfo[] = [];
let latestReport: SkillImportReport | null = null;

const sourceLabels: Record<SkillSource, string> = {
  builtin: '内置',
  project: '项目',
  user: '用户',
  imported: '导入',
};

async function loadSkills() {
  try {
    const data = await fetchJson<{ skills?: SkillInfo[] }>('/api/skills');
    cache = data.skills ?? [];
    const enabledCount = cache.filter((s) => s.enabled).length;
    status.textContent = `${enabledCount}/${cache.length} 已启用`;
    renderCards();
  } catch (error) {
    status.textContent = '加载失败';
    list.innerHTML = '<div class="version-empty">Skill 列表加载失败</div>';
    showToast({ kind: 'error', title: 'Skill 加载失败', message: (error as Error).message });
  }
}

function renderCards() {
  list.innerHTML = '';
  if (cache.length === 0) {
    list.innerHTML = '<div class="version-empty">暂无 Skill</div>';
    return;
  }
  cache.forEach((skill) => {
    const card = document.createElement('div');
    card.className = 'skill-item';
    const sourceClass = skill.source === 'builtin' ? 'local' : 'external';
    const missingText = skill.missingCapabilities.length > 0
      ? `缺失能力:${skill.missingCapabilities.join(', ')}`
      : '能力满足';

    card.innerHTML = `
      <div class="tool-item-header">
        <span class="tool-item-name">${escapeHtml(skill.name)}</span>
        <span class="tool-item-source ${sourceClass}">${sourceLabels[skill.source] ?? skill.source}</span>
      </div>
      <div class="tool-item-desc">${escapeHtml(skill.description)}</div>
      <div class="tool-item-stats">
        <span>读取 ${skill.usage.readCount} 次</span>
        <span>启用 ${skill.usage.activationCount} 次</span>
        <span>${skill.allowImplicitInvocation ? '允许隐式触发' : '仅显式触发'}</span>
      </div>
      <div class="skill-meta">最近使用:${escapeHtml(skill.usage.lastUsedAt ? formatLocalTime(skill.usage.lastUsedAt) : '从未使用')}</div>
      <div class="${skill.missingCapabilities.length > 0 ? 'skill-warning' : 'skill-ok'}">${escapeHtml(missingText)}</div>
      <div class="skill-actions">
        <div class="tool-toggle">
          <span>${skill.enabled ? '已启用' : '已禁用'}</span>
          <div class="tool-toggle-switch${skill.enabled ? ' on' : ''}"></div>
        </div>
      </div>
      <details class="skill-details">
        <summary>详情</summary>
        <div class="skill-detail-body">${escapeHtml([
          `路径规则:${skill.filePatterns.length ? skill.filePatterns.join(', ') : '无'}`,
          `标签:${skill.tags.length ? skill.tags.join(', ') : '无'}`,
          `Shadowed:${skill.shadowed ? '是' : '否'}`,
        ].join('\n'))}</div>
      </details>
    `;

    card.querySelector<HTMLElement>('.tool-toggle')!
      .addEventListener('click', () => toggleEnabled(skill.name, !skill.enabled));

    if (skill.source === 'project' || skill.source === 'imported') {
      const actions = card.querySelector<HTMLElement>('.skill-actions')!;
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'skill-delete-button';
      deleteBtn.textContent = '删除';
      deleteBtn.addEventListener('click', () => deleteSkill(skill));
      actions.appendChild(deleteBtn);
    }

    list.appendChild(card);
  });
}

async function toggleEnabled(skillName: string, enabled: boolean) {
  try {
    await fetchJson(`/api/skills/${encodeURIComponent(skillName)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const skill = cache.find((item) => item.name === skillName);
    if (skill) skill.enabled = enabled;
    const enabledCount = cache.filter((item) => item.enabled).length;
    status.textContent = `${enabledCount}/${cache.length} 已启用`;
    renderCards();
  } catch (error) {
    showToast({ kind: 'error', title: '操作失败', message: (error as Error).message });
  }
}

async function deleteSkill(skill: SkillInfo) {
  const confirmed = window.confirm(`确定删除 Skill "${skill.name}" 吗?此操作只允许删除项目/导入 Skill。`);
  if (!confirmed) return;
  try {
    await fetchJson(`/api/skills/${encodeURIComponent(skill.name)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootPath: skill.rootPath }),
    });
    showToast({ kind: 'info', title: 'Skill 已删除', message: skill.name });
    await loadSkills();
  } catch (error) {
    showToast({ kind: 'error', title: '删除失败', message: (error as Error).message });
  }
}

// ── 导入对话框 ──
function getMode(): SkillImportMode {
  const checked = document.querySelector<HTMLInputElement>('input[name="skillImportMode"]:checked');
  return (checked?.value as SkillImportMode | undefined) ?? 'local_path';
}

function buildPayload(confirm: boolean) {
  const mode = getMode();
  const payload: Record<string, unknown> = { mode, confirm };
  if (mode === 'inline_markdown') {
    payload.name = nameInput.value.trim();
    payload.content = contentInput.value;
  } else {
    payload.path = pathInput.value.trim();
  }
  return payload;
}

function renderForm() {
  const mode = getMode();
  pathField.style.display = mode === 'inline_markdown' ? 'none' : 'grid';
  nameField.style.display = mode === 'inline_markdown' ? 'grid' : 'none';
  contentField.style.display = mode === 'inline_markdown' ? 'grid' : 'none';
  pathInput.placeholder = mode === 'workspace_path' ? '.aicoding/skills/my-skill' : 'D:\\external-skills\\my-skill';
  latestReport = null;
  confirmBtn.disabled = true;
  reportEl.textContent = '尚未预检查';
}

function openDialog() {
  overlay.classList.add('visible');
  overlay.setAttribute('aria-hidden', 'false');
  renderForm();
}

function closeDialog() {
  overlay.classList.remove('visible');
  overlay.setAttribute('aria-hidden', 'true');
}

function renderReport(report: SkillImportReport) {
  reportEl.textContent = [
    `识别结果:${report.recognized ? '成功' : '失败'}`,
    `格式:${report.format}`,
    `名称:${report.name}`,
    `描述:${report.description}`,
    `目标位置:${report.targetPath}`,
    `允许隐式触发:${report.allowImplicitInvocation ? '是' : '否'}`,
    `需要能力:${report.requiredCapabilities.length ? report.requiredCapabilities.join(', ') : '无'}`,
    `缺失能力:${report.missingCapabilities.length ? report.missingCapabilities.join(', ') : '无'}`,
    `资源:${report.resources.length ? report.resources.join(', ') : '无'}`,
    `脚本:${report.scripts.length ? report.scripts.join(', ') : '无'}`,
    `风险提示:${report.warnings.length ? report.warnings.join('; ') : '无'}`,
    `冲突:${report.conflicts.length ? report.conflicts.join('; ') : '无'}`,
  ].join('\n');
}

async function previewImport() {
  previewBtn.disabled = true;
  reportEl.textContent = '正在预检查...';
  try {
    const data = await fetchJson<{ ok?: boolean; report?: SkillImportReport; error?: string }>(
      '/api/skills/import/preview',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(false)),
      },
    );
    if (!data.ok || !data.report) {
      latestReport = null;
      confirmBtn.disabled = true;
      reportEl.textContent = `预检查失败:${data.error ?? '未知错误'}`;
      return;
    }
    latestReport = data.report;
    renderReport(data.report);
    confirmBtn.disabled = data.report.conflicts.length > 0;
  } catch (error) {
    reportEl.textContent = `预检查失败:${(error as Error).message}`;
  } finally {
    previewBtn.disabled = false;
  }
}

async function confirmImport() {
  if (!latestReport) return;
  confirmBtn.disabled = true;
  try {
    await fetchJson('/api/skills/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(true)),
    });
    showToast({ kind: 'info', title: 'Skill 已导入', message: latestReport.name });
    closeDialog();
    await loadSkills();
  } catch (error) {
    showToast({ kind: 'error', title: '导入失败', message: (error as Error).message });
  } finally {
    confirmBtn.disabled = false;
  }
}

document.querySelectorAll<HTMLInputElement>('input[name="skillImportMode"]').forEach((input) => {
  input.addEventListener('change', renderForm);
});
importBtn.addEventListener('click', openDialog);
closeBtn.addEventListener('click', closeDialog);
previewBtn.addEventListener('click', previewImport);
confirmBtn.addEventListener('click', confirmImport);
refreshBtn.addEventListener('click', loadSkills);

loadSkills();
