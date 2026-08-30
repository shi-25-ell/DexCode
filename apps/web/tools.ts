/**
 * 工具管理子页:列表 / 启用切换 / 测试 / 调用日志。
 */
import { showToast, fetchJson, escapeHtml, formatLocalTime } from './shared.js';

type ToolInfo = {
  name: string;
  description: string;
  source: 'local' | 'external';
  enabled: boolean;
  callCount: number;
  successCount: number;
  avgDurationMs: number;
  lastCalledAt: string | null;
};

type ToolLogEntry = {
  id: string;
  at: string;
  ok: boolean;
  durationMs: number;
  argsPreview: string;
  resultPreview: string;
};

const list = document.querySelector<HTMLElement>('#toolList')!;
const status = document.querySelector<HTMLElement>('#toolStatus')!;
const refreshBtn = document.querySelector<HTMLButtonElement>('#refreshToolsBtn')!;

let cache: ToolInfo[] = [];

const TEST_PRESETS: Record<string, string> = {
  read_file: '{\n  "path": "package.json"\n}',
  write_file: '{\n  "path": "test.txt",\n  "content": "hello"\n}',
  patch_file: '{\n  "path": "test.txt",\n  "patch": "hello\\n---\\nworld"\n}',
  search_in_workspace: '{\n  "query": "function"\n}',
  run_command: '{\n  "command": "npm test"\n}',
  read_lints: '{}',
  diff_file: '{\n  "path": "package.json"\n}',
  list_workspace: '{}',
  list_versions: '{}',
};

async function loadTools() {
  try {
    const data = await fetchJson<{ tools?: ToolInfo[] }>('/api/tools');
    cache = data.tools ?? [];
    status.textContent = `${cache.length} 个工具`;
    renderCards();
  } catch (error) {
    status.textContent = '加载失败';
    list.innerHTML = '<div class="version-empty">工具列表加载失败</div>';
    showToast({ kind: 'error', title: '工具列表加载失败', message: (error as Error).message });
  }
}

function renderCards() {
  list.innerHTML = '';
  if (cache.length === 0) {
    list.innerHTML = '<div class="version-empty">暂无工具</div>';
    return;
  }
  cache.forEach((tool) => {
    const card = document.createElement('div');
    card.className = 'tool-item';
    const successRate = tool.callCount > 0 ? Math.round((tool.successCount / tool.callCount) * 100) : 0;
    card.innerHTML = `
      <div class="tool-item-header">
        <span class="tool-item-name">${escapeHtml(tool.name)}</span>
        <span class="tool-item-source ${tool.source}">${tool.source === 'local' ? '内置' : '外部'}</span>
      </div>
      <div class="tool-item-desc">${escapeHtml(tool.description)}</div>
      <div class="tool-item-stats">
        <span>调用 ${tool.callCount} 次</span>
        <span>成功率 ${successRate}%</span>
        <span>平均 ${tool.avgDurationMs}ms</span>
      </div>
      <div class="tool-toggle" data-tool="${escapeHtml(tool.name)}">
        <span>${tool.enabled ? '已启用' : '已禁用'}</span>
        <div class="tool-toggle-switch${tool.enabled ? ' on' : ''}"></div>
      </div>
      <div class="tool-item-actions">
        ${tool.source === 'local' ? `<button type="button" class="ghost-button tool-test-btn">测试</button>` : ''}
        <button type="button" class="ghost-button tool-logs-btn">日志</button>
      </div>
    `;
    card.querySelector<HTMLElement>('.tool-toggle')!.addEventListener('click', () => toggleEnabled(tool.name, !tool.enabled));
    card.querySelector<HTMLButtonElement>('.tool-test-btn')?.addEventListener('click', () => openTestDialog(tool.name));
    card.querySelector<HTMLButtonElement>('.tool-logs-btn')?.addEventListener('click', () => openLogsDialog(tool.name));
    list.appendChild(card);
  });
}

async function toggleEnabled(toolName: string, enabled: boolean) {
  try {
    await fetchJson(`/api/tools/${encodeURIComponent(toolName)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const tool = cache.find((t) => t.name === toolName);
    if (tool) tool.enabled = enabled;
    renderCards();
  } catch (error) {
    showToast({ kind: 'error', title: '操作失败', message: (error as Error).message });
  }
}

function openTestDialog(toolName: string) {
  const preset = TEST_PRESETS[toolName] ?? '{}';
  const dialog = document.createElement('div');
  dialog.className = 'tree-dialog-overlay visible';
  dialog.setAttribute('aria-hidden', 'false');
  dialog.innerHTML = `
    <div class="tree-dialog tool-test-dialog">
      <h3>测试工具:${escapeHtml(toolName)}</h3>
      <label class="tool-test-label">参数 JSON</label>
      <textarea class="tool-test-args" rows="8"></textarea>
      <pre class="tool-test-result"></pre>
      <div class="tree-dialog-actions">
        <button type="button" data-role="cancel" class="ghost-button">关闭</button>
        <button type="button" data-role="run" class="confirm-submit-btn">运行</button>
      </div>
    </div>
  `;
  (dialog.querySelector('.tool-test-args') as HTMLTextAreaElement).value = preset;
  document.body.appendChild(dialog);
  const close = () => dialog.remove();
  dialog.querySelector('[data-role="cancel"]')!.addEventListener('click', close);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  dialog.querySelector('[data-role="run"]')!.addEventListener('click', async () => {
    const textarea = dialog.querySelector<HTMLTextAreaElement>('.tool-test-args')!;
    const resultEl = dialog.querySelector<HTMLElement>('.tool-test-result')!;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(textarea.value);
    } catch (err) {
      resultEl.textContent = `JSON 解析错误:${(err as Error).message}`;
      return;
    }
    resultEl.textContent = '运行中…';
    try {
      const data = await fetchJson(`/api/tools/${encodeURIComponent(toolName)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      resultEl.textContent = JSON.stringify(data, null, 2);
      void loadTools();
    } catch (err) {
      resultEl.textContent = `错误:${(err as Error).message}`;
    }
  });
}

async function openLogsDialog(toolName: string) {
  let logs: ToolLogEntry[] = [];
  try {
    const data = await fetchJson<{ logs?: ToolLogEntry[] }>(`/api/tools/${encodeURIComponent(toolName)}/logs?limit=20`);
    logs = data.logs ?? [];
  } catch (error) {
    showToast({ kind: 'error', title: '日志加载失败', message: (error as Error).message });
    return;
  }
  const dialog = document.createElement('div');
  dialog.className = 'tree-dialog-overlay visible';
  dialog.innerHTML = `
    <div class="tree-dialog tool-logs-dialog">
      <h3>${escapeHtml(toolName)} 调用日志</h3>
      <div class="tool-logs-list">${
        logs.length === 0
          ? '<p class="version-empty">暂无记录</p>'
          : logs.map((l) => `
              <div class="tool-log-entry ${l.ok ? 'ok' : 'fail'}">
                <div class="tool-log-meta">${escapeHtml(formatLocalTime(l.at))} · ${l.durationMs}ms · ${l.ok ? '成功' : '失败'}</div>
                <div class="tool-log-args">${escapeHtml(l.argsPreview)}</div>
                <div class="tool-log-result">${escapeHtml(l.resultPreview)}</div>
              </div>
            `).join('')
      }</div>
      <div class="tree-dialog-actions">
        <button type="button" class="ghost-button">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.querySelector('button')!.addEventListener('click', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });
}

refreshBtn.addEventListener('click', loadTools);

loadTools();
