import { describe, expect, it } from 'vitest';

import {
  normalizeAccessRequirements,
  normalizeAccessRequirementsInput,
  splitAccessRequirements,
} from '@core/application/jobs/job-access-requirements.js';

describe('normalizeAccessRequirements', () => {
  it('rejects non-array input', () => {
    expect(() => normalizeAccessRequirements({})).toThrow(/must be an array/);
  });

  it('rejects entries without a target object', () => {
    expect(() => normalizeAccessRequirements([{ reason: 'x' }])).toThrow(
      /require a target object/,
    );
  });

  it('rejects an unknown target.kind', () => {
    expect(() =>
      normalizeAccessRequirements([{ target: { kind: 'nope' } }]),
    ).toThrow(/tool_rule, capability, or mcp_server/);
  });

  it('normalizes and dedupes tool_rule targets', () => {
    const out = normalizeAccessRequirements([
      { target: { kind: 'tool_rule', rule: 'Browser' } },
      { target: { kind: 'tool_rule', rule: 'Browser' } },
    ]);
    expect(out).toEqual([{ target: { kind: 'tool_rule', rule: 'Browser' } }]);
  });

  it('rejects an unsupported tool_rule', () => {
    expect(() =>
      normalizeAccessRequirements([
        { target: { kind: 'tool_rule', rule: 'cli *' } },
      ]),
    ).toThrow(/not supported/);
  });

  it('normalizes a capability target and keeps reason', () => {
    const out = normalizeAccessRequirements([
      {
        target: { kind: 'capability', capabilityId: 'acme.records.append' },
        reason: 'Write rows',
      },
    ]);
    expect(out).toEqual([
      {
        target: { kind: 'capability', capabilityId: 'acme.records.append' },
        reason: 'Write rows',
      },
    ]);
  });

  it('rejects an incomplete local_cli capability target', () => {
    expect(() =>
      normalizeAccessRequirements([
        {
          target: {
            kind: 'capability',
            capabilityId: 'acme.records.append',
            implementation: {
              kind: 'local_cli',
              executablePath: '/usr/local/bin/acme',
              // missing executableVersion/executableHash/commandTemplate
            },
          },
        },
      ]),
    ).toThrow(/local_cli/);
  });

  it('dedupes mcp_server targets', () => {
    const out = normalizeAccessRequirements([
      { target: { kind: 'mcp_server', server: 'records' } },
      { target: { kind: 'mcp_server', server: 'records' } },
    ]);
    expect(out).toEqual([
      { target: { kind: 'mcp_server', server: 'records' } },
    ]);
  });

  it('returns undefined when input is undefined (Input variant)', () => {
    expect(normalizeAccessRequirementsInput(undefined)).toBeUndefined();
  });
});

describe('splitAccessRequirements', () => {
  it('tolerates undefined without throwing', () => {
    expect(splitAccessRequirements(undefined)).toEqual({
      toolAccessRequirements: [],
      capabilityRequirements: [],
      requiredMcpServers: [],
    });
  });

  it('collapses a capability target into a capability:<id> tool rule', () => {
    const split = splitAccessRequirements([
      {
        target: { kind: 'capability', capabilityId: 'acme.records.append' },
        reason: 'Write rows',
      },
    ]);
    expect(split.toolAccessRequirements).toContain(
      'capability:acme.records.append',
    );
    expect(split.capabilityRequirements).toEqual([
      { capabilityId: 'acme.records.append', reason: 'Write rows' },
    ]);
  });

  it('does NOT re-validate incomplete stored requirements (surfaced as blockers, not throws)', () => {
    expect(() =>
      splitAccessRequirements([
        {
          target: {
            kind: 'capability',
            capabilityId: 'acme.records.append',
            implementation: {
              kind: 'local_cli',
              // intentionally incomplete — would throw at create-time, must NOT throw here
              executablePath: '/usr/local/bin/acme',
            },
          },
        },
      ]),
    ).not.toThrow();
  });

  it('splits all three target kinds into the working lists', () => {
    const split = splitAccessRequirements([
      { target: { kind: 'tool_rule', rule: 'Browser' } },
      { target: { kind: 'mcp_server', server: 'records' } },
      { target: { kind: 'capability', capabilityId: 'acme.records.append' } },
    ]);
    expect(split.toolAccessRequirements).toEqual(
      expect.arrayContaining(['Browser', 'capability:acme.records.append']),
    );
    expect(split.requiredMcpServers).toEqual(['records']);
    expect(split.capabilityRequirements).toHaveLength(1);
  });
});
