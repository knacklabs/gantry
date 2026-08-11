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

function manifestAssetWithBrowserAccess(browserAccess: unknown) {
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestAsset('${skillRoot}/run.sh')[0].content),
  );
  manifest.actions[0].browserAccess = browserAccess;
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

  it('accepts only the host-managed browser mode', () => {
    const [action] = parseSkillActionPermissionsFromAssets({
      assets: manifestAssetWithBrowserAccess('managed_browser'),
      skillName: 'demo',
    });
    expect(action.browserAccess).toBe('managed_browser');
    expect(
      skillActionSemanticCapability({
        skillId: 'skill:demo',
        skillName: 'demo',
        action,
      }).source,
    ).toMatchObject({ browserAccess: 'managed_browser' });
  });

  it('rejects arbitrary browser access modes', () => {
    expect(() =>
      parseSkillActionPermissionsFromAssets({
        assets: manifestAssetWithBrowserAccess('raw_cdp'),
        skillName: 'demo',
      }),
    ).toThrow('browserAccess must be managed_browser');
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
