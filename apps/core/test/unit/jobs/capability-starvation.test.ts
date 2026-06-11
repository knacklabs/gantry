import { describe, expect, it, vi } from 'vitest';

import type { RuntimeEventPublishInput } from '@core/domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import {
  CapabilityStarvationAlerter,
  fleetCanSatisfyRequiredCapabilities,
  fleetMissingRequiredCapabilities,
} from '@core/jobs/capability-starvation.js';

function signal(overrides: Record<string, unknown> = {}) {
  return {
    cause: 'pending_run' as const,
    appId: 'default',
    key: 'job-1',
    jobId: 'job-1',
    requiredCapabilities: ['toolchain:h1'],
    missingCapabilities: ['toolchain:h1'],
    ageSeconds: 600,
    ...overrides,
  };
}

describe('CapabilityStarvationAlerter', () => {
  it('emits one task.notification audit event with remediation', async () => {
    const events: RuntimeEventPublishInput[] = [];
    const alerter = new CapabilityStarvationAlerter({
      publishRuntimeEvent: async (event) => {
        events.push(event);
      },
    });
    const alerted = await alerter.alert(signal());
    expect(alerted).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(RUNTIME_EVENT_TYPES.TASK_NOTIFICATION);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.kind).toBe('capability_starvation');
    expect(payload.cause).toBe('pending_run');
    expect(payload.missing_capabilities).toEqual(['toolchain:h1']);
    expect(String(payload.next_action)).toContain('bake');
  });

  it('dedupes the same (cause,key) within the cooldown window', async () => {
    let nowMs = 1_000_000;
    const events: RuntimeEventPublishInput[] = [];
    const alerter = new CapabilityStarvationAlerter({
      publishRuntimeEvent: async (event) => {
        events.push(event);
      },
      cooldownMs: 60_000,
      now: () => nowMs,
    });
    expect(await alerter.alert(signal())).toBe(true);
    expect(await alerter.alert(signal())).toBe(false);
    nowMs += 60_001;
    expect(await alerter.alert(signal())).toBe(true);
    expect(events).toHaveLength(2);
  });

  it('alerts distinct causes and keys independently', async () => {
    const alerter = new CapabilityStarvationAlerter({
      publishRuntimeEvent: vi.fn(async () => {}),
    });
    expect(await alerter.alert(signal({ key: 'job-1' }))).toBe(true);
    expect(await alerter.alert(signal({ key: 'job-2' }))).toBe(true);
    expect(
      await alerter.alert(signal({ cause: 'no_eligible_recoverer' })),
    ).toBe(true);
  });

  it('re-allows alerting after a publish failure', async () => {
    let fail = true;
    const alerter = new CapabilityStarvationAlerter({
      publishRuntimeEvent: async () => {
        if (fail) throw new Error('boom');
      },
    });
    expect(await alerter.alert(signal())).toBe(false);
    fail = false;
    expect(await alerter.alert(signal())).toBe(true);
  });
});

describe('fleet capability satisfaction helpers', () => {
  it('is satisfiable when any active worker advertises a superset', () => {
    expect(
      fleetCanSatisfyRequiredCapabilities(
        ['skill:a'],
        [['browser'], ['skill:a', 'toolchain:h']],
      ),
    ).toBe(true);
  });

  it('is unsatisfiable when no worker covers the full set', () => {
    expect(
      fleetCanSatisfyRequiredCapabilities(
        ['skill:a', 'toolchain:h'],
        [['skill:a'], ['toolchain:h']],
      ),
    ).toBe(false);
  });

  it('reports the union gap across active workers', () => {
    expect(
      fleetMissingRequiredCapabilities(
        ['skill:a', 'toolchain:h'],
        [['skill:a'], ['browser']],
      ),
    ).toEqual(['toolchain:h']);
  });

  it('treats an empty required set as satisfiable', () => {
    expect(fleetCanSatisfyRequiredCapabilities([], [])).toBe(true);
    expect(fleetMissingRequiredCapabilities([], [])).toEqual([]);
  });
});
