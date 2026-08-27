import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { type AgentDirectoryItem, agentVersionsQuery } from '../agents-queries';
import { AgentDrawer } from './agent-drawer';

export function AgentVersionHistory({ agent }: { agent: AgentDirectoryItem }) {
  const versions = useQuery(agentVersionsQuery(agent.id));
  const [selectedId, setSelectedId] = useState<string>();
  const selected =
    versions.data?.versions.find((version) => version.id === selectedId) ??
    versions.data?.versions[0];
  const [open, setOpen] = useState(false);
  const count = versions.data?.versions.length;
  return (
    <>
      <Button
        className="border-border-strong bg-surface px-3 text-xs font-semibold shadow-panel hover:bg-surface-muted"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        Version history
      </Button>
      <AgentDrawer
        eyebrow="Read-only history"
        description={`${agent.name} · ${count === undefined ? 'Loading' : count} ${count === 1 ? 'version' : 'versions'}`}
        footer={
          <Button
            className="h-[34px] px-3 text-[12.5px]"
            onClick={() => setOpen(false)}
          >
            Done
          </Button>
        }
        open={open}
        title="Configuration versions"
        onOpenChange={setOpen}
      >
        {versions.isLoading ? (
          <p className="m-0 text-sm text-text-secondary">Loading history…</p>
        ) : null}
        {versions.isError ? (
          <Button variant="secondary" onClick={() => void versions.refetch()}>
            <RefreshCw size={15} />
            Retry
          </Button>
        ) : null}
        {versions.data?.versions.length === 0 ? (
          <p className="m-0 text-sm text-text-secondary">
            No saved configuration versions.
          </p>
        ) : null}
        {selected ? (
          <div className="grid gap-3 sm:grid-cols-[145px_minmax(0,1fr)]">
            <div className="grid content-start gap-[7px] border-b border-border pb-3 sm:max-h-[520px] sm:border-r sm:border-b-0 sm:pr-3 sm:pb-0">
              {versions.data?.versions.map((version, index) => (
                <button
                  className="rounded-md border border-border bg-surface p-[9px] text-left hover:border-text-secondary hover:bg-surface-muted data-[selected=true]:border-text-secondary data-[selected=true]:bg-surface-muted"
                  data-selected={selected.id === version.id}
                  key={version.id}
                  onClick={() => setSelectedId(version.id)}
                  type="button"
                >
                  <strong className="block text-[11px]">
                    v{version.version}
                    {index === 0 ? ' · Current' : ''}
                  </strong>
                  <span className="mt-[3px] block text-[9px] text-text-secondary">
                    Configuration snapshot
                  </span>
                  <span className="block text-[9px] text-text-secondary">
                    {formatDate(version.createdAt)}
                  </span>
                </button>
              ))}
            </div>
            <article className="grid content-start gap-3">
              <Badge variant="success">
                v{selected.version}
                {selected.id === versions.data?.versions[0]?.id
                  ? ' · Current'
                  : ''}
              </Badge>
              <div>
                <h3 className="m-0 text-[13px] font-semibold">
                  Configuration snapshot
                </h3>
                <p className="mt-1 mb-0 text-[13px] text-text-secondary">
                  {formatDateTime(selected.createdAt)}
                </p>
              </div>
              <div className="grid gap-2">
                <Change
                  text={`Saved role snapshot: ${selected.roleSnapshot?.displayName ?? 'none'}.`}
                />
                <Change text={`Configured model: ${selected.llmProfileId}.`} />
              </div>
              <section>
                <h4 className="m-0 text-[12px] font-semibold">Snapshot</h4>
                <dl className="mt-2 grid rounded-md border border-border bg-surface-muted px-3">
                  <Row
                    label="Role"
                    value={
                      selected.roleSnapshot?.displayName ?? 'No role snapshot'
                    }
                  />
                  <Row label="Model" value={selected.llmProfileId} />
                </dl>
              </section>
            </article>
          </div>
        ) : null}
        <div className="rounded-lg border border-status-attention/40 bg-status-attention-soft p-[11px] text-[10.5px] leading-[1.5]">
          <strong className="block text-[12px]">History is read-only.</strong>
          Restoring an earlier version is not available in the Web release.
        </div>
      </AgentDrawer>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border py-3 text-sm last:border-0">
      <dt>{label}</dt>
      <dd className="text-right font-semibold">{value}</dd>
    </div>
  );
}
function Change({ text }: { text: string }) {
  return (
    <div className="grid grid-cols-[18px_1fr] gap-[7px] rounded-md border border-border bg-surface-muted p-2 text-[10px] leading-[1.45]">
      <span className="font-semibold text-status-success">+</span>
      <span>{text}</span>
    </div>
  );
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
      }).format(date);
}
function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
}
