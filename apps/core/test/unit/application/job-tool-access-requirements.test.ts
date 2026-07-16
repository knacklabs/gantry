import { describe, expect, it } from 'vitest';

import {
  evaluateToolAccessRequirements,
  normalizeToolAccessRequirements,
  toolAccessRequirementRecoveryAction,
} from '@core/application/jobs/job-tool-access-requirements.js';

describe('job tool access requirements', () => {
  it('accepts canonical tool access requirement rules', () => {
    expect(
      normalizeToolAccessRequirements([
        'Browser',
        'WebRead',
        'FileRead',
        'FileWrite',
        'AgentDelegation',
        'mcp__gantry__settings_desired_state',
        'capability:example.records.append',
        'RunCommand(npm test *)',
        'Browser',
      ]),
    ).toEqual([
      'Browser',
      'WebRead',
      'FileRead',
      'FileWrite',
      'AgentDelegation',
      'mcp__gantry__settings_desired_state',
      'capability:example.records.append',
      'RunCommand(npm test *)',
    ]);
  });

  it('rejects raw browser and broad wildcard tool access requirement rules', () => {
    expect(() =>
      normalizeToolAccessRequirements([
        'mcp__browser' + '_' + 'backend' + '__navigate',
      ]),
    ).toThrow(/canonical Browser/);
    expect(() =>
      normalizeToolAccessRequirements([
        `${'mcp__agent'}_${'browser'}__navigate`,
      ]),
    ).toThrow(/canonical Browser/);
    expect(() =>
      normalizeToolAccessRequirements([`mcp__${'play'}${'wright'}__click`]),
    ).toThrow(/canonical Browser/);
    expect(() =>
      normalizeToolAccessRequirements([`mcp__${'pup'}${'peteer'}__screenshot`]),
    ).toThrow(/canonical Browser/);
    expect(() =>
      normalizeToolAccessRequirements(['mcp__gantry__browser_act']),
    ).toThrow(/canonical Browser/);
    expect(() => normalizeToolAccessRequirements(['Bash'])).toThrow(
      /Provider-native/,
    );
    expect(() => normalizeToolAccessRequirements(['mcp__gantry__*'])).toThrow(
      /wildcard/,
    );
  });

  it.each([
    [[42], /non-empty strings/],
    [['   '], /non-empty strings/],
    [['Read(src/index.ts)'], /Only RunCommand supports persistent scoped/],
    [['mcp__thirdparty__tool'], /Persistent access approvals support only/],
    [['capability:GoogleSheets'], /Capability id must use lowercase/],
  ])(
    'rejects unsupported tool access requirement rule %j',
    (rules, message) => {
      expect(() => normalizeToolAccessRequirements(rules)).toThrow(message);
    },
  );

  it('reports missing tool access requirements without granting permission', () => {
    expect(
      evaluateToolAccessRequirements({
        toolAccessRequirements: ['Browser', 'RunCommand(npm test *)'],
        effectiveAllowedTools: ['Browser'],
      }),
    ).toEqual({
      toolAccessRequirements: ['Browser', 'RunCommand(npm test *)'],
      missingTools: ['RunCommand(npm test *)'],
    });
  });

  it('treats broader scoped RunCommand grants as satisfying narrower requirements', () => {
    expect(
      evaluateToolAccessRequirements({
        toolAccessRequirements: ['RunCommand(npm test *)'],
        effectiveAllowedTools: ['RunCommand(npm *)'],
      }),
    ).toEqual({
      toolAccessRequirements: ['RunCommand(npm test *)'],
      missingTools: [],
    });
  });

  it('treats an absolute local CLI grant as satisfying a stale bare executable requirement', () => {
    expect(
      evaluateToolAccessRequirements({
        toolAccessRequirements: ['RunCommand(acme records get *)'],
        effectiveAllowedTools: [
          'capability:acme.records.get',
          'RunCommand(/opt/homebrew/bin/acme records get *)',
        ],
      }),
    ).toEqual({
      toolAccessRequirements: [
        'RunCommand(/opt/homebrew/bin/acme records get *)',
      ],
      missingTools: [],
    });
  });

  it('preserves specific argv boundaries when projecting stale bare executable requirements', () => {
    expect(
      evaluateToolAccessRequirements({
        toolAccessRequirements: [
          'RunCommand(acme records get "Fixture Leads!A1:Z1" --json *)',
        ],
        effectiveAllowedTools: [
          'RunCommand(/opt/homebrew/bin/acme records get * --json *)',
        ],
      }),
    ).toEqual({
      toolAccessRequirements: [
        "RunCommand(/opt/homebrew/bin/acme records get 'Fixture Leads!A1:Z1' --json *)",
      ],
      missingTools: [],
    });
  });

  it('does not satisfy a bare executable requirement with a different absolute CLI grant', () => {
    expect(
      evaluateToolAccessRequirements({
        toolAccessRequirements: ['RunCommand(acme records get *)'],
        effectiveAllowedTools: [
          'RunCommand(/opt/homebrew/bin/acme records update *)',
        ],
      }),
    ).toEqual({
      toolAccessRequirements: ['RunCommand(acme records get *)'],
      missingTools: ['RunCommand(acme records get *)'],
    });
  });

  it('builds durable recovery actions for scoped RunCommand requirements', () => {
    const action = toolAccessRequirementRecoveryAction(
      'RunCommand(acme records append *)',
    );

    expect(action).toContain('"kind":"run_command"');
    expect(action).toContain('"argvPattern":"acme records append *"');
    expect(action).not.toContain(
      '"argvPattern":"RunCommand(acme records append *)"',
    );
  });

  it('builds durable recovery actions for exact Gantry tool requirements', () => {
    const delegationAction =
      toolAccessRequirementRecoveryAction('AgentDelegation');
    expect(delegationAction).toContain('"kind":"tool"');
    expect(delegationAction).toContain('"name":"AgentDelegation"');

    const adminAction = toolAccessRequirementRecoveryAction(
      'mcp__gantry__request_settings_update',
    );
    expect(adminAction).toContain('"kind":"tool"');
    expect(adminAction).toContain(
      '"name":"mcp__gantry__request_settings_update"',
    );
  });
});
