import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROCESS_ROLE,
  PROCESS_ROLES,
  PROCESS_ROLE_ENV_VAR,
  type ProcessRole,
} from '@core/app/bootstrap/roles/process-role.js';
import { resolveProcessRole } from '@core/app/bootstrap/roles/role-resolver.js';
import {
  roleCapabilities,
  type RoleCapabilities,
} from '@core/app/bootstrap/roles/role-capabilities.js';
import { roleReadinessRequirements } from '@core/app/bootstrap/roles/role-readiness.js';

describe('resolveProcessRole', () => {
  it('defaults to "all" when the env var is missing', () => {
    expect(resolveProcessRole({})).toBe('all');
    expect(DEFAULT_PROCESS_ROLE).toBe('all');
  });

  it('defaults to "all" when the env var is empty or whitespace', () => {
    expect(resolveProcessRole({ [PROCESS_ROLE_ENV_VAR]: '' })).toBe('all');
    expect(resolveProcessRole({ [PROCESS_ROLE_ENV_VAR]: '   ' })).toBe('all');
  });

  it('parses every valid role value, trimming surrounding whitespace', () => {
    for (const role of PROCESS_ROLES) {
      expect(resolveProcessRole({ [PROCESS_ROLE_ENV_VAR]: role })).toBe(role);
      expect(resolveProcessRole({ [PROCESS_ROLE_ENV_VAR]: ` ${role} ` })).toBe(
        role,
      );
    }
  });

  it('throws loudly on an unrecognised role (wrong-lane config fails closed)', () => {
    expect(() =>
      resolveProcessRole({ [PROCESS_ROLE_ENV_VAR]: 'worker' }),
    ).toThrow(/Invalid GANTRY_PROCESS_ROLE/);
    expect(() => resolveProcessRole({ [PROCESS_ROLE_ENV_VAR]: 'ALL' })).toThrow(
      /Valid roles: all, control, live-worker, job-worker/,
    );
  });
});

describe('roleCapabilities matrix', () => {
  const expected: Record<ProcessRole, RoleCapabilities> = {
    all: {
      controlApi: 'full',
      liveExecution: true,
      jobExecution: true,
      providerInbound: true,
      settingsDesiredStateWrites: true,
      bakeExecution: true,
      workerRegistration: true,
    },
    control: {
      controlApi: 'full',
      liveExecution: false,
      jobExecution: false,
      providerInbound: false,
      settingsDesiredStateWrites: true,
      bakeExecution: false,
      workerRegistration: false,
    },
    'live-worker': {
      controlApi: 'ops',
      liveExecution: true,
      jobExecution: false,
      providerInbound: true,
      settingsDesiredStateWrites: false,
      bakeExecution: false,
      workerRegistration: true,
    },
    'job-worker': {
      controlApi: 'ops',
      liveExecution: false,
      jobExecution: true,
      providerInbound: false,
      settingsDesiredStateWrites: false,
      bakeExecution: true,
      workerRegistration: true,
    },
  };

  for (const role of PROCESS_ROLES) {
    it(`matches the exact contract for "${role}"`, () => {
      expect(roleCapabilities(role)).toEqual(expected[role]);
    });
  }

  it('grants worker registration to every role except control', () => {
    expect(roleCapabilities('all').workerRegistration).toBe(true);
    expect(roleCapabilities('live-worker').workerRegistration).toBe(true);
    expect(roleCapabilities('job-worker').workerRegistration).toBe(true);
    expect(roleCapabilities('control').workerRegistration).toBe(false);
  });
});

describe('roleReadinessRequirements descriptors', () => {
  it('derives requirement flags from capabilities for each role', () => {
    expect(roleReadinessRequirements('all')).toEqual({
      requiresWorkerRegistration: true,
      requiresSchedulerClaiming: true,
      requiresLiveCapacitySignal: true,
      requiresApiAuthConfigured: true,
    });
    expect(roleReadinessRequirements('control')).toEqual({
      requiresWorkerRegistration: false,
      requiresSchedulerClaiming: false,
      requiresLiveCapacitySignal: false,
      requiresApiAuthConfigured: true,
    });
    expect(roleReadinessRequirements('live-worker')).toEqual({
      requiresWorkerRegistration: true,
      requiresSchedulerClaiming: false,
      requiresLiveCapacitySignal: true,
      requiresApiAuthConfigured: true,
    });
    expect(roleReadinessRequirements('job-worker')).toEqual({
      requiresWorkerRegistration: true,
      requiresSchedulerClaiming: true,
      requiresLiveCapacitySignal: false,
      requiresApiAuthConfigured: true,
    });
  });
});
