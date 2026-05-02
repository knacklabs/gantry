import { describe, expect, it } from 'vitest';

import {
  formatPermissionReceiptText,
  formatPermissionRequestText,
  permissionApproveLabel,
  permissionDecisionOptions,
} from '@core/channels/permission-approval-format.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';

const request: PermissionApprovalRequest = {
  requestId: 'perm-test',
  sourceGroup: 'main_agent',
  toolName: 'request_tool_enable',
  approvalScope: 'persistent',
  decisionOptions: ['approve_permanent', 'approve_once', 'reject'],
  decisionReason: 'Run focused checks',
  permissionRule: {
    canonical: 'Bash(npm run test *)',
    risk: 'medium',
    riskReason: 'Bash is scoped but still executes workspace commands.',
    broad: false,
    examples: ['Run `npm run test unit`.'],
    boundary: 'Does not allow unrelated shell commands.',
  },
};

describe('permission approval formatting', () => {
  it('formats pending requests without making the request id primary text', () => {
    const text = formatPermissionRequestText(request, 300_000);
    expect(text).toContain('Permission request');
    expect(text).toContain('Status: Pending');
    expect(text).toContain('Requested access: Bash(npm run test *)');
    expect(text).toContain('Risk: medium');
    expect(text).toContain('Request ID: perm-test');
    expect(text.startsWith('Permission request: perm-test')).toBe(false);
  });

  it('summarizes non-Bash tool input without command-specific wording', () => {
    const text = formatPermissionRequestText(
      {
        ...request,
        toolName: 'WebFetch',
        toolInput: { url: 'https://github.com/vrknetha/myclaw/issues/70' },
        permissionRule: {
          canonical: 'WebFetch(domain:github.com)',
          risk: 'low',
          riskReason: 'WebFetch is constrained to a domain.',
          broad: false,
          examples: ['Fetch pages from github.com.'],
          boundary: 'Does not allow fetching other domains.',
        },
      },
      300_000,
    );
    expect(text).toContain('Requested access: WebFetch(domain:github.com)');
    expect(text).toContain(
      'URL: `https://github.com/vrknetha/myclaw/issues/70`',
    );
    expect(text).not.toContain('Command:');
  });

  it('uses one-time rejection wording, not future deny policy wording', () => {
    expect(
      formatPermissionReceiptText(request, {
        approved: false,
        reason: 'not needed',
        decidedBy: 'Ravi',
      }),
    ).toBe('Rejected this request: Bash(npm run test *) by Ravi. not needed');
  });

  it('uses scoped and broad button labels', () => {
    expect(permissionDecisionOptions(request)).toEqual([
      'approve_permanent',
      'approve_once',
      'reject',
    ]);
    expect(permissionApproveLabel(request, 'approve_permanent')).toBe(
      'Approve rule',
    );
    expect(
      permissionApproveLabel(
        {
          ...request,
          permissionRule: { ...request.permissionRule!, broad: true },
        },
        'approve_permanent',
      ),
    ).toBe('Approve broad access');
  });

  it('formats decision receipts in human language', () => {
    expect(
      formatPermissionReceiptText(request, {
        approved: true,
        mode: 'approve_once',
        decidedBy: 'Ravi',
      }),
    ).toContain('Approved once: Bash(npm run test *) by Ravi');
    expect(
      formatPermissionReceiptText(request, {
        approved: true,
        mode: 'approve_permanent',
      }),
    ).toContain('Applying persistent permission update');
    expect(
      formatPermissionReceiptText(request, {
        approved: false,
        reason: 'timed out',
      }),
    ).toBe(
      'Expired without approval: Bash(npm run test *). No persistent permission changed.',
    );
  });
});
