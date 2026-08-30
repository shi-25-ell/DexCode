/**
 * 命令白名单管理子页。
 */
import { showToast, fetchJson, escapeHtml } from './shared.js';

type WhitelistEntry = {
  id: string;
  pattern: string;
  matchType: 'exact' | 'prefix' | 'command';
  label?: string;
  addedAt: string;
};

const list = document.querySelector<HTMLElement>('#whitelistList')!;
const status = document.querySelector<HTMLElement>('#whitelistStatus')!;
const refreshBtn = document.querySelector<HTMLButtonElement>('#refreshWhitelistBtn')!;
const form = document.querySelector<HTMLFormElement>('#whitelistAddForm')!;
const patternInput = document.querySelector<HTMLInputElement>('#whitelistPatternInput')!;
const matchTypeSelect = document.querySelector<HTMLSelectElement>('#whitelistMatchTypeSelect')!;

let cache: WhitelistEntry[] = [];

const matchTypeLabel: Record<WhitelistEntry['matchType'], string> = {
  exact: '完全',
  prefix: '前缀',
  command: '命令名',
};

async function loadWhitelist() {
  try {
    const data = await fetchJson<{ entries?: WhitelistEntry[] }>('/api/command-whitelist');
    cache = data.entries ?? [];
    status.textContent = `${cache.length} 条规则`;
    renderEntries();
  } catch (error) {
    status.textContent = '加载失败';
    list.innerHTML = '<div class="version-empty">白名单加载失败</div>';
    showToast({ kind: 'error', title: '白名单加载失败', message: (error as Error).message });
  }
}

function renderEntries() {
  list.innerHTML = '';
  if (cache.length === 0) {
    list.innerHTML = '<div class="version-empty">暂无白名单,可在任务运行的命令确认弹窗中一键添加。</div>';
    return;
  }
  cache.forEach((entry) => {
    const card = document.createElement('div');
    card.className = 'whitelist-item';
    card.innerHTML = `
      <div class="whitelist-item-header">
        <code class="whitelist-pattern">${escapeHtml(entry.pattern)}</code>
        <span class="whitelist-match-type">${matchTypeLabel[entry.matchType] ?? entry.matchType}</span>
      </div>
      <div class="whitelist-item-meta">${escapeHtml(entry.label || entry.id)}</div>
      <button type="button" class="ghost-button whitelist-remove-btn" data-id="${escapeHtml(entry.id)}">删除</button>
    `;
    card.querySelector<HTMLButtonElement>('.whitelist-remove-btn')!.addEventListener('click', () => removeEntry(entry.id));
    list.appendChild(card);
  });
}

async function removeEntry(id: string) {
  try {
    await fetchJson(`/api/command-whitelist/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showToast({ kind: 'info', title: '已删除', message: '白名单规则已移除' });
    await loadWhitelist();
  } catch (error) {
    showToast({ kind: 'error', title: '删除失败', message: (error as Error).message });
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pattern = patternInput.value.trim();
  if (!pattern) {
    showToast({ kind: 'warn', title: '请输入命令', message: '至少输入一个 pattern' });
    return;
  }
  try {
    await fetchJson('/api/command-whitelist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern, matchType: matchTypeSelect.value }),
    });
    patternInput.value = '';
    showToast({ kind: 'info', title: '已添加', message: `白名单:${pattern}` });
    await loadWhitelist();
  } catch (error) {
    showToast({ kind: 'error', title: '添加失败', message: (error as Error).message });
  }
});

refreshBtn.addEventListener('click', loadWhitelist);

loadWhitelist();
