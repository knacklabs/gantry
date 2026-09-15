import { describe, expect, it } from 'vitest';

import {
  isRuntimeEventType,
  parseRuntimeEventType,
  requireRuntimeEventType,
  RUNTIME_EVENT_TYPES,
} from '@core/domain/events/runtime-event-types.js';
import type {
  ProviderSessionCleanupFailedEventPayload,
  ProviderSessionRetiredEventPayload,
} from '@core/domain/events/events.js';
import { hashProviderSessionExternalId } from '@core/domain/events/events.js';

describe('runtime event types', () => {
  it('defines the scheduled job heartbeat primitive', () => {
    expect(RUNTIME_EVENT_TYPES.JOB_HEARTBEAT).toBe('job.heartbeat');
  });

  it('accepts the permission classifier decision event type', () => {
    const eventType = 'permission.classifier_decision';

    expect(RUNTIME_EVENT_TYPES.PERMISSION_CLASSIFIER_DECISION).toBe(eventType);
    expect(isRuntimeEventType(eventType)).toBe(true);
    expect(parseRuntimeEventType(eventType)).toBe(eventType);
    expect(requireRuntimeEventType(eventType)).toBe(eventType);
  });

  it('accepts every canonical runtime event type', () => {
    for (const eventType of Object.values(RUNTIME_EVENT_TYPES)) {
      expect(isRuntimeEventType(eventType)).toBe(true);
      expect(parseRuntimeEventType(eventType)).toBe(eventType);
      expect(requireRuntimeEventType(eventType)).toBe(eventType);
    }
  });

  it('normalizes common human-facing runtime event aliases', () => {
    expect(parseRuntimeEventType('run_completed')).toBe('run.completed');
    expect(parseRuntimeEventType('job.finished')).toBe('job.run.completed');
    expect(parseRuntimeEventType('job.dead_lettered')).toBe(
      'run.dead_lettered',
    );
  });

  it('rejects unknown runtime event strings', () => {
    expect(isRuntimeEventType('runtime.unknown')).toBe(false);
    expect(parseRuntimeEventType('runtime.unknown')).toBeUndefined();
    expect(() => requireRuntimeEventType('runtime.unknown')).toThrow(
      'Runtime event type must be a known runtime event type.',
    );
  });

  it('types session.provider.retired with cap evidence only for the ceiling reason', () => {
    const ceiling: ProviderSessionRetiredEventPayload = {
      reason: 'ceiling',
      providerSessionHash: hashProviderSessionExternalId('session-secret'),
      executionProviderId: 'claude-code',
      contextHighWaterMark: 150_001,
      cap: 150_000,
    };
    const fingerprint: ProviderSessionRetiredEventPayload = {
      reason: 'fingerprint',
      providerSessionHash: hashProviderSessionExternalId('fingerprint'),
      executionProviderId: 'claude-code',
    };

    // @ts-expect-error Non-ceiling retirements cannot carry cap evidence.
    const invalid: ProviderSessionRetiredEventPayload = {
      reason: 'missing',
      providerSessionHash: hashProviderSessionExternalId('missing'),
      executionProviderId: 'claude-code',
      contextHighWaterMark: 150_001,
      cap: 150_000,
    };

    expect(RUNTIME_EVENT_TYPES.SESSION_PROVIDER_RETIRED).toBe(
      'session.provider.retired',
    );
    expect(ceiling).toMatchObject({ reason: 'ceiling', cap: 150_000 });
    expect(fingerprint).not.toHaveProperty('cap');
    expect(invalid.reason).toBe('missing');
    expect(ceiling.providerSessionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('types session.provider.cleanup_failed as a flat payload without a reason', () => {
    const cleanupFailed: ProviderSessionCleanupFailedEventPayload = {
      providerSessionHash: hashProviderSessionExternalId('cleanup-failed'),
      executionProviderId: 'claude-code',
      error: 'release failed',
    };

    // @ts-expect-error Cleanup failures are not reason-discriminated.
    const invalid: ProviderSessionCleanupFailedEventPayload = {
      reason: 'new',
      providerSessionHash: hashProviderSessionExternalId('invalid-cleanup'),
      executionProviderId: 'claude-code',
      error: 'release failed',
    };

    expect(RUNTIME_EVENT_TYPES.SESSION_PROVIDER_CLEANUP_FAILED).toBe(
      'session.provider.cleanup_failed',
    );
    expect(cleanupFailed).not.toHaveProperty('reason');
    expect(invalid.reason).toBe('new');
  });
});
