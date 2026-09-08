import { describe, expect, it, vi } from 'vitest';

import {
  buildPermissionCardAffordances,
  parsePermissionCardAffordances,
} from '@core/application/permissions/permission-card-affordances.js';
import {
  formatPermissionCardPreTapLines,
  formatPermissionCardReceipt,
  permissionCardButtonLabel,
  permissionCardDecisionOptions,
} from '@core/channels/permission-card-affordances.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';

const remembered = (scopeKey = 'scope') => ({
  ok: true as const,
  scopeKey,
  pathOnly: false,
});

function request(
  overrides: Partial<PermissionApprovalRequest> = {},
): PermissionApprovalRequest {
  return {
    requestId: 'permission-1',
    sourceAgentFolder: 'main_agent',
    toolName: 'FileRead',
    ...overrides,
  };
}

function context(
  overrides: Record<string, unknown> = {},
): Parameters<typeof buildPermissionCardAffordances>[0]['rememberContext'] {
  return {
    eligible: true,
    candidates: {
      exact: remembered('exact:read'),
      kind: remembered('kind:file_read'),
      kindTool: remembered('kind:tool:FileRead'),
      place: remembered('place:file_read:/workspace/project'),
      ...overrides,
    },
  };
}

describe('permission card affordances', () => {
  it('renders eligible destructive protected and trust-growth cards with the exact labels order scope nouns and pre and post-tap lines and picks family over trust growth over folder as the single alternative', async () => {
    const folder = await buildPermissionCardAffordances({
      request: request(),
      rememberContext: context(),
      canonicalRoot: '/workspace/project',
      highRisk: false,
    });
    expect(permissionCardDecisionOptions(folder)).toEqual([
      'remember_allow_exact',
      'remember_allow_place',
      'allow_once',
      'remember_deny_exact',
    ]);
    expect(
      permissionCardDecisionOptions(folder).map((code) =>
        permissionCardButtonLabel(code, folder),
      ),
    ).toEqual(['Allow', 'Allow only in this folder', 'Just this once', 'No']);
    expect(formatPermissionCardPreTapLines(folder)).toEqual([
      'Allow will remember: this exact action',
      'Allow only in this folder will remember: only in /workspace/project.',
      'No will remember: this exact action.',
    ]);
    expect(formatPermissionCardReceipt(folder, 'remember_allow_exact')).toBe(
      'Remembered: this exact action. Change it any time with /permissions.',
    );
    expect(formatPermissionCardReceipt(folder, 'remember_allow_place')).toBe(
      'Remembered: only in /workspace/project. Change it any time with /permissions.',
    );
    expect(formatPermissionCardReceipt(folder, 'remember_deny_exact')).toBe(
      "I'll keep saying no to this exact action. Change it with /permissions.",
    );

    const read = await buildPermissionCardAffordances({
      request: request({
        toolName: 'FileRead',
        toolInput: { file_path: '/workspace/project/report.md' },
      }),
      rememberContext: context(),
      highRisk: false,
    });
    expect(read.preTapLines[0]).toBe('Allow will remember: this exact action');
    expect(formatPermissionCardReceipt(read, 'remember_allow_exact')).toBe(
      'Remembered: this exact action. Change it any time with /permissions.',
    );

    const write = await buildPermissionCardAffordances({
      request: request({
        toolName: 'FileWrite',
        toolInput: { file_path: '/workspace/project/report.md' },
      }),
      rememberContext: context(),
      highRisk: false,
    });
    expect(write.preTapLines[0]).toBe(
      'Allow will remember: writing to /workspace/project/report.md — any future content, no more asking for this file',
    );
    expect(formatPermissionCardReceipt(write, 'remember_allow_exact')).toBe(
      'Remembered: writes to /workspace/project/report.md (any content). Change it any time with /permissions.',
    );

    const destructive = await buildPermissionCardAffordances({
      request: request({
        toolName: 'RunCommand',
        risk_category: 'destructive',
        toolInput: { command: 'rm -rf build' },
      }),
      rememberContext: context(),
      canonicalRoot: '/workspace/project',
      highRisk: true,
      countExactAllowsByTool: vi.fn().mockResolvedValue(3),
    });
    expect(permissionCardDecisionOptions(destructive)).toEqual([
      'remember_allow_exact',
      'allow_once',
      'remember_deny_exact',
    ]);
    expect(destructive.alternative).toBeUndefined();
    expect(destructive.preTapLines).toEqual([
      'Allow will remember: this exact command only — nothing broader. No will remember: this exact command.',
    ]);

    const protectedCard = await buildPermissionCardAffordances({
      request: request({ blockedPath: '/workspace/.env' }),
      rememberContext: context({
        exact: { ok: false, reason: 'protected_destination' },
      }),
      canonicalRoot: '/workspace/project',
      highRisk: true,
      countExactAllowsByTool: vi.fn().mockResolvedValue(3),
    });
    expect(permissionCardDecisionOptions(protectedCard)).toEqual([
      'allow_once',
      'remember_deny_exact',
    ]);
    expect(
      permissionCardDecisionOptions(protectedCard).map((code) =>
        permissionCardButtonLabel(code, protectedCard),
      ),
    ).toEqual(['Allow once', 'No']);
    expect(protectedCard.preTapLines).toEqual([
      '/workspace/.env is protected, so I always ask.',
    ]);

    const familyCount = vi.fn().mockResolvedValue(3);
    const family = await buildPermissionCardAffordances({
      request: request({
        toolName: 'RunCommand',
        toolInput: { command: 'npm test' },
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'RunCommand', ruleContent: 'npm *' }],
          },
        ],
      }),
      rememberContext: context(),
      canonicalRoot: '/workspace/project',
      highRisk: true,
      countExactAllowsByTool: familyCount,
    });
    expect(family.alternative).toEqual({
      code: 'allow_persistent_rule',
      label: 'Allow all `npm` commands',
      line: 'Allow for future covers: npm *',
    });
    expect(familyCount).not.toHaveBeenCalled();

    const trust = await buildPermissionCardAffordances({
      request: request({ toolName: 'FileWrite' }),
      rememberContext: context(),
      canonicalRoot: '/workspace/project',
      toolLabel: 'file writing',
      highRisk: true,
      countExactAllowsByTool: vi.fn().mockResolvedValue(3),
    });
    expect(trust.alternative).toEqual({
      code: 'remember_allow_kind',
      label: 'Allow all file writing actions',
      line: 'Allow all file writing actions will remember: every file writing action, anywhere.',
    });
    expect(formatPermissionCardReceipt(trust, 'remember_allow_kind')).toBe(
      'Remembered: this kind of action, anywhere. Change it any time with /permissions.',
    );

    const displayFallback = await buildPermissionCardAffordances({
      request: request({
        toolName: 'custom_internal_id',
        displayName: 'Deploy',
      }),
      rememberContext: context({ place: { ok: false, reason: 'no_root' } }),
      highRisk: true,
      countExactAllowsByTool: vi.fn().mockResolvedValue(3),
    });
    expect(displayFallback.alternative?.label).toBe('Allow all Deploy actions');

    const missingLabel = await buildPermissionCardAffordances({
      request: request({ toolName: 'custom_internal_id' }),
      rememberContext: context({ place: { ok: false, reason: 'no_root' } }),
      highRisk: true,
      countExactAllowsByTool: vi.fn().mockResolvedValue(3),
    });
    expect(missingLabel.alternative).toBeUndefined();

    const warn = vi.fn();
    const failedCount = await buildPermissionCardAffordances({
      request: request({ toolName: 'FileWrite' }),
      rememberContext: context({ place: { ok: false, reason: 'no_root' } }),
      toolLabel: 'file writing',
      highRisk: true,
      countExactAllowsByTool: vi.fn().mockRejectedValue(new Error('offline')),
      warn,
    });
    expect(failedCount.alternative).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    const scalar = await buildPermissionCardAffordances({
      request: request(),
      rememberContext: { ...context(), eligible: false },
      highRisk: false,
    });
    expect(scalar).toEqual({
      eligible: false,
      offered: [],
      destructive: false,
      protected: false,
      preTapLines: [],
      postTapLines: {},
    });
    expect(parsePermissionCardAffordances(folder)).toEqual(folder);
    expect(
      parsePermissionCardAffordances({
        ...folder,
        offered: ['remember_allow_exact', 'forged'],
      }),
    ).toBeNull();
  });

  it('offers no folder alternative when the default kind candidate is refused even with a valid root-derived place candidate', async () => {
    const card = await buildPermissionCardAffordances({
      request: request(),
      rememberContext: context({
        kind: { ok: false as const, reason: 'no_kind' },
      }),
      canonicalRoot: '/workspace/project',
      highRisk: false,
    });
    expect(card.alternative).toBeUndefined();
    expect(permissionCardDecisionOptions(card)).toEqual([
      'remember_allow_exact',
      'allow_once',
      'remember_deny_exact',
    ]);
  });

  it('offers the trust-growth alternative from the human tool label when the request has no displayName and withholds it when no label exists', async () => {
    const card = await buildPermissionCardAffordances({
      request: request({ toolName: 'FileWrite' }),
      rememberContext: context(),
      canonicalRoot: undefined,
      highRisk: true,
      countExactAllowsByTool: async () => 3,
    });
    expect(card.alternative).toMatchObject({
      code: 'remember_allow_kind',
      label: 'Allow all file writing actions',
      line: 'Allow all file writing actions will remember: every file writing action, anywhere.',
    });
    const noLabel = await buildPermissionCardAffordances({
      request: request({ toolName: 'UnknownTool' }),
      rememberContext: context(),
      highRisk: true,
      countExactAllowsByTool: async () => 3,
    });
    expect(noLabel.alternative).toBeUndefined();
  });
});
