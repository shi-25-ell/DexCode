import type { UserMessage } from '../shared/types.ts';

export type RunCommandDecision =
  | { action: 'continue'; steer: UserMessage; itemId: string; directive: string; refreshContext?: boolean; updateActiveRequest?: boolean }
  | { action: 'proceed' }
  | { action: 'finish' }
  | { action: 'stop' };

export interface RunCommandSource {
  atSafeBoundary(input: {
    sessionId: string;
    runId: string;
    remainingModelTurns: number;
    wouldNaturallyComplete: boolean;
  }): Promise<RunCommandDecision>;
}
