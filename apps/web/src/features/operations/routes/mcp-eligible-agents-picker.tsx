import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button } from '../../../ui/primitives/button';
import { Input } from '../../../ui/primitives/input';
import {
  mcpEligibleAgentsQuery,
  type McpEligibleAgent,
} from '../operations-queries';

export function McpEligibleAgentsPicker({
  enabled,
  onToggle,
  selected,
  serverId,
}: {
  enabled: boolean;
  onToggle: (agentId: string) => void;
  selected: ReadonlySet<string>;
  serverId: string | undefined;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const query = useQuery(
    mcpEligibleAgentsQuery(serverId, page, search, enabled),
  );

  useEffect(() => {
    if (!enabled) return;
    setSearch('');
    setPage(1);
  }, [enabled, serverId]);

  const totalPages = Math.max(
    1,
    Math.ceil((query.data?.total ?? 0) / (query.data?.pageSize ?? 25)),
  );

  function toggle(agent: McpEligibleAgent) {
    if (agent.status !== 'active' || agent.attachment === 'attached') return;
    onToggle(agent.id);
  }

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
      <label className="grid gap-1.5 text-xs font-semibold">
        Search AI employees
        <Input
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder="Search AI employees by name..."
          value={search}
        />
      </label>
      <div className="min-h-0 max-h-64 overflow-y-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-surface-muted text-xs text-text-secondary">
            <tr>
              <th className="w-11 p-3" scope="col">
                <span className="sr-only">Select</span>
              </th>
              <th className="p-3" scope="col">
                AI employee
              </th>
              <th className="p-3" scope="col">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {query.data?.agents.map((agent) => {
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
                        ? 'Unavailable · AI employee is disabled'
                        : 'Eligible'}
                  </td>
                </tr>
              );
            })}
            {!query.isLoading && query.data?.agents.length === 0 ? (
              <tr>
                <td className="p-4 text-text-secondary" colSpan={3}>
                  No matching AI employees.
                </td>
              </tr>
            ) : null}
            {query.isLoading ? (
              <tr>
                <td className="p-4 text-text-secondary" colSpan={3}>
                  Loading AI employees…
                </td>
              </tr>
            ) : null}
            {query.isError ? (
              <tr>
                <td className="p-4 text-danger" colSpan={3}>
                  Eligible AI employees could not be loaded.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        <span>
          Page {page} of {totalPages}
        </span>
        <Button
          disabled={page <= 1 || query.isLoading}
          onClick={() => setPage((value) => value - 1)}
          size="sm"
          type="button"
          variant="secondary"
        >
          Previous
        </Button>
        <Button
          disabled={page >= totalPages || query.isLoading}
          onClick={() => setPage((value) => value + 1)}
          size="sm"
          type="button"
          variant="secondary"
        >
          Next
        </Button>
      </div>
    </div>
  );
}
