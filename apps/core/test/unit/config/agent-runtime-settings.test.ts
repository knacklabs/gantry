import { describe, expect, it, vi } from 'vitest';

import { SettingsDesiredStateService } from '@core/config/settings/desired-state-service.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';
import { parseRuntimeSettings } from '@core/config/settings/runtime-settings-parser.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import { resolveConfiguredAgentRuntime } from '@core/config/settings/runtime-settings-agent-runtime.js';

function emptySources() {
  return { skills: [], mcpServers: [], tools: [] };
}

describe('agent runtime settings', () => {
  it('parses inline runtime and defaults agents to worker', () => {
    const defaults = parseRuntimeSettings(`agents:
  main_agent:
    name: Main
`);
    expect(resolveConfiguredAgentRuntime(defaults.agents.main_agent)).toBe(
      'worker',
    );

    const parsed = parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: inline
`);
    expect(resolveConfiguredAgentRuntime(parsed.agents.main_agent)).toBe(
      'inline',
    );

    const rendered = renderRuntimeSettingsYaml(parsed);
    expect(rendered).toContain('runtime: inline');
    expect(
      resolveConfiguredAgentRuntime(
        parseRuntimeSettings(rendered).agents.main_agent,
      ),
    ).toBe('inline');
  });

  it('rejects inline agents while naming worker-only configured capabilities', () => {
    expect(() =>
      parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: inline
    access:
      sources:
        skills:
          - id: skill:writer
        tools:
          - id: acme-cli
            kind: local_cli
      selections:
        - id: RunCommand(npm test *)
          version: builtin
        - id: FileRead
          version: builtin
        - id: Browser
          version: builtin
`),
    ).toThrow(
      'agents.main_agent.runtime inline is incompatible with worker-only capabilities: Browser, FileRead, RunCommand(npm test *), acme-cli, skill:writer',
    );
  });

  it('rejects a worker to inline flip while worker-only capabilities are held', () => {
    const worker = parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: worker
    access:
      selections:
        - id: FileWrite
          version: builtin
`);
    expect(resolveConfiguredAgentRuntime(worker.agents.main_agent)).toBe(
      'worker',
    );

    expect(() =>
      parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: inline
    access:
      selections:
        - id: FileWrite
          version: builtin
`),
    ).toThrow('worker-only capabilities: FileWrite');
  });

  it('allows an inline to worker flip with worker-only capabilities still held', () => {
    const parsed = parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: worker
    access:
      sources:
        skills:
          - id: skill:writer
      selections:
        - id: RunCommand(npm test *)
          version: builtin
`);
    expect(resolveConfiguredAgentRuntime(parsed.agents.main_agent)).toBe(
      'worker',
    );
    expect(parsed.agents.main_agent.sources.skills[0]?.id).toBe('skill:writer');
  });

  it('rejects inline settings apply when an attached MCP source is stdio', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      runtime: 'inline',
      bindings: {},
      sources: {
        ...emptySources(),
        mcpServers: [{ id: 'mcp:stdio-crm' }],
      },
      capabilities: [],
      accessPreset: 'full',
    };
    const service = new SettingsDesiredStateService({
      ops: {} as never,
      repositories: {
        tools: {
          listTools: vi.fn(async () => []),
          getTool: vi.fn(async () => null),
        },
        skills: {
          listSkills: vi.fn(async () => []),
          getSkill: vi.fn(async () => null),
        },
        mcpServers: {
          getServer: vi.fn(async () => ({
            id: 'mcp:stdio-crm',
            appId: 'default',
            name: 'stdio-crm',
            status: 'active',
            createdSource: 'admin',
            riskClass: 'medium',
            transport: 'stdio_template',
            config: { transport: 'stdio_template' },
            allowedToolPatterns: [],
            autoApproveToolPatterns: [],
            credentialRefs: [],
            networkHosts: [],
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
          })),
        },
      } as never,
    });

    await expect(
      service.validateCapabilityReferences(settings),
    ).resolves.toEqual([
      'agents.main_agent.runtime inline is incompatible with worker-only capabilities: mcp:stdio-crm',
    ]);
  });
});
