import { describe, expect, it } from 'vitest';

import { durablePermissionRequestSnapshot } from '@core/application/interactions/pending-interaction-permission-envelope.js';
import { buildBoundedPermissionCard } from '@core/channels/permission-card.js';
import { buildPermissionPromptFullView } from '@core/channels/permission-full-view.js';
import { formatPermissionPromptText } from '@core/channels/permission-interaction.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';

function ask(
  overrides: Partial<PermissionApprovalRequest>,
): PermissionApprovalRequest {
  return {
    requestId: 'prompt-secrets',
    appId: 'default',
    sourceAgentFolder: 'main_agent',
    targetJid: 'tg:100200300',
    toolName: 'mcp__vault__unlock',
    decisionOptions: ['allow_once', 'cancel'],
    ...overrides,
  };
}

// A credential value long enough that shortening keeps only its end.
const longValue = `${'abc'.repeat(500)}LONGSECRETTAIL`;

// Every shape a secret reaches a permission prompt in. Each row is checked
// against what is stored for a restart and everything a channel renders.
const SHAPES: Array<{
  shape: string;
  request: PermissionApprovalRequest;
  secret: string;
  shows?: string;
}> = [
  {
    shape: 'a credential-named field',
    request: ask({ toolInput: { vault: 'team', api_key: 'shortkey1' } }),
    secret: 'shortkey1',
    shows: 'Vault: team',
  },
  {
    shape: 'a passphrase field',
    request: ask({ toolInput: { vault: 'team', passphrase: 'open sesame' } }),
    secret: 'open sesame',
  },
  {
    shape: 'a field named key outside the browser',
    request: ask({ toolInput: { vault: 'team', key: 'plainkey1' } }),
    secret: 'plainkey1',
  },
  {
    shape: 'a credential-named display field',
    request: ask({ toolInput: { credentialNeeds: ['shortkey1'] } }),
    secret: 'shortkey1',
  },
  {
    shape: 'a credential-named field nested in a displayed list',
    request: ask({
      toolName: 'request_skill_install',
      toolInput: {
        commandSummary: 'npx skills add acme/weather',
        files: [{ path: 'SKILL.md', token: 'nestedtok1' }],
      },
    }),
    secret: 'nestedtok1',
    shows: 'Install: npx skills add acme/weather',
  },
  {
    shape: 'a quoted JSON credential field',
    request: ask({
      toolName: 'Write',
      toolInput: {
        file_path: '/workspace/config.json',
        content: '{\n  "user": "ravi",\n  "password": "jsonpw-1"\n}\n',
      },
    }),
    secret: 'jsonpw-1',
    shows: '"user": "ravi"',
  },
  {
    shape: 'a KEY=value credential in a command',
    request: ask({
      toolName: 'Bash',
      toolInput: { command: 'PGPASSWORD=envpw-1 psql -h db -c "select 1"' },
    }),
    secret: 'envpw-1',
    shows: 'Runs: psql',
  },
  {
    shape: 'an escaped quote in a command credential',
    request: ask({
      toolName: 'Bash',
      toolInput: {
        command: String.raw`PGPASSWORD="prefix\"suffix" psql -h db -c "select 1"`,
      },
    }),
    secret: 'suffix',
    shows: 'Runs: psql',
  },
  {
    shape: 'an opaque credential in a command header',
    request: ask({
      toolName: 'Bash',
      toolInput: {
        command:
          'curl -H "X-Auth: aB3dE5gH7jK9mN2pQ4sT6vW8yZ0" https://api.example.com',
      },
    }),
    secret: 'aB3dE5gH7jK9mN2pQ4sT6vW8yZ0',
  },
  {
    shape: 'URL user:password in a command',
    request: ask({
      toolName: 'Bash',
      toolInput: {
        command: 'git clone https://ravi:urlpw-1@git.example.com/x',
      },
    }),
    secret: 'urlpw-1',
    shows: 'Runs: git',
  },
  {
    shape: 'a bearer token in a command',
    request: ask({
      toolName: 'Bash',
      toolInput: {
        command:
          'curl -H "Authorization: Bearer bearertok-123456" https://api.example.com',
      },
    }),
    secret: 'bearertok-123456',
    shows: 'Runs: curl',
  },
  {
    shape: 'a provider token in prose',
    request: ask({
      toolName: 'Bash',
      toolInput: {
        command: 'gh repo list',
        description: 'List repos with ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      },
    }),
    secret: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    shows: 'Runs: gh',
  },
  {
    shape: 'a long credential value that gets shortened',
    request: ask({
      toolName: 'Bash',
      toolInput: {
        command: `${'echo filler && '.repeat(200)}deploy --password="${longValue}"`,
      },
    }),
    secret: 'LONGSECRETTAIL',
  },
  {
    shape: "URL user:password in the turn's request",
    request: ask({
      toolInput: { vault: 'team' },
      turnIntentSummary:
        '<messages>\n<message sender="Ravi" time="09:00">Unlock https://ravi:whypw-1@vault.example.com for me</message>\n</messages>',
    }),
    secret: 'whypw-1',
    shows: 'Why: Unlock https://',
  },
];

describe('permission prompts hide secrets', () => {
  it.each(SHAPES)(
    'hides $shape in the stored request and every rendered form',
    ({ request, secret, shows }) => {
      const stored = JSON.stringify(durablePermissionRequestSnapshot(request));
      const card = buildBoundedPermissionCard({ request, providerAlias: 'x' });
      const rendered = [
        formatPermissionPromptText(request),
        card.text,
        JSON.stringify(card.fullView ?? null),
        JSON.stringify(buildPermissionPromptFullView(request) ?? null),
      ].join('\n');

      expect(stored).not.toContain(secret);
      expect(rendered).not.toContain(secret);
      if (shows) expect(rendered).toContain(shows);
    },
  );

  // Credential-like names are hidden for every tool, including browser tools.
  it('hides a browser field named key in the stored request and prompt', () => {
    const request = ask({
      toolName: 'mcp__gantry__browser_press_key',
      toolInput: { key: 'Enter' },
    });
    expect(durablePermissionRequestSnapshot(request).toolInput).toMatchObject({
      key: '[hidden]',
    });
    expect(formatPermissionPromptText(request)).toContain('Key: [hidden]');
    expect(formatPermissionPromptText(request)).not.toContain('Enter');
  });
});
