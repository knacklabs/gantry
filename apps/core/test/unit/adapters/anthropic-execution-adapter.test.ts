import { describe, expect, it, vi } from 'vitest';

import { AnthropicClaudeAgentExecutionAdapter } from '@core/adapters/llm/anthropic-claude-agent/execution-adapter.js';
import type { AgentExecutionAdapterPrepareInput } from '@core/application/agent-execution/agent-execution-adapter.js';
import type { SkillArtifactStore } from '@core/domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import type { SkillCatalogItem } from '@core/domain/skills/skills.js';
import {
  type ModelCatalogEntry,
  resolveModelSelection,
} from '@core/shared/model-catalog.js';
import fs from 'fs';

const mockMaterializeClaudeRuntime = vi.hoisted(() =>
  vi.fn(async () => ({
    claudeConfigDir: '/tmp/gantry-runtime/.claude',
    protectedFilesystemPaths: ['/tmp/gantry-runtime/.claude'],
    cleanup: vi.fn(),
  })),
);

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
    },
  };
});

vi.mock(
  '@core/adapters/llm/anthropic-claude-agent/claude-config-materializer.js',
  () => ({
    materializeClaudeRuntime: mockMaterializeClaudeRuntime,
    projectClaudeModelCredentialEnv: (env: Record<string, string>) => env,
  }),
);

function prepareInput(
  patch: Partial<AgentExecutionAdapterPrepareInput> = {},
): AgentExecutionAdapterPrepareInput {
  return {
    group: {
      name: 'Test Agent',
      folder: 'test-agent',
      added_at: '2026-05-19T00:00:00.000Z',
    },
    input: {
      prompt: 'hello',
      chatJid: 'tg:test',
    },
    hostRuntime: {
      groupDir: '/tmp/gantry/agents/test-agent',
      groupIpcDir: '/tmp/gantry/ipc/test-agent',
      runnerDistDir: '/opt/gantry/dist/runner',
    },
    groupDir: '/tmp/gantry/agents/test-agent',
    effectiveModel: 'claude-sonnet-4-5',
    modelCredentialProjection: {
      env: {},
      credentialProviders: {},
      brokerProfile: 'none',
      brokerApplied: false,
    },
    browserIpcEnabled: false,
    packageRootFromRunner: () => '/opt/gantry',
    ...patch,
  };
}

const anthropicBaseUrlKey = () => 'ANTHROPIC' + '_BASE_URL';
const claudeCodeOAuthTokenKey = () =>
  ['CLAUDE', 'CODE', 'OAUTH', 'TOKEN'].join('_');
function catalogEntry(alias: string): ModelCatalogEntry {
  const resolved = resolveModelSelection(alias);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.entry;
}

function installedSkill(): SkillCatalogItem {
  return {
    id: 'skill:release' as never,
    appId: 'app:test' as never,
    agentId: 'agent:test' as never,
    name: 'release-writer',
    source: 'admin_uploaded',
    status: 'installed',
    promptRefs: [],
    toolIds: [],
    workflowRefs: [],
    storage: {
      storageType: 'local-filesystem',
      storageRef: 'skill-release',
      contentHash: 'sha256:release',
      sizeBytes: 1,
    },
    createdAt: '2026-06-16T00:00:00.000Z',
    updatedAt: '2026-06-16T00:00:00.000Z',
  };
}

describe('AnthropicClaudeAgentExecutionAdapter', () => {
  it('passes the host-validated Gantry MCP server path to the relocated runner', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    const prepared = await adapter.prepare(prepareInput());

    expect(prepared.env.GANTRY_MCP_SERVER_PATH).toBe(
      '/opt/gantry/dist/runner/mcp/stdio.js',
    );
  });

  it('delegates Claude config projection to the materializer', async () => {
    mockMaterializeClaudeRuntime.mockClear();
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await adapter.prepare(prepareInput());

    const materializeInput = mockMaterializeClaudeRuntime.mock.calls[0]?.[0];
    expect(materializeInput).toMatchObject({
      groupDir: '/tmp/gantry/agents/test-agent',
    });
    expect(materializeInput.baseTempDir).toBeUndefined();
  });

  it('declares Claude runtime paths through the adapter boundary', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    const prepared = await adapter.prepare(prepareInput());

    expect(prepared.runtimeConfigDir).toBe('/tmp/gantry-runtime/.claude');
    expect(prepared.sandboxRuntime?.toolTempDirLeaf).toMatch(/^claude/);
    expect(prepared.sandboxRuntime?.tempEnv?.('/tmp/runner')).toEqual({
      CLAUDE_CODE_TMPDIR: '/tmp/runner',
      CLAUDE_TMPDIR: '/tmp/runner',
    });
  });

  it('classifies stale Claude SDK resume sessions inside the adapter boundary', () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    expect(
      adapter.isMissingProviderSessionError(
        'No conversation found with session ID: stale',
      ),
    ).toBe(true);
    expect(adapter.isMissingProviderSessionError('provider auth failed')).toBe(
      false,
    );
  });

  it('passes only materialized Gantry skill names to the runner SDK whitelist', async () => {
    mockMaterializeClaudeRuntime.mockResolvedValueOnce({
      claudeConfigDir: '/tmp/gantry-runtime/.claude',
      protectedFilesystemPaths: ['/tmp/gantry-runtime/.claude'],
      materializedSkills: [
        { name: 'gantry-admin', materializedName: 'gantry-admin' },
        { name: 'LinkedIn Posting', materializedName: 'LinkedIn-Posting' },
      ],
      cleanup: vi.fn(),
    });
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    const prepared = await adapter.prepare(prepareInput());

    expect(prepared.env.GANTRY_CLAUDE_SDK_SKILLS_JSON).toBe(
      JSON.stringify(['LinkedIn-Posting', 'gantry-admin']),
    );
  });

  it('rejects materialized skill names that collide with Claude-native skills', async () => {
    mockMaterializeClaudeRuntime.mockResolvedValueOnce({
      claudeConfigDir: '/tmp/gantry-runtime/.claude',
      protectedFilesystemPaths: ['/tmp/gantry-runtime/.claude'],
      materializedSkills: [{ name: 'commands', materializedName: 'commands' }],
      cleanup: vi.fn(),
    });
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(adapter.prepare(prepareInput())).rejects.toThrow(
      'Claude-native reserved names',
    );
  });

  it('rejects gateway-brokered spawns whose model is not in the catalog', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          modelCredentialProjection: {
            env: {},
            credentialProviders: {},
            brokerProfile: 'gantry',
            brokerApplied: true,
          },
        }),
      ),
    ).rejects.toThrow('not in the model catalog');
  });

  it('passes only selected skill ids to Claude runtime materialization', async () => {
    mockMaterializeClaudeRuntime.mockClear();
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await adapter.prepare(
      prepareInput({
        browserIpcEnabled: true,
        input: {
          prompt: 'hello',
          chatJid: 'tg:test',
          attachedSkillSourceIds: ['skill:release'],
        },
      }),
    );

    expect(mockMaterializeClaudeRuntime.mock.calls[0]?.[0]).toMatchObject({
      enabledSkillIds: ['gantry-browser', 'skill:release'],
    });
  });

  it('feeds selected artifact skills to Claude through the Gantry projection', async () => {
    mockMaterializeClaudeRuntime.mockClear();
    const repo = {
      listEnabledSkillsForAgent: vi.fn(async () => [installedSkill()]),
    } as Partial<SkillCatalogRepository> as SkillCatalogRepository;
    const artifacts = {
      getSkillArtifact: vi.fn(async () => ({
        assets: [
          {
            path: 'SKILL.md',
            content: Buffer.from(`---
name: release-writer
description: Use this skill for release notes.
---

# Release Writer
`),
            contentType: 'text/markdown',
          },
        ],
      })),
    } as Partial<SkillArtifactStore> as SkillArtifactStore;
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await adapter.prepare(
      prepareInput({
        input: {
          prompt: 'hello',
          chatJid: 'tg:test',
          attachedSkillSourceIds: ['skill:release'],
        },
        options: {
          skillRepository: repo,
          skillArtifactStore: artifacts,
          skillContext: {
            appId: 'app:test',
            agentId: 'agent:test',
          },
        },
      }),
    );

    const skillSource =
      mockMaterializeClaudeRuntime.mock.calls[0]?.[0].skillSource;
    const skills = await skillSource.listSkills({
      enabledSkillIds: ['skill:release'],
    });
    expect(
      skills.filter((skill: { enabled: boolean }) => skill.enabled),
    ).toMatchObject([
      {
        id: 'skill:release',
        name: 'release-writer',
        sourceType: 'artifact',
        contentHash: 'sha256:release',
        enabled: true,
      },
    ]);
    expect(repo.listEnabledSkillsForAgent).toHaveBeenCalledWith({
      appId: 'app:test',
      agentId: 'agent:test',
    });
    expect(artifacts.getSkillArtifact).toHaveBeenCalledWith('skill-release');
  });

  it('passes an empty SDK skill allowlist when no skills are selected', async () => {
    mockMaterializeClaudeRuntime.mockClear();
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    const prepared = await adapter.prepare(prepareInput());

    expect(mockMaterializeClaudeRuntime.mock.calls[0]?.[0]).toMatchObject({
      enabledSkillIds: [],
    });
    expect(prepared.env.GANTRY_CLAUDE_SDK_SKILLS_JSON).toBe('[]');
  });

  it('fails when runner files are missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(adapter.prepare(prepareInput())).rejects.toThrow(
      'missing required Anthropic execution adapter runner files',
    );
  });

  it('fails when Anthropic model credentials are missing', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModelEntry: {
            ...catalogEntry('sonnet'),
            displayName: 'Sonnet',
            runnerModel: 'claude-sonnet-4-5',
          },
        }),
      ),
    ).rejects.toThrow('requires Gantry Model Gateway credentials');
  });

  it('allows Gantry gateway projections for Anthropic models', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModelEntry: {
            ...catalogEntry('sonnet'),
            displayName: 'Sonnet',
            runnerModel: 'claude-sonnet-4-5',
          },
          modelCredentialProjection: {
            env: Object.fromEntries([
              [anthropicBaseUrlKey(), 'http://127.0.0.1:4567/anthropic'],
              ['ANTHROPIC_API_KEY', 'gtw_test'],
            ]),
            credentialProviders: {},
            brokerProfile: 'gantry',
            brokerApplied: true,
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('rejects raw Claude Code OAuth projections for Anthropic models', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModelEntry: {
            ...catalogEntry('sonnet'),
            displayName: 'Sonnet',
            runnerModel: 'claude-sonnet-4-5',
          },
          modelCredentialProjection: {
            env: {
              [claudeCodeOAuthTokenKey()]: 'sk-ant-oat-test',
            },
            credentialProviders: {
              [claudeCodeOAuthTokenKey()]: 'native',
            },
            brokerProfile: 'gantry',
            brokerApplied: true,
          },
        }),
      ),
    ).rejects.toThrow('must not expose provider OAuth tokens');
  });

  it('allows IPv6 loopback Gantry gateway projections', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModelEntry: {
            ...catalogEntry('sonnet'),
            displayName: 'Sonnet',
            runnerModel: 'claude-sonnet-4-5',
          },
          modelCredentialProjection: {
            env: Object.fromEntries([
              [anthropicBaseUrlKey(), 'http://[::1]:4567/anthropic'],
              [['ANTHROPIC', 'API_KEY'].join('_'), 'gtw_test'],
            ]),
            credentialProviders: {},
            brokerProfile: 'gantry',
            brokerApplied: true,
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('rejects non-loopback gateway credentials for provider models', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          effectiveModelEntry: {
            ...catalogEntry('sonnet'),
            displayName: 'Sonnet',
            runnerModel: 'claude-sonnet-4-5',
          },
          modelCredentialProjection: {
            env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
            credentialProviders: {},
            brokerProfile: 'gantry',
            brokerApplied: true,
          },
        }),
      ),
    ).rejects.toThrow('must use a loopback ANTHROPIC_BASE_URL');
  });

  it('rejects runner paths outside the package root', async () => {
    const adapter = new AnthropicClaudeAgentExecutionAdapter();

    await expect(
      adapter.prepare(
        prepareInput({
          packageRootFromRunner: () => '/opt/other-package',
        }),
      ),
    ).rejects.toThrow('runner path escaped the Gantry package root');
  });
});
