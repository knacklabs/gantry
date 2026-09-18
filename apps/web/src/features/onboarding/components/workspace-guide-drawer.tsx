import { X } from 'lucide-react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import { Button } from '../../../ui/primitives/button';

const slackSteps = [
  ['Create an app', 'Start from an app manifest in Slack API.'],
  ['Review scopes', 'Confirm the exact workspace permissions before install.'],
  ['Install to workspace', 'Approve in Slack, then return to Gantry.'],
] as const;

export function WorkspaceGuideDrawer({
  channel,
  open,
  onOpenChange,
}: {
  channel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isSlack = channel === 'slack';
  const title = isSlack ? 'Slack setup guide' : `${channel} setup guide`;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="web-drawer top-0 right-0 left-auto flex h-dvh flex-col translate-x-0 translate-y-0 overflow-hidden rounded-none border-l border-border bg-surface p-0 shadow-popover"
        drawer
        showCloseButton={false}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-[19px]">
          <div className="grid gap-1">
            <span className="font-mono text-[10px] font-semibold tracking-wider text-text-secondary uppercase">
              Workspace preview
            </span>
            <DialogTitle className="text-[17px] font-semibold text-text">
              {title}
            </DialogTitle>
            <DialogDescription className="text-[13px] text-text-secondary">
              This is a visual guide only. No app, token, or workspace is
              created from this preview.
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              aria-label="Close setup guide"
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" size={16} />
            </Button>
          </DialogClose>
        </header>
        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-5">
          {(isSlack
            ? slackSteps
            : [
                [
                  'Choose a workspace',
                  'Select where the employee would appear.',
                ],
                [
                  'Review permissions',
                  'Production setup will show the real scopes.',
                ],
                ['Connect', 'A future flow will ask for authorization.'],
              ]
          ).map(([step, detail], index) => (
            <section
              className="grid grid-cols-[28px_minmax(0,1fr)] gap-3"
              key={step}
            >
              <span className="grid size-7 place-items-center rounded-full border border-status-attention bg-status-attention-soft font-mono text-xs text-status-attention">
                {index + 1}
              </span>
              <div>
                <h2 className="m-0 text-[15px] font-semibold text-text">
                  {step}
                </h2>
                <p className="mt-1 mb-0 text-[13px] leading-5 text-text-secondary">
                  {detail}
                </p>
              </div>
            </section>
          ))}
          <div className="rounded-[10px] border border-border bg-surface-muted p-3 text-[12px] leading-5 text-text-secondary">
            Preview mode deliberately keeps credentials out of the browser and
            does not contact {channel}.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
