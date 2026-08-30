export type JsonSchema = Record<string, unknown>;

export type McpToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
export type McpResourceHandler = () => unknown | Promise<unknown>;
export type McpPromptHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: McpToolHandler;
};

export type McpResourceDefinition = {
  name: string;
  description: string;
  uri: string;
  mimeType?: string;
  handler: McpResourceHandler;
};

export type McpPromptDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: McpPromptHandler;
};

export type McpCallResult = {
  success: boolean;
  tool: string;
  data?: unknown;
  error?: string;
};

export type McpReadResourceResult = {
  success: boolean;
  resource: string;
  data?: unknown;
  error?: string;
};

export type McpPromptResult = {
  success: boolean;
  prompt: string;
  data?: unknown;
  error?: string;
};

export type McpJsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
};

export type McpJsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function assertObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function validateSchema(input: Record<string, unknown>, schema: JsonSchema) {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const properties = assertObject(schema.properties);

  for (const key of required) {
    if (!(key in input)) return `Missing required property: ${key}`;
  }

  for (const [key, value] of Object.entries(input)) {
    const propSchema = assertObject(properties[key]);
    const expectedType = typeof propSchema.type === 'string' ? propSchema.type : undefined;
    if (!expectedType) continue;
    if (expectedType === 'array') {
      if (!Array.isArray(value)) return `Invalid type for ${key}: expected array`;
      continue;
    }
    if (expectedType === 'null') {
      if (value !== null) return `Invalid type for ${key}: expected null`;
      continue;
    }
    if (typeof value !== expectedType) return `Invalid type for ${key}: expected ${expectedType}`;
  }

  return null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function okResponse(id: string | number | null, result: unknown): McpJsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: string | number | null, code: number, message: string, data?: unknown): McpJsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export function createMcpServer(options: {
  tools: McpToolDefinition[];
  resources?: McpResourceDefinition[];
  prompts?: McpPromptDefinition[];
}) {
  const toolMap = new Map(options.tools.map((tool) => [tool.name, tool] as const));
  const resourceMap = new Map((options.resources ?? []).map((resource) => [resource.name, resource] as const));
  const promptMap = new Map((options.prompts ?? []).map((prompt) => [prompt.name, prompt] as const));

  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    const tool = toolMap.get(name);
    if (!tool) return { success: false, tool: name, error: `Tool not found: ${name}` };
    const validationError = validateSchema(args, tool.inputSchema);
    if (validationError) return { success: false, tool: name, error: validationError };
    try {
      const data = await tool.handler(args);
      return { success: true, tool: name, data };
    } catch (error: unknown) {
      return { success: false, tool: name, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async function readResource(name: string): Promise<McpReadResourceResult> {
    const resource = resourceMap.get(name);
    if (!resource) return { success: false, resource: name, error: `Resource not found: ${name}` };
    try {
      const data = await resource.handler();
      return { success: true, resource: name, data };
    } catch (error: unknown) {
      return { success: false, resource: name, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async function getPrompt(name: string, args: Record<string, unknown> = {}): Promise<McpPromptResult> {
    const prompt = promptMap.get(name);
    if (!prompt) return { success: false, prompt: name, error: `Prompt not found: ${name}` };
    const validationError = validateSchema(args, prompt.inputSchema);
    if (validationError) return { success: false, prompt: name, error: validationError };
    try {
      const data = await prompt.handler(args);
      return { success: true, prompt: name, data };
    } catch (error: unknown) {
      return { success: false, prompt: name, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  function listTools() {
    return options.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  function listResources() {
    return (options.resources ?? []).map(({ name, description, uri, mimeType }) => ({ name, description, uri, mimeType }));
  }

  function listPrompts() {
    return (options.prompts ?? []).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  async function jsonRpc(request: McpJsonRpcRequest): Promise<McpJsonRpcResponse | null> {
    const { id = null, method, params } = request;

    if (method === 'notifications/initialized') return null;

    if (method === 'initialize') {
      return okResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
          logging: {},
        },
        serverInfo: { name: 'ai-coding-agent-mcp', version: '0.1.0' },
      });
    }

    if (method === 'tools/list') return okResponse(id, { tools: listTools() });
    if (method === 'resources/list') return okResponse(id, { resources: listResources() });
    if (method === 'prompts/list') return okResponse(id, { prompts: listPrompts() });

    if (method === 'tools/call') {
      const record = toRecord(params);
      const result = await callTool(String(record.name ?? ''), toRecord(record.arguments));
      if (!result.success) return errorResponse(id, -32000, result.error ?? 'Tool call failed', result);
      return okResponse(id, result);
    }

    if (method === 'resources/read') {
      const record = toRecord(params);
      const result = await readResource(String(record.name ?? ''));
      if (!result.success) return errorResponse(id, -32000, result.error ?? 'Resource read failed', result);
      return okResponse(id, result);
    }

    if (method === 'prompts/get') {
      const record = toRecord(params);
      const result = await getPrompt(String(record.name ?? ''), toRecord(record.arguments));
      if (!result.success) return errorResponse(id, -32000, result.error ?? 'Prompt get failed', result);
      return okResponse(id, result);
    }

    return errorResponse(id, -32601, `Method not found: ${method}`);
  }

  return {
    listTools,
    listResources,
    listPrompts,
    callTool,
    readResource,
    getPrompt,
    jsonRpc,
  };
}

export type McpServer = ReturnType<typeof createMcpServer>;
