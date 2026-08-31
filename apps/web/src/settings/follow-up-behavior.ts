import type { FollowUpBehavior } from '../types';

const STORAGE_KEY = 'dexcode.follow-up-behavior.v1';

export function readFollowUpBehavior(): FollowUpBehavior {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'steer' ? 'steer' : 'queue';
  } catch {
    return 'queue';
  }
}

export function writeFollowUpBehavior(value: FollowUpBehavior) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // A blocked storage backend should not prevent sending a follow-up.
  }
}
