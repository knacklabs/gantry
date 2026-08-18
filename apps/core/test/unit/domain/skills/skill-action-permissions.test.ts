import { describe, expect, it } from 'vitest';

import {
  parseSkillActionPermissionsFromAssets,
  skillActionSemanticCapability,
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

function manifestAssetWithNetworkHosts(networkHosts: unknown) {
  const manifest = {
    actions: [
      {
        id: 'publish',
        capabilityId: 'skill.demo.publish',
        displayName: 'Demo publish',
        risk: 'write',
        can: 'Publish through the demo skill.',
        cannot: 'Do anything else.',
        commandTemplates: ['${skillRoot}/run.sh --publish'],
        requiredEnvVars: [],
        networkHosts,
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

function parseHosts(networkHosts: unknown): string[] {
  const actions = parseSkillActionPermissionsFromAssets({
    assets: manifestAssetWithNetworkHosts(networkHosts),
    skillName: 'demo',
  });
  return actions[0].networkHosts;
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

  it('accepts Node only when its script stays under the skill dir', () => {
    const actions = parseSkillActionPermissionsFromAssets({
      assets: manifestAsset('node ${skillRoot}/scripts/worker.mjs sync'),
      skillName: 'demo',
    });
    expect(actions[0].commandTemplates).toContain(
      'node skills/demo/scripts/worker.mjs sync',
    );
  });

  it.each([
    'node -e "process.exit(0)"',
    'node /tmp/worker.mjs',
    'node ../other-skill/worker.mjs',
  ])('rejects an unscoped Node command template: %s', (commandTemplate) => {
    expect(() =>
      parseSkillActionPermissionsFromAssets({
        assets: manifestAsset(commandTemplate),
        skillName: 'demo',
      }),
    ).toThrow(/must run under skills\/demo/i);
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

describe('parseSkillActionPermissionsFromAssets networkHosts', () => {
  it('accepts exact hosts with and without ports', () => {
    expect(parseHosts(['api.linkedin.com:443', 'www.linkedin.com'])).toEqual([
      'api.linkedin.com:443',
      'www.linkedin.com',
    ]);
  });

  it('normalizes case and trailing dots and dedupes', () => {
    expect(
      parseHosts(['API.LinkedIn.Com.:443', 'api.linkedin.com:443']),
    ).toEqual(['api.linkedin.com:443']);
  });

  it('defaults to an empty list when networkHosts is omitted', () => {
    const actions = parseSkillActionPermissionsFromAssets({
      assets: manifestAsset('${skillRoot}/run.sh --publish'),
      skillName: 'demo',
    });
    expect(actions[0].networkHosts).toEqual([]);
  });

  it('carries declared hosts onto the generated semantic capability', () => {
    const action = parseSkillActionPermissionsFromAssets({
      assets: manifestAssetWithNetworkHosts(['api.linkedin.com:443']),
      skillName: 'demo',
    })[0];
    const capability = skillActionSemanticCapability({
      skillId: 'skill:demo',
      skillName: 'demo',
      action,
    });
    expect(capability.networkHosts).toEqual(['api.linkedin.com:443']);
  });

  it.each([
    ['URL strings', ['https://api.linkedin.com/v2']],
    ['schemes', ['tcp://api.linkedin.com']],
    ['paths', ['api.linkedin.com/v2/posts']],
    ['credentials', ['user:pass@api.linkedin.com']],
    ['wildcards', ['*.linkedin.com']],
    ['empty hosts', ['']],
    ['invalid ports', ['api.linkedin.com:0']],
    ['out-of-range ports', ['api.linkedin.com:70000']],
    ['localhost', ['localhost:443']],
    ['loopback IPs', ['127.0.0.1:443']],
    ['private IPs', ['10.0.0.5:443']],
    ['unbracketed IPv6', ['2001:db8::1']],
  ])('rejects %s', (_label, hosts) => {
    expect(() => parseHosts(hosts)).toThrow(/networkHosts/i);
  });
});
