import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WAITING_STATUS_THRESHOLD_MS,
  WAITING_STATUS_TEXT,
  startWaitingStatusMonitor,
} from '@core/app/bootstrap/live-execution-waiting-status.js';

type WaitingResult = {
  conversationJid: string;
  threadId: string | null;
  waitingSince: string;
  ageSeconds: number;
} | null;

function makeMonitor(input: {
  results: WaitingResult[];
  thresholdMs?: number;
}) {
  const sent: Array<{ jid: string; text: string }> = [];
  let index = 0;
  let queued: (() => Promise<void>) | undefined;
  const monitor = startWaitingStatusMonitor({
    liveTurns: {
      getOldestWaitingLiveAdmission: vi.fn(async () => {
        const result = input.results[Math.min(index, input.results.length - 1)];
        index += 1;
        return result;
      }),
    },
    getConversationJids: () => ['tg:a', 'tg:b'],
    sendStatus: async (jid, text) => {
      sent.push({ jid, text });
    },
    warn: vi.fn(),
    thresholdMs: input.thresholdMs ?? 15_000,
    // Capture the interval callback so the test drives ticks deterministically.
    setIntervalFn: ((fn: () => void) => {
      queued = fn as unknown as () => Promise<void>;
      return 0 as never;
    }) as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
  });
  const tick = async () => {
    await queued?.();
    // Allow the async tick body to settle.
    await Promise.resolve();
    await Promise.resolve();
  };
  return { monitor, sent, tick };
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.restoreAllMocks());

describe('startWaitingStatusMonitor', () => {
  it('defaults the visible waiting status threshold to 30 seconds', () => {
    expect(WAITING_STATUS_THRESHOLD_MS).toBe(30_000);
  });

  it('uses user-facing copy without worker or capacity jargon', () => {
    expect(WAITING_STATUS_TEXT).toBe('Still starting this request.');
    expect(WAITING_STATUS_TEXT).not.toMatch(
      /worker|capacity|slot|saturat|admission/i,
    );
  });

  it('sends the visible status once per waiting episode past the threshold', async () => {
    const { sent, tick, monitor } = makeMonitor({
      results: [
        {
          conversationJid: 'tg:a',
          threadId: null,
          waitingSince: '2026-06-11T00:00:00.000Z',
          ageSeconds: 30,
        },
      ],
      thresholdMs: 15_000,
    });
    await tick();
    await tick();
    expect(sent).toEqual([{ jid: 'tg:a', text: WAITING_STATUS_TEXT }]);
    expect(monitor.oldestWaitingSeconds()).toBe(30);
  });

  it('does not send while below the threshold but still reports the age', async () => {
    const { sent, tick, monitor } = makeMonitor({
      results: [
        {
          conversationJid: 'tg:a',
          threadId: null,
          waitingSince: '2026-06-11T00:00:00.000Z',
          ageSeconds: 5,
        },
      ],
      thresholdMs: 15_000,
    });
    await tick();
    expect(sent).toEqual([]);
    expect(monitor.oldestWaitingSeconds()).toBe(5);
  });

  it('resets the episode and re-notifies after the queue clears then backs up again', async () => {
    const waiting = {
      conversationJid: 'tg:a',
      threadId: null,
      waitingSince: '2026-06-11T00:00:00.000Z',
      ageSeconds: 30,
    };
    const { sent, tick } = makeMonitor({
      // wait → clear → wait again
      results: [waiting, null, waiting],
      thresholdMs: 15_000,
    });
    await tick(); // sends
    await tick(); // queue cleared → episode reset, age 0
    await tick(); // backed up again → sends a second time
    expect(sent).toEqual([
      { jid: 'tg:a', text: WAITING_STATUS_TEXT },
      { jid: 'tg:a', text: WAITING_STATUS_TEXT },
    ]);
  });

  it('reports 0 and clears episodes when nothing is waiting', async () => {
    const { sent, tick, monitor } = makeMonitor({ results: [null] });
    await tick();
    expect(sent).toEqual([]);
    expect(monitor.oldestWaitingSeconds()).toBe(0);
  });
});
