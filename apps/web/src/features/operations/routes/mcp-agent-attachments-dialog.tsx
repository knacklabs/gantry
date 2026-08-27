import { useEffect, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { Button } from '../../../ui/primitives/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import { Input } from '../../../ui/primitives/input';

type EligibleAgent = {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  attachment: 'attached' | 'eligible';
};

type EligibleAgentsResponse = {
  agents: EligibleAgent[];
  page: number;
  pageSize: number;
  total: number;
};

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
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<EligibleAgentsResponse>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const timeout = window.setTimeout(() => {
      void (async () => {
        setLoading(true);
        setError(undefined);
        try {
          const params = new URLSearchParams({
            page: String(page),
            pageSize: '25',
            ...(search.trim() ? { q: search.trim() } : {}),
          });
          const response = await browserFetch(
            `/ui/api/mcp-servers/${encodeURIComponent(serverId)}/eligible-agents?${params}`,
            { credentials: 'same-origin' },
          );
          const data = (await response.json().catch(() => null)) as
            | EligibleAgentsResponse
            | BrowserError
            | null;
          if (!response.ok || !data || !('agents' in data)) {
            setError(
              (data as BrowserError | null)?.error?.message ??
                'Eligible agents could not be loaded.',
            );
            return;
          }
          setResult(data);
        } catch {
          setError('Eligible agents could not be loaded.');
        } finally {
          setLoading(false);
        }
      })();
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [open, page, search, serverId]);

  useEffect(() => {
    if (open) return;
    setError(undefined);
    setPage(1);
    setSearch('');
    setSelected(new Set());
  }, [open]);

  function toggle(agent: EligibleAgent) {
    if (agent.status !== 'active' || agent.attachment === 'attached') return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(agent.id)) next.delete(agent.id);
      else next.add(agent.id);
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
            'Agents could not be attached.',
        );
        return;
      }
      await onAttached(data.attached ?? selected.size);
      setSelected(new Set());
      onOpenChange(false);
    } catch {
      setError(
        'Agents could not be attached. Check the Gantry service and try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  const totalPages = Math.max(
    1,
    Math.ceil((result?.total ?? 0) / (result?.pageSize ?? 25)),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="grid h-[min(700px,calc(100dvh-46px))] w-[min(940px,calc(100vw-32px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="grid gap-1">
            <DialogTitle className="text-lg font-semibold">
              Attach agents
            </DialogTitle>
            <DialogDescription className="text-xs text-text-secondary">
              Choose active agents that can use this reviewed source. This does
              not grant actions.
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              aria-label="Close attach agents dialog"
              size="icon-sm"
              variant="ghost"
            >
              ×
            </Button>
          </DialogClose>
        </header>
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden p-5">
          <label className="grid gap-1.5 text-xs font-semibold">
            Search agents
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search agents by name..."
            />
          </label>
          <div className="min-h-0 overflow-hidden rounded-lg border border-border">
            <div className="max-h-full overflow-y-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-surface-muted text-xs text-text-secondary">
                  <tr>
                    <th className="w-11 p-3" scope="col">
                      <span className="sr-only">Select</span>
                    </th>
                    <th className="p-3" scope="col">
                      Agent
                    </th>
                    <th className="p-3" scope="col">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {result?.agents.map((agent) => {
                    const unavailable = agent.status !== 'active';
                    const attached = agent.attachment === 'attached';
                    return (
                      <tr
                        className={unavailable ? 'text-text-secondary' : ''}
                        key={agent.id}
                      >
                        <td className="p-3">
                          <Input
                            aria-label={`Select ${agent.name}`}
                            checked={selected.has(agent.id)}
                            className="size-4"
                            disabled={unavailable || attached}
                            onChange={() => toggle(agent)}
                            type="checkbox"
                          />
                        </td>
                        <td className="p-3 font-medium">{agent.name}</td>
                        <td className="p-3 text-xs">
                          {attached
                            ? 'Attached'
                            : unavailable
                              ? 'Unavailable · agent is disabled'
                              : 'Eligible'}
                        </td>
                      </tr>
                    );
                  })}
                  {!loading && result?.agents.length === 0 ? (
                    <tr>
                      <td className="p-4 text-text-secondary" colSpan={3}>
                        No matching agents.
                      </td>
                    </tr>
                  ) : null}
                  {loading ? (
                    <tr>
                      <td className="p-4 text-text-secondary" colSpan={3}>
                        Loading agents…
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-border bg-surface-muted px-5 py-3">
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <span>
              Page {page} of {totalPages}
            </span>
            <Button
              disabled={page <= 1 || loading}
              onClick={() => setPage((value) => value - 1)}
              size="sm"
              variant="secondary"
            >
              Previous
            </Button>
            <Button
              disabled={page >= totalPages || loading}
              onClick={() => setPage((value) => value + 1)}
              size="sm"
              variant="secondary"
            >
              Next
            </Button>
          </div>
          <div className="flex items-center gap-3">
            {error ? (
              <p aria-live="polite" className="m-0 text-xs text-danger">
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
                : `Attach ${selected.size} agent${selected.size === 1 ? '' : 's'}`}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
