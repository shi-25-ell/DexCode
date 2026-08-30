type ExternalMcpServerConfig =
  | {
      name: string;
      type: 'http';
      url: string;
      headers?: Record<string, string>;
      enabled?: boolean;
    }
  | {
      name: string;
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      enabled?: boolean;
    };

type ExternalMcpTool = {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const serverList = document.querySelector<HTMLElement>('#mcpServerList')!;
const form = document.querySelector<HTMLFormElement>('#mcpForm')!;
const nameInput = document.querySelector<HTMLInputElement>('#mcpName')!;
const typeSelect = document.querySelector<HTMLSelectElement>('#mcpType')!;
const urlInput = document.querySelector<HTMLInputElement>('#mcpUrl')!;
const commandInput = document.querySelector<HTMLInputElement>('#mcpCommand')!;
const argsInput = document.querySelector<HTMLTextAreaElement>('#mcpArgs')!;
const headersInput = document.querySelector<HTMLTextAreaElement>('#mcpHeaders')!;
const envInput = document.querySelector<HTMLTextAreaElement>('#mcpEnv')!;
const enabledInput = document.querySelector<HTMLInputElement>('#mcpEnabled')!;
const refreshMcpListBtn = document.querySelector<HTMLButtonElement>('#refreshMcpBtn')!;
const saveBtn = document.querySelector<HTMLButtonElement>('#saveMcpBtn')!;

const STORAGE_KEY = 'externalMcpServers';

function loadConfigs(): ExternalMcpServerConfig[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as ExternalMcpServerConfig[];
  } catch {
    return [];
  }
}

async function saveConfigs(configs: ExternalMcpServerConfig[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs, null, 2));
  try {
    await fetch('/api/external-mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ servers: configs }),
    });
  } catch {
    // 后端不可用时静默失败
  }
}

async function loadServerConfigs(): Promise<ExternalMcpServerConfig[]> {
  const localConfigs = loadConfigs();
  // 静默同步到后端
  if (localConfigs.length > 0) {
    try {
      await fetch('/api/external-mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers: localConfigs }),
      });
    } catch { /* 后端不可用不影响前端 */ }
  }
  return localConfigs;
}

function parseJson<T>(value: string, fallback: T): T {
  if (!value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function renderServerList(configs: ExternalMcpServerConfig[], tools: ExternalMcpTool[] = []) {
  serverList.innerHTML = '';
  if (configs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '暂无配置';
    serverList.appendChild(empty);
    return;
  }

  configs.forEach((config) => {
    const card = document.createElement('div');
    card.className = 'mcp-server-card';
    const serverTools = tools.filter((tool) => tool.server === config.name);
    card.innerHTML = `
      <div class="mcp-server-card-header">
        <strong>${config.name}</strong>
        <span class="mcp-badge ${config.enabled === false ? 'off' : 'on'}">${config.enabled === false ? '禁用' : '启用'}</span>
      </div>
      <div class="mcp-server-meta">类型：${config.type}</div>
      <div class="mcp-server-meta">${config.type === 'http' ? config.url : config.command}</div>
      <div class="mcp-server-tools">${serverTools.length ? serverTools.map((tool) => `<span class="mcp-tool-pill">${tool.name}</span>`).join('') : '<span class="muted">未发现工具</span>'}</div>
      <button class="mcp-delete-btn" data-name="${config.name}">删除</button>
    `;
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('mcp-delete-btn')) return;
      loadToForm(config);
    });
    card.querySelector<HTMLButtonElement>('.mcp-delete-btn')!.addEventListener('click', async (e) => {
      e.stopPropagation();
      const configs = loadConfigs().filter((c) => c.name !== config.name);
      await saveConfigs(configs);
      await render();
    });
    serverList.appendChild(card);
  });
}

function toggleFields() {
  const isHttp = typeSelect.value === 'http';
  document.querySelectorAll<HTMLElement>('[data-field="url"]').forEach((el) => el.classList.toggle('hidden', !isHttp));
  document.querySelectorAll<HTMLElement>('[data-field="headers"]').forEach((el) => el.classList.toggle('hidden', !isHttp));
  document.querySelectorAll<HTMLElement>('[data-field="command"]').forEach((el) => el.classList.toggle('hidden', isHttp));
  document.querySelectorAll<HTMLElement>('[data-field="args"]').forEach((el) => el.classList.toggle('hidden', isHttp));
  document.querySelectorAll<HTMLElement>('[data-field="env"]').forEach((el) => el.classList.toggle('hidden', isHttp));
}

function loadToForm(config: ExternalMcpServerConfig) {
  nameInput.value = config.name;
  typeSelect.value = config.type;
  enabledInput.checked = config.enabled !== false;
  if (config.type === 'http') {
    urlInput.value = config.url;
    headersInput.value = JSON.stringify(config.headers ?? {}, null, 2);
    commandInput.value = '';
    argsInput.value = '';
    envInput.value = '';
  } else {
    urlInput.value = '';
    headersInput.value = '';
    commandInput.value = config.command;
    argsInput.value = JSON.stringify(config.args ?? [], null, 2);
    envInput.value = JSON.stringify(config.env ?? {}, null, 2);
  }
  toggleFields();
}

async function refreshTools() {
  const res = await fetch('/api/external-mcp/tools');
  return (await res.json()) as { tools?: ExternalMcpTool[] };
}

async function render() {
  const configs = await loadServerConfigs();
  // 先渲染 server 列表，工具加载不阻塞
  renderServerList(configs, []);
  try {
    const toolsRes = await refreshTools();
    renderServerList(configs, toolsRes.tools ?? []);
  } catch {
    // 工具加载失败，server 列表已显示
  }
}

function buildConfig(): ExternalMcpServerConfig | null {
  const name = nameInput.value.trim();
  if (!name) return null;
  const enabled = enabledInput.checked;

  if (typeSelect.value === 'http') {
    const url = urlInput.value.trim();
    if (!url) return null;
    return {
      name,
      type: 'http',
      url,
      headers: parseJson<Record<string, string>>(headersInput.value, {}),
      enabled,
    };
  }

  const command = commandInput.value.trim();
  if (!command) return null;
  return {
    name,
    type: 'stdio',
    command,
    args: parseJson<string[]>(argsInput.value, []),
    env: parseJson<Record<string, string>>(envInput.value, {}),
    enabled,
  };
}


async function upsertConfig(config: ExternalMcpServerConfig) {
  const configs = loadConfigs();
  const index = configs.findIndex((item) => item.name === config.name);
  if (index >= 0) configs[index] = config;
  else configs.push(config);
  await saveConfigs(configs);
}

refreshMcpListBtn.addEventListener('click', () => {
  render();
});

[typeSelect, nameInput, urlInput, commandInput, argsInput, headersInput, envInput].forEach((el) => {
  el.addEventListener('input', () => {
    // keep form responsive; no-op
  });
});

typeSelect.addEventListener('change', () => {
  toggleFields();
});

saveBtn.addEventListener('click', async () => {
  const config = buildConfig();
  if (!config) {
    alert('请填写必要字段');
    return;
  }
  await upsertConfig(config);
  await render();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
});

toggleFields();
render();
