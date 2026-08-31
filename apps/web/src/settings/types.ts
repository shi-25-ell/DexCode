export type ToolInfo = {
  name: string;
  displayName: string;
  description: string;
  source: 'local' | 'external';
  enabled: boolean;
  callCount: number;
  successCount: number;
  avgDurationMs: number;
  lastCalledAt: string | null;
};

export type ToolLogEntry = {
  id: string;
  at: string;
  ok: boolean;
  durationMs: number;
  argsPreview: string;
  resultPreview: string;
  error?: string;
};

export type SkillInfo = {
  name: string;
  description: string;
  source: 'builtin' | 'project' | 'user' | 'imported';
  rootPath: string;
  enabled: boolean;
  allowImplicitInvocation: boolean;
  userInvocable: boolean;
  tags: string[];
  filePatterns: string[];
  requiredCapabilities: string[];
  missingCapabilities: string[];
  shadowed: boolean;
  usage: { readCount: number; activationCount: number; lastUsedAt: string | null };
};

export type SkillImportMode = 'local_path' | 'workspace_path' | 'inline_markdown';
export type SkillImportReport = {
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

export type WhitelistEntry = { id: string; pattern: string; matchType: 'exact' | 'prefix' | 'command'; label?: string; addedAt: string; source?: 'builtin' | 'user' };
export type ApprovalMode = 'read_only' | 'allowlist' | 'full_access';
export type ApprovalModeState = { version: 1; mode: ApprovalMode; revision: number; updatedAt: string; diagnostic?: string };
export type McpServer =
  | { name: string; type: 'http'; url: string; enabled?: boolean; headers?: Record<string, string> }
  | { name: string; type: 'stdio'; command: string; enabled?: boolean; args?: string[]; env?: Record<string, string> };
export type McpTool = { server: string; name: string; description: string; inputSchema?: Record<string, unknown> };
export type McpServerStatus = {
  name: string;
  type: McpServer['type'];
  state: 'idle' | 'connecting' | 'ready' | 'error';
  toolCount: number;
  protocolVersion?: string;
  serverName?: string;
  error?: string;
};
