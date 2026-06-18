import { describe, expect, it } from 'vitest';

import {
  FAILOVER_ON_BILLING_ERROR,
  isFailoverEligibleError,
} from '@core/runtime/failover-eligibility.js';

describe('isFailoverEligibleError', () => {
  it('returns false for empty/undefined (no error / success frame)', () => {
    expect(isFailoverEligibleError(undefined)).toBe(false);
    expect(isFailoverEligibleError('')).toBe(false);
    expect(isFailoverEligibleError('   ')).toBe(false);
  });

  describe('eligible: auth', () => {
    it.each([
      'Failed to authenticate. API Error: 401 {"type":"authentication_error"}',
      'HTTP 403 Forbidden',
      'invalid api key provided',
      'invalid_api_key',
      'authentication failed',
      '401 Unauthorized',
    ])('treats %j as eligible', (error) => {
      expect(isFailoverEligibleError(error)).toBe(true);
    });
  });

  describe('eligible: rate limit', () => {
    it.each([
      'API Error: 429 rate_limit_exceeded',
      'rate limit reached for provider',
      'Too Many Requests',
    ])('treats %j as eligible', (error) => {
      expect(isFailoverEligibleError(error)).toBe(true);
    });
  });

  describe('eligible: server/down', () => {
    it.each([
      'API Error: 500 internal server error',
      '502 Bad Gateway',
      '503 Service Unavailable',
      '504 Gateway Timeout',
      'model is overloaded, please retry',
      'service unavailable',
      'request timed out',
      'connection timeout',
    ])('treats %j as eligible', (error) => {
      expect(isFailoverEligibleError(error)).toBe(true);
    });
  });

  describe('eligible: pre-spawn not configured', () => {
    it.each([
      'Provider groq is not configured',
      'Setup required: configure Model Access',
      'LLM runtime materialization failed',
    ])('treats %j as eligible', (error) => {
      expect(isFailoverEligibleError(error)).toBe(true);
    });
  });

  describe('billing (configurable)', () => {
    it('is eligible by default (the next provider may have credit)', () => {
      expect(FAILOVER_ON_BILLING_ERROR).toBe(true);
      expect(isFailoverEligibleError('You are out of credits')).toBe(true);
      expect(isFailoverEligibleError('insufficient balance')).toBe(true);
      expect(isFailoverEligibleError('402 Payment Required')).toBe(true);
    });
  });

  describe('NOT eligible', () => {
    it('does not fail over a user stop', () => {
      expect(isFailoverEligibleError('Agent runner stopped by request')).toBe(
        false,
      );
    });

    it('does not fail over a missing provider session (handled by stale-session retry first)', () => {
      expect(
        isFailoverEligibleError('No provider session found; it was expired'),
      ).toBe(false);
      expect(
        isFailoverEligibleError('provider session missing for this turn'),
      ).toBe(false);
    });

    it('does not fail over the REAL adapter missing-session markers', () => {
      // The exact strings the adapters throw (anthropic execution-adapter +
      // deepagents session-store). These must short-circuit to NOT eligible so
      // the stale-session retry runs on the SAME provider instead of failing
      // over and skipping recovery.
      expect(
        isFailoverEligibleError('No conversation found with session ID abc123'),
      ).toBe(false);
      expect(
        isFailoverEligibleError(
          'No DeepAgents session found with session ID abc123',
        ),
      ).toBe(false);
    });

    it('a real missing-session marker wins even with an HTTP-ish token', () => {
      // If a session error is ever wrapped with a code / "unavailable" / "not
      // configured" token, the missing-session short-circuit must still win so
      // it is not misclassified as failover-eligible.
      expect(
        isFailoverEligibleError(
          '503 unavailable: No conversation found with session ID abc',
        ),
      ).toBe(false);
      expect(
        isFailoverEligibleError(
          'No DeepAgents session found with session ID abc (not configured)',
        ),
      ).toBe(false);
    });

    it('does not fail over an unrelated/unknown error', () => {
      expect(isFailoverEligibleError('Sandbox runtime startup failed')).toBe(
        false,
      );
      expect(isFailoverEligibleError('some tool was denied')).toBe(false);
    });

    it('a stop wins even if other tokens are present', () => {
      // "stopped by request" short-circuits to NOT eligible.
      expect(
        isFailoverEligibleError('429 received but stopped by request'),
      ).toBe(false);
    });
  });
});
