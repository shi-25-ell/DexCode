"use strict";
const chatLog = document.querySelector('#chatLog');
const chatForm = document.querySelector('#chatForm');
const promptInput = document.querySelector('#promptInput');
const fileTree = document.querySelector('#fileTree');
const editor = document.querySelector('#editor');
const currentFile = document.querySelector('#currentFile');
const editorSaveBadge = document.querySelector('#editorSaveBadge');
const summary = document.querySelector('#summary');
const snapshotBtn = document.querySelector('#snapshotBtn');
const taskStatusSteps = document.querySelector('#taskStatusSteps');
const retryLastTaskBtn = document.querySelector('#retryLastTaskBtn');
const waitingUserPanel = document.querySelector('#waitingUserPanel');
const waitingUserQuestion = document.querySelector('#waitingUserQuestion');
const waitingUserActions = document.querySelector('#waitingUserActions');
const structuredSummary = document.querySelector('#structuredSummary');
const toggleRawSummaryBtn = document.querySelector('#toggleRawSummaryBtn');
const failurePanel = document.querySelector('#failurePanel');
const failureDetail = document.querySelector('#failureDetail');
const clearFailureBtn = document.querySelector('#clearFailureBtn');
const statusTimeline = document.querySelector('#statusTimeline');
const commandConfirmOverlay = document.querySelector('#commandConfirmOverlay');
const commandConfirmReason = document.querySelector('#commandConfirmReason');
const commandConfirmRisk = document.querySelector('#commandConfirmRisk');
const commandConfirmCwd = document.querySelector('#commandConfirmCwd');
const commandConfirmText = document.querySelector('#commandConfirmText');
const commandConfirmDenyBtn = document.querySelector('#commandConfirmDenyBtn');
const commandConfirmOnceBtn = document.querySelector('#commandConfirmOnceBtn');
const commandConfirmWhitelistBtn = document.querySelector('#commandConfirmWhitelistBtn');
const refreshBtn = document.querySelector('#refreshBtn');
const workspaceLayout = document.querySelector('#workspaceLayout');
const newItemBtn = document.querySelector('#newItemBtn');
const newItemMenu = document.querySelector('#newItemMenu');
const sessionBadge = document.querySelector('#sessionBadge');
const sessionDropdown = document.querySelector('#sessionDropdown');
const agentStatusBadge = document.querySelector('#agentStatusBadge');
const newSessionBtn = document.querySelector('#newSessionBtn');
const workspacePathInput = document.querySelector('#workspacePathInput');
const workspaceSuggestList = document.querySelector('#workspaceSuggestList');
const loadWorkspaceBtn = document.querySelector('#loadWorkspaceBtn');
const appendLastTaskMemoryBtn = document.querySelector('#appendLastTaskMemoryBtn');
let selectedFile = null;
let currentFileContent = '';
let workspaceCache = [];
let currentAutoRefreshTimer = null;
let editorSaveTimer = null;
let expandedFolders = new Set();
let currentSessionId = null;
let agentStatus = 'idle';
let saveState = 'idle';
let lastSaveError = null;
let lastUserPrompt = null;
let lastTaskPhase = 'idle';
let lastTaskPhaseUpdatedAt = 0;
let lastConfirmRequest = null;
let lastCommandConfirmRequest = null;
let showRawSummary = false;
let lastFailureText = null;
let statusHistory = [];
let lastRunCommandDetail = null;
let shouldScrollTreeToActive = false;
let lastProjectMemoryEntry = null;
const layoutState = {
    chat: 34,
    editor: 40,
    tree: 26,
};
const layoutLimits = {
    chat: { min: 22, max: 55 },
    editor: { min: 30, max: 60 },
    tree: { min: 18, max: 40 },
};
function loadLayoutState() {
    try {
        const stored = localStorage.getItem('layoutState');
        if (!stored)
            return;
        const parsed = JSON.parse(stored);
        Object.assign(layoutState, parsed);
    }
    catch {
        // ignore
    }
}
function persistLayoutState() {
    localStorage.setItem('layoutState', JSON.stringify(layoutState));
}
function applyLayoutWidths() {
    workspaceLayout.style.gridTemplateColumns = `${layoutState.chat}% 2px ${layoutState.editor}% 2px ${layoutState.tree}%`;
}
function clampLayoutState() {
    const total = layoutState.chat + layoutState.editor + layoutState.tree;
    const normalized = total === 100 ? layoutState : {
        chat: (layoutState.chat / total) * 100,
        editor: (layoutState.editor / total) * 100,
        tree: (layoutState.tree / total) * 100,
    };
    layoutState.chat = normalized.chat;
    layoutState.editor = normalized.editor;
    layoutState.tree = normalized.tree;
}
function adjustLayout(delta, leftPanel, rightPanel) {
    const totalWidth = workspaceLayout.getBoundingClientRect().width;
    if (!totalWidth)
        return;
    const deltaPercent = (delta / totalWidth) * 100;
    const nextLeft = layoutState[leftPanel] + deltaPercent;
    const nextRight = layoutState[rightPanel] - deltaPercent;
    const leftLimits = layoutLimits[leftPanel];
    const rightLimits = layoutLimits[rightPanel];
    if (nextLeft < leftLimits.min || nextLeft > leftLimits.max)
        return;
    if (nextRight < rightLimits.min || nextRight > rightLimits.max)
        return;
    layoutState[leftPanel] = nextLeft;
    layoutState[rightPanel] = nextRight;
    clampLayoutState();
    applyLayoutWidths();
    persistLayoutState();
}
function initResizers() {
    const resizers = document.querySelectorAll('.panel-resizer');
    resizers.forEach((resizer) => {
        const kind = resizer.dataset.resizer;
        let active = false;
        let startX = 0;
        const onMove = (event) => {
            if (!active)
                return;
            const delta = event.clientX - startX;
            startX = event.clientX;
            if (kind === 'chat-editor') {
                adjustLayout(delta, 'chat', 'editor');
            }
            else if (kind === 'editor-tree') {
                adjustLayout(delta, 'editor', 'tree');
            }
        };
        const stop = () => {
            if (!active)
                return;
            active = false;
            resizer.classList.remove('active');
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', stop);
        };
        resizer.addEventListener('mousedown', (event) => {
            event.preventDefault();
            active = true;
            startX = event.clientX;
            resizer.classList.add('active');
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', stop);
        });
    });
}
function loadExpandedFolders() {
    try {
        const stored = localStorage.getItem('expandedFolders');
        if (!stored)
            return;
        expandedFolders = new Set(JSON.parse(stored));
    }
    catch {
        expandedFolders = new Set();
    }
}
function persistExpandedFolders() {
    localStorage.setItem('expandedFolders', JSON.stringify([...expandedFolders]));
}
function toastHost() {
    const host = document.querySelector('#toastHost');
    if (!host)
        throw new Error('toastHost not found');
    return host;
}
function showToast(opts) {
    const host = toastHost();
    const node = document.createElement('div');
    node.className = `toast ${opts.kind}`;
    node.innerHTML = `
    <div>
      <p class="toast-title"></p>
      <p class="toast-msg"></p>
    </div>
    <div class="toast-actions">
      ${opts.actionLabel ? `<button type="button" class="ghost-button toast-action"></button>` : ''}
      <button type="button" class="toast-close" aria-label="关闭">关闭</button>
    </div>
  `;
    node.querySelector('.toast-title').textContent = opts.title;
    node.querySelector('.toast-msg').textContent = opts.message;
    const close = () => node.remove();
    node.querySelector('.toast-close').addEventListener('click', close);
    const actionBtn = node.querySelector('.toast-action');
    if (actionBtn && opts.actionLabel) {
        actionBtn.textContent = opts.actionLabel;
        actionBtn.addEventListener('click', () => {
            try {
                opts.onAction?.();
            }
            finally {
                close();
            }
        });
    }
    host.appendChild(node);
    const timeout = opts.timeoutMs ?? (opts.kind === 'error' ? 8000 : 4500);
    window.setTimeout(() => {
        if (node.isConnected)
            close();
    }, timeout);
}
function setSaveState(next, detail) {
    saveState = next;
    editorSaveBadge.dataset.state = next;
    const labels = {
        idle: '未打开',
        saved: '已保存',
        dirty: '未保存',
        saving: '保存中…',
        error: '保存失败',
    };
    editorSaveBadge.textContent = labels[next];
    if (next === 'idle') {
        editorSaveBadge.title = '未打开文件';
        lastSaveError = null;
    }
    else if (next === 'error') {
        lastSaveError = detail ?? lastSaveError ?? '未知错误';
        editorSaveBadge.title = lastSaveError;
    }
    else {
        editorSaveBadge.title = detail ?? editorSaveBadge.textContent ?? '';
        lastSaveError = null;
    }
}
const TASK_PHASES = [
    { key: 'planning', label: '规划' },
    { key: 'context_loading', label: '加载上下文' },
    { key: 'editing', label: '修改文件' },
    { key: 'validating', label: '验证' },
    { key: 'waiting_user', label: '等待确认' },
    { key: 'succeeded', label: '完成' },
];
function setTaskPhase(phase, detail) {
    lastTaskPhase = phase;
    lastTaskPhaseUpdatedAt = Date.now();
    renderTaskStatusSteps(detail);
    renderWaitingUserPanel();
    pushStatusHistory(phase, detail);
    renderFailurePanel();
    renderTimeline();
}
function renderTaskStatusSteps(detail) {
    const phaseIndex = TASK_PHASES.findIndex((p) => p.key === lastTaskPhase);
    taskStatusSteps.innerHTML = '';
    TASK_PHASES.forEach((p, idx) => {
        const pill = document.createElement('span');
        pill.className = 'step-pill';
        pill.textContent = p.label;
        if (lastTaskPhase === 'failed') {
            if (idx === 0)
                pill.classList.add('error');
        }
        else if (phaseIndex >= 0) {
            if (idx < phaseIndex)
                pill.classList.add('done');
            if (idx === phaseIndex)
                pill.classList.add('active');
        }
        taskStatusSteps.appendChild(pill);
    });
    retryLastTaskBtn.disabled = !lastUserPrompt || agentStatus !== 'idle';
    retryLastTaskBtn.title = lastUserPrompt ? `重试：${lastUserPrompt}` : '暂无可重试任务';
    if (detail) {
        retryLastTaskBtn.title = `${retryLastTaskBtn.title}\n${detail}`;
    }
}
function pushStatusHistory(phase, detail) {
    statusHistory.push({ at: Date.now(), phase, detail });
    if (statusHistory.length > 20)
        statusHistory = statusHistory.slice(-20);
}
function formatTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}
function formatVersionTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return value;
    return date.toLocaleString('zh-CN', { hour12: false });
}
function renderTimeline() {
    statusTimeline.innerHTML = '';
    if (statusHistory.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'timeline-item';
        empty.innerHTML = `<div class="timeline-time">--:--:--</div><div class="timeline-msg">暂无状态记录</div>`;
        statusTimeline.appendChild(empty);
        return;
    }
    for (const item of statusHistory.slice().reverse()) {
        const row = document.createElement('div');
        row.className = 'timeline-item';
        const detail = item.detail ? `\n${item.detail}` : '';
        row.innerHTML = `<div class="timeline-time">${formatTime(item.at)}</div><div class="timeline-msg">${item.phase}${detail}</div>`;
        statusTimeline.appendChild(row);
    }
}
function renderFailurePanel() {
    const visible = !!lastFailureText;
    failurePanel.classList.toggle('hidden', !visible);
    if (!visible) {
        failureDetail.textContent = '';
        return;
    }
    failureDetail.textContent = lastFailureText;
}
function renderWaitingUserPanel() {
    const visible = lastTaskPhase === 'waiting_user' && !!lastConfirmRequest;
    waitingUserPanel.classList.toggle('hidden', !visible);
    if (!visible) {
        waitingUserQuestion.textContent = '';
        waitingUserActions.innerHTML = '';
        return;
    }
    waitingUserQuestion.textContent = lastConfirmRequest.question;
    waitingUserActions.innerHTML = '';
    const confirmId = lastConfirmRequest.confirmId;
    const options = lastConfirmRequest.options ?? [];
    const submit = async (answer) => {
        const trimmed = answer.trim();
        if (!trimmed) {
            showToast({ kind: 'warn', title: '请输入确认内容', message: '回答不能为空。' });
            return;
        }
        try {
            await fetch('/api/agent/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirmId, answer: trimmed }),
            });
            showToast({ kind: 'info', title: '已提交确认', message: trimmed });
            lastConfirmRequest = null;
            if (agentStatus === 'waiting_confirm')
                setAgentStatus('running');
            setTaskPhase('planning', '已提交确认，等待继续执行');
        }
        catch (err) {
            showToast({ kind: 'error', title: '提交确认失败', message: err.message });
        }
    };
    if (options.length > 0) {
        options.forEach((opt) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'confirm-option-btn';
            btn.textContent = opt;
            btn.addEventListener('click', () => submit(opt));
            waitingUserActions.appendChild(btn);
        });
        return;
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '输入你的确认/补充信息…';
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submit(input.value);
        }
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'confirm-submit-btn';
    btn.textContent = '提交';
    btn.addEventListener('click', () => submit(input.value));
    waitingUserActions.appendChild(input);
    waitingUserActions.appendChild(btn);
}
function normalizeToolResults(result) {
    if (!result)
        return [];
    const raw = result.toolResults ?? result.data?.toolResults ?? [];
    return raw.map((item) => ({
        name: item.name,
        ok: item.result?.ok,
        file: item.result?.file,
    }));
}
function buildProjectMemoryEntry(result, changedFiles) {
    if (!result)
        return null;
    const prompt = result.prompt?.trim() || lastUserPrompt?.trim();
    const summaryText = result.summary?.trim() || result.output?.trim();
    if (!prompt && !summaryText && changedFiles.length === 0)
        return null;
    const parts = [
        prompt ? `任务：${prompt}` : '',
        summaryText ? `经验：${summaryText.replace(/\s+/g, ' ').slice(0, 260)}` : '',
        changedFiles.length > 0 ? `相关文件：${changedFiles.slice(0, 5).join('、')}` : '',
        result.toolsUsed?.length ? `工具：${[...new Set(result.toolsUsed)].slice(0, 5).join('、')}` : '',
    ].filter(Boolean);
    return parts.join('；');
}
function renderStructuredSummary(result) {
    const toolResults = normalizeToolResults(result);
    const changedFiles = new Set();
    for (const t of toolResults) {
        const file = t.file;
        if (file?.path)
            changedFiles.add(file.path);
    }
    (result?.changedFiles ?? []).forEach((p) => changedFiles.add(p));
    const writeOk = toolResults.some((t) => t.name === 'write_file' && t.ok);
    const commandOk = toolResults.some((t) => t.name === 'run_command' && t.ok);
    const hasErrors = lastTaskPhase === 'failed';
    structuredSummary.innerHTML = '';
    const mkRow = (key, valueNode) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'structured-row';
        const k = document.createElement('div');
        k.className = 'structured-key';
        k.textContent = key;
        wrapper.appendChild(k);
        wrapper.appendChild(valueNode);
        structuredSummary.appendChild(wrapper);
    };
    const mkValue = (text) => {
        const div = document.createElement('div');
        div.className = 'structured-value';
        div.textContent = text;
        return div;
    };
    const mkFileLinks = (paths) => {
        const outer = document.createElement('div');
        outer.className = 'structured-value';
        paths.forEach((p) => {
            const a = document.createElement('a');
            a.className = 'file-link';
            a.textContent = p;
            a.href = '#';
            a.addEventListener('click', (e) => {
                e.preventDefault();
                openFile(p);
            });
            outer.appendChild(a);
            outer.appendChild(document.createElement('br'));
        });
        return outer;
    };
    const mkTags = (items) => {
        const list = document.createElement('div');
        list.className = 'structured-list';
        items.forEach((it) => {
            const tag = document.createElement('span');
            tag.className = `tag${it.kind ? ` ${it.kind}` : ''}`;
            tag.textContent = it.text;
            list.appendChild(tag);
        });
        const outer = document.createElement('div');
        outer.className = 'structured-value';
        outer.appendChild(list);
        return outer;
    };
    if (!result) {
        mkRow('状态', mkValue('暂无摘要（等待任务运行）。'));
        lastProjectMemoryEntry = null;
        appendLastTaskMemoryBtn.disabled = true;
        return;
    }
    mkRow('当前阶段', mkValue(lastTaskPhase));
    mkRow('结果概览', mkTags([
        { text: writeOk ? '文件已写入' : '未写入文件', kind: writeOk ? 'ok' : 'warn' },
        { text: commandOk ? '命令已执行' : '未执行命令', kind: commandOk ? 'ok' : 'warn' },
        { text: hasErrors ? '存在错误' : '无错误', kind: hasErrors ? 'err' : 'ok' },
    ]));
    if (changedFiles.size > 0) {
        mkRow('变更文件', mkFileLinks([...changedFiles]));
    }
    if (lastRunCommandDetail) {
        mkRow('验证/命令输出', mkValue(lastRunCommandDetail));
    }
    if (typeof result.summary === 'string' && result.summary.trim()) {
        mkRow('摘要', mkValue(result.summary.trim()));
    }
    else if (typeof result.output === 'string' && result.output.trim()) {
        mkRow('输出', mkValue(result.output.trim()));
    }
    if (toolResults.length > 0) {
        const brief = toolResults
            .map((t) => `${t.name}${t.ok === undefined ? '' : t.ok ? ' ✅' : ' ❌'}`)
            .join(' / ');
        mkRow('工具调用', mkValue(brief));
    }
    lastProjectMemoryEntry = buildProjectMemoryEntry(result, [...changedFiles]);
    appendLastTaskMemoryBtn.disabled = !lastProjectMemoryEntry;
}
// ── 工作区历史记录 ──
const WORKSPACE_HISTORY_KEY = 'workspaceHistory';
const WORKSPACE_HISTORY_MAX = 10;
function loadWorkspaceHistory() {
    try {
        return JSON.parse(localStorage.getItem(WORKSPACE_HISTORY_KEY) ?? '[]');
    }
    catch {
        return [];
    }
}
function saveWorkspaceHistory(path) {
    const history = loadWorkspaceHistory().filter((p) => p !== path);
    history.unshift(path);
    localStorage.setItem(WORKSPACE_HISTORY_KEY, JSON.stringify(history.slice(0, WORKSPACE_HISTORY_MAX)));
}
// ── 路径补全 ──
let suggestDebounceTimer = null;
function hideSuggestList() {
    workspaceSuggestList.classList.remove('visible');
    workspaceSuggestList.innerHTML = '';
}
function renderSuggestItems(items) {
    if (items.length === 0) {
        hideSuggestList();
        return;
    }
    workspaceSuggestList.innerHTML = '';
    items.forEach(({ path, isHistory }) => {
        const li = document.createElement('li');
        li.textContent = path;
        if (isHistory)
            li.classList.add('history-item');
        li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            workspacePathInput.value = path;
            hideSuggestList();
            fetchSuggestions(path).then((suggestions) => {
                const items = suggestions.map((p) => ({ path: p, isHistory: false }));
                renderSuggestItems(items);
            });
        });
        workspaceSuggestList.appendChild(li);
    });
    workspaceSuggestList.classList.add('visible');
}
async function fetchSuggestions(prefix) {
    try {
        const res = await fetch(`/api/fs/suggest?prefix=${encodeURIComponent(prefix)}`);
        const data = await res.json();
        return data.suggestions ?? [];
    }
    catch {
        showToast({ kind: 'warn', title: '路径补全失败', message: '无法获取路径建议，请检查后端是否运行。' });
        return [];
    }
}
workspacePathInput.addEventListener('input', () => {
    if (suggestDebounceTimer)
        clearTimeout(suggestDebounceTimer);
    suggestDebounceTimer = setTimeout(async () => {
        const prefix = workspacePathInput.value.trim();
        if (!prefix) {
            hideSuggestList();
            return;
        }
        const [fsSuggestions, history] = await Promise.all([
            fetchSuggestions(prefix),
            Promise.resolve(loadWorkspaceHistory().filter((h) => h.startsWith(prefix))),
        ]);
        const seen = new Set();
        const items = [];
        for (const p of fsSuggestions) {
            if (!seen.has(p)) {
                seen.add(p);
                items.push({ path: p, isHistory: false });
            }
        }
        for (const p of history) {
            if (!seen.has(p)) {
                seen.add(p);
                items.push({ path: p, isHistory: true });
            }
        }
        renderSuggestItems(items);
    }, 200);
});
workspacePathInput.addEventListener('focus', () => {
    if (workspacePathInput.value.trim())
        return;
    const history = loadWorkspaceHistory();
    renderSuggestItems(history.map((p) => ({ path: p, isHistory: true })));
});
workspacePathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape')
        hideSuggestList();
    if (e.key === 'Tab') {
        const first = workspaceSuggestList.querySelector('li');
        if (first) {
            e.preventDefault();
            const path = first.textContent ?? '';
            workspacePathInput.value = path;
            hideSuggestList();
            fetchSuggestions(path).then((suggestions) => {
                renderSuggestItems(suggestions.map((p) => ({ path: p, isHistory: false })));
            });
        }
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        loadWorkspaceBtn.click();
    }
});
// ── 加载工作区 ──
function setWorkspaceError(msg) {
    if (msg) {
        workspacePathInput.classList.add('error');
        workspacePathInput.title = msg;
    }
    else {
        workspacePathInput.classList.remove('error');
        workspacePathInput.title = '';
    }
}
loadWorkspaceBtn.addEventListener('click', async () => {
    const path = workspacePathInput.value.trim();
    if (!path)
        return;
    hideSuggestList();
    loadWorkspaceBtn.disabled = true;
    loadWorkspaceBtn.textContent = '加载中…';
    setWorkspaceError(null);
    try {
        const res = await fetch('/api/workspace/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
        });
        const data = await res.json();
        if (!data.ok) {
            setWorkspaceError(data.error ?? '加载失败');
            showToast({ kind: 'error', title: '加载工作区失败', message: data.error ?? '未知错误' });
            return;
        }
        saveWorkspaceHistory(path);
        workspaceCache = data.tree ?? [];
        renderTree(workspaceCache);
        if (data.sessionId) {
            currentSessionId = data.sessionId;
            const shortId = data.sessionId.replace('session-', '').slice(-6);
            sessionBadge.textContent = `会话 #${shortId}`;
        }
        chatLog.innerHTML = '';
        selectedFile = null;
        currentFile.textContent = '未打开文件';
        editor.value = '';
        currentFileContent = '';
        appendMessage('agent', `已加载工作区：${path}`);
        showToast({ kind: 'info', title: '工作区已加载', message: path });
    }
    catch (err) {
        setWorkspaceError(`请求失败：${err.message}`);
        showToast({ kind: 'error', title: '加载工作区失败', message: err.message });
    }
    finally {
        loadWorkspaceBtn.disabled = false;
        loadWorkspaceBtn.textContent = '加载';
    }
});
function setAgentStatus(status) {
    agentStatus = status;
    agentStatusBadge.dataset.status = status;
    const labels = {
        idle: '空闲',
        running: '运行中',
        waiting_confirm: '等待确认',
    };
    agentStatusBadge.textContent = labels[status];
    const submitBtn = chatForm.querySelector('button[type="submit"]');
    submitBtn.disabled = status !== 'idle';
    promptInput.disabled = status !== 'idle';
    renderTaskStatusSteps();
}
function renderMarkdown(text) {
    return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>[^\0]*?<\/li>(\n|$))+/g, (m) => `<ul>${m}</ul>`)
        .replace(/\n/g, '<br>');
}
const TOOL_COLORS = {
    write_file: 'var(--accent-2)',
    read_file: 'var(--muted)',
    patch_file: '#a78bfa',
    search_in_workspace: '#94a3b8',
    run_command: '#f59e0b',
    read_lints: '#34d399',
    diff_file: '#38bdf8',
    ask_user: '#facc15',
    list_workspace: 'var(--muted)',
};
const skillCallCards = new Map();
function formatToolDetailForChat(toolName, rawDetail) {
    if (toolName !== 'diff_file')
        return rawDetail;
    try {
        const data = JSON.parse(rawDetail);
        const lines = [
            `文件：${data.path ?? '?'}`,
            `对比快照：${data.snapshotName ?? '最新'}`,
            `变更：+${data.stats?.added ?? 0} / -${data.stats?.removed ?? 0}`,
            '',
        ];
        for (const h of (data.hunks ?? []).slice(0, 80)) {
            const prefix = h.type === 'add' ? '+' : h.type === 'remove' ? '-' : ' ';
            const no = h.newLineNo ?? h.oldLineNo ?? '';
            lines.push(`${prefix} ${String(no).padStart(4)} | ${h.line}`);
        }
        if ((data.hunks?.length ?? 0) > 80)
            lines.push('…（仅显示前 80 行）');
        return lines.join('\n');
    }
    catch {
        return rawDetail;
    }
}
function appendMessage(role, text) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.innerHTML = renderMarkdown(text);
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    return div;
}
function appendSkillEvent(event) {
    if (event.action === 'listed')
        return;
    let node = skillCallCards.get(event.skill);
    if (!node) {
        node = document.createElement('div');
        node.className = 'skill-call';
        const header = document.createElement('div');
        header.className = 'skill-call-header';
        const badge = document.createElement('span');
        badge.className = 'skill-call-badge';
        badge.textContent = 'Skill';
        const title = document.createElement('span');
        title.className = 'skill-call-title';
        title.textContent = `${event.action === 'read' ? '加载' : '启用'} Skill：${event.skill}`;
        const detail = document.createElement('div');
        detail.className = 'skill-call-reason';
        detail.textContent = event.summary || '已处理该 Skill。';
        header.appendChild(badge);
        header.appendChild(title);
        node.appendChild(header);
        node.appendChild(detail);
        skillCallCards.set(event.skill, node);
        chatLog.appendChild(node);
    }
    const detail = node.querySelector('.skill-call-reason');
    if (detail) {
        detail.textContent = event.reason || event.summary || '已处理该 Skill。';
    }
    chatLog.scrollTop = chatLog.scrollHeight;
}
function renderConfirmCard(event) {
    const card = document.createElement('div');
    card.className = 'confirm-card';
    card.dataset.confirmId = event.confirmId;
    const questionEl = document.createElement('p');
    questionEl.className = 'confirm-question';
    questionEl.textContent = event.question;
    card.appendChild(questionEl);
    const actionsEl = document.createElement('div');
    actionsEl.className = 'confirm-actions';
    if (event.options && event.options.length > 0) {
        event.options.forEach((opt) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'confirm-option-btn';
            btn.textContent = opt;
            btn.addEventListener('click', () => submitConfirm(event.confirmId, opt, card));
            actionsEl.appendChild(btn);
        });
    }
    else {
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '输入回答…';
        input.className = 'confirm-input';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'confirm-submit-btn';
        btn.textContent = '提交';
        btn.addEventListener('click', () => submitConfirm(event.confirmId, input.value, card));
        actionsEl.appendChild(input);
        actionsEl.appendChild(btn);
    }
    card.appendChild(actionsEl);
    chatLog.appendChild(card);
    chatLog.scrollTop = chatLog.scrollHeight;
}
async function submitConfirm(confirmId, answer, card) {
    try {
        await fetch('/api/agent/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmId, answer }),
        });
        card.classList.add('confirm-resolved');
        const actionsEl = card.querySelector('.confirm-actions');
        if (actionsEl) {
            actionsEl.innerHTML = `<span class="confirm-answer">已回答：${answer}</span>`;
        }
        if (lastConfirmRequest?.confirmId === confirmId) {
            lastConfirmRequest = null;
            renderWaitingUserPanel();
        }
    }
    catch {
        appendMessage('agent', `提交确认失败`);
    }
}
function isFolder(node) {
    return node.type === 'folder';
}
function ensureContextMenu() {
    let menu = document.querySelector('#treeContextMenu');
    if (menu)
        return menu;
    menu = document.createElement('div');
    menu.id = 'treeContextMenu';
    menu.className = 'tree-context-menu';
    menu.innerHTML = `
    <button type="button" data-action="new-file">新建文件</button>
    <button type="button" data-action="new-folder">新建文件夹</button>
    <button type="button" data-action="rename">重命名</button>
    <button type="button" data-action="delete">删除</button>
  `;
    document.body.appendChild(menu);
    return menu;
}
function hideContextMenu() {
    const menu = document.querySelector('#treeContextMenu');
    if (menu)
        menu.classList.remove('visible');
}
function hideNewItemMenu() {
    if (newItemMenu) {
        newItemMenu.classList.remove('visible');
        newItemMenu.setAttribute('aria-hidden', 'true');
    }
}
function toggleNewItemMenu() {
    if (!newItemMenu)
        return;
    const visible = newItemMenu.classList.contains('visible');
    if (visible) {
        hideNewItemMenu();
    }
    else {
        newItemMenu.classList.add('visible');
        newItemMenu.setAttribute('aria-hidden', 'false');
    }
}
function showConfirmDialog({ title, message, confirmLabel = '确认', danger = false }) {
    return new Promise((resolve) => {
        let dialog = document.querySelector('#treeConfirmDialog');
        if (!dialog) {
            dialog = document.createElement('div');
            dialog.id = 'treeConfirmDialog';
            dialog.className = 'tree-dialog-overlay';
            dialog.innerHTML = `
        <div class="tree-dialog">
          <h3 data-role="title"></h3>
          <p data-role="message"></p>
          <div class="tree-dialog-actions">
            <button type="button" data-role="cancel">取消</button>
            <button type="button" data-role="confirm"></button>
          </div>
        </div>
      `;
            document.body.appendChild(dialog);
        }
        dialog.querySelector('[data-role="title"]').textContent = title;
        dialog.querySelector('[data-role="message"]').textContent = message;
        const confirmBtn = dialog.querySelector('[data-role="confirm"]');
        confirmBtn.textContent = confirmLabel;
        confirmBtn.classList.toggle('danger', danger);
        const cleanup = () => {
            dialog.classList.remove('visible');
            confirmBtn.onclick = null;
            dialog.querySelector('[data-role="cancel"]').onclick = null;
        };
        dialog.classList.add('visible');
        dialog.querySelector('[data-role="cancel"]').onclick = () => {
            cleanup();
            resolve(false);
        };
        confirmBtn.onclick = () => {
            cleanup();
            resolve(true);
        };
    });
}
function showSnapshotDialog() {
    return new Promise((resolve) => {
        let dialog = document.querySelector('#snapshotDialog');
        if (!dialog) {
            dialog = document.createElement('div');
            dialog.id = 'snapshotDialog';
            dialog.className = 'tree-dialog-overlay';
            dialog.innerHTML = `
        <div class="tree-dialog">
          <h3>创建快照</h3>
          <p>为当前工作区保存一个可回滚版本。</p>
          <input data-role="name" type="text" placeholder="快照名称（可选）" />
          <textarea data-role="description" rows="4" placeholder="快照描述（可选）"></textarea>
          <div class="tree-dialog-actions">
            <button type="button" data-role="cancel">取消</button>
            <button type="button" data-role="confirm">创建</button>
          </div>
        </div>
      `;
            document.body.appendChild(dialog);
        }
        const nameInput = dialog.querySelector('[data-role="name"]');
        const descriptionInput = dialog.querySelector('[data-role="description"]');
        nameInput.value = '';
        descriptionInput.value = '';
        dialog.classList.add('visible');
        nameInput.focus();
        const cleanup = () => dialog.classList.remove('visible');
        dialog.querySelector('[data-role="cancel"]').onclick = () => {
            cleanup();
            resolve(null);
        };
        dialog.querySelector('[data-role="confirm"]').onclick = () => {
            cleanup();
            resolve({
                name: nameInput.value.trim(),
                description: descriptionInput.value.trim(),
            });
        };
    });
}
function showRenameDialog(currentPath) {
    return new Promise((resolve) => {
        let dialog = document.querySelector('#treeRenameDialog');
        if (!dialog) {
            dialog = document.createElement('div');
            dialog.id = 'treeRenameDialog';
            dialog.className = 'tree-dialog-overlay';
            dialog.innerHTML = `
        <div class="tree-dialog">
          <h3>重命名</h3>
          <p data-role="message"></p>
          <input data-role="input" type="text" />
          <div class="tree-dialog-actions">
            <button type="button" data-role="cancel">取消</button>
            <button type="button" data-role="confirm">重命名</button>
          </div>
        </div>
      `;
            document.body.appendChild(dialog);
        }
        dialog.querySelector('[data-role="message"]').textContent = `当前名称：${currentPath}`;
        const input = dialog.querySelector('[data-role="input"]');
        input.value = currentPath.split('/').pop() || currentPath;
        const cleanup = () => {
            dialog.classList.remove('visible');
            dialog.querySelector('[data-role="confirm"]').onclick = null;
            dialog.querySelector('[data-role="cancel"]').onclick = null;
        };
        dialog.classList.add('visible');
        input.focus();
        input.select();
        dialog.querySelector('[data-role="cancel"]').onclick = () => {
            cleanup();
            resolve(null);
        };
        dialog.querySelector('[data-role="confirm"]').onclick = () => {
            const value = input.value.trim();
            cleanup();
            resolve(value || null);
        };
    });
}
function saveCurrentFile() {
    if (!selectedFile)
        return;
    const content = editor.value;
    if (content === currentFileContent) {
        if (saveState !== 'saved')
            setSaveState('saved');
        return;
    }
    if (saveState !== 'saving')
        setSaveState('dirty');
    if (editorSaveTimer)
        clearTimeout(editorSaveTimer);
    editorSaveTimer = setTimeout(async () => {
        try {
            setSaveState('saving');
            const res = await fetch('/api/file', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: selectedFile, content: editor.value }),
            });
            const data = await res.json();
            if (!res.ok || data.ok === false) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            currentFileContent = editor.value;
            workspaceCache = data.tree || workspaceCache;
            renderTree(workspaceCache);
            scheduleWorkspaceRefresh(0);
            setSaveState('saved');
        }
        catch (err) {
            setSaveState('error', err.message);
            appendMessage('agent', `保存失败：${err.message}`);
        }
    }, 300);
}
function cancelPendingEditorSave() {
    if (editorSaveTimer) {
        clearTimeout(editorSaveTimer);
        editorSaveTimer = null;
    }
}
async function flushPendingEditorSave() {
    if (!selectedFile || editor.value === currentFileContent)
        return;
    cancelPendingEditorSave();
    setSaveState('saving');
    const res = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile, content: editor.value }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    currentFileContent = editor.value;
    workspaceCache = data.tree || workspaceCache;
    renderTree(workspaceCache);
    setSaveState('saved');
}
function findNodeByPath(nodes, path) {
    for (const node of nodes) {
        if (node.path === path)
            return node;
        if (node.type === 'folder') {
            const found = findNodeByPath(node.children ?? [], path);
            if (found)
                return found;
        }
    }
    return null;
}
function showCreateNameDialog(kind) {
    return new Promise((resolve) => {
        let dialog = document.querySelector('#treeCreateNameDialog');
        if (!dialog) {
            dialog = document.createElement('div');
            dialog.id = 'treeCreateNameDialog';
            dialog.className = 'tree-dialog-overlay';
            dialog.innerHTML = `
        <div class="tree-dialog">
          <h3 data-role="title"></h3>
          <p data-role="message"></p>
          <input data-role="input" type="text" />
          <div class="tree-dialog-actions">
            <button type="button" data-role="cancel">取消</button>
            <button type="button" data-role="confirm">确认</button>
          </div>
        </div>
      `;
            document.body.appendChild(dialog);
        }
        dialog.querySelector('[data-role="title"]').textContent = kind === 'file' ? '新建文件' : '新建文件夹';
        dialog.querySelector('[data-role="message"]').textContent = kind === 'file' ? '请输入文件名' : '请输入文件夹名';
        const input = dialog.querySelector('[data-role="input"]');
        input.value = '';
        const cleanup = () => {
            dialog.classList.remove('visible');
            dialog.querySelector('[data-role="confirm"]').onclick = null;
            dialog.querySelector('[data-role="cancel"]').onclick = null;
        };
        dialog.classList.add('visible');
        input.focus();
        dialog.querySelector('[data-role="cancel"]').onclick = () => {
            cleanup();
            resolve(null);
        };
        dialog.querySelector('[data-role="confirm"]').onclick = () => {
            const value = input.value.trim();
            cleanup();
            resolve(value || null);
        };
    });
}
async function createWorkspaceItem(kind, basePath = '') {
    const name = await showCreateNameDialog(kind);
    if (!name)
        return;
    if (kind === 'file') {
        const path = basePath ? `${basePath}/${name}` : name;
        const res = await fetch('/api/file', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, content: '' }),
        });
        const data = await res.json();
        workspaceCache = data.tree || workspaceCache;
        renderTree(workspaceCache);
        scheduleWorkspaceRefresh(0);
        return;
    }
    const path = basePath ? `${basePath}/${name}` : name;
    const res = await fetch('/api/folder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
    });
    const data = await res.json();
    workspaceCache = data.tree || workspaceCache;
    renderTree(workspaceCache);
    scheduleWorkspaceRefresh(0);
}
async function renameWorkspaceItem(path) {
    const nextName = await showRenameDialog(path);
    if (!nextName)
        return;
    const res = await fetch('/api/item/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, nextName }),
    });
    const data = await res.json();
    workspaceCache = data.tree || workspaceCache;
    if (selectedFile && selectedFile === path)
        selectedFile = data.to?.path || selectedFile;
    renderTree(workspaceCache);
    scheduleWorkspaceRefresh(0);
}
async function deleteWorkspaceItem(path) {
    const confirmed = await showConfirmDialog({
        title: '删除确认',
        message: `确定删除 ${path} 吗？此操作无法撤销。`,
        confirmLabel: '删除',
        danger: true,
    });
    if (!confirmed)
        return;
    const res = await fetch('/api/item/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
    });
    const data = await res.json();
    workspaceCache = data.tree || workspaceCache;
    if (selectedFile === path) {
        selectedFile = null;
        currentFile.textContent = '未打开文件';
        editor.value = '';
        currentFileContent = '';
    }
    renderTree(workspaceCache);
    scheduleWorkspaceRefresh(0);
}
function renderTree(nodes) {
    fileTree.innerHTML = '';
    const menu = ensureContextMenu();
    const closeMenuOnScroll = () => hideContextMenu();
    const renderNode = (node, depth = 0, parentPath = '') => {
        const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name;
        const row = document.createElement('div');
        row.className = 'file-item';
        row.style.paddingLeft = `${12 + depth * 16}px`;
        if (selectedFile && selectedFile === fullPath) {
            row.classList.add('active');
        }
        if (isFolder(node)) {
            const expanded = expandedFolders.has(fullPath);
            const arrow = expanded ? '▾' : '▸';
            row.innerHTML = `<span class="tree-arrow">${arrow}</span><span class="tree-icon">${expanded ? '📂' : '📁'}</span><span class="tree-label">${node.name}</span>`;
            row.addEventListener('click', () => {
                if (expandedFolders.has(fullPath)) {
                    expandedFolders.delete(fullPath);
                }
                else {
                    expandedFolders.add(fullPath);
                }
                persistExpandedFolders();
                renderTree(workspaceCache);
            });
            row.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                menu.style.left = `${event.clientX}px`;
                menu.style.top = `${event.clientY}px`;
                menu.dataset.basePath = fullPath;
                menu.dataset.targetPath = fullPath;
                menu.dataset.targetType = 'folder';
                menu.classList.add('visible');
            });
            fileTree.appendChild(row);
            if (expanded) {
                (node.children || []).forEach((child) => renderNode(child, depth + 1, fullPath));
            }
            return;
        }
        row.innerHTML = `<span class="tree-arrow tree-arrow-spacer"></span><span class="tree-icon">📄</span><span class="tree-label">${node.name}</span>`;
        row.addEventListener('click', () => openFile(fullPath));
        row.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            menu.style.left = `${event.clientX}px`;
            menu.style.top = `${event.clientY}px`;
            menu.dataset.basePath = parentPath;
            menu.dataset.targetPath = fullPath;
            menu.dataset.targetType = 'file';
            menu.classList.add('visible');
        });
        fileTree.appendChild(row);
    };
    nodes.forEach((node) => renderNode(node, 0, ''));
    if (shouldScrollTreeToActive) {
        shouldScrollTreeToActive = false;
        const active = fileTree.querySelector('.file-item.active');
        if (active) {
            active.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        }
    }
    menu.querySelectorAll('button').forEach((button) => {
        button.onclick = async () => {
            const action = button.dataset.action;
            const basePath = menu.dataset.basePath || '';
            const targetPath = menu.dataset.targetPath || '';
            hideContextMenu();
            if (action === 'new-file') {
                await createWorkspaceItem('file', basePath);
            }
            else if (action === 'new-folder') {
                await createWorkspaceItem('folder', basePath);
            }
            else if (action === 'rename') {
                await renameWorkspaceItem(targetPath);
            }
            else if (action === 'delete') {
                await deleteWorkspaceItem(targetPath);
            }
        };
    });
    fileTree.removeEventListener('scroll', closeMenuOnScroll);
    fileTree.addEventListener('scroll', closeMenuOnScroll, { once: true });
}
async function loadWorkspace() {
    const res = await fetch('/api/workspace');
    const data = await res.json();
    workspaceCache = data.tree;
    renderTree(workspaceCache);
    updateTreeEmptyState();
}
function scheduleWorkspaceRefresh(delayMs = 0) {
    if (currentAutoRefreshTimer)
        clearTimeout(currentAutoRefreshTimer);
    currentAutoRefreshTimer = setTimeout(() => {
        loadWorkspace();
    }, delayMs);
}
async function syncSelectedFileAfterWorkspaceChange() {
    if (!selectedFile)
        return;
    const exists = findNodeByPath(workspaceCache, selectedFile);
    if (!exists) {
        selectedFile = null;
        currentFile.textContent = '未打开文件';
        editor.value = '';
        currentFileContent = '';
        setSaveState('idle');
        return;
    }
    await openFile(selectedFile);
}
async function createSnapshot() {
    try {
        await flushPendingEditorSave();
    }
    catch (error) {
        showToast({ kind: 'error', title: '保存失败', message: error.message });
        return;
    }
    const input = await showSnapshotDialog();
    if (!input)
        return;
    snapshotBtn.disabled = true;
    snapshotBtn.textContent = '创建中...';
    try {
        const res = await fetch('/api/version/snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        const data = await res.json();
        if (!res.ok || data.ok === false)
            throw new Error(data.error || '创建快照失败');
        showToast({
            kind: 'info',
            title: '已创建快照',
            message: data.snapshot?.id ?? '快照已保存',
            actionLabel: '查看快照',
            onAction: () => { window.location.href = '/snapshots.html'; },
        });
    }
    catch (error) {
        showToast({ kind: 'error', title: '创建快照失败', message: error.message });
    }
    finally {
        snapshotBtn.disabled = false;
        snapshotBtn.textContent = '创建快照';
    }
}
async function openFile(path) {
    try {
        const res = await fetch(`/api/file/${encodeURIComponent(path)}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const file = await res.json();
        selectedFile = path;
        currentFile.textContent = path;
        currentFileContent = file.content ?? '';
        editor.value = currentFileContent;
        setSaveState('saved');
        shouldScrollTreeToActive = true;
        renderTree(workspaceCache);
    }
    catch (err) {
        showToast({
            kind: 'error',
            title: '打开文件失败',
            message: `${path}\n${err.message}`,
            actionLabel: '重试',
            onAction: () => openFile(path),
        });
    }
}
function updateTreeEmptyState() {
    const emptyState = document.querySelector('#treeEmptyState');
    if (emptyState)
        emptyState.remove();
}
/**
 * 显示模板选择对话框
 */
async function showTemplateSelectionDialog() {
    return new Promise(async (resolve) => {
        try {
            // 获取可用的模板列表
            const response = await fetch('/api/templates');
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const { templates } = await response.json();
            if (!Array.isArray(templates)) {
                throw new Error('响应中缺少 templates 列表');
            }
            let dialog = document.querySelector('#templateSelectionDialog');
            if (!dialog) {
                dialog = document.createElement('div');
                dialog.id = 'templateSelectionDialog';
                dialog.className = 'tree-dialog-overlay';
                document.body.appendChild(dialog);
            }
            // 按类别分组模板
            const categories = {};
            for (const template of templates) {
                if (!categories[template.category]) {
                    categories[template.category] = [];
                }
                categories[template.category].push(template);
            }
            const categoryNames = {
                frontend: '前端项目',
                backend: '后端项目',
                fullstack: '全栈项目',
                api: 'API 服务',
                cli: '命令行工具',
            };
            let templateHtml = '<div class="template-list">';
            for (const [category, categoryTemplates] of Object.entries(categories)) {
                templateHtml += `<div class="template-category">
          <h4>${categoryNames[category] || category}</h4>
          <div class="template-grid">`;
                for (const template of categoryTemplates) {
                    templateHtml += `
            <button type="button" class="template-card" data-template-id="${template.id}">
              <span class="template-name">${template.name}</span>
              <span class="template-description">${template.description}</span>
            </button>`;
                }
                templateHtml += '</div></div>';
            }
            templateHtml += '</div>';
            dialog.innerHTML = `
        <div class="tree-dialog" style="max-width: 600px; max-height: 70vh; overflow-y: auto;">
          <h3>选择项目模板</h3>
          <p>选择一个模板快速开始新项目</p>
          ${templateHtml}
          <div class="tree-dialog-actions">
            <button type="button" data-role="cancel">取消</button>
          </div>
        </div>
      `;
            dialog.classList.add('visible');
            let selectedTemplate = null;
            // 处理模板选择
            dialog.querySelectorAll('.template-card').forEach((button) => {
                button.addEventListener('click', () => {
                    selectedTemplate = button.dataset.templateId || null;
                    if (selectedTemplate) {
                        // 进入项目名称输入
                        showProjectNameInputDialog(selectedTemplate).then((projectName) => {
                            dialog.classList.remove('visible');
                            resolve(projectName ? { templateId: selectedTemplate, projectName } : null);
                        });
                    }
                });
            });
            // 处理取消
            dialog.querySelector('[data-role="cancel"]').addEventListener('click', () => {
                dialog.classList.remove('visible');
                resolve(null);
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            showToast({
                kind: 'warn',
                title: '无法加载模板列表',
                message: `请确认已通过 npm run dev 启动后端（含 /api/templates）。${message}`,
                timeoutMs: 8000,
            });
            resolve(null);
        }
    });
}
/**
 * 显示项目名称输入对话框
 */
function showProjectNameInputDialog(templateId) {
    return new Promise((resolve) => {
        let dialog = document.querySelector('#projectNameInputDialog');
        if (!dialog) {
            dialog = document.createElement('div');
            dialog.id = 'projectNameInputDialog';
            dialog.className = 'tree-dialog-overlay';
            dialog.innerHTML = `
        <div class="tree-dialog">
          <h3>创建项目</h3>
          <p>请输入项目名称</p>
          <input data-role="input" type="text" placeholder="例如: my-app, my-project" />
          <div class="tree-dialog-actions">
            <button type="button" data-role="cancel">取消</button>
            <button type="button" data-role="confirm">创建</button>
          </div>
        </div>
      `;
            document.body.appendChild(dialog);
        }
        const input = dialog.querySelector('[data-role="input"]');
        input.value = 'my-project';
        dialog.classList.add('visible');
        input.focus();
        input.select();
        const cleanup = () => {
            dialog.classList.remove('visible');
        };
        const handleConfirm = () => {
            const value = input.value.trim();
            cleanup();
            resolve(value || null);
        };
        const handleCancel = () => {
            cleanup();
            resolve(null);
        };
        dialog.querySelector('[data-role="confirm"]').onclick = handleConfirm;
        dialog.querySelector('[data-role="cancel"]').onclick = handleCancel;
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter')
                handleConfirm();
            if (e.key === 'Escape')
                handleCancel();
        });
    });
}
/**
 * 流式生成项目骨架
 */
async function streamGenerateScaffold(projectName, templateId) {
    const response = await fetch('/api/scaffold/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectName, templateId }),
    });
    if (!response.ok || !response.body) {
        throw new Error('项目生成请求失败');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const assistantMessage = appendMessage('agent', '');
    let finalResult = null;
    let generatedFileCount = 0;
    const updateAssistant = (text) => {
        assistantMessage.textContent = text;
        chatLog.scrollTop = chatLog.scrollHeight;
    };
    while (true) {
        const { value, done } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
            const line = part.split('\n').find((item) => item.startsWith('data: '));
            if (!line)
                continue;
            const payload = line.slice(6);
            if (payload === '[DONE]')
                continue;
            try {
                const event = JSON.parse(payload);
                if (event.type === 'chunk') {
                    updateAssistant((assistantMessage.textContent || '') + event.chunk);
                }
                else if (event.type === 'tool') {
                    generatedFileCount++;
                    updateAssistant(`✓ 已生成 ${generatedFileCount} 个文件...\n\n${event.summary || '正在生成项目'}`);
                }
                else if (event.type === 'result') {
                    finalResult = event.result;
                    updateAssistant(`✅ 项目骨架生成完成！\n\n${projectName} 项目已生成 ${generatedFileCount} 个文件。\n\n现在你可以开始编辑文件或继续输入需求来修改项目。`);
                    scheduleWorkspaceRefresh(200);
                }
                else if (event.type === 'error') {
                    updateAssistant(`❌ 出错了：${event.message}`);
                }
            }
            catch (e) {
                console.error('解析事件失败:', e);
                continue;
            }
        }
    }
    return finalResult;
}
async function streamChat(prompt) {
    skillCallCards.clear();
    const response = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, selectedFile, sessionId: currentSessionId }),
    });
    if (!response.ok || !response.body) {
        throw new Error('流式请求失败');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const assistantMessage = appendMessage('agent', '');
    let finalResult = null;
    let sawWriteFileSuccess = false;
    let currentMessageElement = assistantMessage;
    let toolCallElement = null;
    let pendingToolDetails = '';
    const ensureToolNode = (toolName) => {
        if (toolCallElement)
            return toolCallElement;
        toolCallElement = document.createElement('div');
        toolCallElement.className = 'tool-call';
        toolCallElement.dataset.kind = 'tool';
        toolCallElement.dataset.expanded = 'false';
        const color = toolName ? (TOOL_COLORS[toolName] ?? 'var(--muted)') : 'var(--muted)';
        const label = toolName ?? '工具调用';
        toolCallElement.innerHTML = `
      <button type="button" class="tool-call-header">
        <span class="tool-call-arrow">▸</span>
        <span class="tool-call-badge" style="background:${color}20;color:${color};border-color:${color}40">${label}</span>
        <span class="tool-call-title">执行结果</span>
      </button>
      <pre class="tool-call-body"></pre>
    `;
        chatLog.replaceChild(toolCallElement, assistantMessage);
        currentMessageElement = toolCallElement;
        const header = toolCallElement.querySelector('.tool-call-header');
        const arrow = toolCallElement.querySelector('.tool-call-arrow');
        const body = toolCallElement.querySelector('.tool-call-body');
        header.addEventListener('click', () => {
            const expanded = toolCallElement.dataset.expanded === 'true';
            toolCallElement.dataset.expanded = expanded ? 'false' : 'true';
            arrow.textContent = expanded ? '▸' : '▾';
            body.style.display = expanded ? 'none' : 'block';
        });
        body.style.display = 'none';
        return toolCallElement;
    };
    const updateAssistant = (text) => {
        const body = currentMessageElement.querySelector('.tool-call-body');
        if (body) {
            body.innerHTML = renderMarkdown(text);
            body.style.display = 'block';
            currentMessageElement.dataset.expanded = 'true';
            const arrow = currentMessageElement.querySelector('.tool-call-arrow');
            if (arrow)
                arrow.textContent = '▾';
        }
        else {
            currentMessageElement.innerHTML = renderMarkdown(text);
        }
        chatLog.scrollTop = chatLog.scrollHeight;
    };
    const appendToolDetail = (toolName, text) => {
        const node = ensureToolNode(toolName);
        const body = node.querySelector('.tool-call-body');
        pendingToolDetails = pendingToolDetails ? `${pendingToolDetails}\n${text}` : text;
        body.textContent = pendingToolDetails;
    };
    let accumulatedChunks = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
            const line = part.split('\n').find((item) => item.startsWith('data: '));
            if (!line)
                continue;
            const payload = line.slice(6);
            if (payload === '[DONE]')
                continue;
            try {
                const event = JSON.parse(payload);
                if (event.type === 'chunk') {
                    accumulatedChunks += event.chunk;
                    updateAssistant(accumulatedChunks);
                }
                else if (event.type === 'tool') {
                    const detailBody = formatToolDetailForChat(event.tool, event.detail || '');
                    appendToolDetail(event.tool, `${event.summary || '工具调用结果'}\n\n${detailBody}`);
                    if (event.tool === 'run_command') {
                        lastRunCommandDetail = `${event.summary || '命令执行'}\n\n${event.detail || ''}`.trim();
                    }
                    if (event.tool === 'write_file' || event.tool === 'patch_file') {
                        sawWriteFileSuccess = true;
                        scheduleWorkspaceRefresh(300);
                    }
                }
                else if (event.type === 'plan') {
                    appendToolDetail('multi-agent', `Agent plan\n\n${event.steps.map((step) => `- ${step}`).join('\n')}`);
                }
                else if (event.type === 'skill') {
                    appendSkillEvent(event);
                }
                else if (event.type === 'result') {
                    finalResult = event.result;
                    setAgentStatus('idle');
                    setTaskPhase('succeeded');
                    renderStructuredSummary(finalResult);
                }
                else if (event.type === 'error') {
                    updateAssistant(`出错了：${event.message}`);
                    setAgentStatus('idle');
                    setTaskPhase('failed', event.message);
                    lastFailureText = `任务失败：${event.message}`;
                    renderStructuredSummary(finalResult);
                }
                else if (event.type === 'session') {
                    currentSessionId = event.sessionId;
                    const shortId = event.sessionId.replace('session-', '').slice(-6);
                    sessionBadge.textContent = `会话 #${shortId}`;
                }
                else if (event.type === 'task_status') {
                    const statusMap = {
                        planning: 'running',
                        executing: 'running',
                        summarizing: 'running',
                        waiting_confirm: 'waiting_confirm',
                        done: 'idle',
                        error: 'idle',
                    };
                    if (statusMap[event.status]) {
                        setAgentStatus(statusMap[event.status]);
                    }
                    const phaseMap = {
                        planning: 'planning',
                        executing: 'editing',
                        summarizing: 'validating',
                        waiting_confirm: 'waiting_user',
                        done: 'succeeded',
                        error: 'failed',
                    };
                    if (phaseMap[event.status])
                        setTaskPhase(phaseMap[event.status], `状态：${event.status}`);
                    if (event.status === 'error') {
                        lastFailureText = `任务失败：状态=error`;
                    }
                }
                else if (event.type === 'confirm_request') {
                    setAgentStatus('waiting_confirm');
                    setTaskPhase('waiting_user');
                    lastConfirmRequest = { confirmId: event.confirmId, question: event.question, options: event.options };
                    renderWaitingUserPanel();
                    renderConfirmCard(event);
                }
                else if (event.type === 'command_confirm_request') {
                    setAgentStatus('waiting_confirm');
                    setTaskPhase('waiting_user', '等待命令确认');
                    hideCommandConfirmOverlay();
                    showCommandConfirmOverlay(event);
                }
            }
            catch {
                continue;
            }
        }
    }
    return finalResult;
}
async function createNewSession() {
    try {
        const response = await fetch('/api/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok)
            throw new Error('创建会话失败');
        const data = await response.json();
        if (!data.sessionId)
            throw new Error('未返回会话 ID');
        currentSessionId = data.sessionId;
        const shortId = data.sessionId.replace('session-', '').slice(-6);
        sessionBadge.textContent = `会话 #${shortId}`;
        chatLog.innerHTML = '';
        hideSessionDropdown();
        showToast({ kind: 'info', title: '已创建新会话', message: `当前会话 #${shortId}` });
    }
    catch (error) {
        showToast({
            kind: 'error',
            title: '创建会话失败',
            message: error.message,
        });
    }
}
function hideSessionDropdown() {
    sessionDropdown.classList.remove('visible');
    sessionDropdown.setAttribute('aria-hidden', 'true');
}
async function deleteSession(sessionId) {
    const confirmed = await showConfirmDialog({
        title: '删除会话',
        message: '确定要删除这个会话吗？此操作无法撤销。',
        confirmLabel: '删除',
        danger: true,
    });
    if (!confirmed)
        return;
    const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (!res.ok) {
        showToast({ kind: 'error', title: '删除失败', message: '无法删除会话' });
        return;
    }
    if (currentSessionId === sessionId) {
        await createNewSession();
    }
    await refreshSessionList();
    showToast({ kind: 'info', title: '已删除', message: `会话已删除` });
}
async function renameSession(sessionId) {
    const newTitle = await new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '输入新标题…';
        input.style.cssText = 'width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--panel);color:var(--text)';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '确认';
        btn.style.cssText = 'margin-top:4px;padding:4px 12px;border-radius:6px;border:1px solid var(--accent-2);background:var(--accent-2);color:#fff;cursor:pointer';
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'padding:8px';
        wrapper.appendChild(input);
        wrapper.appendChild(btn);
        let dialog = document.querySelector('#renameDialog');
        if (!dialog) {
            dialog = document.createElement('div');
            dialog.id = 'renameDialog';
            dialog.className = 'tree-dialog-overlay';
            dialog.innerHTML = '<div class="tree-dialog" data-role="container"><h3>重命名会话</h3></div>';
            document.body.appendChild(dialog);
        }
        dialog.querySelector('[data-role="container"]').appendChild(wrapper);
        dialog.classList.add('visible');
        input.focus();
        const cleanup = () => { dialog.classList.remove('visible'); wrapper.remove(); };
        btn.onclick = () => { cleanup(); resolve(input.value.trim() || null); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
            cleanup();
            resolve(input.value.trim() || null);
        } if (e.key === 'Escape') {
            cleanup();
            resolve(null);
        } });
    });
    if (!newTitle)
        return;
    const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
    });
    if (!res.ok) {
        showToast({ kind: 'error', title: '重命名失败', message: '无法更新会话标题' });
        return;
    }
    await refreshSessionList();
}
async function archiveSession(sessionId, archive) {
    const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: archive }),
    });
    if (!res.ok) {
        showToast({ kind: 'error', title: '操作失败', message: '无法更新会话状态' });
        return;
    }
    await refreshSessionList();
    showToast({ kind: 'info', title: archive ? '已归档' : '已取消归档', message: `会话已${archive ? '归档' : '取消归档'}` });
}
function exportSession(sessionId) {
    const a = document.createElement('a');
    a.href = `/api/session/${encodeURIComponent(sessionId)}/export`;
    a.download = `${sessionId}.json`;
    a.click();
}
async function refreshSessionList() {
    if (!sessionDropdown.classList.contains('visible'))
        return;
    await renderSessionDropdown();
}
async function renderSessionDropdown() {
    try {
        const response = await fetch('/api/sessions');
        if (!response.ok)
            throw new Error('加载会话列表失败');
        const data = await response.json();
        sessionDropdown.innerHTML = '';
        const sessions = data.sessions ?? [];
        if (sessions.length === 0) {
            const empty = document.createElement('button');
            empty.type = 'button';
            empty.disabled = true;
            empty.textContent = '暂无历史会话';
            sessionDropdown.appendChild(empty);
        }
        else {
            sessions.forEach((session) => {
                const item = document.createElement('div');
                item.className = `session-item${currentSessionId === session.sessionId ? ' active' : ''}`;
                const shortId = session.sessionId.replace('session-', '').slice(-6);
                const updatedAt = new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false });
                const title = session.title || '未命名会话';
                const msgCount = session.messageCount ?? 0;
                const taskCount = session.taskCount ?? 0;
                const archived = session.archived ?? false;
                item.innerHTML = `
          <div class="session-item-header">
            <span class="session-item-id">#${shortId}${archived ? ' 📦' : ''}</span>
            <span class="session-item-time">${updatedAt}</span>
          </div>
          <div class="session-item-preview">${title}</div>
          <div class="session-item-meta">${msgCount} 条消息 · ${taskCount} 个任务</div>
          <div class="session-item-actions">
          </div>
        `;
                const actionsEl = item.querySelector('.session-item-actions');
                const renameBtn = document.createElement('button');
                renameBtn.textContent = '重命名';
                renameBtn.addEventListener('click', (e) => { e.stopPropagation(); renameSession(session.sessionId); });
                actionsEl.appendChild(renameBtn);
                const archiveBtn = document.createElement('button');
                archiveBtn.textContent = archived ? '取消归档' : '归档';
                archiveBtn.addEventListener('click', (e) => { e.stopPropagation(); archiveSession(session.sessionId, !archived); });
                actionsEl.appendChild(archiveBtn);
                const exportBtn = document.createElement('button');
                exportBtn.textContent = '导出';
                exportBtn.addEventListener('click', (e) => { e.stopPropagation(); exportSession(session.sessionId); });
                actionsEl.appendChild(exportBtn);
                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = '删除';
                deleteBtn.classList.add('danger');
                deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(session.sessionId); });
                actionsEl.appendChild(deleteBtn);
                item.addEventListener('click', async () => {
                    try {
                        const switchResponse = await fetch('/api/session/switch', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sessionId: session.sessionId }),
                        });
                        if (!switchResponse.ok)
                            throw new Error('切换会话失败');
                        const switched = await switchResponse.json();
                        currentSessionId = switched.sessionId ?? session.sessionId;
                        sessionBadge.textContent = `会话 #${currentSessionId.replace('session-', '').slice(-6)}`;
                        chatLog.innerHTML = '';
                        (switched.messages ?? []).forEach((message) => {
                            if (message.role === 'user' || message.role === 'assistant' || message.role === 'tool') {
                                appendMessage(message.role === 'user' ? 'user' : 'agent', String(message.content ?? ''));
                            }
                        });
                        hideSessionDropdown();
                    }
                    catch (error) {
                        showToast({
                            kind: 'error',
                            title: '切换会话失败',
                            message: error.message,
                        });
                    }
                });
                sessionDropdown.appendChild(item);
            });
        }
        sessionDropdown.classList.add('visible');
        sessionDropdown.setAttribute('aria-hidden', 'false');
    }
    catch (error) {
        showToast({
            kind: 'warn',
            title: '加载会话列表失败',
            message: error.message,
        });
    }
}
editor.addEventListener('input', saveCurrentFile);
editor.addEventListener('blur', saveCurrentFile);
promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        chatForm.requestSubmit();
    }
});
chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const prompt = promptInput.value.trim();
    if (!prompt || agentStatus !== 'idle')
        return;
    appendMessage('user', prompt);
    promptInput.value = '';
    setAgentStatus('running');
    lastRunCommandDetail = null;
    lastFailureText = null;
    try {
        const result = await streamChat(prompt);
        summary.textContent = JSON.stringify(result, null, 2);
        renderStructuredSummary(result);
    }
    catch (error) {
        appendMessage('agent', `请求失败：${error.message}`);
        setTaskPhase('failed', error.message);
        lastFailureText = `请求失败：${error.message}`;
        renderStructuredSummary(null);
        showToast({
            kind: 'error',
            title: '任务执行失败',
            message: error.message,
            actionLabel: lastUserPrompt ? '重试' : undefined,
            onAction: () => {
                if (lastUserPrompt) {
                    promptInput.value = lastUserPrompt;
                    chatForm.requestSubmit();
                }
            },
            timeoutMs: 9000,
        });
        setAgentStatus('idle');
    }
});
retryLastTaskBtn.addEventListener('click', () => {
    if (!lastUserPrompt || agentStatus !== 'idle')
        return;
    promptInput.value = lastUserPrompt;
    chatForm.requestSubmit();
});
toggleRawSummaryBtn.addEventListener('click', () => {
    showRawSummary = !showRawSummary;
    summary.classList.toggle('hidden', !showRawSummary);
    toggleRawSummaryBtn.textContent = showRawSummary ? '隐藏原始' : '查看原始';
});
clearFailureBtn.addEventListener('click', () => {
    lastFailureText = null;
    renderFailurePanel();
});
function hideCommandConfirmOverlay() {
    commandConfirmOverlay.classList.remove('visible');
    commandConfirmOverlay.setAttribute('aria-hidden', 'true');
    lastCommandConfirmRequest = null;
}
function showCommandConfirmOverlay(event) {
    lastCommandConfirmRequest = event;
    commandConfirmReason.textContent = event.reason;
    commandConfirmRisk.textContent = `风险：${event.risk}`;
    commandConfirmRisk.dataset.risk = event.risk;
    commandConfirmCwd.textContent = `cwd: ${event.cwd}`;
    commandConfirmText.textContent = event.command;
    commandConfirmOverlay.classList.add('visible');
    commandConfirmOverlay.setAttribute('aria-hidden', 'false');
}
async function submitCommandConfirm(decision) {
    if (!lastCommandConfirmRequest)
        return;
    const { confirmId } = lastCommandConfirmRequest;
    try {
        const res = await fetch('/api/agent/command-confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmId, decision }),
        });
        if (!res.ok)
            throw new Error('命令确认提交失败');
        hideCommandConfirmOverlay();
        if (decision === 'deny') {
            showToast({ kind: 'info', title: '已拒绝', message: '命令未执行' });
        }
        else {
            setAgentStatus('running');
            if (decision === 'allow_whitelist') {
                showToast({
                    kind: 'info',
                    title: '已加入白名单',
                    message: '可在"白名单"页查看和管理。',
                    actionLabel: '打开白名单页',
                    onAction: () => { window.location.href = '/whitelist.html'; },
                });
            }
            showToast({
                kind: 'info',
                title: '命令已允许',
                message: '命令正在执行…',
            });
        }
    }
    catch (error) {
        showToast({ kind: 'error', title: '确认失败', message: error.message });
    }
}
commandConfirmDenyBtn.addEventListener('click', () => submitCommandConfirm('deny'));
commandConfirmOnceBtn.addEventListener('click', () => submitCommandConfirm('allow_once'));
commandConfirmWhitelistBtn.addEventListener('click', () => submitCommandConfirm('allow_whitelist'));
commandConfirmOverlay.addEventListener('click', (e) => {
    if (e.target === commandConfirmOverlay)
        void submitCommandConfirm('deny');
});
newSessionBtn.addEventListener('click', createNewSession);
sessionBadge.addEventListener('click', (e) => {
    e.stopPropagation();
    if (sessionDropdown.classList.contains('visible')) {
        hideSessionDropdown();
    }
    else {
        renderSessionDropdown();
    }
});
refreshBtn.addEventListener('click', loadWorkspace);
snapshotBtn.addEventListener('click', () => {
    createSnapshot();
});
newItemBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleNewItemMenu();
});
newItemMenu?.querySelectorAll('button[data-kind]').forEach((button) => {
    button.addEventListener('click', async (event) => {
        event.stopPropagation();
        hideNewItemMenu();
        const createKind = button.dataset.kind;
        await createWorkspaceItem(createKind, '');
    });
});
document.addEventListener('click', () => {
    hideContextMenu();
    hideNewItemMenu();
    hideSuggestList();
    hideSessionDropdown();
});
// ── 项目知识入口(主页保留:任务跑完后一键把经验加入项目知识)──
async function appendLastTaskMemory() {
    if (!lastProjectMemoryEntry) {
        showToast({ kind: 'warn', title: '暂无可保存经验', message: '完成一次任务后再保存到项目知识。' });
        return;
    }
    try {
        appendLastTaskMemoryBtn.disabled = true;
        const res = await fetch('/api/project-memory/append', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ section: 'Agent 任务经验', entry: lastProjectMemoryEntry }),
        });
        if (!res.ok)
            throw new Error('任务经验保存失败');
        showToast({
            kind: 'info',
            title: '任务经验已保存',
            message: '已写入 project-memory.md',
            actionLabel: '打开项目知识',
            onAction: () => { window.location.href = '/project-memory.html'; },
        });
    }
    catch (error) {
        appendLastTaskMemoryBtn.disabled = false;
        showToast({ kind: 'error', title: '保存任务经验失败', message: error.message });
    }
}
appendLastTaskMemoryBtn.addEventListener('click', appendLastTaskMemory);
appendLastTaskMemoryBtn.disabled = true;
loadLayoutState();
applyLayoutWidths();
initResizers();
loadExpandedFolders();
loadWorkspace();
// 添加模板生成按钮到新建菜单
const newItemMenuElement = newItemMenu;
if (newItemMenuElement) {
    const scaffoldButton = document.createElement('button');
    scaffoldButton.type = 'button';
    scaffoldButton.setAttribute('role', 'menuitem');
    scaffoldButton.textContent = '📦 生成项目模板';
    scaffoldButton.style.borderTop = '1px solid #ccc';
    scaffoldButton.style.marginTop = '8px';
    scaffoldButton.style.paddingTop = '8px';
    scaffoldButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        event.preventDefault();
        hideNewItemMenu();
        const result = await showTemplateSelectionDialog();
        if (result) {
            appendMessage('user', `生成 ${result.projectName} 项目（${result.templateId}）`);
            appendMessage('agent', `正在生成 ${result.projectName} 项目骨架…`);
            try {
                await streamGenerateScaffold(result.projectName, result.templateId);
            }
            catch (error) {
                appendMessage('agent', `项目生成失败：${error.message}`);
            }
        }
    });
    newItemMenuElement.appendChild(scaffoldButton);
}
appendMessage('agent', 'DexCode 已就绪：可以浏览工作区文件，或直接输入编码任务。');
//# sourceMappingURL=app.js.map