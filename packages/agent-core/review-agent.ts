import type { ModelClient } from '../llm-client/index.ts';
import type { ChatMessage, FileDiff, ReviewIssue, ReviewOutput } from '../shared/types.ts';

type ReviewAgentInput = {
  originalPrompt: string;
  diff: FileDiff[];
  subTaskDescription?: string;
  modelClient?: ModelClient;
  executionHistory?: ChatMessage[];
};

function fallbackReview(diff: FileDiff[]): ReviewOutput {
  const issues: ReviewIssue[] = diff.length === 0
    ? [{ severity: 'warning' as const, file: '', description: 'No file diff was produced.' }]
    : diff
      .filter((item) => item.before === item.after)
      .map((item) => ({
        severity: 'warning' as const,
        file: item.path,
        description: 'File content did not change.',
      }));

  return { passed: issues.every((issue) => issue.severity !== 'error'), issues, suggestions: [] };
}

function parseReview(content: string, diff: FileDiff[]): ReviewOutput {
  try {
    const parsed = JSON.parse(content) as Partial<ReviewOutput>;
    return {
      passed: Boolean(parsed.passed),
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      retryInstruction: parsed.retryInstruction,
    };
  } catch {
    return fallbackReview(diff);
  }
}

export async function runReviewAgent(input: ReviewAgentInput): Promise<ReviewOutput> {
  if (!input.modelClient) {
    return fallbackReview(input.diff);
  }

  const messages = [
    {
      role: 'system',
      content: [
        'You are an independent code review agent.',
        'Review only the original request, subtask, and file diffs.',
        'Return JSON: {"passed":boolean,"issues":[],"suggestions":[],"retryInstruction":string}.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        originalPrompt: input.originalPrompt,
        subTaskDescription: input.subTaskDescription,
        diff: input.diff,
      }, null, 2),
    },
  ];

  const result = await input.modelClient.createMessage(messages);
  const choice = (result as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0];
  return parseReview(choice?.message?.content ?? '', input.diff);
}
