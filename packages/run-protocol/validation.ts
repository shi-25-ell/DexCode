import type { RunEventEnvelope, RunEventPayload, SafeRunNote } from './contracts.ts';

export class RunProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunProtocolError';
  }
}

const SECRET_PATTERN = /(authorization\s*[:=]\s*(?:bearer\s+)?|bearer\s+|api[_-]?key\s*[:=]\s*|token\s*[:=]\s*)\S+/gi;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s,;]+/g;
const UNIX_HOME_PATTERN = /\/(?:home|Users)\/[^\s,;]+/g;

export function safeRunNote(value: unknown): SafeRunNote | undefined {
  if (typeof value !== 'string') return undefined;
  const safe = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(SECRET_PATTERN, '$1[已隐藏]')
    .replace(WINDOWS_PATH_PATTERN, '[已隐藏路径]')
    .replace(UNIX_HOME_PATTERN, '[已隐藏路径]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return safe ? safe as SafeRunNote : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseRunEventEnvelope(value: unknown): RunEventEnvelope {
  if (!isRecord(value) || value.version !== 2) throw new RunProtocolError('Run event version must be 2');
  if (typeof value.runId !== 'string' || !value.runId) throw new RunProtocolError('Run event requires runId');
  if (!Number.isSafeInteger(value.seq) || Number(value.seq) <= 0) throw new RunProtocolError('Run event requires a positive integer seq');
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) throw new RunProtocolError('Run event requires an ISO timestamp');
  if (!isRecord(value.event) || typeof value.event.type !== 'string') throw new RunProtocolError('Run event requires a typed payload');
  return value as RunEventEnvelope;
}

export function isDroppableRunEvent(event: RunEventEnvelope | RunEventPayload): boolean {
  const payload = 'event' in event ? event.event : event;
  return payload.type === 'assistant_content_delta'
    || payload.type === 'tool_progress'
    || payload.type === 'context_usage_changed';
}

export function coalesceRunEvents(previous: RunEventEnvelope, next: RunEventEnvelope): RunEventEnvelope | undefined {
  if (previous.runId !== next.runId) return undefined;
  if (previous.event.type === 'assistant_content_delta' && next.event.type === 'assistant_content_delta') {
    if (
      previous.event.messageId === next.event.messageId
      && previous.event.contentIndex === next.event.contentIndex
      && previous.event.kind === next.event.kind
      && previous.event.delta.length + next.event.delta.length <= 16_384
    ) {
      return {
        ...next,
        event: { ...next.event, delta: previous.event.delta + next.event.delta },
      };
    }
  }
  if (previous.event.type === 'tool_progress' && next.event.type === 'tool_progress' && previous.event.callId === next.event.callId) {
    return next;
  }
  if (previous.event.type === 'context_usage_changed' && next.event.type === 'context_usage_changed') return next;
  return undefined;
}

export class RunEventSequenceValidator {
  readonly runId: string;
  #lastSeq = 0;
  #terminal = false;
  #messages = new Map<string, { turn: number; committed: boolean }>();
  #tools = new Map<string, 'started' | 'finished'>();
  #approvals = new Set<string>();
  #accepted = new Map<number, string>();

  constructor(runId: string) {
    if (!runId) throw new RunProtocolError('Validator requires runId');
    this.runId = runId;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  accept(input: RunEventEnvelope): 'accepted' | 'duplicate' {
    const envelope = parseRunEventEnvelope(input);
    if (envelope.runId !== this.runId) throw new RunProtocolError('Run event crossed runId');
    const serialized = JSON.stringify(envelope);
    if (envelope.seq <= this.#lastSeq) {
      if (this.#accepted.get(envelope.seq) === serialized) return 'duplicate';
      throw new RunProtocolError(`Run event is out of order at seq ${envelope.seq}`);
    }
    if (envelope.seq !== this.#lastSeq + 1) throw new RunProtocolError(`Run event has seq gap after ${this.#lastSeq}`);
    if (this.#terminal) throw new RunProtocolError('Run event arrived after terminal');
    if (this.#lastSeq === 0 && envelope.event.type !== 'run_started') throw new RunProtocolError('run_started must be first');
    if (this.#lastSeq > 0 && envelope.event.type === 'run_started') throw new RunProtocolError('run_started must be unique');

    this.#validatePayload(envelope.event);
    this.#lastSeq = envelope.seq;
    this.#accepted.set(envelope.seq, serialized);
    return 'accepted';
  }

  #validatePayload(event: RunEventPayload): void {
    if (event.type === 'assistant_message_started') {
      if (this.#messages.has(event.messageId)) throw new RunProtocolError(`Assistant message already started: ${event.messageId}`);
      this.#messages.set(event.messageId, { turn: event.turn, committed: false });
      return;
    }
    if (event.type === 'assistant_content_delta') {
      const message = this.#messages.get(event.messageId);
      if (!message || message.committed) throw new RunProtocolError(`Assistant delta references inactive message: ${event.messageId}`);
      return;
    }
    if (event.type === 'assistant_message_reset') {
      const message = this.#messages.get(event.messageId);
      if (!message || message.committed) throw new RunProtocolError(`Assistant reset references inactive message: ${event.messageId}`);
      return;
    }
    if (event.type === 'assistant_message_committed') {
      const message = this.#messages.get(event.message.messageId);
      if (!message || message.committed || message.turn !== event.turn || event.message.turn !== event.turn) {
        throw new RunProtocolError(`Assistant commit does not match its draft: ${event.message.messageId}`);
      }
      message.committed = true;
      return;
    }
    if (event.type === 'tool_started') {
      if (event.presentation.callRef !== event.callId) throw new RunProtocolError(`Tool presentation crossed callId: ${event.callId}`);
      if (this.#tools.has(event.callId)) throw new RunProtocolError(`Tool already started: ${event.callId}`);
      this.#tools.set(event.callId, 'started');
      return;
    }
    if (event.type === 'tool_progress') {
      if (event.presentation.callRef !== event.callId) throw new RunProtocolError(`Tool presentation crossed callId: ${event.callId}`);
      if (this.#tools.get(event.callId) !== 'started') throw new RunProtocolError(`Tool progress references inactive call: ${event.callId}`);
      return;
    }
    if (event.type === 'tool_finished') {
      if (event.presentation.callRef !== event.callId) throw new RunProtocolError(`Tool presentation crossed callId: ${event.callId}`);
      if (this.#tools.get(event.callId) !== 'started') throw new RunProtocolError(`Tool finish references inactive call: ${event.callId}`);
      this.#tools.set(event.callId, 'finished');
      return;
    }
    if (event.type === 'approval_requested') {
      if (this.#approvals.has(event.request.approvalId)) throw new RunProtocolError(`Approval already requested: ${event.request.approvalId}`);
      this.#approvals.add(event.request.approvalId);
      return;
    }
    if (event.type === 'approval_resolved') {
      if (!this.#approvals.has(event.approvalId)) throw new RunProtocolError(`Approval resolution has no request: ${event.approvalId}`);
      this.#approvals.delete(event.approvalId);
      return;
    }
    if (event.type === 'run_finished') this.#terminal = true;
  }
}
