import * as Dialog from '@radix-ui/react-dialog';
import { Link } from '@tanstack/react-router';
import { List, X } from 'lucide-react';

import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import { IconButton } from '../../../ui/primitives/icon-button';
import type { ChatSessionPreview } from '../chat-preview';

export function ChatSessionDrawer({
  currentSessionId,
  sessions,
}: {
  currentSessionId: string;
  sessions: ChatSessionPreview[];
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button className="lg:hidden" variant="secondary">
          <List size={15} aria-hidden="true" /> Sessions
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-30 bg-overlay lg:hidden" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-40 w-[min(340px,calc(100vw-24px))] overflow-y-auto border-l border-border bg-surface p-4 shadow-popover lg:hidden">
          <Dialog.Title className="m-0 text-base font-semibold text-text">
            Chat sessions
          </Dialog.Title>
          <Dialog.Description className="mt-1 mb-4 text-xs text-text-secondary">
            Switch between preview sessions.
          </Dialog.Description>
          <Dialog.Close asChild>
            <IconButton
              className="absolute top-3 right-3"
              aria-label="Close sessions"
              title="Close sessions"
            >
              <X size={17} aria-hidden="true" />
            </IconButton>
          </Dialog.Close>
          <div className="grid gap-2">
            {sessions.map((session) => (
              <Dialog.Close asChild key={session.id}>
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
              </Dialog.Close>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
