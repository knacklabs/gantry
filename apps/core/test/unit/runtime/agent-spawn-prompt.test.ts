import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationRoute } from '@core/domain/types.js';
import type { AgentInput } from '@core/runtime/agent-spawn-types.js';
import '@core/channels/register-builtins.js';
import {
  compileSpawnSystemPrompt,
  publishCapabilityCatalogOverflowDiagnostic,
  resolveSpawnPromptAccessPreset,
} from '@core/runtime/agent-spawn-prompt.js';
import { CapabilityCatalogOverflowError } from '@core/application/agents/agent-prompt-capability-guidance.js';
import {
  DEEPAGENTS_ENGINE,
  DEFAULT_AGENT_ENGINE,
  type AgentEngine,
} from '@core/shared/agent-engine.js';
import { composeAgentCapabilities } from '@core/adapters/llm/anthropic-claude-agent/agent-capabilities.js';
import { decideClaudeSdkToolSearch } from '@core/adapters/llm/anthropic-claude-agent/runner/tool-search-decision.js';

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
  agentEngine?: AgentEngine;
  resolveRoleSnapshot?: (agentId: string) => Promise<{
    displayName: string;
    prompt: string;
  }>;
}): Promise<string> {
  return compileSpawnSystemPrompt({
    group: { ...group, ...(overrides.group ?? {}) },
    agentInput: { ...agentInput, ...(overrides.agentInput ?? {}) },
    appId: 'default',
    accessPreset: overrides.accessPreset ?? 'full',
    mcpInventoryToolsMounted: overrides.mcpInventoryToolsMounted ?? true,
    agentEngine: overrides.agentEngine ?? DEFAULT_AGENT_ENGINE,
    modelIdentity: {
      alias: 'Fable 5',
      modelId: 'claude-fable-5',
      provider: 'Anthropic API',
    },
    ...(overrides.resolveRoleSnapshot
      ? { resolveRoleSnapshot: overrides.resolveRoleSnapshot }
      : {}),
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

  it('the resolved engine from the worker path selects the Anthropic tool name', async () => {
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
              invocations: [
                {
                  kind: 'local_cli',
                  toolRef: 'capability_run',
                  capabilityId: 'calendar.manage',
                  argumentPatterns: ['["events","list"]'],
                },
              ],
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
    expect(prompt).toContain('mcp__gantry__capability_run');
    expect(prompt).toContain('["events","list"]');
    expect(prompt).toContain('mcp_search_tools');
    const projection = composeAgentCapabilities({
      mcpServerPath: '/tmp/gantry-mcp.js',
      chatJid: 'tg:1001',
      workspaceFolder: '/tmp',
      configuredAllowedTools: ['mcp__gantry__capability_run'],
    });
    expect(projection.gantryOwnedTools).toContain(
      'mcp__gantry__capability_run',
    );
    expect(
      decideClaudeSdkToolSearch({
        sdkEnv: {},
        availableTools: projection.availableTools,
        allowedTools: projection.allowedTools,
        disallowedTools: projection.disallowedTools,
        mcpServers: projection.mcpServers,
      }).enableToolSearch,
    ).toBe('auto:10');
  });

  it('a deepagents engine renders no tool name and leaves guidance unchanged', async () => {
    const readyAction = {
      kind: 'reviewed_capability' as const,
      stableRef: 'calendar.manage',
      displayName: 'Team calendar',
      description: 'Find availability and manage events.',
      category: 'Calendar',
    };
    const catalog = {
      schemaVersion: 1 as const,
      digest: 'catalog:deepagents',
      readyActions: [
        {
          ...readyAction,
          invocations: [
            {
              kind: 'local_cli' as const,
              toolRef: 'capability_run' as const,
              capabilityId: 'calendar.manage',
              argumentPatterns: ['["events","list"]'],
            },
          ],
        },
      ],
      installedSkills: [],
      connectedMcpSources: [],
    };

    const withDescriptor = await compile({
      agentEngine: DEEPAGENTS_ENGINE,
      agentInput: { capabilityCatalog: catalog },
    });
    const withoutDescriptor = await compile({
      agentEngine: DEEPAGENTS_ENGINE,
      agentInput: {
        capabilityCatalog: { ...catalog, readyActions: [readyAction] },
      },
    });

    expect(withDescriptor).toBe(withoutDescriptor);
    expect(withDescriptor).not.toContain('capability_run');
  });

  it('hard overflow aborts the spawn and publishes capability_catalog_overflow before any provider call', async () => {
    const publishRuntimeEvent = vi.fn();
    const providerCall = vi.fn();
    const readyActions = Array.from({ length: 600 }, (_, index) => ({
      kind: 'reviewed_capability' as const,
      stableRef: `capability.${index}.${'x'.repeat(60)}`,
      displayName: `Capability ${index}`,
      description: 'Ready.',
      category: 'Operations',
    }));
    let overflow: CapabilityCatalogOverflowError | undefined;

    try {
      await compile({
        agentInput: {
          capabilityCatalog: {
            schemaVersion: 1,
            digest: 'catalog:overflow',
            readyActions,
            installedSkills: [],
            connectedMcpSources: [],
          },
        },
      });
      providerCall();
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityCatalogOverflowError);
      overflow = error as CapabilityCatalogOverflowError;
    }

    await publishCapabilityCatalogOverflowDiagnostic({
      error: overflow!,
      agentInput: {
        ...agentInput,
        appId: 'app-one',
        agentId: 'agent-one',
        runId: 'run-one',
        jobId: 'job-one',
      },
      appId: 'app-one',
      publishRuntimeEvent,
    });

    expect(publishRuntimeEvent).toHaveBeenCalledOnce();
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          provider: 'host',
          diagnostic: 'capability_catalog_overflow',
          conversationJid: 'tg:1001',
          grantedCount: 600,
          renderableCount: expect.any(Number),
          sheddingStage: 'compact_overflow',
        },
      }),
    );
    expect(providerCall).not.toHaveBeenCalled();
    expect(JSON.stringify(publishRuntimeEvent.mock.calls)).not.toContain(
      'capability.0',
    );
  });

  it('uses the saved role snapshot for the runtime agent', async () => {
    const resolveRoleSnapshot = vi.fn(async (agentId: string) => {
      expect(agentId).toBe('agent-one');
      return {
        displayName: 'Release writer',
        prompt: 'Write concise release notes.',
      };
    });

    const prompt = await compile({
      agentInput: { agentId: 'agent-one' },
      resolveRoleSnapshot,
    });

    expect(resolveRoleSnapshot).toHaveBeenCalledTimes(1);
    expect(prompt).toContain('Write concise release notes.');
    expect(prompt).toContain('# Gantry Runtime Rules');
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
