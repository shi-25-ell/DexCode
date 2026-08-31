import type { RunEventEnvelope } from './contracts.ts';

export type RunReplayResult =
  | { status: 'missing'; events: [] }
  | { status: 'available'; events: RunEventEnvelope[]; windowExceeded: boolean };

type StoredRun = {
  events: Array<{ event: RunEventEnvelope; bytes: number }>;
  bytes: number;
  touched: number;
};

export function createRunReplayBuffer(options: { maxRuns?: number; maxEventsPerRun?: number; maxBytesPerRun?: number } = {}) {
  const maxRuns = Math.max(1, options.maxRuns ?? 64);
  const maxEventsPerRun = Math.max(8, options.maxEventsPerRun ?? 512);
  const maxBytesPerRun = Math.max(32_768, options.maxBytesPerRun ?? 2 * 1024 * 1024);
  const runs = new Map<string, StoredRun>();
  let clock = 0;

  function touch(run: StoredRun) {
    clock += 1;
    run.touched = clock;
  }

  function trimRuns() {
    while (runs.size > maxRuns) {
      let oldest: [string, StoredRun] | undefined;
      for (const item of runs) if (!oldest || item[1].touched < oldest[1].touched) oldest = item;
      if (!oldest) return;
      runs.delete(oldest[0]);
    }
  }

  function append(event: RunEventEnvelope): void {
    let run = runs.get(event.runId);
    if (!run) {
      run = { events: [], bytes: 0, touched: 0 };
      runs.set(event.runId, run);
    }
    const last = run.events.at(-1)?.event;
    if (last && event.seq <= last.seq) {
      if (event.seq === last.seq && JSON.stringify(event) === JSON.stringify(last)) return;
      throw new Error(`Replay buffer received out-of-order event for ${event.runId}`);
    }
    const bytes = JSON.stringify(event).length;
    run.events.push({ event, bytes });
    run.bytes += bytes;
    touch(run);
    while (run.events.length > maxEventsPerRun || run.bytes > maxBytesPerRun) {
      const removed = run.events.shift();
      if (!removed) break;
      run.bytes -= removed.bytes;
    }
    trimRuns();
  }

  function read(runId: string, afterSeq = 0): RunReplayResult {
    const run = runs.get(runId);
    if (!run || run.events.length === 0) return { status: 'missing', events: [] };
    touch(run);
    const firstSeq = run.events[0]!.event.seq;
    return {
      status: 'available',
      events: run.events.filter((item) => item.event.seq > afterSeq).map((item) => item.event),
      windowExceeded: afterSeq + 1 < firstSeq,
    };
  }

  return { append, read };
}

