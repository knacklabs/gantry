import { Link } from '@tanstack/react-router';
import { List, X } from 'lucide-react';

import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '../../../ui/primitives/dialog';
import type { ChatSessionPreview } from '../chat-preview';

export function ChatSessionDrawer({
  currentSessionId,
  sessions,
}: {
  currentSessionId: string;
  sessions: ChatSessionPreview[];
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button className="lg:hidden" variant="secondary">
          <List size={15} aria-hidden="true" /> Sessions
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="web-drawer top-0 right-0 left-auto h-dvh max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none border-l border-border bg-surface p-4 shadow-popover lg:hidden"
      >
        <DialogTitle className="m-0 text-base font-semibold text-text">
          Chat sessions
        </DialogTitle>
        <DialogDescription className="mt-1 mb-4 text-xs text-text-secondary">
          Switch between preview sessions.
        </DialogDescription>
        <DialogClose asChild>
          <Button
            size="icon"
            variant="outline"
            className="absolute top-3 right-3"
            aria-label="Close sessions"
            title="Close sessions"
          >
            <X size={17} aria-hidden="true" />
          </Button>
        </DialogClose>
        <div className="grid gap-2">
          {sessions.map((session) => (
            <DialogClose asChild key={session.id}>
              <Link
                className={`grid gap-2 rounded-md border p-3 text-text no-underline ${session.id === currentSessionId ? 'border-border-strong bg-surface-strong' : 'border-border hover:bg-surface-muted'}`}
                params={{ sessionId: session.id }}
                search={{ inspector: 'thread' }}
                to="/chat/$sessionId"
              >
                <span className="flex items-center justify-between gap-2">
                  <strong className="text-[13px]">{session.title}</strong>
                  <StatusBadge status={session.status} />
                </span>
                <span className="text-xs text-text-secondary">
                  {session.agent}
                </span>
              </Link>
            </DialogClose>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
