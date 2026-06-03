import { describe, expect, it } from 'vitest';

import {
  buildLocalCliSemanticCapability,
  projectToolCatalogItemToRuntimeRules,
  semanticCapabilityRuntimeRules,
  validateSemanticCapabilityDefinition,
} from '@core/shared/semantic-capabilities.js';

function localCliCapability(
  overrides: {
    executablePath?: string;
    executableVersion?: string;
    executableHash?: string;
    commandTemplates?: string[];
    authPreflightCommand?: string;
    protectedPaths?: string[];
  } = {},
) {
  return buildLocalCliSemanticCapability({
    capabilityId: 'acme.invoices.read',
    displayName: 'Acme invoices read',
    category: 'Acme',
    risk: 'read',
    accountLabel: 'Acme sandbox',
    can: 'Read invoice records.',
    cannot: 'Write invoices or export tokens.',
    executablePath: overrides.executablePath ?? '/usr/local/bin/acme',
    executableVersion: overrides.executableVersion ?? '1.2.3',
    executableHash: overrides.executableHash ?? 'sha256:abc123',
    commandTemplates: overrides.commandTemplates ?? [
      '/usr/local/bin/acme invoices read *',
    ],
    authPreflightCommand:
      overrides.authPreflightCommand ?? '/usr/local/bin/acme auth status',
    protectedPaths: overrides.protectedPaths ?? ['~/.config/acme'],
  });
}

describe('semantic capability catalog validation', () => {
  it('accepts reviewed local CLI drafts with pinned executable metadata', () => {
    expect(validateSemanticCapabilityDefinition(localCliCapability())).toEqual({
      ok: true,
    });
  });

  it('rejects local CLI drafts without a pinned absolute executable, version, or hash', () => {
    expect(
      validateSemanticCapabilityDefinition(
        localCliCapability({ executablePath: 'acme' }),
      ),
    ).toEqual({
      ok: false,
      reason: 'Local CLI capabilities require an absolute executable path.',
    });
    expect(
      validateSemanticCapabilityDefinition(
        localCliCapability({ executableVersion: '' }),
      ),
    ).toEqual({
      ok: false,
      reason: 'Local CLI capabilities require an executable version.',
    });
    expect(
      validateSemanticCapabilityDefinition(
        localCliCapability({ executableHash: '' }),
      ),
    ).toEqual({
      ok: false,
      reason: 'Local CLI capabilities require an executable hash.',
    });
  });

  it('rejects mismatched local CLI credential source and implementation bindings', () => {
    expect(
      validateSemanticCapabilityDefinition({
        ...localCliCapability(),
        credentialSource: 'configured_access',
      }),
    ).toEqual({
      ok: false,
      reason: 'Local CLI bindings require credentialSource local_cli.',
    });

    expect(
      validateSemanticCapabilityDefinition({
        ...localCliCapability(),
        implementationBindings: [
          { kind: 'adapter', adapterRef: 'configured.acme.invoices.read' },
        ],
      }),
    ).toEqual({
      ok: false,
      reason:
        'Local CLI capabilities require a local_cli implementation binding.',
    });
  });

  it('rejects local CLI-only credential and network fields on other capability types', () => {
    expect(
      validateSemanticCapabilityDefinition({
        capabilityId: 'acme.invoices.read',
        displayName: 'Acme invoices read',
        category: 'Acme',
        risk: 'read',
        can: 'Read invoice records.',
        cannot: 'Write invoices or export tokens.',
        credentialSource: 'configured_access',
        implementationBindings: [
          { kind: 'adapter', adapterRef: 'configured.acme.invoices.read' },
        ],
        networkHosts: ['api.acme.test'],
      }),
    ).toEqual({
      ok: false,
      reason:
        'networkHosts are only supported for local_cli or skill action capabilities.',
    });

    expect(
      validateSemanticCapabilityDefinition({
        capabilityId: 'acme.invoices.read',
        displayName: 'Acme invoices read',
        category: 'Acme',
        risk: 'read',
        can: 'Read invoice records.',
        cannot: 'Write invoices or export tokens.',
        credentialSource: 'configured_access',
        implementationBindings: [
          { kind: 'adapter', adapterRef: 'configured.acme.invoices.read' },
        ],
        protectedPaths: ['~/.config/acme'],
      }),
    ).toEqual({
      ok: false,
      reason: 'protectedPaths are only supported for local_cli capabilities.',
    });
  });

  it('rejects network hosts on skill-secret capabilities that are not skill actions', () => {
    expect(
      validateSemanticCapabilityDefinition({
        capabilityId: 'github.create_issue',
        displayName: 'GitHub create issue',
        category: 'MCP',
        risk: 'write',
        can: 'Create a GitHub issue.',
        cannot: 'Call unrelated MCP tools.',
        credentialSource: 'skill_secret',
        implementationBindings: [
          { kind: 'mcp_tool', mcpTool: 'mcp__github__create_issue' },
        ],
        networkHosts: ['api.github.com:443'],
      }),
    ).toEqual({
      ok: false,
      reason:
        'networkHosts are only supported for local_cli or skill action capabilities.',
    });
  });

  it('validates skill action network hosts with the shared host parser', () => {
    const capability = {
      capabilityId: 'skill.linkedin.publish',
      displayName: 'LinkedIn publish',
      category: 'linkedin-posting',
      risk: 'write' as const,
      can: 'Publish a LinkedIn post.',
      cannot: 'Call unrelated endpoints.',
      credentialSource: 'skill_secret' as const,
      implementationBindings: [
        { kind: 'tool_rule' as const, rule: 'RunCommand(skills/post.py *)' },
      ],
      source: {
        kind: 'skill_action',
        skillId: 'skill:linkedin-posting',
        skillName: 'linkedin-posting',
        actionId: 'publish',
      },
    };

    expect(
      validateSemanticCapabilityDefinition({
        ...capability,
        networkHosts: ['api.linkedin.com:443'],
      }),
    ).toEqual({ ok: true });
    expect(
      validateSemanticCapabilityDefinition({
        ...capability,
        networkHosts: ['https://api.linkedin.com/v2'],
      }),
    ).toEqual({
      ok: false,
      reason:
        'networkHosts must be host or host:port values, not URLs, schemes, or paths.',
    });
  });

  it('rejects command templates that do not start with the pinned executable path', () => {
    expect(
      validateSemanticCapabilityDefinition(
        localCliCapability({
          commandTemplates: ['/opt/acme/bin/acme invoices read *'],
        }),
      ),
    ).toEqual({
      ok: false,
      reason:
        'Local CLI command templates must start with the pinned executable path.',
    });
  });

  it('rejects broad local CLI command templates', () => {
    for (const commandTemplate of [
      '/usr/local/bin/acme *',
      '/usr/local/bin/acme * invoices',
    ]) {
      expect(
        validateSemanticCapabilityDefinition(
          localCliCapability({ commandTemplates: [commandTemplate] }),
        ),
      ).toEqual({
        ok: false,
        reason:
          'Local CLI command templates must scope a concrete subcommand, not the whole executable.',
      });
    }
  });

  it('rejects shell control and redirection syntax in local CLI command templates', () => {
    for (const commandTemplate of [
      '/usr/local/bin/acme invoices read *; cat ~/.config/acme/token',
      '/usr/local/bin/acme invoices read * > /tmp/out',
      '/usr/local/bin/acme invoices read * < /tmp/in',
    ]) {
      expect(
        validateSemanticCapabilityDefinition(
          localCliCapability({ commandTemplates: [commandTemplate] }),
        ).ok,
      ).toBe(false);
    }
  });

  it('rejects local CLI credential, config, proxy, and CA environment overrides', () => {
    for (const commandTemplate of [
      'ACME_TOKEN=abc /usr/local/bin/acme invoices read *',
      '/usr/local/bin/acme invoices read * HTTP_PROXY=http://127.0.0.1:8080',
      '/usr/local/bin/acme invoices read * SSL_CERT_FILE=/tmp/ca.pem',
      '/usr/local/bin/acme invoices read * AWS_CA_BUNDLE=/tmp/ca.pem',
      '/usr/local/bin/acme invoices read * CARGO_HTTP_CAINFO=/tmp/ca.pem',
      '/usr/local/bin/acme invoices read * ACME_CONFIG=/tmp/config',
    ]) {
      expect(
        validateSemanticCapabilityDefinition(
          localCliCapability({ commandTemplates: [commandTemplate] }),
        ).ok,
      ).toBe(false);
    }
  });

  it('rejects wildcard local CLI preflight commands', () => {
    expect(
      validateSemanticCapabilityDefinition(
        localCliCapability({
          authPreflightCommand: '/usr/local/bin/acme auth status *',
        }),
      ),
    ).toEqual({
      ok: false,
      reason: 'Local CLI preflight commands cannot contain wildcards.',
    });
  });

  it('rejects relative protected credential paths', () => {
    expect(
      validateSemanticCapabilityDefinition(
        localCliCapability({ protectedPaths: ['.config/acme'] }),
      ),
    ).toEqual({
      ok: false,
      reason:
        'Protected paths must be absolute, home-relative, or env-rooted paths.',
    });
  });

  it('accepts OS-neutral protected credential path hints', () => {
    expect(
      validateSemanticCapabilityDefinition(
        localCliCapability({
          protectedPaths: [
            '${XDG_CONFIG_HOME}/acme',
            '$HOME/.config/acme',
            '%APPDATA%\\Acme',
            '~',
          ],
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('projects reviewed local CLI capabilities to scoped command-tool authority', () => {
    const capability = localCliCapability();

    expect(
      projectToolCatalogItemToRuntimeRules({
        name: 'capability:acme.invoices.read',
        inputSchema: {
          format: 'gantry.semantic-capability.v1',
          schema: capability,
        },
      }),
    ).toEqual([
      'capability:acme.invoices.read',
      'RunCommand(/usr/local/bin/acme invoices read *)',
    ]);
  });

  it('does not project local CLI command rules from malformed non-local capability objects', () => {
    expect(
      semanticCapabilityRuntimeRules({
        ...localCliCapability(),
        credentialSource: 'configured_access',
      }),
    ).toEqual([]);
  });
});
