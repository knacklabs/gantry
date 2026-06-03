import { describe, expect, it } from 'vitest';

import {
  resolveConfiguredAllowedTools,
  resolveConfiguredToolPolicy,
} from '@core/runtime/configured-agent-tools.js';

describe('configured agent tools', () => {
  it('resolves namespaced permission-rule catalog rows to scoped RunCommand rules', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:abc123',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'RunCommand(npm test *)',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual(['RunCommand(npm test *)']);
  });

  it('projects reviewed semantic capabilities to runtime rules', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:capability:acme.records.append',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'capability:acme.records.append',
        inputSchema: {
          format: 'gantry.semantic-capability.v1',
          schema: {
            capabilityId: 'acme.records.append',
            displayName: 'Acme records append',
            category: 'Acme',
            risk: 'write',
            can: 'Append records through an approved implementation.',
            cannot: 'Read unrelated systems or receive raw credentials.',
            credentialSource: 'local_cli',
            implementationBindings: [
              {
                kind: 'local_cli',
                executablePath: '/opt/bin/acme',
                executableVersion: '1.0.0',
                executableHash: 'sha256:acme',
                commandTemplates: ['/opt/bin/acme records append *'],
              },
            ],
          },
        },
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual([
      'capability:acme.records.append',
      'RunCommand(/opt/bin/acme records append *)',
    ]);
  });

  it('projects skill action command rules only while the selected installed skill still declares the action', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:capability:skill.linkedin-posting.publish',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'capability:skill.linkedin-posting.publish',
        inputSchema: {
          format: 'gantry.semantic-capability.v1',
          schema: {
            capabilityId: 'skill.linkedin-posting.publish',
            displayName: 'LinkedIn posting',
            category: 'linkedin-posting',
            risk: 'write',
            can: 'Publish a prepared LinkedIn post.',
            cannot: 'Read unrelated credentials.',
            credentialSource: 'skill_secret',
            implementationBindings: [
              {
                kind: 'tool_rule',
                rule: 'RunCommand(skills/linkedin-posting/post.py *)',
              },
            ],
            source: {
              kind: 'skill_action',
              skillId: 'skill:linkedin-posting',
              skillName: 'linkedin-posting',
              actionId: 'publish',
            },
          },
        },
      }),
    };
    const matchingSkillRepository = {
      listEnabledSkillsForAgent: async () => [
        {
          id: 'skill:linkedin-posting',
          appId: 'default',
          name: 'linkedin-posting',
          version: 'abc123',
          source: 'admin_uploaded',
          status: 'installed',
          promptRefs: [],
          toolIds: [],
          workflowRefs: [],
          actionPermissions: [
            {
              id: 'publish',
              capabilityId: 'skill.linkedin-posting.publish',
              displayName: 'LinkedIn posting',
              risk: 'write',
              can: 'Publish a prepared LinkedIn post.',
              cannot: 'Read unrelated credentials.',
              requiredEnvVars: [],
              commandTemplates: ['skills/linkedin-posting/post.py *'],
            },
          ],
          storage: {
            storageType: 'local-filesystem',
            storageRef: 'skill',
            contentHash: 'sha256:abc123',
            sizeBytes: 1,
          },
          createdAt: '2026-05-21T00:00:00.000Z',
          updatedAt: '2026-05-21T00:00:00.000Z',
        },
      ],
    };
    const changedSkillRepository = {
      listEnabledSkillsForAgent: async () => [
        {
          ...(await matchingSkillRepository.listEnabledSkillsForAgent())[0],
          actionPermissions: [],
        },
      ],
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        skillRepository: matchingSkillRepository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual([
      'capability:skill.linkedin-posting.publish',
      'RunCommand(skills/linkedin-posting/post.py *)',
    ]);
    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        skillRepository: changedSkillRepository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual([]);
  });

  it('projects skill action network hosts into command-bound network bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:capability:skill.linkedin-posting.publish',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'capability:skill.linkedin-posting.publish',
        inputSchema: {
          format: 'gantry.semantic-capability.v1',
          schema: {
            capabilityId: 'skill.linkedin-posting.publish',
            displayName: 'LinkedIn Posting publish',
            category: 'linkedin-posting',
            risk: 'write',
            can: 'Publish a prepared LinkedIn post.',
            cannot: 'Read unrelated credentials.',
            credentialSource: 'skill_secret',
            implementationBindings: [
              {
                kind: 'tool_rule',
                rule: 'RunCommand(skills/linkedin-posting/post.py *)',
              },
            ],
            networkHosts: ['api.linkedin.com:443', 'www.linkedin.com:443'],
            source: {
              kind: 'skill_action',
              skillId: 'skill:linkedin-posting',
              skillName: 'linkedin-posting',
              actionId: 'publish',
            },
          },
        },
      }),
    };
    const skillRepository = {
      listEnabledSkillsForAgent: async () => [
        {
          id: 'skill:linkedin-posting',
          appId: 'default',
          name: 'linkedin-posting',
          version: 'abc123',
          source: 'admin_uploaded',
          status: 'installed',
          promptRefs: [],
          toolIds: [],
          workflowRefs: [],
          actionPermissions: [
            {
              id: 'publish',
              capabilityId: 'skill.linkedin-posting.publish',
              displayName: 'LinkedIn Posting publish',
              risk: 'write',
              can: 'Publish a prepared LinkedIn post.',
              cannot: 'Read unrelated credentials.',
              requiredEnvVars: [],
              commandTemplates: ['skills/linkedin-posting/post.py *'],
              networkHosts: ['api.linkedin.com:443', 'www.linkedin.com:443'],
            },
          ],
          storage: {
            storageType: 'local-filesystem',
            storageRef: 'skill',
            contentHash: 'sha256:abc123',
            sizeBytes: 1,
          },
          createdAt: '2026-05-21T00:00:00.000Z',
          updatedAt: '2026-05-21T00:00:00.000Z',
        },
      ],
    };

    await expect(
      resolveConfiguredToolPolicy({
        repository: repository as never,
        skillRepository: skillRepository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual({
      allowedTools: [
        'capability:skill.linkedin-posting.publish',
        'RunCommand(skills/linkedin-posting/post.py *)',
      ],
      runtimeAccess: [
        {
          selectedCapabilityId: 'skill.linkedin-posting.publish',
          sourceType: 'skill_action',
          auditLabel: 'LinkedIn Posting publish',
          skillId: 'skill:linkedin-posting',
          selectedAction: 'publish',
          declaredEnvRefs: [],
          commandRules: ['RunCommand(skills/linkedin-posting/post.py *)'],
          networkBindings: [
            {
              commandRules: ['RunCommand(skills/linkedin-posting/post.py *)'],
              hosts: ['api.linkedin.com:443', 'www.linkedin.com:443'],
            },
          ],
        },
      ],
    });
  });

  it('expands reviewed local CLI capabilities to scoped command rules', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:capability:acme.invoices.read',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'capability:acme.invoices.read',
        inputSchema: {
          format: 'gantry.semantic-capability.v1',
          schema: {
            capabilityId: 'acme.invoices.read',
            displayName: 'Acme invoices read',
            category: 'Acme',
            risk: 'read',
            can: 'Read invoice records.',
            cannot: 'Write invoices or export tokens.',
            credentialSource: 'local_cli',
            implementationBindings: [
              {
                kind: 'local_cli',
                executablePath: '/usr/local/bin/acme',
                executableVersion: '1.2.3',
                executableHash: 'sha256:abc123',
                commandTemplates: ['/usr/local/bin/acme invoices read *'],
                authPreflightCommand: '/usr/local/bin/acme auth status',
              },
            ],
            protectedPaths: [
              '~/.config/acme/*',
              '/Users/tester/.config/acme/credentials.json',
              '/Users/tester/.config/acme/*.token',
            ],
            networkHosts: ['api.acme.test'],
          },
        },
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual([
      'capability:acme.invoices.read',
      'RunCommand(/usr/local/bin/acme invoices read *)',
    ]);
  });

  it('marks reviewed user-defined local CLI capabilities for credential env projection', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:capability:acme.invoices.read',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'capability:acme.invoices.read',
        inputSchema: {
          format: 'gantry.semantic-capability.v1',
          schema: {
            capabilityId: 'acme.invoices.read',
            displayName: 'Acme invoices read',
            category: 'Acme',
            risk: 'read',
            can: 'Read invoice records.',
            cannot: 'Write invoices or export tokens.',
            credentialSource: 'local_cli',
            implementationBindings: [
              {
                kind: 'local_cli',
                executablePath: '/usr/local/bin/acme',
                executableVersion: '1.2.3',
                executableHash: 'sha256:abc123',
                commandTemplates: ['/usr/local/bin/acme invoices read *'],
                authPreflightCommand: '/usr/local/bin/acme auth status',
              },
            ],
            protectedPaths: [
              '~/.config/acme/*',
              '/Users/tester/.config/acme/credentials.json',
              '/Users/tester/.config/acme/*.token',
            ],
            networkHosts: ['api.acme.test'],
          },
        },
      }),
    };

    await expect(
      resolveConfiguredToolPolicy({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual({
      allowedTools: [
        'capability:acme.invoices.read',
        'RunCommand(/usr/local/bin/acme invoices read *)',
      ],
      runtimeAccess: [
        {
          selectedCapabilityId: 'acme.invoices.read',
          sourceType: 'local_cli',
          auditLabel: 'Acme invoices read',
          commandRules: ['RunCommand(/usr/local/bin/acme invoices read *)'],
          credentialDirs: ['~/.config/acme', '/Users/tester/.config/acme'],
          networkBindings: [
            {
              commandRules: ['RunCommand(/usr/local/bin/acme invoices read *)'],
              hosts: ['api.acme.test'],
            },
          ],
        },
      ],
    });
  });

  it('rejects custom semantic capability rows with invalid reviewed schema', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:capability:acme.invoices.read',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'capability:acme.invoices.read',
        inputSchema: {
          format: 'gantry.semantic-capability.v1',
          schema: {
            capabilityId: 'acme.invoices.read',
            displayName: 'Acme invoices read',
            category: 'Acme',
            risk: 'read',
            can: 'Read invoice records.',
            cannot: 'Write invoices or export tokens.',
            credentialSource: 'configured_access',
            implementationBindings: [
              {
                kind: 'local_cli',
                executablePath: '/usr/local/bin/acme',
                executableVersion: '1.2.3',
                executableHash: 'sha256:abc123',
                commandTemplates: ['/usr/local/bin/acme invoices read *'],
                authPreflightCommand: '/usr/local/bin/acme auth status',
              },
            ],
            protectedPaths: ['~/.config/acme'],
            networkHosts: ['api.acme.test'],
          },
        },
      }),
    };

    await expect(
      resolveConfiguredToolPolicy({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow(
      'Semantic capability rules must resolve to a reviewed capability definition.',
    );
  });

  it('drops stale active bindings when the catalog row is unavailable', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:Bash',
        },
      ],
      getTool: async () => null,
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual([]);
  });

  it('fails closed for stale active provider-native SDK bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:Read',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'Read',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('Provider-native SDK tools');
  });

  it('fails closed for stale active raw browser action MCP bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:browser',
        },
        {
          status: 'active',
          toolId: 'tool:Read',
        },
      ],
      getTool: async (toolId: string) =>
        toolId === 'tool:Read'
          ? { appId: 'default', name: 'Read' }
          : {
              appId: 'default',
              name: 'mcp__browser' + '_' + 'backend' + '__*',
            },
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('Host-private browser backend tools');
  });

  it('fails closed for stale active projected browser MCP bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:browser-projected',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'mcp__gantry__browser_act',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('runtime projections, not durable capabilities');
  });

  it('fails closed for stale active Gantry MCP wildcard bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:gantry-wildcard',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'mcp__gantry__*',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('wildcard grants are not supported');
  });

  it('fails closed for stale active RunCommand wildcard bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:bash-wildcard',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'RunCommand(*)',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('Persistent RunCommand scope is too broad');
  });

  it('fails closed for stale active SDK sandbox network bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:sandbox-network',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'SandboxNetworkAccess',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('SDK sandbox network prompts are internal');
  });

  it('fails closed for stale active third-party MCP wildcard bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:mcp-wildcard',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'mcp__github__*',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow('request a reviewed semantic capability');
  });

  it('fails closed for stale active exact third-party MCP tool bindings', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:mcp-github-search',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'mcp__github__search_repositories',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).rejects.toThrow(
      'Third-party MCP tools must be projected from a reviewed semantic capability',
    );
  });

  it('drops bindings whose catalog row belongs to a different app', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:Browser',
        },
      ],
      getTool: async () => ({
        appId: 'default',
        name: 'Browser',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'app:one',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual([]);
  });
});
