import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import { agentQueryKeys, type AgentDirectoryItem } from '../agents-queries';

export function AgentSettings({
  agent,
  onStatusRequest,
}: {
  agent: AgentDirectoryItem;
  onStatusRequest: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(agent.name);
  useEffect(() => setName(agent.name), [agent.name]);
  const rename = useMutation({
    mutationFn: async () => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agent.id)}`,
        {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            ...browserCsrfHeader(),
          },
          body: JSON.stringify({ name }),
        },
      );
      if (!response.ok) throw new Error('Agent name could not be saved.');
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: agentQueryKeys.all }),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() && name.trim() !== agent.name) rename.mutate();
  }

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1.4fr_0.9fr]">
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="m-0 text-base font-semibold">General settings</h2>
        <p className="mt-1 mb-4 text-sm text-text-secondary">
          Changes to the name are saved directly to this agent.
        </p>
        <form className="grid max-w-xl gap-3" onSubmit={submit}>
          <TextField
            error={rename.isError ? rename.error.message : undefined}
            id="agent-name"
            label="Agent name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div>
            <Button
              disabled={
                !name.trim() || name.trim() === agent.name || rename.isPending
              }
              type="submit"
            >
              {rename.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
        <div className="mt-4 rounded-md border border-border bg-surface-muted p-3 text-sm">
          <span className="block font-mono text-[10px] font-semibold tracking-wide text-text-secondary uppercase">
            Model
          </span>
          <strong className="mt-1 block">
            {agent.modelAlias ?? 'Deployment default'}
          </strong>
          <span className="mt-1 block text-xs text-text-secondary">
            Model changes are not available in the current browser API.
          </span>
        </div>
      </section>
      <aside className="rounded-lg border border-border bg-surface p-4">
        <h2 className="m-0 text-base font-semibold">Availability</h2>
        <p className="mt-1 mb-4 text-sm text-text-secondary">
          {agent.status === 'active'
            ? 'Disable this agent to reject new sessions and delegation.'
            : 'Enable this agent to accept new sessions and delegation.'}
        </p>
        <p className="mb-4 text-sm font-semibold capitalize">
          Current status: {agent.status}
        </p>
        <Button
          variant={agent.status === 'active' ? 'destructive' : 'default'}
          onClick={onStatusRequest}
        >
          {agent.status === 'active' ? 'Disable agent' : 'Enable agent'}
        </Button>
        <div className="mt-4 rounded-md border border-status-attention/40 bg-status-attention-soft p-3 text-xs text-text-secondary">
          History and saved configuration are retained when availability
          changes.
        </div>
      </aside>
    </div>
  );
}
