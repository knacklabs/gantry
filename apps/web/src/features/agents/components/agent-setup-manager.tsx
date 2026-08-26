import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { Button } from '../../../ui/primitives/button';
import { Checkbox } from '../../../ui/primitives/checkbox';
import {
  agentCapabilitiesQuery,
  agentQueryKeys,
  agentSourcesQuery,
  type AgentSource,
} from '../agents-queries';

type SetupKind = 'sources' | 'capabilities';

export function AgentSetupManager({
  agentId,
  kind,
  onSaved,
}: {
  agentId: string;
  kind: SetupKind;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const sources = useQuery(agentSourcesQuery(agentId));
  const capabilities = useQuery(agentCapabilitiesQuery(agentId));
  const data = kind === 'sources' ? sources.data : capabilities.data;
  const [selected, setSelected] = useState<string[]>([]);
  const sourceCurrent = sources.data?.sources.sources;
  const capabilityCurrent = capabilities.data?.capabilities.capabilities;

  useEffect(() => {
    if (kind === 'sources' && sourceCurrent)
      setSelected([
        ...sourceCurrent.skills.map((item) => `skill:${item.id}`),
        ...sourceCurrent.mcpServers.map((item) => `mcp:${item.id}`),
      ]);
    if (kind === 'capabilities' && capabilityCurrent)
      setSelected(
        capabilityCurrent.map((item) => `${item.id}:${item.version}`),
      );
  }, [capabilityCurrent, kind, sourceCurrent]);

  const save = useMutation({
    mutationFn: async () => {
      const url = `/ui/api/agents/${encodeURIComponent(agentId)}/${kind}`;
      const body =
        kind === 'sources'
          ? { sources: nextSources(selected, sourceCurrent ?? emptySources) }
          : {
              capabilities: selected.map((entry) => {
                const separator = entry.lastIndexOf(':');
                return {
                  id: entry.slice(0, separator),
                  version: entry.slice(separator + 1),
                };
              }),
            };
      const response = await browserFetch(url, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...browserCsrfHeader() },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Agent ${kind} could not be saved.`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentQueryKeys.all });
      onSaved?.();
    },
  });
  const items =
    kind === 'sources'
      ? [
          ...(data?.catalog.skills ?? []).map((item) => ({
            id: `skill:${item.id}`,
            label: item.name,
            description: item.description,
            group: 'Skills',
          })),
          ...(data?.catalog.mcpServers ?? []).map((item) => ({
            id: `mcp:${item.id}`,
            label: item.displayName ?? item.name,
            description: item.description,
            group: 'MCP servers',
          })),
        ]
      : (data?.catalog.capabilities ?? []).map((item) => ({
          id: `${item.id}:${item.version}`,
          label: item.label,
          description: item.description,
          group: 'Capabilities',
        }));

  if (sources.isLoading || capabilities.isLoading)
    return (
      <p className="p-5 text-sm text-text-secondary">Loading saved setup…</p>
    );
  if (!data)
    return (
      <p className="p-5 text-sm text-destructive">Setup could not be loaded.</p>
    );
  return (
    <div className="grid gap-5 p-5">
      <p className="text-sm text-text-secondary">
        {kind === 'sources'
          ? 'Attach installed skills or active MCP servers. This does not grant tool authority.'
          : 'Choose the tool capabilities this agent may use. Source attachment alone does not grant these.'}
      </p>
      {items.length ? (
        <div className="grid max-h-80 gap-2 overflow-y-auto rounded-md border border-border p-3">
          {items.map((item) => (
            <label
              className="flex cursor-pointer items-start gap-3 rounded p-2 hover:bg-surface-muted"
              key={item.id}
            >
              <Checkbox
                checked={selected.includes(item.id)}
                onCheckedChange={() =>
                  setSelected((value) =>
                    value.includes(item.id)
                      ? value.filter((id) => id !== item.id)
                      : [...value, item.id],
                  )
                }
              />
              <span className="grid gap-0.5 text-sm">
                <strong>{item.label}</strong>
                <span className="text-xs text-text-secondary">
                  {item.description ?? item.group}
                </span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="rounded-md bg-surface-muted p-4 text-sm text-text-secondary">
          No eligible {kind === 'sources' ? 'sources' : 'capabilities'} are
          available.
        </p>
      )}
      {save.isError ? (
        <p className="text-sm text-destructive">{save.error.message}</p>
      ) : null}
      <div className="flex justify-end">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          <Save size={15} aria-hidden="true" />
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}

function nextSources(selected: string[], current: AgentSource): AgentSource {
  return {
    skills: selected
      .filter((id) => id.startsWith('skill:'))
      .map((id) => ({ id: id.slice(6) })),
    mcpServers: selected
      .filter((id) => id.startsWith('mcp:'))
      .map((id) => ({ id: id.slice(4) })),
    tools: current?.tools ?? [],
  };
}

const emptySources: AgentSource = { skills: [], mcpServers: [], tools: [] };
