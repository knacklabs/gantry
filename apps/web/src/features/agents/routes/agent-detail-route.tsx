import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Pause, Play, SearchX } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useRuntimeConnection } from '../../../lib/api/runtime-connection';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import { loadAgent, updateAgent } from '../agents-api';
import { agentQueryKeys } from '../agents-queries';

export function AgentDetailRoute() {
  const { agentId } = useParams({ from: '/agents/$agentId' });
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  const {
    data: agent,
    isPending,
    isError,
  } = useQuery({
    queryKey: [...agentQueryKeys.list(), agentId],
    enabled: Boolean(connection.transport),
    queryFn: () => loadAgent(connection.transport!, agentId),
  });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  useEffect(() => {
    if (!agent) return;
    setName(agent.name);
    setDescription(agent.description ?? '');
  }, [agent]);
  const save = useMutation({
    mutationFn: () =>
      updateAgent(connection.transport!, agentId, { name, description }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.list() });
      await queryClient.invalidateQueries({
        queryKey: [...agentQueryKeys.list(), agentId],
      });
    },
  });
  const toggle = useMutation({
    mutationFn: () =>
      updateAgent(connection.transport!, agentId, {
        status: agent?.status === 'active' ? 'disabled' : 'active',
      }),
    onSuccess: async () =>
      queryClient.invalidateQueries({ queryKey: agentQueryKeys.all }),
  });

  if (isPending)
    return (
      <PageState
        kind="loading"
        icon={<SearchX size={18} />}
        title="Loading agent…"
        description="Fetching the current agent configuration."
      />
    );
  if (isError || !agent)
    return (
      <PageState
        kind="empty"
        icon={<SearchX size={18} />}
        title="Agent not found"
        description="This agent may have been removed or is unavailable."
      />
    );
  const pause = agent.status === 'active';
  return (
    <div className="mx-auto grid w-full max-w-[900px] gap-6">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        to="/agents"
        search={{
          q: '',
          status: 'all',
          model: 'all',
          page: 1,
          sort: 'name',
          desc: false,
          setup: undefined,
        }}
      >
        <ArrowLeft size={15} />
        Agents
      </Link>
      <PageHeader
        eyebrow="Agent administration"
        title={agent.name}
        description={agent.description ?? 'No purpose has been set.'}
        action={
          <div className="flex gap-2">
            <StatusBadge status={agent.status} />
            <Button variant="secondary" onClick={() => toggle.mutate()}>
              {pause ? <Pause size={15} /> : <Play size={15} />}
              {pause ? 'Pause agent' : 'Resume agent'}
            </Button>
          </div>
        }
      />
      <Panel title="Identity" description="Live agent identity and purpose.">
        <form
          className="grid gap-4 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <TextField
            id="agent-name"
            label="Agent name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <label className="grid gap-1.5 text-xs font-semibold text-text">
            Purpose
            <textarea
              className="min-h-28 resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] font-normal text-text"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <div className="flex justify-end">
            <Button
              disabled={!name.trim() || save.isPending}
              type="submit"
              variant="primary"
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
