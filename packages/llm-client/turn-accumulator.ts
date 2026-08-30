import type {
  JsonObject,
  ModelEvent,
  ModelResponse,
  ModelToolCall,
  ModelTurnResult,
} from './types.ts';

export type ModelProtocolErrorCode =
  | 'MODEL_EVENT_AFTER_TERMINAL'
  | 'MODEL_EVENT_BEFORE_START'
  | 'MODEL_EVENT_DUPLICATE_START'
  | 'MODEL_EVENT_INVALID_TOOL_INDEX'
  | 'MODEL_EVENT_INCOMPLETE_TOOL_CALL'
  | 'MODEL_EVENT_RESPONSE_MISMATCH'
  | 'MODEL_EVENT_NOT_TERMINAL'
  | 'MODEL_TOOL_ARGUMENTS_INVALID';

export class ModelProtocolError extends Error {
  readonly code: ModelProtocolErrorCode;

  constructor(code: ModelProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ModelProtocolError';
    this.code = code;
  }
}

type PartialToolCall = { id: string; name: string; argumentsText: string };

function parseArguments(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new TypeError('tool arguments must be a JSON object');
    }
    return parsed as JsonObject;
  } catch (error) {
    throw new ModelProtocolError(
      'MODEL_TOOL_ARGUMENTS_INVALID',
      error instanceof Error ? error.message : 'tool arguments are invalid JSON',
    );
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class ModelTurnAccumulator {
  #started = false;
  #terminal?: ModelTurnResult;
  #text = '';
  #reasoning = '';
  #tools = new Map<number, PartialToolCall>();
  #producedSemanticOutput = false;

  accept(event: ModelEvent): void {
    if (this.#terminal) {
      throw new ModelProtocolError('MODEL_EVENT_AFTER_TERMINAL', 'terminal event must be last');
    }
    if (event.type === 'turn_started') {
      if (this.#started) {
        throw new ModelProtocolError('MODEL_EVENT_DUPLICATE_START', 'turn_started must occur once');
      }
      this.#started = true;
      return;
    }
    if (!this.#started) {
      throw new ModelProtocolError('MODEL_EVENT_BEFORE_START', 'stream must start with turn_started');
    }

    if (event.type === 'text_delta') {
      this.#text += event.delta;
      if (event.delta) this.#producedSemanticOutput = true;
      return;
    }
    if (event.type === 'reasoning_delta') {
      this.#reasoning += event.delta;
      if (event.delta) this.#producedSemanticOutput = true;
      return;
    }
    if (event.type === 'tool_call_delta') {
      if (!Number.isSafeInteger(event.index) || event.index < 0) {
        throw new ModelProtocolError('MODEL_EVENT_INVALID_TOOL_INDEX', 'tool index must be non-negative');
      }
      const current = this.#tools.get(event.index) ?? { id: '', name: '', argumentsText: '' };
      if (event.id !== undefined) {
        if (current.id && current.id !== event.id) {
          throw new ModelProtocolError('MODEL_EVENT_INCOMPLETE_TOOL_CALL', 'tool call id changed');
        }
        current.id = event.id;
      }
      if (event.name !== undefined) {
        if (current.name && current.name !== event.name) {
          throw new ModelProtocolError('MODEL_EVENT_INCOMPLETE_TOOL_CALL', 'tool call name changed');
        }
        current.name = event.name;
      }
      current.argumentsText += event.argumentsDelta ?? '';
      this.#tools.set(event.index, current);
      this.#producedSemanticOutput = true;
      return;
    }
    if (event.type === 'turn_failed') {
      this.#terminal = {
        status: 'failed',
        failure: event.failure,
        producedSemanticOutput: this.#producedSemanticOutput,
      };
      return;
    }

    const toolCalls: ModelToolCall[] = [...this.#tools.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => {
        if (!call.id || !call.name) {
          throw new ModelProtocolError(
            'MODEL_EVENT_INCOMPLETE_TOOL_CALL',
            'tool call requires stable id and name',
          );
        }
        return { id: call.id, name: call.name, arguments: parseArguments(call.argumentsText) };
      });
    const reduced: ModelResponse = {
      content: this.#text,
      reasoning: this.#reasoning,
      toolCalls,
      finishReason: event.response.finishReason,
      ...(event.response.usage ? { usage: event.response.usage } : {}),
    };
    if (!same(reduced, event.response)) {
      throw new ModelProtocolError(
        'MODEL_EVENT_RESPONSE_MISMATCH',
        'terminal response does not match streamed deltas',
      );
    }
    this.#terminal = { status: 'completed', response: reduced };
  }

  result(): ModelTurnResult {
    if (!this.#terminal) {
      throw new ModelProtocolError('MODEL_EVENT_NOT_TERMINAL', 'model stream ended without terminal');
    }
    return this.#terminal;
  }

  producedSemanticOutput(): boolean {
    return this.#producedSemanticOutput;
  }
}

export async function collectModelTurn(events: AsyncIterable<ModelEvent>): Promise<ModelTurnResult> {
  const accumulator = new ModelTurnAccumulator();
  try {
    for await (const event of events) accumulator.accept(event);
    return accumulator.result();
  } catch (error) {
    return {
      status: 'failed',
      failure: {
        category: error instanceof ModelProtocolError ? 'invalid_response' : 'adapter_bug',
        retryable: false,
        message: error instanceof Error ? error.message : 'model adapter failed',
      },
      producedSemanticOutput: accumulator.producedSemanticOutput(),
    };
  }
}
