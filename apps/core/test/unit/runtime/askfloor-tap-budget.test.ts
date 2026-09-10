import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { PermissionClassifierStatus } from '@core/domain/permission-classifier-status.js';

import {
  assertLlmConsultNotInvoked,
  replayDestructiveExactMemory,
  replayRememberedJobProjection,
  replayRememberedExactAllow,
  replayPermissionRequest,
  TAP_BUDGET_WORKSPACE_ROOT,
} from './askfloor-tap-budget-harness.js';

const HIGH_CLASSIFIER_VERDICT = {
  risk_level: 'high' as const,
  reason: 'The native table must decide before the classifier.',
};

const LOW_CLASSIFIER_VERDICT = {
  risk_level: 'low' as const,
  risk_category: 'benign' as const,
  reason: 'Classifier allows the ambiguous request.',
};

describe('ASKFLOOR tap budget', () => {
  it('S1: opening an attachment already in the conversation costs 0 taps in every lane with the typed fact carried by the fixture', async () => {
    for (const lane of [
      { permissionMode: 'ask' as const },
      { permissionMode: 'auto' as const },
      { permissionMode: 'auto_strict' as const },
      { permissionMode: 'auto' as const, hostJobId: 'job-attachment-open' },
    ]) {
      await expect(
        replayPermissionRequest({
          ...lane,
          toolName: 'mcp__gantry__attachment_open',
          toolInput: { attachment_ids: ['attachment-1'] },
          attachmentOpenIds: { wellFormed: true, count: 1 },
          workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
          trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
          classifierVerdict: {
            risk_level: 'high',
            reason: 'The classifier must not run for a birthright.',
          },
        }),
      ).resolves.toEqual({
        taps: 0,
        decidedBy: 'birthright',
        source: 'birthright',
        railProvenance: null,
      });
    }
  });

  it('S2 taps at most once with a remembered exact Allow on the first run through the real claim, learning and application path and zero times on the second identical run through the real coordinator', async () => {
    await expect(replayRememberedExactAllow()).resolves.toEqual({
      taps: [1, 0],
      claimedCodes: ['remember_allow_exact'],
      applications: ['allow_once'],
      activeRows: 1,
    });
  });

  it('S3: 2>/dev/null costs 0 taps and hard-floor find costs 1 tap in interactive auto', async () => {
    const classifierVerdict = {
      risk_level: 'low' as const,
      risk_category: 'benign' as const,
      reason: 'Classifier allows this read.',
    };
    const stderrRedirect = await replayPermissionRequest({
      permissionMode: 'auto',
      command: 'git status 2>/dev/null',
      workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
      trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
      classifierVerdict,
    });
    const readOnlyFind = await replayPermissionRequest({
      permissionMode: 'auto',
      command: "find . -name '*.ts'",
      workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
      trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
      classifierVerdict,
    });

    expect(stderrRedirect).toMatchObject({
      taps: 0,
      decidedBy: 'auto_classifier',
      source: 'auto_classifier',
      railProvenance: null,
    });
    expect(readOnlyFind).toMatchObject({
      taps: 1,
      decidedBy: 'owner',
      source: 'user',
      railProvenance: null,
    });
  });

  it('S4 asks once for rm -rf build remembers the exact command runs it again with zero taps asks for rm -rf dist and remembers No exactly', async () => {
    const replay = await replayDestructiveExactMemory();

    expect(replay.taps).toEqual([1, 0, 1, 0]);
    expect(replay.claimedCodes).toEqual([
      'remember_allow_exact',
      'remember_deny_exact',
    ]);
    expect(replay.applications).toEqual(['allow_once', 'cancel']);
    expect(replay.decisions).toMatchObject([
      { approved: true, mode: 'allow_once', source: 'human_once' },
      { approved: true, mode: 'allow_once', source: 'human_decision' },
      { approved: false, mode: 'cancel', source: 'human_once' },
      { approved: false, mode: 'cancel', source: 'human_decision' },
    ]);
    expect(replay.rows).toMatchObject([
      { outcome: 'allow', scope: 'exact', principal: 'RunCommand' },
      { outcome: 'deny', scope: 'exact', principal: 'RunCommand' },
    ]);
    expect(replay.rows[0]?.scopeKey).toBe(replay.rows[0]?.effectHash);
    expect(replay.rows[1]?.scopeKey).toBe(replay.rows[1]?.effectHash);
    expect(replay.rows[0]?.scopeKey).not.toBe(replay.rows[1]?.scopeKey);
  });

  it('S5 remembers in chat runs the projected job with zero cards still cards the near-miss forgets and the same job asks again', async () => {
    const replay = await replayRememberedJobProjection();

    expect(replay.chatTaps).toBe(1);
    expect(replay.jobTaps).toEqual([0, 1, 1]);
    expect(replay.revoked).toBe('applied');
    expect(replay.decisions).toMatchObject([
      { approved: true, source: 'human_decision' },
      { approved: false, source: 'user' },
      { approved: false, source: 'user' },
    ]);
  });

  it('TB1 TB2 TB3 TB4: a browser click, a file read by path, an unprotected file write and a native FileWrite inside the workspace cost 0 taps in interactive auto with the LLM consult not invoked', async () => {
    for (const request of [
      {
        toolName: 'mcp__gantry__browser_act',
        toolInput: { action: 'click', payload: {} },
      },
      {
        toolName: 'mcp__gantry__file',
        toolInput: { action: 'read', path: 'notes/a.md' },
      },
      {
        toolName: 'mcp__gantry__file',
        toolInput: { action: 'write', path: 'notes/a.md', content: 'ok' },
      },
      {
        toolName: 'FileWrite',
        toolInput: { path: 'notes/a.md', content: 'ok' },
      },
    ]) {
      await expect(
        replayPermissionRequest({
          permissionMode: 'auto',
          ...request,
          workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
          trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
          classifierVerdict: HIGH_CLASSIFIER_VERDICT,
          classifierConsult: assertLlmConsultNotInvoked,
        }),
      ).resolves.toEqual({
        taps: 0,
        decidedBy: 'auto_classifier',
        source: 'auto_classifier',
        railProvenance: null,
      });
    }
  });

  it('mirror fixtures: a protected file write, a FileWrite outside the workspace and scheduler_delete_job cost 1 tap, and a raw-path file_attach reaches the stubbed LLM consult as ambiguous', async () => {
    for (const request of [
      {
        toolName: 'mcp__gantry__file',
        toolInput: { action: 'write', path: 'settings.yaml', content: 'no' },
      },
      {
        toolName: 'FileWrite',
        toolInput: {
          path: path.resolve(TAP_BUDGET_WORKSPACE_ROOT, '../outside.md'),
          content: 'no',
        },
      },
      {
        toolName: 'mcp__gantry__scheduler_delete_job',
        toolInput: { jobId: 'job-1' },
      },
    ]) {
      await expect(
        replayPermissionRequest({
          permissionMode: 'auto',
          ...request,
          workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
          trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
          classifierVerdict: LOW_CLASSIFIER_VERDICT,
          classifierConsult: assertLlmConsultNotInvoked,
        }),
      ).resolves.toEqual({
        taps: 1,
        decidedBy: 'owner',
        source: 'user',
        railProvenance: null,
      });
    }

    const classifierConsult = vi.fn(async () => ({
      ...LOW_CLASSIFIER_VERDICT,
      latencyMs: 1,
    }));
    await expect(
      replayPermissionRequest({
        permissionMode: 'auto',
        toolName: 'mcp__gantry__browser_act',
        toolInput: {
          action: 'file_attach',
          payload: { source: { type: 'path', path: '/tmp/upload.txt' } },
        },
        workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
        trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
        classifierVerdict: LOW_CLASSIFIER_VERDICT,
        classifierConsult,
      }),
    ).resolves.toMatchObject({
      taps: 0,
      decidedBy: 'auto_classifier',
      source: 'auto_classifier',
    });
    expect(classifierConsult).toHaveBeenCalledOnce();
  });

  it("keeps today's outcome for the TB1 TB2 TB3 TB4 fixtures under auto_strict, ask and autonomous", async () => {
    const requests = [
      {
        toolName: 'mcp__gantry__browser_act',
        toolInput: { action: 'click', payload: {} },
      },
      {
        toolName: 'mcp__gantry__file',
        toolInput: { action: 'read', path: 'notes/a.md' },
      },
      {
        toolName: 'mcp__gantry__file',
        toolInput: { action: 'write', path: 'notes/a.md', content: 'ok' },
      },
      {
        toolName: 'FileWrite',
        toolInput: { path: 'notes/a.md', content: 'ok' },
      },
    ];
    for (const lane of [
      { permissionMode: 'auto_strict' as const },
      { permissionMode: 'ask' as const },
    ]) {
      for (const request of requests) {
        await expect(
          replayPermissionRequest({
            ...lane,
            ...request,
            workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
            trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
            classifierVerdict: LOW_CLASSIFIER_VERDICT,
            classifierConsult: assertLlmConsultNotInvoked,
          }),
        ).resolves.toEqual({
          taps: 1,
          decidedBy: 'owner',
          source: 'user',
          railProvenance: null,
        });
      }
    }
    for (const request of requests) {
      const classifierEligible = request.toolName !== 'FileWrite';
      const classifierConsult = vi.fn(async () => ({
        ...LOW_CLASSIFIER_VERDICT,
        latencyMs: 1,
      }));
      await expect(
        replayPermissionRequest({
          permissionMode: 'auto',
          hostJobId: 'job-tb',
          ...request,
          workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
          trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
          classifierVerdict: LOW_CLASSIFIER_VERDICT,
          classifierConsult,
        }),
      ).resolves.toEqual({
        taps: classifierEligible ? 0 : 1,
        decidedBy: classifierEligible ? 'auto_classifier' : 'owner',
        source: classifierEligible ? 'auto_classifier' : 'user',
        railProvenance: null,
      });
      expect(classifierConsult).toHaveBeenCalledTimes(
        classifierEligible ? 1 : 0,
      );
    }
  });

  it('S6 judge offline sends one notice per episode keeps trusted-root reads at zero taps asks at most once for an uncovered read and Allow still remembers while offline', async () => {
    const offlineConsult = vi.fn(async () => ({
      status: PermissionClassifierStatus.Unavailable,
      risk_level: 'high' as const,
      reason: 'Judge offline.',
      failureCode: 'query_error' as const,
      latencyMs: 1,
    }));
    const sendMessage = vi.fn(async () => undefined);
    const readOnly = await replayPermissionRequest({
      permissionMode: 'auto',
      toolName: 'mcp__gantry__file',
      toolInput: { action: 'read', path: 'notes/a.md' },
      workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
      trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
      classifierVerdict: HIGH_CLASSIFIER_VERDICT,
      classifierConsult: assertLlmConsultNotInvoked,
      sendMessage,
    });
    const uncovered = await replayPermissionRequest({
      permissionMode: 'auto',
      toolName: 'mcp__crm__update_record',
      toolInput: { id: 'offline' },
      workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
      trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
      classifierVerdict: {
        status: PermissionClassifierStatus.Unavailable,
        risk_level: 'high',
        reason: 'Judge offline.',
      },
      classifierConsult: offlineConsult,
      sendMessage,
    });
    expect(readOnly).toMatchObject({ taps: 0 });
    expect(uncovered).toMatchObject({ taps: 1, decidedBy: 'owner' });
    expect(offlineConsult).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    const remembered = await replayDestructiveExactMemory({
      classifierConsult: offlineConsult,
      sendMessage,
    });

    expect(remembered.taps).toEqual([1, 0, 1, 0]);
    expect(remembered.decisions[1]).toMatchObject({
      source: 'human_decision',
    });
  });

  it('aggregates the tap budget across S1 to S6 TB1 to TB4 and the mirror fixtures and reports the total per lane', async () => {
    const totals = {
      interactiveAuto: 0,
      strict: 0,
      ask: 0,
      autonomous: 0,
    };
    const fixture = (permissionMode: 'auto' | 'auto_strict' | 'ask') => ({
      permissionMode,
      workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
      trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
      classifierVerdict: LOW_CLASSIFIER_VERDICT,
    });
    const attachment = await replayPermissionRequest({
      ...fixture('auto'),
      toolName: 'mcp__gantry__attachment_open',
      toolInput: { attachment_ids: ['attachment-1'] },
      attachmentOpenIds: { wellFormed: true, count: 1 },
    });
    const read = await replayPermissionRequest({
      ...fixture('auto'),
      command: 'git status 2>/dev/null',
    });
    const strict = await replayPermissionRequest({
      ...fixture('auto_strict'),
      toolName: 'mcp__gantry__browser_act',
      toolInput: { action: 'click', payload: {} },
    });
    const ask = await replayPermissionRequest({
      ...fixture('ask'),
      toolName: 'mcp__gantry__file',
      toolInput: { action: 'read', path: 'notes/a.md' },
    });
    const autonomous = await replayPermissionRequest({
      ...fixture('auto'),
      hostJobId: 'job-aggregation',
      toolName: 'mcp__gantry__file',
      toolInput: { action: 'write', path: 'notes/a.md', content: 'ok' },
    });
    const s2 = await replayRememberedExactAllow();
    const s4 = await replayDestructiveExactMemory();
    const s5 = await replayRememberedJobProjection();
    const s6 = await replayPermissionRequest({
      ...fixture('auto'),
      toolName: 'mcp__crm__update_record',
      toolInput: { id: 'offline' },
      classifierVerdict: {
        status: PermissionClassifierStatus.Unavailable,
        risk_level: 'high',
        reason: 'Judge offline.',
      },
    });
    totals.interactiveAuto =
      attachment.taps + read.taps + s2.taps[0] + s4.taps[0] + s6.taps;
    totals.strict = strict.taps;
    totals.ask = ask.taps;
    totals.autonomous =
      autonomous.taps + s5.jobTaps.reduce((sum, taps) => sum + taps, 0);

    console.info('ASKFLOOR tap totals', totals);
    expect(totals).toEqual({
      interactiveAuto: 3,
      strict: 1,
      ask: 1,
      autonomous: 2,
    });
  });
});
