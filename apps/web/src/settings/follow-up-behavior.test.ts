import { beforeEach, describe, expect, it } from 'vitest';
import { readFollowUpBehavior, writeFollowUpBehavior } from './follow-up-behavior';

describe('follow-up behavior', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to Queue and persists an explicit Steer preference', () => {
    expect(readFollowUpBehavior()).toBe('queue');
    writeFollowUpBehavior('steer');
    expect(readFollowUpBehavior()).toBe('steer');
  });
});
