import { describe, expect, it } from 'vitest';

import {
  parseSkillActionPermissionsFromAssets,
  SKILL_ACTION_MANIFEST_FILE,
} from '@core/domain/skills/skill-action-permissions.js';

function manifestAsset(commandTemplate: string) {
  const manifest = {
    actions: [
      {
        id: 'publish',
        capabilityId: 'skill.demo.publish',
        displayName: 'Demo publish',
        risk: 'write',
        can: 'Publish through the demo skill.',
        cannot: 'Do anything else.',
        commandTemplates: [commandTemplate],
        requiredEnvVars: [],
      },
    ],
  };
  return [
    {
      path: SKILL_ACTION_MANIFEST_FILE,
      content: new TextEncoder().encode(JSON.stringify(manifest)),
    },
  ];
}

describe('parseSkillActionPermissionsFromAssets durable safety', () => {
  it('accepts a concrete command template scoped under the skill dir', () => {
    const actions = parseSkillActionPermissionsFromAssets({
      assets: manifestAsset('${skillRoot}/run.sh --publish'),
      skillName: 'demo',
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].commandTemplates).toContain(
      'skills/demo/run.sh --publish',
    );
  });

  it('rejects a command template with a destructive redirect (durable-safety gate)', () => {
    expect(() =>
      parseSkillActionPermissionsFromAssets({
        assets: manifestAsset('${skillRoot}/run.sh > /etc/passwd'),
        skillName: 'demo',
      }),
    ).toThrow(/destructive redirection|Invalid skill action command template/i);
  });
});
