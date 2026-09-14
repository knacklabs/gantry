import { X } from 'lucide-react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../ui/primitives/dialog';
import { Button } from '../../ui/primitives/button';

const TOKEN_GUIDES = [
  {
    title: 'App-level token',
    path: 'Basic Information → App-Level Tokens',
    field: 'Generate Token and Scopes · connections:write',
    sample: 'xapp-1-A0••••••••',
    note: 'Copy it when Slack creates it — the value is shown only once.',
    active: 'Basic Information',
  },
  {
    title: 'Bot user OAuth token',
    path: 'OAuth & Permissions → OAuth Tokens for Your Workspace',
    field: 'Bot User OAuth Token',
    sample: 'xoxb-2••••••••••',
    note: 'This appears after Install to Workspace is approved.',
    active: 'OAuth & Permissions',
  },
] as const;

const NAV_ITEMS = [
  'Basic Information',
  'Collaborators',
  'Socket Mode',
  'OAuth & Permissions',
  'Event Subscriptions',
];

export function SlackTokenGuideDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        drawer
        showCloseButton={false}
        className="web-drawer top-0 right-0 left-auto flex h-dvh flex-col translate-x-0 translate-y-0 overflow-hidden rounded-none border-l border-border bg-surface p-0 shadow-popover"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-[19px]">
          <div className="grid gap-1">
            <span className="text-[10px] font-semibold tracking-wider text-text-secondary uppercase">
              Slack setup
            </span>
            <DialogTitle className="text-[17px] font-semibold text-text">
              Where to find the tokens
            </DialogTitle>
            <DialogDescription className="text-[13px] text-text-secondary">
              Finish the Slack app setup, then copy these two values into
              Gantry.
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              aria-label="Close token guide"
              size="icon-sm"
              variant="ghost"
            >
              <X aria-hidden="true" size={16} />
            </Button>
          </DialogClose>
        </header>
        <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto p-5">
          {TOKEN_GUIDES.map((guide, index) => (
            <section className="grid gap-3" key={guide.title}>
              <div className="grid gap-1">
                <span className="font-mono text-[10px] tracking-[0.04em] text-text-muted uppercase">
                  {index + 1}. {guide.path}
                </span>
                <h2 className="m-0 text-[15px] font-semibold text-text">
                  {guide.title}
                </h2>
              </div>
              <div className="overflow-hidden rounded-[10px] border border-border-strong bg-surface">
                <div className="flex items-center gap-[5px] border-b border-border bg-surface-strong px-[9px] py-[7px]">
                  <span className="size-1.5 rounded-full bg-border-strong" />
                  <span className="size-1.5 rounded-full bg-border-strong" />
                  <span className="ml-[5px] font-mono text-[9px] text-text-muted">
                    api.slack.com/apps
                  </span>
                </div>
                <div className="grid grid-cols-[78px_minmax(0,1fr)]">
                  <nav className="grid content-start gap-[3px] border-r border-border bg-surface-muted p-[7px]">
                    {NAV_ITEMS.map((item) => (
                      <span
                        className={`rounded-[5px] px-[6px] py-1 text-[8.5px] leading-[1.3] ${item === guide.active ? 'border border-status-attention bg-status-attention-soft text-text' : 'text-text-muted'}`}
                        key={item}
                      >
                        {item}
                      </span>
                    ))}
                  </nav>
                  <div className="grid content-start gap-[7px] p-2.5">
                    <span className="text-[10px] font-semibold text-text">
                      {guide.active}
                    </span>
                    <span className="h-[5px] w-[70%] rounded-[3px] bg-surface-strong" />
                    <div className="relative grid gap-1 rounded-[7px] bg-surface-muted p-2">
                      <span className="pointer-events-none absolute inset-[-3px] rounded-[9px] border-2 border-status-attention [animation:onboarding-pulse_2.4s_ease-in-out_infinite] motion-reduce:animate-none" />
                      <span className="relative text-[9px] text-text-secondary">
                        {guide.field}
                      </span>
                      <span className="relative flex items-center gap-[5px]">
                        <span className="flex h-[17px] flex-1 items-center overflow-hidden rounded-[5px] border border-border-strong bg-surface px-[6px] font-mono text-[9px] whitespace-nowrap text-text">
                          {guide.sample}
                        </span>
                        <span className="rounded-[5px] bg-surface-strong px-[6px] py-0.5 text-[8.5px] text-text-secondary">
                          Copy
                        </span>
                      </span>
                    </div>
                    <span className="h-[5px] w-[45%] rounded-[3px] bg-surface-strong" />
                  </div>
                </div>
              </div>
              <p className="m-0 text-[12px] leading-[1.5] text-text-secondary">
                {guide.note}
              </p>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
