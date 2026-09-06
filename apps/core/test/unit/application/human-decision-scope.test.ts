import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveHumanDecisionScopeKey,
  HumanDecisionNotRememberableReason,
} from '@core/application/permissions/human-decision-scope.js';
import {
  HumanDecisionOutcome,
  HumanDecisionScope,
} from '@core/domain/ports/permission-decision-memory.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';

const tempRoots: string[] = [];

function makeRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `human-scope-${label}-`));
  tempRoots.push(root);
  return root;
}

function request(
  toolName: string,
  toolInput: Record<string, unknown>,
): PermissionApprovalRequest {
  return {
    requestId: `request-${toolName}`,
    sourceAgentFolder: 'main_agent',
    toolName,
    toolInput,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('human decision scope keys', () => {
  it("keys a remembered No on the full effect hash for every shape and a remembered Allow path-only on canonical tool plus the boundary's canonicalPath or the virtual scope and path for a single unprotected native or virtual write including bare file and mcp__gantry__file and an omitted virtual scope, checking every supplied native destination first so a conflicting dual input with one unsafe destination is refused while an all-safe dual input, shell commands and malformed shapes fall back to the full hash, with a changed-content near-miss keeping allow keys equal and deny keys different", async () => {
    const workspaceRoot = makeRoot('workspace');
    fs.mkdirSync(path.join(workspaceRoot, 'notes'));

    const shapes = [
      request('FileWrite', { path: 'notes/a.md', content: 'one' }),
      request('file', { action: 'write', path: 'a.md', content: 'one' }),
      request('RunCommand', { command: 'printf x > a.md' }),
      request('WebSearch', { query: 'gantry' }),
    ];
    for (const [index, shape] of shapes.entries()) {
      await expect(
        deriveHumanDecisionScopeKey({
          outcome: HumanDecisionOutcome.Deny,
          scope: HumanDecisionScope.Exact,
          request: shape,
          effectHash: `deny-hash-${index}`,
          workspaceRoot,
        }),
      ).resolves.toEqual({
        ok: true,
        scopeKey: `deny-hash-${index}`,
        pathOnly: false,
      });
    }

    const allowOne = await deriveHumanDecisionScopeKey({
      outcome: HumanDecisionOutcome.Allow,
      scope: HumanDecisionScope.Exact,
      request: request('FileWrite', {
        path: 'notes/a.md',
        content: 'one',
      }),
      effectHash: 'allow-hash-one',
      workspaceRoot,
    });
    const allowChangedContent = await deriveHumanDecisionScopeKey({
      outcome: HumanDecisionOutcome.Allow,
      scope: HumanDecisionScope.Exact,
      request: request('FileWrite', {
        path: 'notes/a.md',
        content: 'two',
      }),
      effectHash: 'allow-hash-two',
      workspaceRoot,
    });
    const canonicalWorkspaceRoot = fs.realpathSync(workspaceRoot);
    expect(allowOne).toEqual({
      ok: true,
      scopeKey: `exact:path:FileWrite:${path.join(canonicalWorkspaceRoot, 'notes/a.md')}`,
      pathOnly: true,
    });
    expect(allowChangedContent).toEqual(allowOne);

    const denyOne = await deriveHumanDecisionScopeKey({
      outcome: HumanDecisionOutcome.Deny,
      scope: HumanDecisionScope.Exact,
      request: request('FileWrite', {
        path: 'notes/a.md',
        content: 'one',
      }),
      effectHash: 'deny-one',
      workspaceRoot,
    });
    const denyChangedContent = await deriveHumanDecisionScopeKey({
      outcome: HumanDecisionOutcome.Deny,
      scope: HumanDecisionScope.Exact,
      request: request('FileWrite', {
        path: 'notes/a.md',
        content: 'two',
      }),
      effectHash: 'deny-two',
      workspaceRoot,
    });
    expect(denyOne).not.toEqual(denyChangedContent);

    await expect(
      deriveHumanDecisionScopeKey({
        outcome: HumanDecisionOutcome.Allow,
        scope: HumanDecisionScope.Exact,
        request: request('FileEdit', {
          file_path: 'notes/a.md',
          patch: 'x',
        }),
        effectHash: 'edit-hash',
        workspaceRoot,
      }),
    ).resolves.toEqual({
      ok: true,
      scopeKey: `exact:path:FileEdit:${path.join(canonicalWorkspaceRoot, 'notes/a.md')}`,
      pathOnly: true,
    });

    await expect(
      deriveHumanDecisionScopeKey({
        outcome: HumanDecisionOutcome.Allow,
        scope: HumanDecisionScope.Exact,
        request: request('FileWrite', {
          file_path: 'notes/a.md',
          path: 'notes/b.md',
        }),
        effectHash: 'dual-safe-hash',
        workspaceRoot,
      }),
    ).resolves.toEqual({
      ok: true,
      scopeKey: 'dual-safe-hash',
      pathOnly: false,
    });
    await expect(
      deriveHumanDecisionScopeKey({
        outcome: HumanDecisionOutcome.Allow,
        scope: HumanDecisionScope.Exact,
        request: request('FileWrite', {
          file_path: 'notes/a.md',
          path: '../outside.md',
        }),
        effectHash: 'dual-unsafe-hash',
        workspaceRoot,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: HumanDecisionNotRememberableReason.ProtectedDestination,
    });

    const virtualExpected = {
      ok: true,
      scopeKey: 'exact:path:file:default/notes/a.md',
      pathOnly: true,
    } as const;
    for (const toolName of ['file', 'mcp__gantry__file']) {
      await expect(
        deriveHumanDecisionScopeKey({
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Exact,
          request: request(toolName, {
            action: 'write',
            path: ' notes/a.md ',
            content: 'hello',
          }),
          effectHash: 'virtual-hash',
        }),
      ).resolves.toEqual(virtualExpected);
    }
    await expect(
      deriveHumanDecisionScopeKey({
        outcome: HumanDecisionOutcome.Allow,
        scope: HumanDecisionScope.Exact,
        request: request('file', {
          action: 'promote_scratch',
          path: 'draft.md',
          targetScope: 'shared',
          targetPath: 'final.md',
        }),
        effectHash: 'promote-hash',
      }),
    ).resolves.toEqual({
      ok: true,
      scopeKey: 'exact:path:file:shared/final.md',
      pathOnly: true,
    });

    for (const malformed of [
      request('file', { action: 'write', content: 'missing path' }),
      request('file', { action: 'write', path: 1, content: 'bad path' }),
      request('FileWrite', { path: 1, file_path: 'notes/a.md' }),
      request('RunCommand', { command: 'cp a b' }),
    ]) {
      await expect(
        deriveHumanDecisionScopeKey({
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Exact,
          request: malformed,
          effectHash: 'fallback-hash',
          workspaceRoot,
        }),
      ).resolves.toEqual({
        ok: true,
        scopeKey: 'fallback-hash',
        pathOnly: false,
      });
    }
  });

  it('returns the closed refusal reason for an Allow to a protected, outside, hidden, secret or symlinked destination, for a kind scope without a closed category including a mixed read and write pipeline, for a place scope without a root, for a deny outside exact scope and for an incomplete effect, and formats kind keys from the closed request table (read_only_command and file_read over every parsed leaf with the gate\'s compound stdinOk rule pinned for pipelines and and-or-semicolon compounds alike, virtual_file_read, web_search, web_read, the trust-growth tool kind) and place keys from the canonical root', async () => {
    const workspaceRoot = makeRoot('protected-workspace');
    const outsideRoot = makeRoot('outside');
    fs.mkdirSync(path.join(workspaceRoot, 'notes'));
    fs.symlinkSync(outsideRoot, path.join(workspaceRoot, 'linked'));

    for (const destination of [
      'settings.yaml',
      '../outside.md',
      '.hidden/a.md',
      'notes/private-key.pem',
      'linked/a.md',
    ]) {
      await expect(
        deriveHumanDecisionScopeKey({
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Exact,
          request: request('FileWrite', { path: destination, content: 'x' }),
          effectHash: 'protected-hash',
          workspaceRoot,
        }),
      ).resolves.toEqual({
        ok: false,
        reason: HumanDecisionNotRememberableReason.ProtectedDestination,
      });
    }
    for (const toolInput of [
      { action: 'write', path: 'settings.yaml', content: 'x' },
      { action: 'write', path: 'notes/a.md', content: 'x', protected: true },
    ]) {
      await expect(
        deriveHumanDecisionScopeKey({
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Exact,
          request: request('file', toolInput),
          effectHash: 'protected-virtual-hash',
        }),
      ).resolves.toEqual({
        ok: false,
        reason: HumanDecisionNotRememberableReason.ProtectedDestination,
      });
    }

    const kindCases: Array<[PermissionApprovalRequest, string]> = [
      [request('RunCommand', { command: 'echo hi' }), 'kind:read_only_command'],
      [request('Bash', { command: 'cat notes/a.md' }), 'kind:file_read'],
      [request('Bash', { command: 'cat notes/a.md | cat' }), 'kind:file_read'],
      [request('Bash', { command: 'echo hi | cat' }), 'kind:read_only_command'],
      [request('Bash', { command: 'echo a && echo b' }), 'kind:read_only_command'],
      [request('Bash', { command: 'echo a || echo b' }), 'kind:read_only_command'],
      [request('Bash', { command: 'echo a; echo b' }), 'kind:read_only_command'],
      [request('file', { action: 'list' }), 'kind:virtual_file_read'],
      [request('mcp__gantry__file', { action: 'read', path: 'a.md' }), 'kind:virtual_file_read'],
      [request('WebSearch', { query: 'gantry' }), 'kind:web_search'],
      [request('WebRead', { url: 'https://example.com' }), 'kind:web_read'],
    ];
    for (const [kindRequest, scopeKey] of kindCases) {
      await expect(
        deriveHumanDecisionScopeKey({
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Kind,
          request: kindRequest,
        }),
      ).resolves.toEqual({ ok: true, scopeKey, pathOnly: false });
    }
    await expect(
      deriveHumanDecisionScopeKey({
        outcome: HumanDecisionOutcome.Allow,
        scope: HumanDecisionScope.Kind,
        request: request('mcp__gantry__scheduler_delete_job', { jobId: '1' }),
        trustGrowthTool: true,
      }),
    ).resolves.toEqual({
      ok: true,
      scopeKey: 'kind:tool:scheduler_delete_job',
      pathOnly: false,
    });

    for (const noCategory of [
      request('UnknownTool', {}),
      request('Bash', { command: 'cat notes/a.md | tee notes/b.md' }),
      request('Bash', { command: '' }),
    ]) {
      await expect(
        deriveHumanDecisionScopeKey({
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Kind,
          request: noCategory,
        }),
      ).resolves.toEqual({
        ok: false,
        reason: HumanDecisionNotRememberableReason.NoCategory,
      });
    }

    await expect(
      deriveHumanDecisionScopeKey({
        outcome: HumanDecisionOutcome.Allow,
        scope: HumanDecisionScope.Place,
        request: request('WebRead', {}),
        canonicalRoot: '/canonical/root',
      }),
    ).resolves.toEqual({
      ok: true,
      scopeKey: 'place:/canonical/root',
      pathOnly: false,
    });
    await expect(
      deriveHumanDecisionScopeKey({
        outcome: HumanDecisionOutcome.Allow,
        scope: HumanDecisionScope.Place,
        request: request('WebRead', {}),
        canonicalRoot: ' ',
      }),
    ).resolves.toEqual({
      ok: false,
      reason: HumanDecisionNotRememberableReason.NoRoot,
    });

    for (const scope of [HumanDecisionScope.Kind, HumanDecisionScope.Place]) {
      await expect(
        deriveHumanDecisionScopeKey({
          outcome: HumanDecisionOutcome.Deny,
          scope,
          request: request('WebRead', {}),
        }),
      ).resolves.toEqual({
        ok: false,
        reason: HumanDecisionNotRememberableReason.DenyRequiresExact,
      });
    }
    for (const incomplete of [
      {
        outcome: HumanDecisionOutcome.Deny,
        request: request('file', { action: 'write', path: 'a.md' }),
      },
      {
        outcome: HumanDecisionOutcome.Allow,
        request: request('WebSearch', { query: 'gantry' }),
      },
    ]) {
      await expect(
        deriveHumanDecisionScopeKey({
          ...incomplete,
          scope: HumanDecisionScope.Exact,
        }),
      ).resolves.toEqual({
        ok: false,
        reason: HumanDecisionNotRememberableReason.IncompleteEffect,
      });
    }
  });
});
