import { describe, expect, it } from 'vitest';
import { isTimelineNearBottom } from './scroll-follow';

describe('timeline follow policy', () => {
  it('keeps following at the bottom and stops after the user moves away', () => {
    expect(isTimelineNearBottom({ scrollHeight: 1_000, scrollTop: 700, clientHeight: 300 })).toBe(true);
    expect(isTimelineNearBottom({ scrollHeight: 1_000, scrollTop: 400, clientHeight: 300 })).toBe(false);
  });
});
