import { createHash } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalSubject,
  ToolApprovalRequest,
  ToolApprovalResponse,
} from '../shared/types.ts';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function createApprovalFingerprint(input: {
  toolName: string;
  effect: ApprovalSubject['effect'];
  normalizedInput: unknown;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(input)))
    .digest('hex');
}

export function authorizeApproval(subject: ApprovalSubject, mode: ApprovalMode): ApprovalDecision {
  if (subject.hardDeniedReason) {
    return { outcome: 'deny', reason: subject.hardDeniedReason };
  }
  if (subject.origin === 'user_ui') {
    return { outcome: 'allow', reason: '用户直接操作不进入 Agent 批准流' };
  }
  if (subject.effect === 'interactive') {
    return { outcome: 'allow', reason: '交互工具保持原有用户交互' };
  }
  if (subject.effect === 'read') {
    return { outcome: 'allow', reason: '只读操作自动允许' };
  }
  if (subject.matchedRule) {
    return { outcome: 'allow', reason: '命令命中当前项目白名单', matchedRule: subject.matchedRule };
  }
  if (mode === 'full_access') {
    return { outcome: 'allow', reason: '完全访问模式跳过普通批准' };
  }
  if (mode === 'allowlist' && subject.effect === 'write') {
    return { outcome: 'allow', reason: '白名单模式允许工作区文件修改' };
  }
  const options = subject.effect === 'execute'
    ? ['allow_once', 'allow_whitelist', 'deny'] as const
    : ['allow_once', 'deny'] as const;
  return {
    outcome: 'ask',
    reason: mode === 'read_only'
      ? '只读模式需要批准此副作用'
      : '当前操作需要用户批准',
    options: [...options],
  };
}

export type ApprovalPolicy = {
  authorize(subject: ApprovalSubject, mode: ApprovalMode): ApprovalDecision;
};

export function createApprovalPolicy(): ApprovalPolicy {
  return { authorize: authorizeApproval };
}

export type ToolApprovalHook = (request: ToolApprovalRequest) => Promise<ToolApprovalResponse>;
