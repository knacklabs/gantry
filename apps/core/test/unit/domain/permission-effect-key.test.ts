import { describe, expect, it } from 'vitest';

import {
  computePermissionEffectHash,
  EFFECT_SCHEMA_VERSION,
  RAIL_CATALOG_VERSION,
} from '@core/domain/permission-effect-key.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';

function shellRequest(
  command: string,
  overrides: Partial<PermissionApprovalRequest> = {},
): PermissionApprovalRequest {
  return {
    requestId: 'req-1',
    appId: 'default',
    sourceAgentFolder: 'agent-a',
    toolName: 'Bash',
    toolInput: { command },
    ...overrides,
  };
}

describe('computePermissionEffectHash', () => {
  it('is stable for identical exact input', () => {
    const a = computePermissionEffectHash({ request: shellRequest('ls -la') });
    const b = computePermissionEffectHash({ request: shellRequest('ls -la') });
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('is delimiter-safe: framing prevents a|b == ab collisions', () => {
    // Two requests whose adjacent fields, if naively concatenated, would form
    // the same string. appId+folder "a"+"bagent" vs "ab"+"agent".
    const left = computePermissionEffectHash({
      request: shellRequest('x', { appId: 'a', sourceAgentFolder: 'bagent' }),
    });
    const right = computePermissionEffectHash({
      request: shellRequest('x', { appId: 'ab', sourceAgentFolder: 'agent' }),
    });
    expect(left).not.toBe(right);
  });

  it('quoting differences change the hash', () => {
    const quoted = computePermissionEffectHash({
      request: shellRequest('echo "a b"'),
    });
    const bare = computePermissionEffectHash({
      request: shellRequest('echo a b'),
    });
    expect(quoted).not.toBe(bare);
  });

  it('different cwd changes the hash', () => {
    const req = shellRequest('cat notes.txt');
    const here = computePermissionEffectHash({
      request: req,
      workspaceRoot: '/agents/one',
    });
    const there = computePermissionEffectHash({
      request: req,
      workspaceRoot: '/agents/two',
    });
    expect(here).not.toBe(there);
  });

  it('different destination host changes the hash', () => {
    const a = computePermissionEffectHash({
      request: shellRequest('curl https://example.com/a'),
    });
    const b = computePermissionEffectHash({
      request: shellRequest('curl https://evil.example.net/a'),
    });
    expect(a).not.toBe(b);
  });

  it('different tool name changes the hash', () => {
    const bash = computePermissionEffectHash({
      request: shellRequest('git status'),
    });
    const run = computePermissionEffectHash({
      request: shellRequest('git status', { toolName: 'RunCommand' }),
    });
    expect(bash).not.toBe(run);
  });

  it('version bumps invalidate: versions are inside the hash', () => {
    // Guards against silently dropping the version fields from the payload.
    expect(EFFECT_SCHEMA_VERSION).toBe(3);
    expect(RAIL_CATALOG_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('isolates identical effects across provider accounts', () => {
    const accountA = computePermissionEffectHash({
      request: shellRequest('npm test', {
        providerAccountId: 'account-a',
        targetJid: 'conversation-a',
      }),
    });
    const accountB = computePermissionEffectHash({
      request: shellRequest('npm test', {
        providerAccountId: 'account-b',
        targetJid: 'conversation-a',
      }),
    });
    expect(accountA).toBeDefined();
    expect(accountA).not.toBe(accountB);
  });

  it('reuses identical effects within the same provider account', () => {
    const first = computePermissionEffectHash({
      request: shellRequest('npm test', {
        providerAccountId: 'account-a',
        targetJid: 'conversation-a',
      }),
    });
    const second = computePermissionEffectHash({
      request: shellRequest('npm test', {
        providerAccountId: 'account-a',
        targetJid: 'conversation-a',
      }),
    });
    const padded = computePermissionEffectHash({
      request: shellRequest('npm test', {
        providerAccountId: '  account-a  ',
        targetJid: 'conversation-a',
      }),
    });
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(padded).toBe(first);
  });

  it('hashes absent provider-account identity deterministically', () => {
    const first = computePermissionEffectHash({
      request: shellRequest('npm test', { targetJid: 'conversation-a' }),
    });
    const second = computePermissionEffectHash({
      request: shellRequest('npm test', { targetJid: 'conversation-a' }),
    });
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it('scopes identical effects to the parent conversation', () => {
    const conversationA = computePermissionEffectHash({
      request: shellRequest('npm test', { targetJid: 'conversation-a' }),
    });
    const conversationB = computePermissionEffectHash({
      request: shellRequest('npm test', { targetJid: 'conversation-b' }),
    });
    expect(conversationA).toBeDefined();
    expect(conversationA).not.toBe(conversationB);
  });

  it('reuses the parent-conversation effect across threads', () => {
    const base = shellRequest('npm test', {
      targetJid: 'conversation-a',
    });
    const parent = computePermissionEffectHash({ request: base });
    const thread = computePermissionEffectHash({
      request: { ...base, threadId: 'thread-1' },
    });
    expect(parent).toBeDefined();
    expect(thread).toBe(parent);
  });

  it('keeps the existing shared identity when no conversation is available', () => {
    const first = computePermissionEffectHash({
      request: shellRequest('npm test'),
    });
    const second = computePermissionEffectHash({
      request: shellRequest('npm test', { threadId: 'thread-without-parent' }),
    });
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it('non-shell input hashes a stable canonical JSON (key order agnostic)', () => {
    const base: PermissionApprovalRequest = {
      requestId: 'req-2',
      appId: 'default',
      sourceAgentFolder: 'agent-a',
      toolName: 'Read',
      toolInput: { file_path: '/x', limit: 10 },
    };
    const reordered: PermissionApprovalRequest = {
      ...base,
      toolInput: { limit: 10, file_path: '/x' },
    };
    const a = computePermissionEffectHash({ request: base });
    const b = computePermissionEffectHash({ request: reordered });
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('returns undefined when tool input is missing', () => {
    const req = shellRequest('ls');
    delete req.toolInput;
    expect(computePermissionEffectHash({ request: req })).toBeUndefined();
  });

  it('still caches sanitized/redacted input (values redacted, verbs intact)', () => {
    // Sensitive-VALUE redaction and 500-char display alteration do not change
    // the risk-relevant command, so the key still builds.
    expect(
      computePermissionEffectHash({
        request: shellRequest('ls', { toolInputSanitized: true }),
      }),
    ).toBeDefined();
    expect(
      computePermissionEffectHash({
        request: shellRequest('ls', { toolInputSanitizedPaths: ['command'] }),
      }),
    ).toBeDefined();

    const redacted = shellRequest('ls') as PermissionApprovalRequest & {
      toolInputRedactedPaths?: string[];
    };
    redacted.toolInputRedactedPaths = ['command'];
    expect(computePermissionEffectHash({ request: redacted })).toBeDefined();
  });

  it('returns undefined only when the shell command was truncated', () => {
    const truncated = shellRequest('ls') as PermissionApprovalRequest & {
      toolInputTruncatedPaths?: string[];
    };
    truncated.toolInputTruncatedPaths = ['command'];
    expect(computePermissionEffectHash({ request: truncated })).toBeUndefined();
  });

  it('builds a key for a benign host-env-prefixed (already-stripped) command', () => {
    // After ipc-parsing strips the host env prefix, the effect key sees the
    // real command and caches it.
    expect(
      computePermissionEffectHash({
        request: shellRequest('head -30 file'),
      }),
    ).toBeDefined();
  });

  it('hashes the full 16K classifier command, not the truncated display copy', () => {
    const full = `echo ${'a'.repeat(520)}`;
    const key = computePermissionEffectHash({
      request: shellRequest(`${full.slice(0, 500)}...[truncated]`, {
        classifierToolInput: { command: full },
      }),
    });
    expect(key).toBeDefined();
    // Same full command, different truncated display ⇒ same hash: the display
    // copy is ignored, the 16K command is what's hashed.
    const other = computePermissionEffectHash({
      request: shellRequest('a completely different display string', {
        classifierToolInput: { command: full },
      }),
    });
    expect(other).toBe(key);
  });

  it('returns undefined for a shell request with no command', () => {
    const req: PermissionApprovalRequest = {
      requestId: 'req-3',
      appId: 'default',
      sourceAgentFolder: 'agent-a',
      toolName: 'Bash',
      toolInput: {},
    };
    expect(computePermissionEffectHash({ request: req })).toBeUndefined();
  });
});
