import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Box, Plus, Search } from 'lucide-react';
import { type FormEvent } from 'react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { agentPreviewQuery, sourcePreviewQuery } from '../agents-queries';

const kinds = [
  'all',
  'Built-in tools',
  'Skill catalog',
  'MCP server',
  'Local CLI',
] as const;

export function SourcesRoute() {
  const search = useSearch({ from: '/sources' });
  const navigate = useNavigate({ from: '/sources' });
  const { data: sources } = useQuery(sourcePreviewQuery);
  const { data: agents } = useQuery(agentPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const query = search.q.toLowerCase();
  const visible = sources.filter(
    (source) =>
      (search.kind === 'all' || source.kind === search.kind) &&
      (!query ||
        `${source.name} ${source.kind} ${source.description}`
          .toLowerCase()
          .includes(query)),
  );
  const selected =
    sources.find((source) => source.id === search.selected) ??
    visible[0] ??
    sources[0];
  const assignedAgents = agents.filter((agent) =>
    agent.sources.includes(selected.id),
  );

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void navigate({ search: { ...search, q: String(form.get('q') ?? '') } });
  }

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Administration"
        title="Sources & access"
        description="Reviewed tool, skill, MCP, and local CLI catalogs available to agents."
        action={
          <Button onClick={() => requestConnection('Add source')}>
            <Plus size={16} aria-hidden="true" />
            Add source
          </Button>
        }
      />

      <form
        className="grid items-end gap-3 md:grid-cols-[minmax(0,1fr)_190px_auto]"
        onSubmit={submitSearch}
      >
        <TextField
          defaultValue={search.q}
          id="source-search"
          label="Search sources"
          name="q"
          placeholder="Name, type, or capability"
        />
        <label className="grid gap-1.5 text-xs font-semibold text-text">
          Type
          <select
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
            value={search.kind}
            onChange={(event) =>
              void navigate({
                search: {
                  ...search,
                  kind: event.target.value as typeof search.kind,
                },
              })
            }
          >
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind === 'all' ? 'All source types' : kind}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" type="submit">
          <Search size={15} aria-hidden="true" /> Search
        </Button>
      </form>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(300px,.75fr)_minmax(0,1.25fr)]">
        <Panel
          title="Source catalog"
          description={`${visible.length} matching sources`}
        >
          <div className="divide-y divide-border">
            {visible.map((source) => (
              <button
                aria-pressed={selected.id === source.id}
                className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-4 text-left hover:bg-surface-muted ${selected.id === source.id ? 'bg-surface-strong' : 'bg-transparent'}`}
                key={source.id}
                type="button"
                onClick={() =>
                  void navigate({ search: { ...search, selected: source.id } })
                }
              >
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-text">
                    {source.name}
                  </span>
                  <span className="mt-1 block text-xs text-text-secondary">
                    {source.kind} · {source.version}
                  </span>
                </span>
                <StatusBadge status={source.status} />
              </button>
            ))}
          </div>
        </Panel>

        <Panel
          title={selected.name}
          description={selected.kind}
          action={<StatusBadge status={selected.status} />}
        >
          <div className="grid gap-5 p-5">
            <p className="m-0 text-sm leading-6 text-text-secondary">
              {selected.description}
            </p>
            {selected.blocker ? (
              <div className="rounded-md border border-status-attention/40 bg-status-attention-soft p-3 text-xs leading-5 text-status-attention">
                {selected.blocker}
              </div>
            ) : null}
            <section>
              <h2 className="m-0 text-xs font-semibold text-text">
                Projected capabilities
              </h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {selected.capabilities.map((capability) => (
                  <Badge key={capability}>{capability}</Badge>
                ))}
              </div>
            </section>
            <section>
              <h2 className="m-0 text-xs font-semibold text-text">
                Selected by agents
              </h2>
              <div className="mt-3 grid gap-2">
                {assignedAgents.map((agent) => (
                  <div
                    className="flex min-h-12 items-center justify-between rounded-md border border-border px-3"
                    key={agent.id}
                  >
                    <span className="inline-flex items-center gap-2 text-[13px] font-medium text-text">
                      <Box size={15} aria-hidden="true" /> {agent.name}
                    </span>
                    <StatusBadge status={agent.status} />
                  </div>
                ))}
              </div>
            </section>
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <Button
                onClick={() => requestConnection(`Attach ${selected.name}`)}
              >
                Attach to agent
              </Button>
              <Button
                variant="secondary"
                onClick={() => requestConnection(`Review ${selected.name}`)}
              >
                Review source
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
