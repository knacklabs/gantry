import iconDiscord from '@iconify-icons/logos/discord-icon';
import iconMicrosoftTeams from '@iconify-icons/logos/microsoft-teams';
import iconSlack from '@iconify-icons/logos/slack-icon';
import iconTelegram from '@iconify-icons/logos/telegram';
import { Icon } from '@iconify/react';
import { Check, ExternalLink } from 'lucide-react';
import { useState } from 'react';

import type { OnboardingDraft } from '../onboarding-state';
import { WorkspaceGuideDrawer } from '../components/workspace-guide-drawer';
import { Heading } from './create-employee-step';

const channels = [
  [
    'slack',
    'Slack',
    iconSlack,
    'Create the app',
    'One click — Slack opens ready to go',
    '20 sec',
  ],
  [
    'teams',
    'Microsoft Teams',
    iconMicrosoftTeams,
    'Register the app',
    'Create it in your tenant',
    '2 min',
  ],
  [
    'discord',
    'Discord',
    iconDiscord,
    'Create the application',
    'Add a bot user to it',
    '1 min',
  ],
  [
    'telegram',
    'Telegram',
    iconTelegram,
    'Create the bot',
    'BotFather does it in one message',
    '30 sec',
  ],
] as const;

export function ConnectWorkspaceStep({
  connected,
  draft,
  onChange,
  setConnected,
}: {
  connected: boolean;
  draft: OnboardingDraft;
  onChange: (update: Partial<OnboardingDraft>) => void;
  setConnected: (value: boolean) => void;
}) {
  const [activePhase, setActivePhase] = useState(0);
  const [guideOpen, setGuideOpen] = useState(false);
  const selected = channels.find(([id]) => id === draft.channel) ?? channels[0];
  const phases = [
    [selected[3], selected[4], selected[5]],
    ['Connect it', 'Paste preview values and you are done', '30 sec'],
  ];

  return (
    <section className="grid w-full min-h-0 justify-items-center gap-[13px]">
      <Heading
        body={`Create a ${selected[1]} preview where your employee would work. No app, token, or workspace is connected.`}
        title={`Give ${draft.name || 'your agent'} a place to work`}
      />
      <div
        aria-label="Choose a workspace"
        className="flex flex-wrap justify-center gap-2"
      >
        {channels.map(([id, label, icon]) => (
          <button
            aria-pressed={draft.channel === id}
            className={`relative inline-flex h-[34px] items-center gap-[9px] rounded-full border border-border bg-surface px-[13px] text-[12.5px] font-medium text-text transition-[background-color,transform] duration-[160ms] [@media(hover:hover)_and_(pointer:fine)]:hover:translate-y-[-1px] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-muted active:translate-y-px active:scale-[0.98] ${draft.channel === id ? "after:pointer-events-none after:absolute after:inset-[-1px] after:rounded-[inherit] after:border-2 after:border-ink after:content-['']" : ''}`}
            key={id}
            onClick={() => {
              onChange({ channel: id });
              setActivePhase(0);
              setConnected(false);
            }}
            type="button"
          >
            <span className="relative grid size-6 place-items-center overflow-hidden rounded-[7px] border border-border-strong bg-surface-muted [&_svg]:size-3.5">
              <Icon icon={icon} />
            </span>
            {label}
          </button>
        ))}
      </div>
      <div className="w-full p-0.5">
        <div className="grid gap-[9px]">
          {phases.map(([title, summary, duration], index) => {
            const active = activePhase === index;
            const complete = connected && index === 0;
            return (
              <article
                className={`relative overflow-hidden rounded-[13px] border border-border bg-surface shadow-panel ${active ? "after:pointer-events-none after:absolute after:inset-[-1px] after:rounded-[14px] after:border-2 after:border-ink after:content-['']" : ''}`}
                key={title}
              >
                <button
                  aria-expanded={active}
                  className="grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 border-0 bg-transparent px-3.5 py-[11px] text-left text-text"
                  onClick={() => setActivePhase(index)}
                  type="button"
                >
                  <span
                    className={`relative z-[1] grid size-[26px] place-items-center rounded-full border border-border-strong bg-surface-muted font-mono text-[11px] text-text-secondary ${complete ? 'border-status-success bg-status-success-soft text-status-success' : ''}`}
                  >
                    {complete ? (
                      <Check aria-hidden="true" size={11} strokeWidth={2.2} />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span className="grid min-w-0 gap-0.5">
                    <b className="text-[13.5px] font-medium">{title}</b>
                    <small className="text-[12px] leading-[1.45] text-text-secondary">
                      {summary}
                    </small>
                  </span>
                  <span className="font-mono text-[10.5px] text-text-muted whitespace-nowrap">
                    {duration}
                  </span>
                </button>
                {active ? (
                  <div className="relative z-[1] grid gap-[11px] pt-0 pr-3.5 pb-[13px] pl-[50px]">
                    <p className="m-0 text-[13px] leading-[1.6] text-text-secondary">
                      Preview actions are local only. Production setup will ask
                      for the actual workspace permissions here.
                    </p>
                    {index === 0 ? (
                      <button
                        className="onboarding-secondary justify-self-start"
                        onClick={() => setGuideOpen(true)}
                        type="button"
                      >
                        <ExternalLink aria-hidden="true" size={13} />
                        View setup guide
                      </button>
                    ) : (
                      <button
                        className="onboarding-primary justify-self-start"
                        onClick={() => setConnected(true)}
                        type="button"
                      >
                        <Check aria-hidden="true" size={13} />
                        {connected
                          ? 'Connected — preview only'
                          : 'Mark preview connected'}
                      </button>
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </div>
      <WorkspaceGuideDrawer
        channel={selected[1]}
        onOpenChange={setGuideOpen}
        open={guideOpen}
      />
    </section>
  );
}
