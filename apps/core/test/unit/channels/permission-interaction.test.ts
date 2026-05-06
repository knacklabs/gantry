import { describe, expect, it } from 'vitest';

import {
  decisionForMode,
  firstPersistentRule,
  permissionDecisionOptions,
  permissionButtonLabel,
} from '@core/channels/permission-interaction.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';

function requestWithSuggestions(
  suggestions: PermissionApprovalRequest['suggestions'],
): PermissionApprovalRequest {
  return {
    requestId: 'permission_123',
    sourceAgentFolder: 'kai_group',
    toolName: 'Bash',
    suggestions,
  };
}

describe('permission interaction', () => {
  it('allows persistent approval only when one displayed rule maps to one update', () => {
    const request = requestWithSuggestions([
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
      },
    ]);

    expect(firstPersistentRule(request)).toBe('Bash(npm test *)');
    expect(permissionDecisionOptions(request)).toContain(
      'allow_persistent_rule',
    );
    expect(
      decisionForMode(request, 'allow_persistent_rule').updatedPermissions,
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
      },
    ]);
  });

  it('does not offer persistent approval when hidden extra rules are present', () => {
    const request = requestWithSuggestions([
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
      },
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: '*' }],
      },
    ]);

    expect(firstPersistentRule(request)).toBeUndefined();
    expect(permissionDecisionOptions(request)).toEqual([
      'allow_once',
      'cancel',
    ]);
    const decision = decisionForMode(request, 'allow_persistent_rule');
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('persistent rule unavailable');
  });

  it('labels job-scoped durable approvals without saying allow once', () => {
    const request = requestWithSuggestions([]);

    expect(permissionButtonLabel('allow_job_policy', request)).toBe(
      'Store on this job',
    );
    expect(decisionForMode(request, 'allow_job_policy')).toMatchObject({
      approved: true,
      mode: 'allow_job_policy',
      reason: 'job-scoped policy approved',
      decisionClassification: 'user_permanent',
    });
  });
});
