import { createHash } from 'node:crypto';
import type {
  ChatMessage,
  CompactionCheckpoint,
  ContextCompactionStrategy,
  ContextManifestV1,
  SystemMessage,
} from '../shared/types.ts';

export type LegacyHistoryProjection = {
  messages: ChatMessage[];
  manifest: ContextManifestV1;
  checkpoint?: CompactionCheckpoint;
};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pairedMessages(messages: ChatMessage[]): ChatMessage[] {
  const knownCalls = new Set<string>();
  const result: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) knownCalls.add(call.id);
      result.push(message);
    } else if (message.role !== 'tool' || knownCalls.has(message.tool_call_id)) {
      result.push(message);
    }
  }
  return result;
}

function messagePreview(message: ChatMessage): string {
  if (message.role === 'assistant') {
    const tools = message.tool_calls?.map((call) => call.function.name).join(', ');
    return `assistant: ${(message.content ?? '').slice(0, 600)}${tools ? ` [tools: ${tools}]` : ''}`;
  }
  if (message.role === 'tool') return `tool(${message.name}): ${message.content.slice(0, 400)}`;
  return `${message.role}: ${message.content.slice(0, 600)}`;
}

export function contextCompactionStrategy(
  environment: Record<string, string | undefined> = process.env,
): ContextCompactionStrategy {
  const value = environment.CONTEXT_COMPACTION_STRATEGY?.trim().toLowerCase();
  if (value === undefined || value === '') return 'four_layer';
  if (value === 'four_layer' || value === 'legacy') return value;
  throw new Error('Invalid context strategy: CONTEXT_COMPACTION_STRATEGY must be four_layer or legacy');
}

export function projectLegacyHistory(
  runId: string,
  messages: ChatMessage[],
  maxEstimatedTokens = 12_000,
): LegacyHistoryProjection {
  if (!Number.isFinite(maxEstimatedTokens) || maxEstimatedTokens <= 0) {
    throw new Error('Legacy context token limit must be a positive number');
  }
  const paired = pairedMessages(messages);
  const serialized = JSON.stringify(paired);
  const estimated = Math.ceil(serialized.length / 4);
  if (estimated <= maxEstimatedTokens) {
    return {
      messages: paired,
      manifest: {
        version: 1,
        id: crypto.randomUUID(),
        runId,
        estimatedInputTokens: estimated,
        selectedMessageCount: paired.length,
        omittedMessageCount: 0,
        requestDigest: digest(serialized),
      },
    };
  }

  const retainedCharBudget = Math.floor(maxEstimatedTokens * 4 * 0.65);
  let retainedChars = 0;
  let start = paired.length;
  while (start > 0 && retainedChars < retainedCharBudget) {
    start -= 1;
    retainedChars += JSON.stringify(paired[start]).length;
  }
  while (start < paired.length && paired[start]?.role !== 'user') start += 1;
  const retained = paired.slice(start);
  const omitted = paired.slice(0, start);
  const summary = omitted.map(messagePreview).join('\n').slice(0, 8_000);
  const checkpoint: CompactionCheckpoint = {
    version: 1,
    id: crypto.randomUUID(),
    sourceMessageCount: omitted.length,
    sourceDigest: digest(JSON.stringify(omitted)),
    summary,
    strategyVersion: 'deterministic-summary-v1',
  };
  const checkpointMessage: SystemMessage = {
    role: 'system',
    content: `## Previous conversation checkpoint\n${summary}`,
  };
  const selected = [checkpointMessage, ...retained];
  return {
    messages: selected,
    manifest: {
      version: 1,
      id: crypto.randomUUID(),
      runId,
      estimatedInputTokens: Math.ceil(JSON.stringify(selected).length / 4),
      selectedMessageCount: retained.length,
      omittedMessageCount: omitted.length,
      requestDigest: digest(JSON.stringify(selected)),
      checkpointId: checkpoint.id,
    },
    checkpoint,
  };
}
