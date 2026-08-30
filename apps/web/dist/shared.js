/**
 * 子页面共享的小工具:toast、fetch JSON、HTML 转义。
 * 每个独立子页(/tools.html、/skills.html 等)都会 import 它。
 * 主页 app.ts 已经有自己内联的 showToast 实现,暂不迁移避免破坏现有逻辑。
 */
function ensureToastHost() {
    let host = document.querySelector('#toastHost');
    if (host)
        return host;
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-atomic', 'true');
    document.body.appendChild(host);
    return host;
}
export function showToast(opts) {
    const host = ensureToastHost();
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
/**
 * fetch + JSON 解析的薄封装。非 2xx 抛 Error,err.message 为后端 error 字段或 statusText。
 */
export async function fetchJson(input, init) {
    const res = await fetch(input, init);
    let data = null;
    try {
        data = await res.json();
    }
    catch {
        /* 没 body 或不是 json */
    }
    if (!res.ok) {
        const message = (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string')
            ? data.error
            : res.statusText || `HTTP ${res.status}`;
        throw new Error(message);
    }
    return data;
}
/**
 * 把字符串转成可安全插入到 innerHTML 的 HTML。
 */
export function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
/**
 * 把 ISO 时间字符串格式化成本地友好显示;失败时返回原字符串。
 */
export function formatLocalTime(iso) {
    if (!iso)
        return '';
    try {
        return new Date(iso).toLocaleString('zh-CN', { hour12: false });
    }
    catch {
        return iso;
    }
}
//# sourceMappingURL=shared.js.map