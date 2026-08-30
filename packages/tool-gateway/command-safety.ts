export type CommandRisk = 'low' | 'medium' | 'high';

export type WhitelistMatchType = 'exact' | 'prefix' | 'command';

export type WhitelistEntry = {
  id: string;
  pattern: string;
  matchType: WhitelistMatchType;
  label?: string;
  addedAt: string;
};

export type CommandValidation = {
  /** false = 语法/策略层面禁止，不进入确认流 */
  allowed: boolean;
  needsConfirmation: boolean;
  whitelisted: boolean;
  risk: CommandRisk;
  reason: string;
  normalizedCommand: string;
  timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;

/** 只读诊断命令（仅 read_lints 等内部调用，不经过用户确认） */
export const TRUSTED_READONLY_COMMANDS = [
  /^npx\s+tsc\s+--noEmit\b/i,
  /^npx\s+eslint\b/i,
  /^npm\s+run\s+lint\b/i,
];

const HIGH_RISK_SUBSTRINGS = [
  'rm -rf',
  'rm -r ',
  'del /f',
  'del /s',
  'format ',
  'mkfs',
  'dd if=',
  'git push --force',
  'git push -f',
  'shutdown',
  'reboot',
  ':(){',
];

const MEDIUM_RISK_SUBSTRINGS = [
  'npm install',
  'npm i ',
  'yarn add',
  'pnpm add',
  'pip install',
  'git push',
  'git reset',
  'git clean',
  'curl ',
  'wget ',
  'Invoke-WebRequest',
];

const HIGH_RISK_FIRST_TOKENS = new Set([
  'rm', 'del', 'erase', 'format', 'shutdown', 'reboot', 'curl', 'wget',
]);

const SHELL_WRAPPER_TOKENS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'powershell', 'pwsh', 'cmd',
]);

/** 禁止的 shell 元字符（execFile 虽不走 shell，但可防止误传与后续扩展） */
const FORBIDDEN_METACHAR = /[;&|`$<>]|(?:\$\()|(?:\|\|)|(?:&&)/;

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

export function getCommandBase(command: string): string {
  const normalized = normalizeCommand(command);
  const first = normalized.split(/\s+/)[0] ?? '';
  return first.replace(/^["']|["']$/g, '').toLowerCase();
}

export function isTrustedReadonlyCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  return TRUSTED_READONLY_COMMANDS.some((re) => re.test(normalized));
}

function matchWhitelistEntry(command: string, entry: WhitelistEntry): boolean {
  const normalized = normalizeCommand(command);
  const pattern = entry.pattern.trim();
  if (!pattern) return false;

  switch (entry.matchType) {
    case 'exact':
      return normalized === pattern;
    case 'prefix':
      return normalized.startsWith(pattern);
    case 'command':
      return getCommandBase(normalized) === pattern.toLowerCase();
    default:
      return false;
  }
}

export function isWhitelisted(command: string, entries: WhitelistEntry[]): boolean {
  return entries.some((e) => matchWhitelistEntry(command, e));
}

export function assessRisk(command: string): CommandRisk {
  const normalized = normalizeCommand(command);
  const lower = normalized.toLowerCase();
  const base = getCommandBase(normalized);

  if (HIGH_RISK_SUBSTRINGS.some((s) => lower.includes(s))) return 'high';
  if (HIGH_RISK_FIRST_TOKENS.has(base)) return 'high';
  if (SHELL_WRAPPER_TOKENS.has(base)) return 'high';

  if (MEDIUM_RISK_SUBSTRINGS.some((s) => lower.includes(s))) return 'medium';

  if (/^(npm|yarn|pnpm|npx|node|python|pytest|cargo|go)\b/i.test(normalized)) {
    return 'low';
  }

  return 'medium';
}

export function validateCommand(
  command: string,
  whitelist: WhitelistEntry[],
): CommandValidation {
  const normalizedCommand = normalizeCommand(command);

  if (!normalizedCommand) {
    return {
      allowed: false,
      needsConfirmation: false,
      whitelisted: false,
      risk: 'high',
      reason: '命令不能为空',
      normalizedCommand,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  if (FORBIDDEN_METACHAR.test(normalizedCommand)) {
    return {
      allowed: false,
      needsConfirmation: false,
      whitelisted: false,
      risk: 'high',
      reason: '命令包含不允许的 shell 元字符（; && | ` $ 等），请使用单一可执行命令',
      normalizedCommand,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  const base = getCommandBase(normalizedCommand);
  if (SHELL_WRAPPER_TOKENS.has(base)) {
    return {
      allowed: false,
      needsConfirmation: false,
      whitelisted: false,
      risk: 'high',
      reason: `不允许通过 ${base} 包装执行命令，请直接调用目标程序`,
      normalizedCommand,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  const risk = assessRisk(normalizedCommand);
  const whitelisted = isWhitelisted(normalizedCommand, whitelist);

  if (whitelisted) {
    return {
      allowed: true,
      needsConfirmation: false,
      whitelisted: true,
      risk,
      reason: '命令在白名单中，将直接执行',
      normalizedCommand,
      timeoutMs: timeoutForRisk(risk),
    };
  }

  return {
    allowed: true,
    needsConfirmation: true,
    whitelisted: false,
    risk,
    reason: riskReason(risk, normalizedCommand),
    normalizedCommand,
    timeoutMs: timeoutForRisk(risk),
  };
}

function timeoutForRisk(risk: CommandRisk): number {
  if (risk === 'high') return 30_000;
  if (risk === 'medium') return 120_000;
  return 60_000;
}

function riskReason(risk: CommandRisk, command: string): string {
  const base = getCommandBase(command);
  if (risk === 'high') return `高风险命令（${base}），执行前需确认`;
  if (risk === 'medium') return `中等风险命令（${base}），执行前需确认`;
  return `命令（${base}）不在白名单中，执行前需确认`;
}

export function suggestWhitelistPattern(command: string): Pick<WhitelistEntry, 'pattern' | 'matchType' | 'label'> {
  const normalized = normalizeCommand(command);
  const base = getCommandBase(normalized);
  const parts = normalized.split(/\s+/);

  if (parts.length <= 1) {
    return { pattern: normalized, matchType: 'exact', label: normalized };
  }

  if (/^(npm|yarn|pnpm)\s+run\s+\S+$/i.test(normalized)) {
    const prefix = parts.slice(0, 3).join(' ');
    return { pattern: prefix, matchType: 'prefix', label: `${prefix} *` };
  }

  if (/^(npm|yarn|pnpm)\s+(install|i|test|build|lint)\b/i.test(normalized)) {
    return { pattern: `${parts[0]} ${parts[1]}`, matchType: 'prefix', label: `${parts[0]} ${parts[1]} *` };
  }

  return { pattern: base, matchType: 'command', label: `命令: ${base}` };
}
