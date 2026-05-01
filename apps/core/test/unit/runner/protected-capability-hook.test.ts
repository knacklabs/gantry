import { describe, expect, it } from 'vitest';

import {
  evaluateProtectedCapabilityToolUse,
  protectedCapabilityPreToolUseHook,
} from '@agent-runner-src/claude/protected-capability-hook.js';

describe('protected capability SDK hook', () => {
  it('blocks direct skill file writes through the native PreToolUse hook', async () => {
    const result = await protectedCapabilityPreToolUseHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/work',
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/myclaw/agents/kai_tg_1/skills/linkedin/SKILL.md',
        content: '# LinkedIn\n',
      },
      tool_use_id: 'toolu_1',
    });

    expect(result).toEqual(
      expect.objectContaining({
        continue: false,
        decision: 'block',
      }),
    );
    expect(result.hookSpecificOutput).toEqual(
      expect.objectContaining({
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      }),
    );
  });

  it('blocks direct MCP configuration changes', () => {
    expect(
      evaluateProtectedCapabilityToolUse('Write', {
        file_path: '/tmp/work/.mcp.json',
        content: '{"mcpServers":{"github":{"type":"http"}}}',
      }),
    ).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining('MCP capability'),
      }),
    );

    expect(
      evaluateProtectedCapabilityToolUse('Bash', {
        command: 'claude mcp add-json github \'{"type":"http"}\'',
      }),
    ).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining('MCP'),
      }),
    );
  });

  it('blocks direct permission setting changes through Config', () => {
    expect(
      evaluateProtectedCapabilityToolUse('Config', {
        setting: 'permissions.defaultMode',
        value: 'acceptEdits',
      }),
    ).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining('permission'),
      }),
    );
  });

  it('allows normal file edits and approved capability request tools', () => {
    expect(
      evaluateProtectedCapabilityToolUse('Edit', {
        file_path: '/tmp/work/README.md',
        old_string: 'old',
        new_string: 'new',
      }),
    ).toBeNull();

    expect(
      evaluateProtectedCapabilityToolUse('mcp__myclaw__request_mcp_server', {
        name: 'github',
        reason: 'Search repository issues',
      }),
    ).toBeNull();

    expect(
      evaluateProtectedCapabilityToolUse(
        'mcp__myclaw__request_skill_proposal',
        {
          files: [{ path: 'SKILL.md', content: '# Skill' }],
          reason: 'Reuse workflow',
        },
      ),
    ).toBeNull();

    expect(
      evaluateProtectedCapabilityToolUse('mcp__myclaw__request_tool_enable', {
        toolName: 'Bash',
        reason: 'Run project tests',
      }),
    ).toBeNull();

    expect(
      evaluateProtectedCapabilityToolUse('mcp__myclaw__request_skill_install', {
        spec: 'clawhub:some-skill@1.0.0',
        reason: 'Install approved shared skill',
      }),
    ).toBeNull();

    expect(
      evaluateProtectedCapabilityToolUse(
        'mcp__myclaw__request_skill_dependency_install',
        {
          packages: ['tsx'],
          ecosystem: 'npm',
          reason: 'Install skill dependency',
        },
      ),
    ).toBeNull();

    expect(
      evaluateProtectedCapabilityToolUse(
        'mcp__myclaw__request_channel_tool_enable',
        {
          channelTool: 'slack_file_access',
          reason: 'Allow file download support',
        },
      ),
    ).toBeNull();
  });
});
