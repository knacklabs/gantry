import iconDiscord from '@iconify-icons/logos/discord-icon';
import iconMicrosoftTeams from '@iconify-icons/logos/microsoft-teams';
import iconSlack from '@iconify-icons/logos/slack-icon';
import iconTelegram from '@iconify-icons/logos/telegram';
import { Icon } from '@iconify/react';
import { Check, ChevronDown, ExternalLink } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../../../ui/primitives/button';
import { toast } from '../../../ui/primitives/toast';
import type { OnboardingDraft } from '../onboarding-state';
import { Heading } from './create-employee-step';

const channels = [
  [
    'slack',
    'Slack',
    iconSlack,
    'Bring Gantry into Slack where your team already talks.',
  ],
  [
    'teams',
    'Microsoft Teams',
    iconMicrosoftTeams,
    'Set up the same preview flow for your Teams workspace.',
  ],
  [
    'discord',
    'Discord',
    iconDiscord,
    'Preview a server connection and where the employee appears.',
  ],
  [
    'telegram',
    'Telegram',
    iconTelegram,
    'Preview a Telegram workspace connection.',
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
  const [open, setOpen] = useState('create');
  const selected = channels.find(([id]) => id === draft.channel) ?? channels[0];
  return (
    <div className="grid gap-6">
      <Heading
        body="Choose a workspace surface. This screen is a local preview—no app, token, or workspace is connected."
        title="Connect your workspace"
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {channels.map(([id, label, icon]) => (
          <button
            className={`grid min-w-0 justify-items-center gap-2 rounded-xl border p-3 text-sm font-medium transition-colors duration-200 ease-[var(--ease-gantry)] ${draft.channel === id ? 'border-status-attention bg-status-attention-soft' : 'border-border bg-surface hover:border-border-strong hover:bg-surface-muted'}`}
            key={id}
            onClick={() => {
              onChange({ channel: id as OnboardingDraft['channel'] });
              setConnected(false);
            }}
            type="button"
          >
            <Icon aria-hidden="true" className="size-7" icon={icon} />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>
      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-panel">
        {[
          ['create', `Create ${selected[1]}`, selected[3]],
          [
            'connect',
            'Preview the connection',
            'Choose a workspace and mark it ready locally.',
          ],
          [
            'review',
            'Review what Gantry can see',
            'The production flow will request real scopes and show them here.',
          ],
        ].map(([id, title, body], index) => {
          const isOpen = open === id;
          return (
            <div className="border-b border-border last:border-b-0" key={id}>
              <button
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left hover:bg-surface-muted"
                onClick={() => setOpen(id)}
                type="button"
              >
                <span className="flex items-center gap-3">
                  <span
                    className={`grid size-7 place-items-center rounded-full border font-mono text-xs ${connected && index < 2 ? 'border-status-success bg-status-success text-surface' : 'border-border-strong bg-surface-muted text-text-secondary'}`}
                  >
                    {connected && index < 2 ? (
                      <Check aria-hidden="true" className="size-3.5" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span>
                    <b className="block text-sm">{title}</b>
                    <small className="mt-0.5 block text-xs text-text-secondary">
                      {body}
                    </small>
                  </span>
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={`size-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {isOpen ? (
                <div className="grid gap-3 border-t border-border bg-surface-muted px-5 py-4 text-sm text-text-secondary">
                  <p className="m-0 leading-6">
                    Preview actions are intentionally local. They make the UI
                    testable without authorising a third-party workspace.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() =>
                        toast.message(
                          'Preview only—no external workspace was opened.',
                        )
                      }
                      type="button"
                      variant="outline"
                    >
                      <ExternalLink aria-hidden="true" />
                      View setup guide
                    </Button>
                    {id === 'connect' ? (
                      <Button
                        onClick={() => {
                          setConnected(true);
                          toast.success('Workspace preview marked ready.');
                        }}
                        type="button"
                      >
                        <Check aria-hidden="true" />
                        {connected ? 'Preview ready' : 'Mark preview ready'}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </section>
    </div>
  );
}
