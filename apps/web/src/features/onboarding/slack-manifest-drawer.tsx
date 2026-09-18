import { X } from 'lucide-react';
import { Button } from '../../ui/primitives/button';
import { CopyButton } from '../../ui/primitives/copy-button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../ui/primitives/dialog';

type PermissionGroup = { title: string; description: string; scopes: string[] };

export function SlackManifestDrawer({
  employeeName,
  manifestJson,
  open,
  onOpenChange,
  permissionGroups,
}: {
  employeeName: string;
  manifestJson: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  permissionGroups: PermissionGroup[];
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
              Slack app manifest
            </span>
            <DialogTitle className="text-[17px] font-semibold text-text">
              What the button sets up in Slack
            </DialogTitle>
            <DialogDescription className="text-[13px] text-text-secondary">
              Review the permissions before creating the app.
            </DialogDescription>
          </div>
          <div className="flex shrink-0 gap-1">
            <CopyButton size="sm" variant="outline" value={manifestJson} />
            <DialogClose asChild>
              <Button
                aria-label="Close Slack app manifest"
                size="icon-sm"
                variant="ghost"
              >
                <X aria-hidden="true" size={16} />
              </Button>
            </DialogClose>
          </div>
        </header>
        <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto p-5">
          <section className="grid gap-3">
            <div className="grid gap-1">
              <h2 className="m-0 text-[15px] font-semibold text-text">
                What {employeeName || 'your employee'} will be allowed to do
              </h2>
              <p className="m-0 text-[13px] leading-5 text-text-secondary">
                These are the exact Slack permissions requested by the app.
              </p>
            </div>
            <div className="grid gap-3">
              {permissionGroups.map((group) => (
                <article
                  className="grid gap-2 rounded-[10px] border border-border bg-surface-muted p-3"
                  key={group.title}
                >
                  <div>
                    <h3 className="m-0 text-[13px] font-medium text-text">
                      {group.title}
                    </h3>
                    <p className="m-0 mt-0.5 text-[12px] leading-[1.5] text-text-secondary">
                      {group.description}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {group.scopes.map((scope) => (
                      <code
                        className="rounded-md border border-border bg-surface px-1.5 py-1 font-mono text-[10.5px] text-text-secondary"
                        key={scope}
                      >
                        {scope}
                      </code>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section className="grid gap-3">
            <div className="grid gap-1">
              <h2 className="m-0 text-[15px] font-semibold text-text">
                What the button sets up in Slack
              </h2>
              <p className="m-0 text-[13px] leading-5 text-text-secondary">
                This JSON is URL-encoded onto the Slack app-creation link.
              </p>
            </div>
            <pre className="m-0 overflow-auto rounded-[10px] border border-border bg-surface-muted p-3 font-mono text-[11px] leading-[1.65] text-text-secondary">
              {manifestJson}
            </pre>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
