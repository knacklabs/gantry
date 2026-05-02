import { describe, expect, it } from 'vitest';

import {
  appendPermissionRule,
  canonicalizePermissionRule,
  describeCanonicalPermissionRule,
  normalizePermissionRules,
} from '@core/shared/permission-rules.js';

describe('permission rule catalog', () => {
  it('canonicalizes scoped SDK and MCP rules', () => {
    expect(
      canonicalizePermissionRule({
        toolName: 'bash',
        rule: 'npm run test *',
      }).canonical,
    ).toBe('Bash(npm run test *)');
    expect(
      canonicalizePermissionRule({ toolName: 'mcp__github__*' }).canonical,
    ).toBe('mcp__github__*');
    expect(
      canonicalizePermissionRule({
        toolName: 'webfetch',
        rule: 'domain:github.com',
      }).canonical,
    ).toBe('WebFetch(domain:github.com)');
    expect(
      canonicalizePermissionRule({
        toolName: 'edit',
        rule: '/docs/**',
      }).canonical,
    ).toBe('Edit(/docs/**)');
    expect(
      canonicalizePermissionRule({
        toolName: 'agent',
        rule: 'Explore',
      }).canonical,
    ).toBe('Agent(Explore)');
    expect(
      canonicalizePermissionRule({
        toolName: 'browser',
        rule: 'localhost:3000',
      }).canonical,
    ).toBe('Browser(localhost:3000)');
  });

  it('marks broad mutating tool access as high risk', () => {
    expect(describeCanonicalPermissionRule('Bash')).toMatchObject({
      broad: true,
      risk: 'high',
    });
    expect(describeCanonicalPermissionRule('Write')).toMatchObject({
      broad: true,
      risk: 'high',
    });
    expect(describeCanonicalPermissionRule('Config')).toMatchObject({
      broad: true,
      risk: 'high',
    });
  });

  it('rejects malformed rules and de-duplicates normalized rule sets', () => {
    expect(() =>
      canonicalizePermissionRule({
        toolName: 'Bash',
        rule: 'npm test\nrm -rf',
      }),
    ).toThrow(/single line/);
    expect(() =>
      canonicalizePermissionRule({ toolName: 'mcp__github' }),
    ).toThrow(/MCP permission rules/);

    expect(
      normalizePermissionRules({
        allow: ['Bash(npm test)', 'Bash(npm test)'],
      }),
    ).toEqual({ allow: ['Bash(npm test)'], deny: [] });
  });

  it('appends only to the requested effect bucket', () => {
    expect(
      appendPermissionRule(undefined, 'deny', 'WebFetch(domain:example.com)'),
    ).toEqual({
      allow: [],
      deny: ['WebFetch(domain:example.com)'],
    });
  });

  it('describes non-Bash scoped rules with tool-specific boundaries', () => {
    expect(
      describeCanonicalPermissionRule('WebFetch(domain:github.com)'),
    ).toMatchObject({
      risk: 'low',
      examples: ['Fetch pages from github.com.'],
      boundary: 'Does not allow fetching other domains.',
    });
    expect(describeCanonicalPermissionRule('Edit(/docs/**)')).toMatchObject({
      risk: 'medium',
      examples: ['Modify files matching `/docs/**`.'],
      boundary:
        'Does not allow file changes outside the requested path pattern.',
    });
    expect(describeCanonicalPermissionRule('mcp__github__*')).toMatchObject({
      risk: 'medium',
      boundary: 'Does not approve other MCP servers or tools.',
    });
    expect(describeCanonicalPermissionRule('Agent(Explore)')).toMatchObject({
      risk: 'medium',
      examples: ['Start subagents matching `Explore`.'],
      boundary: 'Does not allow Agent uses outside the requested scope.',
    });
  });
});
