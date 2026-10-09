import { describe, expect, it } from 'vitest';

import {
  buildPermissionCardAffordances,
  parsePermissionCardAffordances,
} from '@core/application/permissions/permission-card-affordances.js';
import {
  formatPermissionCardPreTapLines,
  formatPermissionCardReceipt,
  permissionCardDecisionOptions,
} from '@core/channels/permission-card-affordances.js';
import { permissionButtonLabel } from '@core/channels/permission-interaction.js';
import { permissionDecisionOptions } from '@core/channels/permission-decision-options.js';
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
      deny: remembered('deny:read'),
      exact: remembered('exact:read'),
      kind: remembered('kind:file_read'),
      kindTool: remembered('kind:tool:FileRead'),
      place: remembered('place:file_read:/workspace/project'),
      ...overrides,
    },
  };
}

const labels = (
  card: Awaited<ReturnType<typeof buildPermissionCardAffordances>>,
) =>
  permissionCardDecisionOptions(card).map((code) =>
    permissionButtonLabel(code),
  );

describe('permission card affordances', () => {
  it('offers Allow once, Allow for future and Deny, with Allow for future remembering only this exact action and Deny never remembered', async () => {
    const read = await buildPermissionCardAffordances({
      request: request({
        toolInput: { file_path: '/workspace/project/report.md' },
      }),
      rememberContext: context(),
    });
    expect(permissionCardDecisionOptions(read)).toEqual([
      'allow_once',
      'remember_allow_exact',
      'cancel',
    ]);
    expect(labels(read)).toEqual(['Allow once', 'Allow for future', 'Deny']);
    expect(read.offered).toEqual(['remember_allow_exact']);
    expect(formatPermissionCardPreTapLines(read)).toEqual([
      'Allow for future remembers: this exact action.',
    ]);
    expect(formatPermissionCardReceipt(read, 'remember_allow_exact')).toBe(
      'Remembered: this exact action. Change it any time with /permissions.',
    );

    const write = await buildPermissionCardAffordances({
      request: request({
        toolName: 'FileWrite',
        toolInput: { file_path: '/workspace/project/report.md' },
      }),
      rememberContext: context(),
    });
    expect(write.preTapLines).toEqual([
      'Allow for future remembers: writing to /workspace/project/report.md — any future content, no more asking for this file.',
    ]);
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
    });
    expect(labels(destructive)).toEqual([
      'Allow once',
      'Allow for future',
      'Deny',
    ]);
    expect(destructive.preTapLines).toEqual([
      'Allow for future remembers: this exact command only — nothing broader.',
    ]);
  });

  it('shows no alternative button even when a command family, trust growth or folder could be saved', async () => {
    const family = await buildPermissionCardAffordances({
      request: request({
        toolName: 'RunCommand',
        toolInput: { command: 'git status' },
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'RunCommand', ruleContent: 'git *' }],
          },
        ],
      }),
      rememberContext: context(),
    });
    expect(labels(family)).toEqual(['Allow once', 'Allow for future', 'Deny']);
    expect(family).not.toHaveProperty('alternative');
    expect(family.offered).toEqual(['remember_allow_exact']);
  });

  it('offers only Allow once and Deny for a protected path, and falls back to the plain prompt when this action cannot be saved', async () => {
    const protectedCard = await buildPermissionCardAffordances({
      request: request({ blockedPath: '/workspace/.env' }),
      rememberContext: context({
        exact: { ok: false, reason: 'protected_destination' },
      }),
    });
    expect(labels(protectedCard)).toEqual(['Allow once', 'Deny']);
    expect(protectedCard.preTapLines).toEqual([
      '/workspace/.env is protected, so I always ask.',
    ]);

    const unsaveable = await buildPermissionCardAffordances({
      request: request(),
      rememberContext: context({
        exact: { ok: false, reason: 'incomplete_effect' },
      }),
    });
    expect(unsaveable.eligible).toBe(false);
    expect(
      await buildPermissionCardAffordances({
        request: request(),
        rememberContext: { ...context(), eligible: false },
      }),
    ).toEqual({
      eligible: false,
      offered: [],
      destructive: false,
      protected: false,
      preTapLines: [],
      postTapLines: {},
    });
  });

  it('keeps person-only asks at Allow once and Deny even with an eligible remember context', async () => {
    const personOnly = request({
      toolName: 'RunCommand',
      toolInput: { command: 'git status' },
      decisionOptions: ['allow_once', 'cancel'],
      cardAffordances: {
        eligible: false,
        offered: [],
        destructive: false,
        protected: false,
        preTapLines: [],
        postTapLines: {},
      },
    });
    const card = await buildPermissionCardAffordances({
      request: personOnly,
      rememberContext: context(),
    });
    expect(card.eligible).toBe(false);
    expect(card.offered).toEqual([]);
    const options = permissionDecisionOptions({
      ...personOnly,
      cardAffordances: card,
    });
    expect(options).toEqual(['allow_once', 'cancel']);
    expect(options.map(permissionButtonLabel)).toEqual(['Allow once', 'Deny']);
  });

  it('round-trips a stored card and rejects a forged code', async () => {
    const card = await buildPermissionCardAffordances({
      request: request(),
      rememberContext: context(),
    });
    expect(parsePermissionCardAffordances(card)).toEqual(card);
    expect(
      parsePermissionCardAffordances({
        ...card,
        offered: ['remember_allow_exact', 'forged'],
      }),
    ).toBeNull();
  });
});
