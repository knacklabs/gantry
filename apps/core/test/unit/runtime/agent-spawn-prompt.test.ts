import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationRoute } from '@core/domain/types.js';
import type { AgentInput } from '@core/runtime/agent-spawn-types.js';
import '@core/channels/register-builtins.js';
import {
  compileSpawnSystemPrompt,
  resolveSpawnPromptAccessPreset,
} from '@core/runtime/agent-spawn-prompt.js';

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  withLogContext: (_context: unknown, callback: () => unknown) => callback(),
  updateLogContext: vi.fn(),
}));

vi.mock('@core/platform/workspace-folder.js', () => ({
  resolveWorkspaceFolderPath: (folder: string) => `/data/agents/${folder}`,
}));

const group: ConversationRoute = {
  name: 'Team',
  folder: 'team',
  trigger: '',
  added_at: '2026-01-01T00:00:00.000Z',
  conversationKind: 'dm',
};

const agentInput: AgentInput = {
  prompt: 'hello',
  workspaceFolder: 'team',
  chatJid: 'tg:1001',
};

function compile(overrides: {
  group?: Partial<ConversationRoute>;
  agentInput?: Partial<AgentInput>;
  accessPreset?: 'full' | 'locked';
  mcpInventoryToolsMounted?: boolean;
}): Promise<string> {
  return compileSpawnSystemPrompt({
    group: { ...group, ...(overrides.group ?? {}) },
    agentInput: { ...agentInput, ...(overrides.agentInput ?? {}) },
    appId: 'default',
    accessPreset: overrides.accessPreset ?? 'full',
    mcpInventoryToolsMounted: overrides.mcpInventoryToolsMounted ?? true,
    modelIdentity: {
      alias: 'Fable 5',
      modelId: 'claude-fable-5',
      provider: 'Anthropic API',
    },
    fileArtifactStore: () => undefined,
    measureAsync: (_name, fn) => fn(),
  });
}

describe('compileSpawnSystemPrompt', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats hidden authority tools as the locked prompt preset', () => {
    expect(resolveSpawnPromptAccessPreset('full', true)).toBe('locked');
    expect(resolveSpawnPromptAccessPreset('locked', false)).toBe('locked');
    expect(resolveSpawnPromptAccessPreset('full', false)).toBe('full');
  });

  it('omits acquisition guidance from a fixed-image compiled profile', async () => {
    const prompt = await compile({
      accessPreset: resolveSpawnPromptAccessPreset('full', true),
    });

    expect(prompt).not.toContain('request_access');
    expect(prompt).not.toContain('Acquire first');
    expect(prompt).toContain('If no provisioned action fits');
  });

  it('omits MCP inventory guidance when the execution surface does not mount it', async () => {
    const prompt = await compile({ mcpInventoryToolsMounted: false });

    expect(prompt).not.toContain('mcp_search_tools');
    expect(prompt).not.toContain('Acquire first');
  });

  it('threads model identity and spawn context into the compiled profile', async () => {
    const prompt = await compile({});

    expect(prompt).toContain(
      '- You are running on Fable 5 (claude-fable-5) via Anthropic API. State this plainly if the user asks which model you are; deeper runtime internals stay internal.',
    );
    expect(prompt).toContain('- Channel: Telegram direct message.');
    expect(prompt).toContain('- Workspace root: /data/agents/team.');
    expect(prompt).toContain('New user messages may arrive mid-run');
  });

  it('threads job context for scheduled job spawns', async () => {
    const prompt = await compile({
      group: { conversationKind: 'channel' },
      agentInput: {
        chatJid: 'sl:C1',
        isScheduledJob: true,
        jobId: 'job-9',
        jobName: 'Daily digest',
      },
    });

    expect(prompt).toContain('- Channel: Slack group conversation.');
    expect(prompt).toContain(
      '- This run executes scheduled job "Daily digest" (job-9).',
    );
    expect(prompt).not.toContain('New user messages may arrive mid-run');
  });

  it('threads the resolved capability catalog into the compiled profile', async () => {
    // Model behavioral-corpus coverage is intentionally deferred to the
    // separate evaluation; this unit test pins only prompt projection.
    const prompt = await compile({
      agentInput: {
        capabilityCatalog: {
          schemaVersion: 1,
          digest: 'catalog:test',
          readyActions: [
            {
              kind: 'reviewed_capability',
              stableRef: 'calendar.manage',
              displayName: 'Team calendar',
              description: 'Find availability and manage events.',
              category: 'Calendar',
            },
          ],
          installedSkills: [],
          connectedMcpSources: [],
        },
      },
    });

    expect(prompt).toContain('# Capability catalog');
    expect(prompt).toContain('Calendar · Team calendar');
    expect(prompt).toContain('Find availability and manage events.');
  });

  it('compiles byte-identical profiles across different clock times (cache safety)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T10:00:00.000Z'));
    const first = await compile({});
    vi.setSystemTime(new Date('2026-07-21T22:33:44.000Z'));
    const second = await compile({});

    expect(second).toBe(first);
  });
});
