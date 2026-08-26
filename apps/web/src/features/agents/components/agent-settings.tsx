import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import { agentQueryKeys, type AgentDirectoryItem } from '../agents-queries';

export function AgentSettings({ agent }: { agent: AgentDirectoryItem }) {
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
    <div className="grid gap-6 p-5">
      <form className="grid max-w-md gap-3" onSubmit={submit}>
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
            {rename.isPending ? 'Saving…' : 'Save name'}
          </Button>
        </div>
      </form>
      <div className="grid gap-2 text-sm text-text-secondary">
        <span>Status: {agent.status}</span>
        <span>
          Configuration version: {agent.configVersion ?? 'No saved version'}
        </span>
        <span>Model: {agent.modelAlias ?? 'Deployment default'}</span>
        <span>Disabling preserves this agent’s configuration and history.</span>
      </div>
    </div>
  );
}
