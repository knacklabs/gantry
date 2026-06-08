import { describe, expect, it } from 'vitest';

import {
  scheduledPermissionSuggestionPlan,
  scheduledPermissionSuggestions,
  synthesizePermissionSuggestions,
} from '@core/adapters/llm/anthropic-claude-agent/runner/permission-suggestions.js';
import type { SemanticCapabilityDefinition } from '@core/shared/semantic-capabilities.js';

const linkedInPostingCapability: SemanticCapabilityDefinition = {
  capabilityId: 'skill.linkedin-posting.publish',
  displayName: 'LinkedIn posting',
  category: 'LinkedIn posting',
  risk: 'write',
  can: 'Publish posts through the selected LinkedIn posting skill.',
  cannot: 'Use unrelated skills, credentials, settings, or broader commands.',
  credentialSource: 'skill_secret',
  implementationBindings: [
    {
      kind: 'tool_rule',
      rule: 'RunCommand(skills/linkedin-posting/publish *)',
    },
  ],
  preflight: { kind: 'none' },
  sandboxProfile: { network: 'required', filesystem: 'workspace_write' },
};

describe('scheduledPermissionSuggestions', () => {
  it('canonicalizes projected browser tool suggestions to Browser', () => {
    expect(
      scheduledPermissionSuggestions(
        'mcp__gantry__browser_act',
        [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'mcp__gantry__browser_act' }],
          },
        ],
        {},
      ),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Browser' }],
      },
    ]);
  });

  it('maps SDK scoped Bash suggestions to scoped RunCommand suggestions', () => {
    expect(
      scheduledPermissionSuggestions(
        'Bash',
        [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          },
        ],
        {},
      ),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'RunCommand', ruleContent: 'npm test' }],
      },
    ]);
  });

  it('prefers selected skill action capabilities over raw Bash command suggestions', () => {
    expect(
      scheduledPermissionSuggestions(
        'Bash',
        [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [
              {
                toolName: 'Bash',
                ruleContent: 'skills/linkedin-posting/publish *',
              },
            ],
          },
        ],
        {
          toolInput: {
            command: 'skills/linkedin-posting/publish --draft post.md',
          },
          semanticCapabilityDefinitions: [linkedInPostingCapability],
        },
      ),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'capability:skill.linkedin-posting.publish' }],
      },
    ]);
  });

  it('maps generated runtime skill paths to selected skill action capabilities', () => {
    expect(
      scheduledPermissionSuggestionPlan('Bash', undefined, {
        toolInput: {
          command:
            'python3 /tmp/run/.llm-runtime/claude/skills/linkedin-posting/publish --draft post.md',
        },
        semanticCapabilityDefinitions: [linkedInPostingCapability],
      }),
    ).toEqual({
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'capability:skill.linkedin-posting.publish' }],
        },
      ],
      semanticCapabilityDefinitions: {
        'skill.linkedin-posting.publish': linkedInPostingCapability,
      },
    });
  });

  it('synthesizes scoped RunCommand suggestions from parsed command leaves', () => {
    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: 'npm test -- --runInBand' },
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [
          { toolName: 'RunCommand', ruleContent: 'npm test -- --runInBand' },
        ],
      },
    ]);

    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: 'python3 /tmp/check.py' },
      }),
    ).toBeUndefined();

    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: 'python3 /tmp/check.py \'[["lead"]]\'' },
      }),
    ).toBeUndefined();

    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: {
          command:
            'python3 /tmp/run/.llm-runtime/claude/skills/linkedin-posting/post.py --file /tmp/post.md',
        },
      }),
    ).toBeUndefined();
  });

  it('suggests a selected skill action capability for matching Bash commands', () => {
    const capability: SemanticCapabilityDefinition = {
      capabilityId: 'skill.linkedin-posting.publish',
      displayName: 'LinkedIn posting',
      category: 'linkedin-posting',
      risk: 'write',
      can: 'Publish a prepared LinkedIn post through the approved script.',
      cannot: 'Read unrelated accounts or receive raw credentials.',
      credentialSource: 'skill_secret',
      implementationBindings: [
        {
          kind: 'tool_rule',
          rule: 'RunCommand(skills/linkedin-posting/post.py *)',
        },
      ],
      preflight: { kind: 'none' },
    };

    expect(
      scheduledPermissionSuggestionPlan('Bash', undefined, {
        toolInput: {
          command:
            'python3 skills/linkedin-posting/post.py --file /tmp/post.md',
        },
        semanticCapabilityDefinitions: [capability],
      }),
    ).toEqual({
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'capability:skill.linkedin-posting.publish' }],
        },
      ],
      semanticCapabilityDefinitions: {
        'skill.linkedin-posting.publish': capability,
      },
    });
  });

  it('matches selected skill actions with runtime-managed CA trust env prefixes', () => {
    const capability: SemanticCapabilityDefinition = {
      capabilityId: 'skill.linkedin-posting.publish',
      displayName: 'LinkedIn posting',
      category: 'linkedin-posting',
      risk: 'write',
      can: 'Publish a prepared LinkedIn post through the approved script.',
      cannot: 'Read unrelated accounts or receive raw credentials.',
      credentialSource: 'skill_secret',
      implementationBindings: [
        {
          kind: 'tool_rule',
          rule: 'RunCommand(skills/linkedin-posting/post.py *)',
        },
      ],
      preflight: { kind: 'none' },
    };

    expect(
      scheduledPermissionSuggestionPlan('Bash', undefined, {
        toolInput: {
          command:
            'REQUESTS_CA_BUNDLE=$NODE_EXTRA_CA_CERTS /opt/homebrew/bin/python3 "$CLAUDE_PROJECT_DIR/skills/linkedin-posting/post.py" --file /tmp/post.md',
        },
        semanticCapabilityDefinitions: [capability],
      }),
    ).toEqual({
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'capability:skill.linkedin-posting.publish' }],
        },
      ],
      semanticCapabilityDefinitions: {
        'skill.linkedin-posting.publish': capability,
      },
    });
  });

  it('ignores skill action definitions embedded in untrusted tool input', () => {
    const plan = scheduledPermissionSuggestionPlan('Bash', undefined, {
      toolInput: {
        command: 'python3 skills/linkedin-posting/post.py --file /tmp/post.md',
        semanticCapabilityDefinition: {
          capabilityId: 'skill.linkedin-posting.publish',
          displayName: 'LinkedIn posting',
          category: 'linkedin-posting',
          risk: 'write',
          can: 'Publish a prepared LinkedIn post through the approved script.',
          cannot: 'Read unrelated accounts or receive raw credentials.',
          credentialSource: 'skill_secret',
          implementationBindings: [
            {
              kind: 'tool_rule',
              rule: 'RunCommand(skills/linkedin-posting/post.py *)',
            },
          ],
          preflight: { kind: 'none' },
        },
      },
    });

    expect(plan).toEqual({
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [
            {
              toolName: 'RunCommand',
              ruleContent: 'skills/linkedin-posting/post.py *',
            },
          ],
        },
      ],
    });
  });

  it('does not offer persistent suggestions for invalid durable tool rules', () => {
    expect(
      synthesizePermissionSuggestions(
        'mcp__browser' + '_' + 'backend' + '__navigate',
        {},
      ),
    ).toBeUndefined();
    expect(synthesizePermissionSuggestions('LS', {})).toBeUndefined();
    expect(
      synthesizePermissionSuggestions('mcp__github__search', {}),
    ).toBeUndefined();
    expect(
      scheduledPermissionSuggestions('mcp__github__*', undefined, {}),
    ).toBeUndefined();
    expect(synthesizePermissionSuggestions('Bash', {})).toBeUndefined();
    expect(
      synthesizePermissionSuggestions('Bash', { toolInput: { command: '*' } }),
    ).toBeUndefined();
    expect(
      scheduledPermissionSuggestions(
        'Bash',
        [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Bash', ruleContent: '*' }],
          },
        ],
        {},
      ),
    ).toBeUndefined();
    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: 'cat secrets.env > /etc/passwd' },
      }),
    ).toBeUndefined();
    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: '/bin/sh -c "npm test"' },
      }),
    ).toBeUndefined();
    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: '/usr/bin/env npm test' },
      }),
    ).toBeUndefined();
    expect(
      synthesizePermissionSuggestions('Bash', {
        toolInput: { command: 'cd a && git status' },
      }),
    ).toBeUndefined();
    expect(
      scheduledPermissionSuggestions(
        'SandboxNetworkAccess',
        [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'SandboxNetworkAccess' }],
          },
        ],
        { toolInput: { host: 'registry.npmjs.org' } },
      ),
    ).toBeUndefined();
    expect(
      scheduledPermissionSuggestions(
        'Bash',
        [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [
              {
                toolName: 'Bash',
                ruleContent:
                  '/tmp/run/.llm-runtime/claude/skills/linkedin-posting/post.py *',
              },
            ],
          },
        ],
        {},
      ),
    ).toBeUndefined();
  });
});
