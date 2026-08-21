import { describe, expect, it } from 'vitest';

import {
  formatJobSetupAction,
  setupReadinessLabel,
} from '@core/shared/job-setup-labels.js';

describe('job setup labels', () => {
  it('uses the review action for unreviewed semantic capabilities', () => {
    expect(
      formatJobSetupAction(
        {
          kind: 'instruction',
          text: 'Refresh attached source inventory, then update the job to a reviewed source-neutral capability.',
        },
        {
          state: 'missing_capability',
          type: 'semantic_capability',
          id: 'acme.records.append',
        },
      ),
    ).toBe(
      'Refresh attached source inventory, then update the job to a reviewed source-neutral capability.',
    );
  });

  it('keeps approve wording for reviewed semantic capabilities', () => {
    expect(
      formatJobSetupAction(
        {
          kind: 'approve_grant',
          grant: {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:acme.records.append' }],
          },
        },
        {
          state: 'missing_capability',
          type: 'semantic_capability',
          id: 'acme.records.append',
        },
      ),
    ).toBe('Approve Acme Records Append, then resume the job.');
  });

  describe('setupReadinessLabel', () => {
    it('maps ready and undefined states to Ready', () => {
      expect(setupReadinessLabel('ready')).toBe('Ready');
      expect(setupReadinessLabel(undefined)).toBe('Ready');
    });

    it('maps missing_capability to Needs approval', () => {
      expect(setupReadinessLabel('missing_capability')).toBe('Needs approval');
    });

    it('maps credential and browser-login states to Needs connection', () => {
      for (const state of [
        'credential_unknown',
        'mcp_missing_credential',
        'browser_login_may_be_required',
      ]) {
        expect(setupReadinessLabel(state)).toBe('Needs connection');
      }
    });

    it('maps broker/config/workspace failure states to Blocked', () => {
      for (const state of [
        'broker_unreachable',
        'invalid_config',
        'invalid_workspace',
        'malformed_requirement',
        'unsupported_field',
      ]) {
        expect(setupReadinessLabel(state)).toBe('Blocked');
      }
    });

    it('falls back to Blocked for unknown states', () => {
      expect(setupReadinessLabel('something_new')).toBe('Blocked');
    });

    it('never produces the removed "Needs setup" label', () => {
      for (const state of [
        'ready',
        undefined,
        'missing_capability',
        'credential_unknown',
        'mcp_missing_credential',
        'browser_login_may_be_required',
        'broker_unreachable',
        'invalid_config',
        'invalid_workspace',
        'malformed_requirement',
        'unsupported_field',
        'something_new',
      ]) {
        expect(setupReadinessLabel(state)).not.toBe('Needs setup');
      }
    });
  });
});
