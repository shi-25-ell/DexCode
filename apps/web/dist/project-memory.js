/**
 * 项目知识独立页:加载、编辑、保存 project-memory.md。
 * 主页保留"加入项目知识"按钮(基于刚跑完的任务,要主页上下文),这里只做基础 CRUD。
 */
import { showToast, fetchJson, formatLocalTime } from './shared.js';
const editor = document.querySelector('#projectMemoryEditor');
const status = document.querySelector('#projectMemoryStatus');
const reloadBtn = document.querySelector('#reloadProjectMemoryBtn');
const saveBtn = document.querySelector('#saveProjectMemoryBtn');
async function loadProjectMemory() {
    try {
        status.textContent = '加载中…';
        const data = await fetchJson('/api/project-memory');
        editor.value = data.content || data.template || '# 项目记忆\n';
        status.textContent = data.exists ? '已加载' : '使用默认模板';
    }
    catch (error) {
        status.textContent = '加载失败';
        showToast({ kind: 'error', title: '项目知识加载失败', message: error.message });
    }
}
async function saveProjectMemory() {
    try {
        status.textContent = '保存中…';
        saveBtn.disabled = true;
        const data = await fetchJson('/api/project-memory', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: editor.value }),
        });
        if (typeof data.content === 'string')
            editor.value = data.content;
        status.textContent = data.updatedAt ? `已保存 ${formatLocalTime(data.updatedAt)}` : '已保存';
        showToast({ kind: 'info', title: '项目知识已保存', message: '后续会话会按任务自动检索这份知识。' });
    }
    catch (error) {
        status.textContent = '保存失败';
        showToast({ kind: 'error', title: '项目知识保存失败', message: error.message });
    }
    finally {
        saveBtn.disabled = false;
    }
}
reloadBtn.addEventListener('click', loadProjectMemory);
saveBtn.addEventListener('click', saveProjectMemory);
loadProjectMemory();
//# sourceMappingURL=project-memory.js.map