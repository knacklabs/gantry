import { Icon } from '@iconify/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import type { ChannelProvider } from '../channel-accounts/channel-account-queries';
import { browserFetch } from '../../lib/auth/browser-auth';
import { SlackManifestDrawer } from './slack-manifest-drawer';
import { SlackTokenGuideDrawer } from './slack-token-guide-drawer';
import {
  CHANNEL_CONTENT,
  SLACK_TOKEN_DETAILS,
  onboardingChannels,
  onboardingPhases,
  slackTokenError,
} from './onboarding-workspace-content';
import { OnboardingWorkspacePhase } from './onboarding-workspace-phase';

export function OnboardingWorkspaceStep({
  agentName,
  busy,
  channel,
  channels,
  channelId,
  connected,
  onChannelChange,
  onConnect,
  values,
  setValues,
}: {
  agentName: string;
  busy: boolean;
  channel?: ChannelProvider;
  channels: ChannelProvider[];
  channelId: string;
  connected: boolean;
  onChannelChange: (id: string) => void;
  onConnect: () => void;
  values: Record<string, string>;
  setValues: (values: Record<string, string>) => void;
}) {
  const [activePhase, setActivePhase] = useState(0);
  const [manifestDrawerOpen, setManifestDrawerOpen] = useState(false);
  const [tokenGuideOpen, setTokenGuideOpen] = useState(false);
  const [slackCreated, setSlackCreated] = useState(false);
  const [credentialErrors, setCredentialErrors] = useState<
    Record<string, string>
  >({});
  const availableChannels = onboardingChannels(channels);
  const content = CHANNEL_CONTENT[channelId] ?? CHANNEL_CONTENT.slack;
  const phases = onboardingPhases(channelId);
  const slack = channelId === 'slack';

  const slackManifest = useQuery({
    queryKey: ['onboarding', 'slack-manifest', agentName],
    enabled: slack,
    queryFn: async (): Promise<{
      manifestJson: string;
      createUrl: string;
      permissionGroups: Array<{
        title: string;
        description: string;
        scopes: string[];
      }>;
    }> => {
      const response = await browserFetch(
        `/ui/api/onboarding/channel-manifest?providerId=slack&employeeName=${encodeURIComponent(agentName)}`,
        { credentials: 'same-origin' },
      );
      if (!response.ok)
        throw new Error('Slack app manifest could not be prepared.');
      return response.json();
    },
  });

  useEffect(() => {
    setActivePhase(0);
    setManifestDrawerOpen(false);
    setTokenGuideOpen(false);
    setSlackCreated(false);
    setCredentialErrors({});
  }, [channelId]);

  const credentialKeys = slack
    ? [
        'app_token',
        'bot_token',
        ...(channel?.credentialKeys ?? []).filter(
          (key) => !SLACK_TOKEN_DETAILS[key],
        ),
      ].filter((key) => channel?.credentialKeys.includes(key))
    : (channel?.credentialKeys ?? []);
  const credentialsReady = useMemo(
    () =>
      Boolean(channel?.credentialKeys.length) &&
      (channel?.credentialKeys.every((key) => values[key]?.trim()) ?? false),
    [channel?.credentialKeys, values],
  );
  const completedThrough = connected
    ? phases.length - 1
    : slack && slackCreated
      ? 0
      : -1;

  function setCredentialError(key: string, error?: string) {
    setCredentialErrors((current) => {
      const next = { ...current };
      if (error) next[key] = error;
      else delete next[key];
      return next;
    });
  }

  function setCredentialValue(key: string, value: string) {
    setValues({ ...values, [key]: value });
    if (credentialErrors[key]) {
      setCredentialError(key, slack ? slackTokenError(key, value) : undefined);
    }
  }

  function connect() {
    if (!slack) {
      if (credentialsReady) onConnect();
      return;
    }
    const errors = Object.fromEntries(
      credentialKeys
        .map((key) => [key, slackTokenError(key, values[key] ?? '')] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
    setCredentialErrors(errors);
    if (Object.keys(errors).length === 0) onConnect();
  }

  return (
    <section className="grid min-h-0 w-full justify-items-center gap-[13px] md:h-full md:grid-rows-[auto_auto_minmax(0,1fr)]">
      <div className="onboarding-heading mx-auto w-full max-w-[58ch] text-center">
        <h1>Give {agentName || 'your agent'} a place to work</h1>
        <p>{content.intro}</p>
      </div>
      <div
        className="flex flex-wrap justify-center gap-2"
        aria-label="Choose a workspace"
      >
        {availableChannels.map((item) => {
          const itemContent = CHANNEL_CONTENT[item.id];
          if (!itemContent) return null;
          return (
            <button
              key={item.id}
              aria-pressed={channelId === item.id}
              className={`relative inline-flex h-[34px] items-center gap-[9px] rounded-full border border-border bg-surface px-[13px] text-[12.5px] font-medium text-text transition-[background-color,transform] duration-[160ms] [@media(hover:hover)_and_(pointer:fine)]:hover:translate-y-[-1px] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-muted active:translate-y-px active:scale-[0.98] motion-reduce:transform-none motion-reduce:transition-none ${channelId === item.id ? "after:pointer-events-none after:absolute after:inset-[-1px] after:rounded-[inherit] after:border-2 after:border-ink after:content-[''] after:[animation:onboarding-fade_0.22s_var(--ease)_both] motion-reduce:after:animate-none" : ''}`}
              onClick={() => onChannelChange(item.id)}
            >
              <span className="relative grid size-6 place-items-center overflow-hidden rounded-[7px] border border-border-strong bg-surface-muted [&_svg]:size-3.5">
                <Icon icon={itemContent.icon} />
              </span>
              {item.displayName}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 w-full p-0.5 md:overflow-y-auto md:overscroll-contain md:[scrollbar-gutter:stable] md:[scroll-padding:14px]">
        <div className="grid gap-[9px]">
          {phases.map((phase, index) => (
            <OnboardingWorkspacePhase
              key={phase.title}
              phase={phase}
              index={index}
              active={activePhase === index}
              done={index <= completedThrough}
              connect={index === phases.length - 1}
              slackCreate={slack && index === 0}
              slack={slack}
              channel={channel}
              connected={connected}
              busy={busy}
              connectDisabled={!slack && !credentialsReady}
              credentialKeys={credentialKeys}
              credentialErrors={credentialErrors}
              values={values}
              onSelect={() => setActivePhase(index)}
              onCredentialError={setCredentialError}
              onCredentialValue={setCredentialValue}
              onConnect={connect}
              onCreateSlackApp={() => {
                if (!slackManifest.data) return;
                window.open(
                  slackManifest.data.createUrl,
                  '_blank',
                  'noopener,noreferrer',
                );
                setSlackCreated(true);
                setActivePhase(1);
              }}
              onOpenManifest={() => setManifestDrawerOpen(true)}
              onOpenTokenGuide={() => setTokenGuideOpen(true)}
              manifest={{
                pending: slackManifest.isPending,
                ready: Boolean(slackManifest.data),
                failed: slackManifest.isError,
              }}
            />
          ))}
        </div>
      </div>
      {slackManifest.data ? (
        <SlackManifestDrawer
          employeeName={agentName}
          manifestJson={slackManifest.data.manifestJson}
          onOpenChange={setManifestDrawerOpen}
          open={manifestDrawerOpen}
          permissionGroups={slackManifest.data.permissionGroups}
        />
      ) : null}
      <SlackTokenGuideDrawer
        onOpenChange={setTokenGuideOpen}
        open={tokenGuideOpen}
      />
    </section>
  );
}
