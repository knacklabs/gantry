import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '../../../ui/primitives/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../ui/primitives/dialog';

export function AgentDrawer({
  bodyClassName,
  children,
  description,
  eyebrow,
  footer,
  onOpenChange,
  open,
  title,
}: {
  bodyClassName?: string;
  children: ReactNode;
  description?: string;
  eyebrow?: string;
  footer?: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="web-drawer top-0 right-0 left-auto flex h-dvh max-w-none flex-col translate-x-0 translate-y-0 overflow-hidden rounded-none border-l border-border bg-surface p-0 shadow-popover"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-surface px-5 py-[19px]">
          <div className="grid gap-1">
            {eyebrow ? (
              <span className="text-[10px] font-semibold tracking-wider text-text-secondary uppercase">
                {eyebrow}
              </span>
            ) : null}
            <DialogTitle className="text-[17px] font-semibold text-text">
              {title}
            </DialogTitle>
            {description ? (
              <DialogDescription className="text-[13px] text-text-secondary">
                {description}
              </DialogDescription>
            ) : null}
          </div>
          <DialogClose asChild>
            <Button
              aria-label={`Close ${title}`}
              size="icon-sm"
              variant="ghost"
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </DialogClose>
        </header>
        <div
          className={
            bodyClassName ??
            'grid min-h-0 flex-1 gap-[18px] overflow-y-auto p-5'
          }
        >
          {children}
        </div>
        {footer ? (
          <footer className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-surface px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
