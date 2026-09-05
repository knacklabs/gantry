import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  assertLlmConsultNotInvoked,
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

  it('S3: 2>/dev/null and read-only find cost 0 taps in interactive auto', async () => {
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
      taps: 0,
      decidedBy: 'auto_classifier',
      source: 'auto_classifier',
      railProvenance: { signal: 'unsupported_meta_executor' },
    });
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
      { permissionMode: 'auto' as const, hostJobId: 'job-tb' },
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
  });
});
