import { spawn } from 'child_process';

export type ExternalMcpServerConfig =
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

export type ExternalMcpTool = {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc?: '2.0';
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type Transport = {
  listTools(): Promise<ExternalMcpTool[]>;
  callTool(toolName: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): void;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeToolName(serverName: string, toolName: string) {
  return `mcp__${serverName}__${toolName}`;
}

async function postJson(url: string, body: JsonRpcRequest, headers: Record<string, string> = {}, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(120_000);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`MCP request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`);
  }
  return (await response.json()) as JsonRpcResponse;
}

function createHttpTransport(config: Extract<ExternalMcpServerConfig, { type: 'http' }>): Transport {
  return {
    async listTools() {
      const response = await postJson(config.url, { jsonrpc: '2.0', id: `tools-list-${config.name}-${Date.now()}`, method: 'tools/list' }, config.headers);
      if (response.error) throw new Error(response.error.message || `Failed to list tools from ${config.name}`);
      const result = asObject(response.result);
      const tools = Array.isArray(result.tools) ? result.tools : [];
      return tools.map((tool) => {
        const item = asObject(tool);
        return {
          server: config.name,
          name: String(item.name ?? ''),
          description: String(item.description ?? ''),
          inputSchema: asObject(item.inputSchema),
        } as ExternalMcpTool;
      });
    },
    async callTool(toolName: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
      const response = await postJson(config.url, { jsonrpc: '2.0', id: `tools-call-${config.name}-${Date.now()}`, method: 'tools/call', params: { name: toolName, arguments: args } }, config.headers, signal);
      if (response.error) throw new Error(response.error.message || `Failed to call tool ${toolName} on ${config.name}`);
      const result = asObject(response.result);
      return 'data' in result ? result.data : result;
    },
    close() {},
  };
}

function createStdioTransport(config: Extract<ExternalMcpServerConfig, { type: 'stdio' }>): Transport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let child: any = null;
  let initError: Error | null = null;
  let nextId = 1;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();
  let buffer = '';

  function ensureChild() {
    if (child) return child;
    if (initError) throw initError;
    try {
      child = spawn(config.command, config.args ?? [], {
        env: { ...(process.env as Record<string, string | undefined>), ...(config.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      } as Record<string, unknown>);
    } catch (err) {
      initError = err instanceof Error ? err : new Error(String(err));
      throw initError;
    }
    child.on('error', (err: Error) => {
      initError = err;
      for (const item of pending.values()) item.reject(err);
      pending.clear();
      child = null;
    });
    child.on('exit', () => {
      const error = new Error(`MCP stdio server exited: ${config.name}`);
      for (const item of pending.values()) item.reject(error);
      pending.clear();
      child = null;
    });
    child.stdout.on('data', childStdout);
    child.stderr.on('data', () => { /* stderr is intentionally not mixed into JSON-RPC stdout */ });
    return child;
  }

  const childStdout = (chunk: { toString(encoding?: string): string }) => {
    buffer += chunk.toString('utf8');
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as JsonRpcResponse;
          const key = String(message.id ?? '');
          const pendingItem = pending.get(key);
          if (pendingItem) {
            pending.delete(key);
            if (message.error) pendingItem.reject(new Error(message.error.message || 'MCP stdio error'));
            else pendingItem.resolve(message.result);
          }
        } catch {
          // ignore non-json stdout
        }
      }
      idx = buffer.indexOf('\n');
    }
  };

  function request(method: string, params?: unknown, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('MCP request aborted'));
    const id = String(nextId++);
    const c = ensureChild();
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
        action();
      };
      const onAbort = () => {
        if (!pending.delete(id)) return;
        try {
          c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'caller aborted' } })}\n`);
        } catch { /* the child may already be gone */ }
        settle(() => reject(signal?.reason ?? new Error(`MCP stdio request aborted: ${method}`)));
      };
      const timeoutId = setTimeout(() => {
        if (!pending.delete(id)) return;
        settle(() => reject(new Error(`MCP stdio request timeout: ${method}`)));
      }, 120_000);
      pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (reason) => settle(() => reject(reason)),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  return {
    async listTools() {
      const result = asObject(await request('tools/list'));
      const tools = Array.isArray(result.tools) ? result.tools : [];
      return tools.map((tool) => {
        const item = asObject(tool);
        return {
          server: config.name,
          name: String(item.name ?? ''),
          description: String(item.description ?? ''),
          inputSchema: asObject(item.inputSchema),
        } as ExternalMcpTool;
      });
    },
    async callTool(toolName: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
      const result = asObject(await request('tools/call', { name: toolName, arguments: args }, signal));
      return 'data' in result ? result.data : result;
    },
    close() {
      if (!child) return;
      child.kill();
      child = null;
    },
  };
}

export function createExternalMcpRegistry(configs: ExternalMcpServerConfig[]) {
  const transports: Array<{ config: ExternalMcpServerConfig; transport: Transport }> = [];

  function addServer(config: ExternalMcpServerConfig) {
    removeServer(config.name);
    const transport = config.type === 'stdio' ? createStdioTransport(config) : createHttpTransport(config);
    transports.push({ config, transport });
  }

  function removeServer(name: string) {
    const idx = transports.findIndex((t) => t.config.name === name);
    if (idx >= 0) {
      transports[idx].transport.close();
      transports.splice(idx, 1);
    }
  }

  // Initialize from constructor configs
  for (const config of configs) {
    if (config.enabled !== false && config.name) addServer(config);
  }

  return {
    async listTools(): Promise<ExternalMcpTool[]> {
      const all: ExternalMcpTool[] = [];
      for (const { transport, config } of transports) {
        try {
          const tools = await transport.listTools();
          all.push(...tools);
        } catch (err) {
          console.error(`[mcp] listTools failed for ${config.name}:`, (err as Error).message);
        }
      }
      return all;
    },
    async callTool(qualifiedName: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
      const match = /^mcp__([^_]+)__(.+)$/.exec(qualifiedName);
      if (!match) throw new Error(`Invalid external MCP tool name: ${qualifiedName}`);
      const [, serverName, toolName] = match;
      const item = transports.find((t) => t.config.name === serverName);
      if (!item) throw new Error(`External MCP server not found: ${serverName}`);
      return item.transport.callTool(toolName, args, signal);
    },
    hasExternalTools() {
      return transports.length > 0;
    },
    addServer,
    removeServer,
    listServers() {
      return transports.map((t) => ({ ...t.config }));
    },
    normalizeToolName,
  };
}
