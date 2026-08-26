import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../../../ui/primitives/button';
import { agentVersionsQuery } from '../agents-queries';
import { AgentDrawer } from './agent-drawer';

export function AgentVersionHistory({ agentId }: { agentId: string }) {
  const versions = useQuery(agentVersionsQuery(agentId));
  const [selectedId, setSelectedId] = useState<string>();
  const selected =
    versions.data?.versions.find((version) => version.id === selectedId) ??
    versions.data?.versions[0];
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Version history
      </Button>
      <AgentDrawer
        description="Read-only history of saved configuration snapshots."
        footer={<Button onClick={() => setOpen(false)}>Done</Button>}
        open={open}
        title="Version history"
        onOpenChange={setOpen}
      >
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
        <div className="grid gap-4">
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
      </AgentDrawer>
    </>
  );
}
