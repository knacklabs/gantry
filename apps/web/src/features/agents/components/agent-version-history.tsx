import { useQuery } from '@tanstack/react-query';
import { History, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../../../ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../../ui/primitives/dialog';
import { agentVersionsQuery } from '../agents-queries';

export function AgentVersionHistory({ agentId }: { agentId: string }) {
  const versions = useQuery(agentVersionsQuery(agentId));
  const [selectedId, setSelectedId] = useState<string>();
  const selected =
    versions.data?.versions.find((version) => version.id === selectedId) ??
    versions.data?.versions[0];
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <History size={15} aria-hidden="true" />
          Version history
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-text-secondary">
          Read-only history of saved configuration snapshots.
        </p>
        {versions.isLoading ? (
          <p className="text-sm text-text-secondary">Loading history…</p>
        ) : null}
        {versions.isError ? (
          <Button variant="secondary" onClick={() => void versions.refetch()}>
            <RefreshCw size={15} aria-hidden="true" />
            Retry
          </Button>
        ) : null}
        {versions.data?.versions.length === 0 ? (
          <p className="text-sm text-text-secondary">
            No saved configuration versions.
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          <div className="grid max-h-80 gap-2 overflow-y-auto">
            {versions.data?.versions.map((version) => (
              <button
                className="rounded-md border border-border p-3 text-left data-[selected=true]:border-primary data-[selected=true]:bg-surface-muted"
                data-selected={selected?.id === version.id}
                key={version.id}
                onClick={() => setSelectedId(version.id)}
                type="button"
              >
                <strong className="text-sm">Version {version.version}</strong>
                <span className="block text-xs text-text-secondary">
                  {version.createdAt}
                </span>
              </button>
            ))}
          </div>
          {selected ? (
            <article className="grid content-start gap-2 rounded-md border border-border p-3">
              <strong className="text-sm">Version {selected.version}</strong>
              <span className="text-xs text-text-secondary">
                {selected.createdAt}
              </span>
              <span className="text-sm">
                {selected.roleSnapshot?.displayName ?? 'No role snapshot'}
              </span>
              <pre className="m-0 max-h-44 overflow-auto whitespace-pre-wrap text-xs leading-5 text-text-secondary">
                {selected.roleSnapshot?.prompt ?? 'No role prompt was saved.'}
              </pre>
              <span className="text-xs text-text-secondary">
                Model profile: {selected.llmProfileId}
              </span>
            </article>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
