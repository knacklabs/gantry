import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@core/cli/control-api.js');
  vi.doUnmock('@clack/prompts');
  vi.doUnmock('@core/config/settings/runtime-settings.js');
  vi.doUnmock('@core/config/settings/desired-settings-writer.js');
});

function mockClack(note?: ReturnType<typeof vi.fn>) {
  vi.doMock('@clack/prompts', () => ({
    log: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn() },
    note: note ?? vi.fn(),
  }));
}

describe('agent access CLI (runAccess)', () => {
  it('returns 1 for an unknown action', async () => {
    mockClack();
    const controlApiRequest = vi.fn();
    vi.doMock('@core/cli/control-api.js', () => ({ controlApiRequest }));
    const { runAccess } = await import('@core/cli/group-access.js');
    expect(await runAccess('/tmp/gantry-access-test', ['bogus', 'a1'])).toBe(1);
    expect(controlApiRequest).not.toHaveBeenCalled();
  });

  it('GET /access for show with a normalized agent id', async () => {
    mockClack();
    const controlApiRequest = vi.fn(async () => ({
      agentId: 'agent:a1',
      sources: { skills: [], mcpServers: [], tools: [] },
      selections: [],
    }));
    vi.doMock('@core/cli/control-api.js', () => ({ controlApiRequest }));
    const { runAccess } = await import('@core/cli/group-access.js');
    expect(await runAccess('/tmp/gantry-access-test', ['show', 'a1'])).toBe(0);
    expect(controlApiRequest).toHaveBeenCalledWith(
      '/tmp/gantry-access-test',
      expect.objectContaining({
        method: 'GET',
        path: '/v1/agents/agent%3Aa1/access',
      }),
    );
  });

  it('renders the outcome-first summary sections', async () => {
    const note = vi.fn();
    mockClack(note);
    const controlApiRequest = vi.fn(async () => ({
      agentId: 'agent:a1',
      sources: {
        skills: [{ id: 'skill:linkedin', name: 'linkedin-posting' }],
        mcpServers: [{ id: 'github', tools: ['read_*'] }, { id: 'linear' }],
        tools: [],
      },
      selections: [{ id: 'browser.use', version: 'builtin' }],
      summary: {
        connected: [
          { label: 'linkedin-posting', detail: 'skill' },
          { label: 'github', detail: 'read_*' },
          { label: 'linear', detail: 'all reviewed tools' },
        ],
        allowed: [{ label: 'browser use', detail: 'future access' }],
        needsAttention: [
          {
            label: 'Send email is awaiting approval',
            detail: "Approve it in the agent's chat.",
          },
        ],
        suggestedCleanup: [
          { label: 'tool:old', detail: 'No longer used. You can remove it.' },
        ],
      },
    }));
    vi.doMock('@core/cli/control-api.js', () => ({ controlApiRequest }));
    const { runAccess } = await import('@core/cli/group-access.js');
    expect(await runAccess('/tmp/gantry-access-test', ['show', 'a1'])).toBe(0);
    const rendered = String(note.mock.calls[0]?.[0] ?? '');
    expect(rendered).toContain('Agent Access');
    expect(rendered).toContain(
      'Used in every conversation this agent is added to.',
    );
    expect(rendered).toContain('Connected:');
    expect(rendered).toContain('  - linkedin-posting (skill)');
    expect(rendered).toContain('  - github (read_*)');
    expect(rendered).toContain('  - linear (all reviewed tools)');
    expect(rendered).toContain('Allowed:');
    expect(rendered).toContain('  - browser use (future access)');
    expect(rendered).toContain('Needs attention:');
    expect(rendered).toContain(
      "  - Send email is awaiting approval. Next: Approve it in the agent's chat.",
    );
    expect(rendered).toContain('Suggested cleanup:');
    expect(rendered).toContain(
      '  - tool:old. Reason: No longer used. You can remove it.',
    );
    expect(rendered).toContain(
      'Details: use --json or audit/events for exact ids and rule details.',
    );
  });

  it('prints (none) for empty summary sections', async () => {
    const note = vi.fn();
    mockClack(note);
    const controlApiRequest = vi.fn(async () => ({
      agentId: 'agent:a1',
      sources: { skills: [], mcpServers: [], tools: [] },
      selections: [],
      summary: {
        connected: [],
        allowed: [],
        needsAttention: [],
        suggestedCleanup: [],
      },
    }));
    vi.doMock('@core/cli/control-api.js', () => ({ controlApiRequest }));
    const { runAccess } = await import('@core/cli/group-access.js');
    expect(await runAccess('/tmp/gantry-access-test', ['show', 'a1'])).toBe(0);
    const rendered = String(note.mock.calls[0]?.[0] ?? '');
    expect(rendered.match(/\(none\)/g)?.length).toBe(4);
  });

  it('falls back to raw sources and selections when summary is absent', async () => {
    const note = vi.fn();
    mockClack(note);
    const controlApiRequest = vi.fn(async () => ({
      agentId: 'agent:a1',
      sources: {
        skills: [{ id: 'skill:linkedin', name: 'linkedin-posting' }],
        mcpServers: [{ id: 'github', tools: ['read_*'] }, { id: 'linear' }],
        tools: [{ id: 'tool:notes', kind: 'adapter' }],
      },
      selections: [{ id: 'browser.use', version: 'builtin' }],
      toolAccess: {},
      updatedAt: '2026-06-03T00:00:00.000Z',
    }));
    vi.doMock('@core/cli/control-api.js', () => ({ controlApiRequest }));
    const { runAccess } = await import('@core/cli/group-access.js');
    expect(await runAccess('/tmp/gantry-access-test', ['show', 'a1'])).toBe(0);
    const rendered = String(note.mock.calls[0]?.[0] ?? '');
    expect(rendered).toContain('  - linkedin-posting (skill)');
    expect(rendered).toContain('  - github (read_*)');
    expect(rendered).toContain('  - linear (all reviewed tools)');
    expect(rendered).toContain('  - tool:notes (adapter)');
    expect(rendered).toContain('  - browser use (future access)');
  });

  it('emits raw JSON for show --json', async () => {
    mockClack();
    const controlApiRequest = vi.fn(async () => ({
      agentId: 'agent:a1',
      sources: { skills: [], mcpServers: [], tools: [] },
      selections: [],
    }));
    vi.doMock('@core/cli/control-api.js', () => ({ controlApiRequest }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { runAccess } = await import('@core/cli/group-access.js');
    expect(
      await runAccess('/tmp/gantry-access-test', ['show', 'a1', '--json']),
    ).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"agentId"'));
  });

  it('apply PUTs only the writable {sources, selections} subset', async () => {
    mockClack();
    const controlApiRequest = vi.fn(async () => ({ ok: true }));
    vi.doMock('@core/cli/control-api.js', () => ({ controlApiRequest }));
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-access-')),
      'access.json',
    );
    // Includes read-only fields that `access show` emits — must be stripped.
    fs.writeFileSync(
      file,
      JSON.stringify({
        agentId: 'agent:a1',
        updatedAt: '2026-05-31T00:00:00.000Z',
        toolAccess: { configuredTools: [] },
        sources: {
          skills: [],
          mcpServers: [{ id: 'mcp:github', tools: ['read_*'] }],
          tools: [],
        },
        selections: [{ id: 'browser.use', version: 'builtin' }],
      }),
    );
    const { runAccess } = await import('@core/cli/group-access.js');
    expect(
      await runAccess('/tmp/gantry-access-test', [
        'apply',
        'a1',
        '--file',
        file,
      ]),
    ).toBe(0);
    expect(controlApiRequest).toHaveBeenCalledWith(
      '/tmp/gantry-access-test',
      expect.objectContaining({
        method: 'PUT',
        path: '/v1/agents/agent%3Aa1/access',
        body: {
          sources: {
            skills: [],
            mcpServers: [{ id: 'mcp:github', tools: ['read_*'] }],
            tools: [],
          },
          selections: [{ id: 'browser.use', version: 'builtin' }],
        },
      }),
    );
  });

  it('returns 1 when apply has no --file', async () => {
    mockClack();
    const controlApiRequest = vi.fn();
    vi.doMock('@core/cli/control-api.js', () => ({ controlApiRequest }));
    const { runAccess } = await import('@core/cli/group-access.js');
    expect(await runAccess('/tmp/gantry-access-test', ['apply', 'a1'])).toBe(1);
    expect(controlApiRequest).not.toHaveBeenCalled();
  });
});

function lockedAgentSettings() {
  return {
    agents: {
      support_agent: {
        name: 'Support',
        folder: 'support_agent',
        bindings: {},
        sources: { skills: [], mcpServers: [], tools: [] },
        capabilities: [],
        accessPreset: 'full' as const,
      },
    },
  };
}

function mockSettingsWriters(
  settings: ReturnType<typeof lockedAgentSettings>,
  writeDesiredRuntimeSettings: ReturnType<typeof vi.fn>,
) {
  vi.doMock('@core/config/settings/runtime-settings.js', () => ({
    loadRuntimeSettings: vi.fn(() => settings),
  }));
  vi.doMock('@core/config/settings/desired-settings-writer.js', () => ({
    writeDesiredRuntimeSettings,
  }));
}

describe('agent access preset CLI (runAccess preset)', () => {
  it('writes the locked preset to settings.yaml via the desired-state writer', async () => {
    mockClack();
    vi.doMock('@core/cli/control-api.js', () => ({
      controlApiRequest: vi.fn(),
    }));
    const writeDesiredRuntimeSettings = vi.fn(async () => ({
      reconciled: true,
    }));
    mockSettingsWriters(lockedAgentSettings(), writeDesiredRuntimeSettings);
    const { runAccess } = await import('@core/cli/group-access.js');

    expect(
      await runAccess('/tmp/gantry-access-test', [
        'preset',
        'support_agent',
        'locked',
      ]),
    ).toBe(0);
    expect(writeDesiredRuntimeSettings).toHaveBeenCalledTimes(1);
    const written = writeDesiredRuntimeSettings.mock.calls[0]?.[0] as {
      settings: { agents: Record<string, { accessPreset: string }> };
    };
    expect(written.settings.agents.support_agent.accessPreset).toBe('locked');
  });

  it('warns about operator-authored profile files after flipping to locked', async () => {
    const log = {
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    };
    vi.doMock('@clack/prompts', () => ({ log, note: vi.fn() }));
    vi.doMock('@core/cli/control-api.js', () => ({
      controlApiRequest: vi.fn(),
    }));
    const writeDesiredRuntimeSettings = vi.fn(async () => ({
      reconciled: true,
    }));
    mockSettingsWriters(lockedAgentSettings(), writeDesiredRuntimeSettings);
    const { runAccess } = await import('@core/cli/group-access.js');

    expect(
      await runAccess('/tmp/gantry-access-test', [
        'preset',
        'support_agent',
        'locked',
      ]),
    ).toBe(0);

    const warning = String(log.warn.mock.calls[0]?.[0] ?? '');
    expect(warning).toContain('Operator-authored profile files');
    expect(warning).toMatch(/support_agent[/\\]SOUL\.md/);
    expect(warning).toMatch(/support_agent[/\\]AGENTS\.md/);
    expect(warning).toContain(
      'gantry agent profile set support_agent agents --file <path|->',
    );
  });

  it('does not print the profile review warning when flipping to full', async () => {
    const log = {
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    };
    vi.doMock('@clack/prompts', () => ({ log, note: vi.fn() }));
    vi.doMock('@core/cli/control-api.js', () => ({
      controlApiRequest: vi.fn(),
    }));
    const writeDesiredRuntimeSettings = vi.fn(async () => ({
      reconciled: true,
    }));
    const settings = lockedAgentSettings();
    settings.agents.support_agent.accessPreset = 'locked' as never;
    mockSettingsWriters(settings, writeDesiredRuntimeSettings);
    const { runAccess } = await import('@core/cli/group-access.js');

    expect(
      await runAccess('/tmp/gantry-access-test', [
        'preset',
        'support_agent',
        'full',
      ]),
    ).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('rejects an invalid preset value without writing', async () => {
    mockClack();
    vi.doMock('@core/cli/control-api.js', () => ({
      controlApiRequest: vi.fn(),
    }));
    const writeDesiredRuntimeSettings = vi.fn(async () => ({
      reconciled: true,
    }));
    mockSettingsWriters(lockedAgentSettings(), writeDesiredRuntimeSettings);
    const { runAccess } = await import('@core/cli/group-access.js');

    expect(
      await runAccess('/tmp/gantry-access-test', [
        'preset',
        'support_agent',
        'paranoid',
      ]),
    ).toBe(1);
    expect(writeDesiredRuntimeSettings).not.toHaveBeenCalled();
  });

  it('returns 1 for an unknown agent without writing', async () => {
    mockClack();
    vi.doMock('@core/cli/control-api.js', () => ({
      controlApiRequest: vi.fn(),
    }));
    const writeDesiredRuntimeSettings = vi.fn(async () => ({
      reconciled: true,
    }));
    mockSettingsWriters(lockedAgentSettings(), writeDesiredRuntimeSettings);
    const { runAccess } = await import('@core/cli/group-access.js');

    expect(
      await runAccess('/tmp/gantry-access-test', [
        'preset',
        'missing_agent',
        'locked',
      ]),
    ).toBe(1);
    expect(writeDesiredRuntimeSettings).not.toHaveBeenCalled();
  });
});
