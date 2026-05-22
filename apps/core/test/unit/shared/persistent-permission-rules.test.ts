import { describe, expect, it } from 'vitest';

import {
  isPersistentRequestPermissionRuleAllowed,
  validatePersistentRequestPermissionRule,
} from '@core/shared/persistent-permission-rules.js';
import type { SemanticCapabilityDefinition } from '@core/shared/semantic-capabilities.js';

const skillActionDefinition: SemanticCapabilityDefinition = {
  capabilityId: 'skill.linkedin-posting.publish',
  displayName: 'LinkedIn posting',
  category: 'linkedin-posting',
  risk: 'write',
  can: 'Publish posts through the selected LinkedIn posting skill.',
  cannot: 'Use unrelated skills, credentials, settings, or broader commands.',
  credentialSource: 'skill_secret',
  implementationBindings: [
    {
      kind: 'tool_rule',
      rule: 'RunCommand(skills/linkedin-posting/post.py *)',
    },
  ],
  preflight: { kind: 'none' },
};

describe('persistent permission rules', () => {
  it('allows exact Gantry facade tools as durable request_permission approvals', () => {
    for (const toolName of [
      'WebSearch',
      'WebRead',
      'FileSearch',
      'FileRead',
      'FileEdit',
      'FileWrite',
      'AgentDelegation',
    ]) {
      expect(validatePersistentRequestPermissionRule(toolName)).toEqual({
        ok: true,
      });
      expect(isPersistentRequestPermissionRuleAllowed(toolName)).toBe(true);
    }
  });

  it('still rejects scoped non-command Gantry facade rules', () => {
    expect(
      validatePersistentRequestPermissionRule('FileEdit(src/index.ts)'),
    ).toEqual({
      ok: false,
      reason:
        'Only RunCommand supports persistent scoped tool rules; use an exact tool name for other tools.',
    });
  });

  it('still rejects provider-native exact tools after facade replacement', () => {
    expect(validatePersistentRequestPermissionRule('Read')).toMatchObject({
      ok: false,
    });
    expect(validatePersistentRequestPermissionRule('Write')).toMatchObject({
      ok: false,
    });
    expect(validatePersistentRequestPermissionRule('Task')).toMatchObject({
      ok: false,
    });
  });

  it('requires trusted definitions for non-builtin semantic capabilities', () => {
    expect(
      validatePersistentRequestPermissionRule(
        'capability:skill.linkedin-posting.publish',
      ),
    ).toEqual({
      ok: false,
      reason:
        'Unknown semantic capability skill.linkedin-posting.publish. Review and register a trusted capability definition before granting it persistently.',
    });

    expect(
      validatePersistentRequestPermissionRule(
        'capability:skill.linkedin-posting.publish',
        {
          semanticCapabilityDefinitions: {
            'skill.linkedin-posting.publish': skillActionDefinition,
          },
        },
      ),
    ).toEqual({ ok: true });

    expect(
      validatePersistentRequestPermissionRule('capability:google.sheets.write'),
    ).toEqual({ ok: true });
  });
});
