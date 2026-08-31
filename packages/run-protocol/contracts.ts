import type {
  ApprovalEffect,
  ApprovalOption,
  ContextPresentation,
  ContextUsageSnapshot,
  QueueItemView,
  QueuePauseReason,
  RunStatus,
  ToolPresentation,
} from '../shared/types.ts';
import type { ConversationViewSnapshot } from '../conversation-view/contracts.ts';

export type RunPhase =
  | 'preparing_context'
  | 'requesting_model'
  | 'thinking'
  | 'answering'
  | 'preparing_tool'
  | 'waiting_approval'
  | 'running_tool'
  | 'retrying'
  | 'finalizing';

export type SafeRunNote = string & { readonly __safeRunNote: unique symbol };

export type AssistantContentKind = 'text' | 'reasoning' | 'tool_input';

export type CommittedAssistantContentBlock = {
  contentIndex: number;
  kind: 'text' | 'reasoning';
  content: string;
  truncated?: boolean;
};

export type CommittedAssistantToolCall = {
  contentIndex: number;
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  truncated?: boolean;
};

export type CommittedAssistantMessage = {
  messageId: string;
  turn: number;
  content: string;
  contentBlocks: CommittedAssistantContentBlock[];
  toolCalls: CommittedAssistantToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown';
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  };
  truncated?: boolean;
};

export type RunApprovalRequest =
  | {
      kind: 'tool';
      approvalId: string;
      toolName: string;
      effect: ApprovalEffect;
      title: string;
      target?: string;
      reason: string;
      fingerprint: string;
      options: ApprovalOption[];
    }
  | {
      kind: 'command';
      approvalId: string;
      title: string;
      target: string;
      reason: string;
      options: ApprovalOption[];
    }
  | {
      kind: 'question';
      approvalId: string;
      title: string;
      options: string[];
    };

export type RunTerminal = {
  status: RunStatus;
  reason: string;
  error?: { code: string; message: string };
};

export type RunEventPayload =
  | { type: 'run_started'; sessionId: string; isNew?: boolean; sourceItemId?: string }
  | { type: 'run_phase_changed'; phase: RunPhase; note?: SafeRunNote }
  | { type: 'assistant_message_started'; turn: number; messageId: string }
  | {
      type: 'assistant_content_delta';
      messageId: string;
      contentIndex: number;
      kind: AssistantContentKind;
      delta: string;
    }
  | { type: 'assistant_message_committed'; turn: number; message: CommittedAssistantMessage }
  | { type: 'tool_started'; callId: string; presentation: ToolPresentation }
  | { type: 'tool_progress'; callId: string; presentation: ToolPresentation }
  | { type: 'tool_finished'; callId: string; presentation: ToolPresentation }
  | { type: 'approval_requested'; request: RunApprovalRequest }
  | { type: 'approval_resolved'; approvalId: string; decision: string }
  | { type: 'context_usage_changed'; usage: ContextUsageSnapshot }
  | { type: 'context_activity_changed'; presentation: ContextPresentation }
  | { type: 'skill_activity'; skill: string; action: string }
  | { type: 'queue_item_added'; sessionId: string; item: QueueItemView; sessionRevision: number }
  | { type: 'queue_item_updated'; sessionId: string; item: QueueItemView; sessionRevision: number }
  | { type: 'queue_item_removed'; sessionId: string; itemId: string; reason: string; sessionRevision: number }
  | { type: 'queue_reordered'; sessionId: string; orderedItemIds: string[]; sessionRevision: number }
  | { type: 'user_message_committed'; sessionId: string; itemId: string }
  | { type: 'context_refresh_started'; sessionId: string; itemId: string }
  | { type: 'context_refresh_completed'; sessionId: string; itemId: string }
  | { type: 'context_refresh_failed'; sessionId: string; itemId: string; message: string }
  | { type: 'run_chain_paused'; sessionId: string; reason: QueuePauseReason }
  | {
      type: 'run_finished';
      terminal: RunTerminal;
      conversationRevision: number;
      finalMessageId?: string;
      conversation: ConversationViewSnapshot;
      legacyResult?: unknown;
    }
  | { type: 'resync_required'; reason: 'replay_window_exceeded'; conversation?: ConversationViewSnapshot }
  | { type: 'stream_error'; message: string };

export type RunEventEnvelope<T extends RunEventPayload = RunEventPayload> = {
  version: 2;
  runId: string;
  seq: number;
  at: string;
  event: T;
};

export type RunEventSink = (envelope: RunEventEnvelope) => void;
