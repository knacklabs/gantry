import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../ui/primitives/select';
import {
  agentModelsQuery,
  agentQueryKeys,
  type AgentDirectoryItem,
} from '../agents-queries';

const DEPLOYMENT_DEFAULT_MODEL = '__deployment_default__';

export function AgentSettings({
  agent,
  onStatusRequest,
}: {
  agent: AgentDirectoryItem;
  onStatusRequest: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(agent.name);
  const [modelAlias, setModelAlias] = useState<string | null>(agent.modelAlias);
  useEffect(() => setName(agent.name), [agent.name]);
  useEffect(() => setModelAlias(agent.modelAlias), [agent.modelAlias]);
  const models = useQuery(agentModelsQuery);
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
          body: JSON.stringify({ name, modelAlias }),
        },
      );
      if (!response.ok) throw new Error('Agent name could not be saved.');
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: agentQueryKeys.all }),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      name.trim() &&
      (name.trim() !== agent.name || modelAlias !== agent.modelAlias)
    )
      rename.mutate();
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
          <label className="grid gap-1.5 text-xs font-semibold text-text">
            Model
            <Select
              value={modelAlias ?? DEPLOYMENT_DEFAULT_MODEL}
              onValueChange={(value) =>
                setModelAlias(value === DEPLOYMENT_DEFAULT_MODEL ? null : value)
              }
            >
              <SelectTrigger
                aria-label="Model"
                className="h-9 w-full rounded-md border-border-strong bg-surface px-3 text-[13px] text-text"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value={DEPLOYMENT_DEFAULT_MODEL}>
                  Use deployment default
                </SelectItem>
                {(models.data?.models ?? []).map((model) => (
                  <SelectItem key={model.alias} value={model.alias}>
                    {model.displayName} ({model.providerLabel})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div>
            <Button
              disabled={
                !name.trim() ||
                (name.trim() === agent.name &&
                  modelAlias === agent.modelAlias) ||
                rename.isPending
              }
              type="submit"
            >
              {rename.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
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
