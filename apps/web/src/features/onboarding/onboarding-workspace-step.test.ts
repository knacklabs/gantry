import { readFileSync } from 'node:fs';

import { expect, it, vi } from 'vitest';

vi.mock('./slack-manifest-drawer', () => ({
  SlackManifestDrawer: () => null,
}));
vi.mock('./slack-token-guide-drawer', () => ({
  SlackTokenGuideDrawer: () => null,
}));

import {
  onboardingChannels,
  onboardingPhases,
  slackTokenError,
} from './onboarding-workspace-content';

const providers = ['telegram', 'mattermost', 'discord', 'slack', 'teams'].map(
  (id) => ({
    id,
    displayName: id,
    capabilities: [],
    credentialKeys: ['token'],
    status: 'available' as const,
  }),
);

it('keeps Step 2 constrained to the V2 channel order', () => {
  expect(onboardingChannels(providers).map((provider) => provider.id)).toEqual([
    'slack',
    'teams',
    'discord',
    'telegram',
  ]);
});

it('uses two honest Slack phases without changing other channel flows', () => {
  expect(onboardingPhases('slack').map((phase) => phase.title)).toEqual([
    'Create the app',
    'Connect it',
  ]);
  expect(onboardingPhases('teams')).toHaveLength(3);
  expect(onboardingPhases('discord')).toHaveLength(3);
  expect(onboardingPhases('telegram')).toHaveLength(3);
});

it('requires Slack token values with their canonical prefixes', () => {
  expect(slackTokenError('app_token', '')).toMatch(/required/i);
  expect(slackTokenError('app_token', 'xoxb-wrong')).toMatch(/xapp-/);
  expect(slackTokenError('bot_token', 'xapp-wrong')).toMatch(/xoxb-/);
  expect(slackTokenError('app_token', 'xapp-valid')).toBeUndefined();
  expect(slackTokenError('bot_token', 'xoxb-valid')).toBeUndefined();
});

it('keeps V2 guidance separate from the live write-only connection', () => {
  const component = [
    './onboarding-workspace-content.ts',
    './onboarding-workspace-flow.tsx',
    './onboarding-workspace-phase.tsx',
  ]
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');

  expect(component).toContain('@iconify-icons/logos/slack-icon');
  expect(component).toContain('@iconify-icons/logos/microsoft-teams');
  expect(component).toContain('@iconify-icons/logos/discord-icon');
  expect(component).toContain('@iconify-icons/logos/telegram');
  expect(component).toContain('Create the app');
  expect(component).toContain('Connect it');
  expect(component).toContain('One click — Slack opens ready to go');
  expect(component).toContain('install it to the workspace, approve it');
  expect(component).toContain("summary: 'Paste two tokens and you are done'");
  expect(component).not.toContain(
    'In Slack, copy the bot token from OAuth & Permissions',
  );
  expect(component).toContain('autoComplete="off"');
  expect(component).toContain('onChannelChange(item.id)');
  expect(component).toContain('disabled={busy || connectDisabled}');
  expect(component).toContain(
    'className="grid min-h-0 w-full justify-items-center gap-[13px]',
  );
  expect(component).not.toContain('max-w-[560px]');
  expect(component).toContain('md:grid-rows-[auto_auto_minmax(0,1fr)]');
  expect(component).toContain('md:overflow-y-auto');
  expect(component).toContain('motion-reduce:animate-none');
  expect(component).toContain('motion-reduce:transition-none');
  expect(component).toContain(
    '/ui/api/onboarding/channel-manifest?providerId=slack&employeeName=',
  );
  expect(component).toContain('Create Gantry Slack App');
  expect(component).toContain('Preparing Slack app…');
  expect(component).toMatch(/See what it sets\s+up/);
  expect(component).toContain('setActivePhase(1);');
  expect(component).toContain('setSlackCreated(true);');
  expect(component).toContain('App-level token');
  expect(component).toContain('Bot user OAuth token');
  expect(component).toContain('xapp-…');
  expect(component).toContain('xoxb-…');
  expect(component).toMatch(/Where to find\s+the tokens/);
});
