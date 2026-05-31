import { describe, expect, it } from 'vitest';

import { runtimeJobSchedulePlanner } from '@core/jobs/job-schedule-planner.js';

function expectThrowsCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('Expected function to throw');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('runtimeJobSchedulePlanner', () => {
  it('creates deterministic readable scheduler job ids', () => {
    const input = {
      name: 'Daily Review!',
      prompt: 'Review memory',
      scheduleType: 'interval',
      scheduleValue: '60000',
      workspaceKey: 'team',
    };

    expect(runtimeJobSchedulePlanner.createJobId(input)).toBe(
      runtimeJobSchedulePlanner.createJobId(input),
    );
    expect(runtimeJobSchedulePlanner.createJobId(input)).toMatch(
      /^job-daily-review-[a-f0-9]{12}$/,
    );
  });

  it('maps invalid app schedules to invalid_schedule', () => {
    expectThrowsCode(
      () =>
        runtimeJobSchedulePlanner.planAppSchedule({
          kind: 'once',
          runAt: '',
        }),
      'INVALID_SCHEDULE',
    );
    expectThrowsCode(
      () =>
        runtimeJobSchedulePlanner.planAppSchedule({
          kind: 'recurring',
          schedule: { type: 'interval', value: '0' },
        }),
      'INVALID_SCHEDULE',
    );
    expectThrowsCode(
      () =>
        runtimeJobSchedulePlanner.planAppSchedule({
          kind: 'recurring',
          schedule: { type: 'cron', value: '' },
        }),
      'INVALID_SCHEDULE',
    );
  });

  it('maps invalid initial schedules to invalid_schedule', () => {
    expectThrowsCode(
      () =>
        runtimeJobSchedulePlanner.planInitial({
          scheduleType: 'cron',
          scheduleValue: 'not cron',
        }),
      'INVALID_SCHEDULE',
    );
    expectThrowsCode(
      () =>
        runtimeJobSchedulePlanner.planInitial({
          scheduleType: 'interval',
          scheduleValue: '-1',
        }),
      'INVALID_SCHEDULE',
    );
    expectThrowsCode(
      () =>
        runtimeJobSchedulePlanner.planInitial({
          scheduleType: 'once',
          scheduleValue: 'not a date',
        }),
      'INVALID_SCHEDULE',
    );
  });

  it('normalizes once schedules with offsets to UTC ISO next_run values', () => {
    expect(
      runtimeJobSchedulePlanner.planInitial({
        scheduleType: 'once',
        scheduleValue: '2026-05-19T09:30:00+05:30',
      }),
    ).toEqual({ nextRun: '2026-05-19T04:00:00.000Z' });
  });

  it('returns undefined for invalid resume schedules', () => {
    expect(
      runtimeJobSchedulePlanner.planResume({
        clock: { now: () => '2026-04-24T00:00:00.000Z' },
        job: {
          schedule_type: 'interval',
          schedule_value: '0',
          next_run: null,
        } as never,
      }),
    ).toBeUndefined();
  });
});
