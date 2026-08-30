/**
 * 版本快照管理子页:列表 / 创建 / 回滚。
 * 主页编辑器顶栏的"创建快照"按钮保留,任务前一键打保护点。
 */
import { showToast, fetchJson, escapeHtml, formatLocalTime } from './shared.js';
const list = document.querySelector('#versionList');
const status = document.querySelector('#versionStatus');
const refreshBtn = document.querySelector('#refreshVersionsBtn');
const createForm = document.querySelector('#snapshotCreateForm');
const nameInput = document.querySelector('#snapshotNameInput');
const descInput = document.querySelector('#snapshotDescInput');
let cache = [];
async function loadVersions() {
    try {
        const data = await fetchJson('/api/versions');
        cache = data.versions ?? [];
        renderVersions();
    }
    catch (error) {
        status.textContent = '加载失败';
        list.innerHTML = '<div class="version-empty">版本列表加载失败,请稍后重试。</div>';
        showToast({ kind: 'error', title: '快照加载失败', message: error.message });
    }
}
function renderVersions() {
    status.textContent = `${cache.length} 个版本`;
    list.innerHTML = '';
    if (cache.length === 0) {
        list.innerHTML = '<div class="version-empty">还没有快照。在上方创建一个快照后,就可以在这里查看和回滚版本。</div>';
        return;
    }
    cache.forEach((version) => {
        const item = document.createElement('article');
        item.className = 'version-item';
        item.innerHTML = `
      <div class="version-item-header">
        <div>
          <div class="version-item-title"></div>
          <div class="version-item-id"></div>
        </div>
      </div>
      <div class="version-item-description"></div>
      <div class="version-item-meta"></div>
      <div class="version-item-actions">
        <button type="button" class="version-restore-btn">回滚到此版本</button>
      </div>
    `;
        item.querySelector('.version-item-title').textContent = version.name;
        item.querySelector('.version-item-id').textContent = version.id;
        item.querySelector('.version-item-description').textContent = version.description || '无描述';
        item.querySelector('.version-item-meta').textContent = `创建时间:${formatLocalTime(version.createdAt)}`;
        item.querySelector('.version-restore-btn').addEventListener('click', () => restoreSnapshot(version));
        list.appendChild(item);
    });
}
createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = createForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = '创建中...';
    try {
        const data = await fetchJson('/api/version/snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: nameInput.value.trim(), description: descInput.value.trim() }),
        });
        cache = data.versions ?? cache;
        renderVersions();
        nameInput.value = '';
        descInput.value = '';
        showToast({ kind: 'info', title: '已创建快照', message: data.snapshot?.id ?? '快照已保存' });
    }
    catch (error) {
        showToast({ kind: 'error', title: '创建快照失败', message: error.message });
    }
    finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '创建快照';
    }
});
async function restoreSnapshot(version) {
    const ok = window.confirm(`确定回滚到 ${version.name || version.id} 吗?\n当前工作区会被覆盖。`);
    if (!ok)
        return;
    try {
        const data = await fetchJson('/api/version/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ snapshotId: version.id }),
        });
        cache = data.versions ?? cache;
        renderVersions();
        showToast({
            kind: 'info',
            title: '已回滚',
            message: `已回滚到快照 ${escapeHtml(version.id)},返回主界面查看最新文件。`,
            actionLabel: '返回主界面',
            onAction: () => { window.location.href = '/'; },
        });
    }
    catch (error) {
        showToast({ kind: 'error', title: '回滚失败', message: error.message });
    }
}
refreshBtn.addEventListener('click', loadVersions);
loadVersions();
//# sourceMappingURL=snapshots.js.map