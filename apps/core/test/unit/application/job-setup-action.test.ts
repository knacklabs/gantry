import { describe, expect, it } from 'vitest';

import {
  compareJobSetupBlockers,
  jobSetupActionIdentity,
} from '@core/shared/job-setup-action.js';
import type { JobSetupBlocker } from '@core/domain/job-types.js';
import { parseSetupState } from '@core/adapters/storage/postgres/services/canonical-job-target-state.js';

const grant = {
  kind: 'approve_grant' as const,
  grant: {
    type: 'addRules' as const,
    behavior: 'allow' as const,
    rules: [{ toolName: 'RunCommand', ruleContent: 'npm test *' }],
  },
};

describe('tagged job setup actions', () => {
  it('uses canonical grant subjects for identity and action priority', () => {
    expect(jobSetupActionIdentity(grant)).toBe(
      jobSetupActionIdentity({
        ...grant,
        grant: {
          ...grant.grant,
          type: 'replaceRules',
          rules: [...grant.grant.rules],
        },
      }),
    );
    const blockers: JobSetupBlocker[] = [
      {
        state: 'broker_unreachable',
        type: 'tool',
        id: 'runtime',
        summary: 'Runtime unavailable.',
        action: { kind: 'instruction', text: 'Restore the runtime.' },
      },
      {
        state: 'missing_capability',
        type: 'tool',
        id: 'RunCommand',
        summary: 'Command access is missing.',
        action: grant,
      },
    ];
    expect(blockers.sort(compareJobSetupBlockers)[0]?.action.kind).toBe(
      'approve_grant',
    );
  });

  it('strictly parses the canonical storage shape', () => {
    expect(
      parseSetupState(
        {
          state: 'missing_capability',
          checked_at: '2026-08-13T00:00:00.000Z',
          fingerprint: 'fingerprint',
          notified_fingerprint: null,
          blockers: [
            {
              state: 'missing_capability',
              type: 'tool',
              id: 'RunCommand',
              summary: 'Command access is missing.',
              action: grant,
            },
          ],
        },
        'job-1',
      ),
    ).toMatchObject({ state: 'missing_capability' });
  });

  it.each([
    [
      'camelCase field',
      { state: 'ready', checkedAt: 'now', fingerprint: 'x', blockers: [] },
    ],
    [
      'missing notified fingerprint',
      { state: 'ready', checked_at: 'now', fingerprint: 'x', blockers: [] },
    ],
    [
      'legacy blocker field',
      {
        state: 'missing_capability',
        checked_at: 'now',
        fingerprint: 'x',
        blockers: [
          {
            state: 'missing_capability',
            type: 'tool',
            id: 'x',
            summary: 'x',
            action: { kind: 'instruction', text: 'x' },
            grantable: false,
          },
        ],
      },
    ],
    [
      'over-broad grant',
      {
        state: 'missing_capability',
        checked_at: 'now',
        fingerprint: 'x',
        blockers: [
          {
            state: 'missing_capability',
            type: 'tool',
            id: 'x',
            summary: 'x',
            action: {
              kind: 'approve_grant',
              grant: {
                type: 'removeRules',
                behavior: 'allow',
                rules: [{ toolName: 'x' }],
              },
            },
          },
        ],
      },
    ],
    [
      'ready with blockers',
      {
        state: 'ready',
        checked_at: 'now',
        fingerprint: 'x',
        blockers: [
          {
            state: 'missing_capability',
            type: 'tool',
            id: 'x',
            summary: 'x',
            action: { kind: 'instruction', text: 'x' },
          },
        ],
      },
    ],
  ])('raises the remediation error for %s', (_label, value) => {
    expect(() => parseSetupState(value, 'job-bad')).toThrow(
      /Job job-bad has malformed setup_state.*remediation migration/,
    );
  });

  it('rejects duplicate action identities without partially accepting rows', () => {
    const blocker = {
      state: 'missing_capability',
      type: 'tool',
      id: 'RunCommand',
      summary: 'Missing.',
      action: grant,
    };
    expect(() =>
      parseSetupState(
        {
          state: 'missing_capability',
          checked_at: 'now',
          fingerprint: 'x',
          notified_fingerprint: null,
          blockers: [blocker, blocker],
        },
        'job-duplicate',
      ),
    ).toThrow(/duplicate action identity/);
  });
});
