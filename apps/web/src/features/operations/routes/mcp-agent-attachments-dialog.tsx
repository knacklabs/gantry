import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { agentQueryKeys } from '../../agents/agents-queries';
import { Button } from '../../../ui/primitives/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import { McpEligibleAgentsPicker } from './mcp-eligible-agents-picker';

type BrowserError = { error?: { message?: string }; message?: string };

export function McpAgentAttachmentsDialog({
  onAttached,
  onOpenChange,
  open,
  serverId,
}: {
  onAttached: (count: number) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  serverId: string;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  function changeOpen(next: boolean) {
    if (!next && saving) return;
    if (!next) {
      setSelected(new Set());
      setError(undefined);
    }
    onOpenChange(next);
  }

  function toggle(agentId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  async function attach() {
    if (selected.size === 0) return;
    setSaving(true);
    setError(undefined);
    try {
      const response = await browserFetch(
        `/ui/api/mcp-servers/${encodeURIComponent(serverId)}/agents`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            ...browserCsrfHeader(),
          },
          body: JSON.stringify({ agentIds: [...selected] }),
        },
      );
      const data = (await response.json().catch(() => null)) as
        | { attached?: number }
        | BrowserError
        | null;
      if (!response.ok || !data || !('attached' in data)) {
        setError(
          (data as BrowserError | null)?.error?.message ??
            'AI employees could not be attached.',
        );
        return;
      }
      await Promise.all(
        [...selected].map((agentId) =>
          queryClient.invalidateQueries({
            queryKey: [...agentQueryKeys.all, 'sources', agentId],
          }),
        ),
      );
      await onAttached(data.attached ?? selected.size);
      setSelected(new Set());
      onOpenChange(false);
    } catch {
      setError(
        'AI employees could not be attached. Check the Gantry service and try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogContent
        className="grid h-[min(560px,calc(100dvh-46px))] w-[min(640px,calc(100vw-32px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-none"
        showCloseButton={false}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="grid gap-1">
            <DialogTitle className="text-lg font-semibold">
              Attach AI employees
            </DialogTitle>
            <DialogDescription className="text-xs text-text-secondary">
              Choose active AI employees that can use this reviewed source. This
              does not grant actions.
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              aria-label="Close attach AI employees dialog"
              size="icon-sm"
              variant="ghost"
            >
              ×
            </Button>
          </DialogClose>
        </header>
        <div className="min-h-0 overflow-hidden p-5">
          <McpEligibleAgentsPicker
            enabled={open}
            onToggle={toggle}
            selected={selected}
            serverId={serverId}
          />
        </div>
        <footer className="flex items-center justify-end gap-3 border-t border-border bg-surface-muted px-5 py-3">
          {error ? (
            <p aria-live="polite" className="m-0 mr-auto text-xs text-danger">
              {error}
            </p>
          ) : null}
          <DialogClose asChild>
            <Button disabled={saving} variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={saving || selected.size === 0}
            onClick={() => void attach()}
          >
            {saving
              ? 'Attaching…'
              : `Attach ${selected.size} AI employee${selected.size === 1 ? '' : 's'}`}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
