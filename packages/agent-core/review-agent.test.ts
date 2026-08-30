import assert from 'node:assert/strict';
import test from 'node:test';
import { runReviewAgent } from './review-agent.ts';

test('reviews only original prompt, subtask description, and file diffs', async () => {
  const seen: unknown[] = [];
  const review = await runReviewAgent({
    originalPrompt: '修复 token 校验',
    subTaskDescription: '修改 auth.ts',
    diff: [{ path: 'auth.ts', before: 'old', after: 'new' }],
    modelClient: {
      model: 'mock',
      baseUrl: '',
      createMessage: async (messages: unknown[]) => {
        seen.push(messages);
        return {
          choices: [{
            message: {
              content: JSON.stringify({ passed: true, issues: [], suggestions: [] }),
            },
            finish_reason: 'stop',
          }],
        };
      },
      streamMessage: async function* () {},
    },
    executionHistory: [{ role: 'assistant', content: 'must not leak' }] as never,
  });

  const serialized = JSON.stringify(seen);
  assert.equal(review.passed, true);
  assert.equal(serialized.includes('must not leak'), false);
  assert.equal(serialized.includes('auth.ts'), true);
});
