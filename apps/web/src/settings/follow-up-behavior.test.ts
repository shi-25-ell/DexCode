import { beforeEach, describe, expect, it } from 'vitest';
import { deliveryForFollowUp, readFollowUpBehavior, writeFollowUpBehavior } from './follow-up-behavior';

describe('follow-up behavior', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to Queue and persists an explicit Steer preference', () => {
    expect(readFollowUpBehavior()).toBe('queue');
    writeFollowUpBehavior('steer');
    expect(readFollowUpBehavior()).toBe('steer');
  });

  it('keeps an explicit Steer delivery independent of the active Run phase', () => {
    expect(deliveryForFollowUp('queue')).toBe('next_run');
    expect(deliveryForFollowUp('steer')).toBe('steer');
  });
});
