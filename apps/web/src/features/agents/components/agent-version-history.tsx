import { useQuery } from '@tanstack/react-query';
import { History, RefreshCw } from 'lucide-react';

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
        <div className="grid max-h-80 gap-2 overflow-y-auto">
          {versions.data?.versions.map((version) => (
            <article
              className="rounded-md border border-border p-3"
              key={version.id}
            >
              <strong className="text-sm">Version {version.version}</strong>
              <p className="m-0 text-xs text-text-secondary">
                {version.createdAt}
              </p>
              <p className="mb-0 text-sm">
                {version.roleSnapshot?.displayName ?? 'No role snapshot'}
              </p>
            </article>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
