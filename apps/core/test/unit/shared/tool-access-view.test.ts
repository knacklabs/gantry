import { describe, expect, it } from 'vitest';

import {
  buildJobToolAccessView,
  buildRequestableAdminToolAccess,
  buildRequestableBrowserToolAccess,
  BROWSER_REQUEST_PERMISSION_ARGS,
} from '@core/shared/tool-access-view.js';

describe('tool access view', () => {
  it('lists Browser as requestable with semantic capability args when not selected', () => {
    expect(buildRequestableBrowserToolAccess({ configuredTools: [] })).toEqual([
      {
        tool: 'Browser',
        toolId: 'tool:Browser',
        requestPermission: BROWSER_REQUEST_PERMISSION_ARGS,
        note: expect.stringContaining('browser_* tools'),
      },
    ]);
    expect(BROWSER_REQUEST_PERMISSION_ARGS).toBe(
      'target.kind=capability target.id=browser.use temporaryOnly=false reason="<why this agent needs Browser>"',
    );
  });

  it('does not list Browser as requestable once the canonical capability is selected', () => {
    expect(
      buildRequestableBrowserToolAccess({ configuredTools: ['Browser'] }),
    ).toEqual([]);
    expect(
      buildRequestableBrowserToolAccess({
        externalMcpAllowedTools: ['mcp__browser' + '_' + 'backend' + '__*'],
      }),
    ).toHaveLength(1);
    expect(
      buildRequestableBrowserToolAccess({
        configuredTools: ['mcp__gantry__browser_act'],
      }),
    ).toHaveLength(1);
  });

  it('lists admin tools as requestable exact Gantry tool grants', () => {
    const requestable = buildRequestableAdminToolAccess(new Set());

    expect(requestable).toContainEqual(
      expect.objectContaining({
        tool: 'mcp__gantry__request_settings_update',
        requestPermission:
          'target.kind=tool target.name="mcp__gantry__request_settings_update" temporaryOnly=false reason="<why this agent needs request_settings_update>"',
      }),
    );
  });

  it('projects canonical Browser and facade authority into runtime tools for jobs', () => {
    expect(
      buildJobToolAccessView({
        effectiveAllowedTools: [
          'FileRead',
          'FileSearch',
          'RunCommand(npm test *)',
          'Browser',
        ],
      }).projectedRuntimeTools,
    ).toEqual(
      expect.arrayContaining([
        'mcp__gantry__browser_act',
        'Read',
        'Glob',
        'Grep',
        'Bash',
      ]),
    );
  });

  it('hides generated runtime skill implementation paths in job tool access', () => {
    const view = buildJobToolAccessView({
      inheritedAgentTools: [
        'RunCommand(/Users/tester/gantry/agents/main_agent/.llm-runtime/claude/skills/linkedin-posting/post.py *)',
        'RunCommand(chmod +x /Users/tester/gantry/agents/main_agent/.llm-runtime/claude/skills/linkedin-posting/post.py)',
      ],
      effectiveAllowedTools: [
        'RunCommand(/Users/tester/gantry/agents/main_agent/.llm-runtime/claude/skills/linkedin-posting/post.py *)',
      ],
    });

    expect(view.inheritedAgentTools).toEqual([
      'Generated skill action (skills/linkedin-posting/post.py)',
      'Generated skill action setup (skills/linkedin-posting/post.py)',
    ]);
    expect(view.effectiveAllowedTools).toEqual([
      'Generated skill action (skills/linkedin-posting/post.py)',
    ]);
    expect(view.projectedRuntimeTools).toContain('Bash');
  });
});
