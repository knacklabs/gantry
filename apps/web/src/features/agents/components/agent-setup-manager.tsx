import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { Button } from '../../../ui/primitives/button';
import { Checkbox } from '../../../ui/primitives/checkbox';
import { TextField } from '../../../ui/compositions/text-field';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../../ui/primitives/dialog';
import {
  agentCapabilitiesQuery,
  agentCatalogQuery,
  agentQueryKeys,
  agentSourcesQuery,
  type AgentSource,
  type CapabilityCatalog,
} from '../agents-queries';

type SetupKind = 'sources' | 'capabilities';

export function AgentSetupManager({
  agentId,
  kind,
  onSaved,
  disabled = false,
}: {
  agentId: string;
  kind: SetupKind;
  onSaved?: () => void;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const sources = useQuery({
    ...agentSourcesQuery(agentId),
    enabled: kind === 'sources',
  });
  const capabilities = useQuery({
    ...agentCapabilitiesQuery(agentId),
    enabled: kind === 'capabilities',
  });
  const data = kind === 'sources' ? sources.data : capabilities.data;
  const [selected, setSelected] = useState<string[]>([]);
  const [sourceTab, setSourceTab] = useState<'skills' | 'mcp'>('skills');
  const [catalogInput, setCatalogInput] = useState('');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogPage, setCatalogPage] = useState(1);
  const catalog = useQuery({
    ...agentCatalogQuery(
      agentId,
      kind === 'sources' ? 'sources' : 'capabilities',
      kind === 'sources' ? sourceTab : 'capabilities',
      catalogSearch,
      catalogPage,
    ),
    enabled: Boolean(data),
  });
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
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setCatalogSearch(catalogInput.trim());
      setCatalogPage(1);
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [catalogInput]);

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
  const allItems =
    kind === 'sources'
      ? sourceTab === 'skills'
        ? (
            (catalog.data?.catalog.data ?? []) as NonNullable<
              CapabilityCatalog['skills']
            >
          ).map((item) => ({
            id: `skill:${item.id}`,
            label: item.name,
            description: item.description,
            group: 'Skills',
          }))
        : (
            (catalog.data?.catalog.data ?? []) as NonNullable<
              CapabilityCatalog['mcpServers']
            >
          ).map((item) => ({
            id: `mcp:${item.id}`,
            label: item.displayName ?? item.name,
            description: item.description,
            group: 'MCP servers',
          }))
      : (
          (catalog.data?.catalog.data ?? []) as NonNullable<
            CapabilityCatalog['capabilities']
          >
        ).map((item) => ({
          id: `${item.id}:${item.version}`,
          label: item.label,
          description: item.description,
          group: 'Capabilities',
        }));
  const items = allItems ?? [];

  if (
    (kind === 'sources' && sources.isLoading) ||
    (kind === 'capabilities' && capabilities.isLoading)
  )
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
      {kind === 'sources' ? (
        <div className="flex gap-2" role="tablist" aria-label="Source type">
          <Button
            aria-selected={sourceTab === 'skills'}
            role="tab"
            size="sm"
            variant={sourceTab === 'skills' ? 'secondary' : 'ghost'}
            onClick={() => {
              setSourceTab('skills');
              setCatalogPage(1);
            }}
          >
            Skills ({selected.filter((id) => id.startsWith('skill:')).length})
          </Button>
          <Button
            aria-selected={sourceTab === 'mcp'}
            role="tab"
            size="sm"
            variant={sourceTab === 'mcp' ? 'secondary' : 'ghost'}
            onClick={() => {
              setSourceTab('mcp');
              setCatalogPage(1);
            }}
          >
            MCP servers ({selected.filter((id) => id.startsWith('mcp:')).length}
            )
          </Button>
        </div>
      ) : null}
      <TextField
        id={`${kind}-catalog-search`}
        label={`Search ${kind === 'sources' ? (sourceTab === 'skills' ? 'skills' : 'MCP servers') : 'capabilities'}`}
        placeholder="Name"
        value={catalogInput}
        onChange={(event) => setCatalogInput(event.target.value)}
      />
      {kind === 'capabilities' ? (
        <Dialog>
          <DialogTrigger asChild>
            <Button className="w-fit" size="sm" variant="secondary">
              How access works
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>How access works</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-text-secondary">
              Connected sources → Allowed capabilities → Runtime checks
            </p>
            <p className="text-sm text-text-secondary">
              Connected sources provide tools. Allowed capabilities authorize
              actions. Some risky actions may still require approval.
            </p>
          </DialogContent>
        </Dialog>
      ) : null}
      {catalog.isLoading ? (
        <p className="text-sm text-text-secondary">
          Loading available options…
        </p>
      ) : null}
      {catalog.isError ? (
        <div className="flex items-center gap-2 text-sm text-destructive">
          Available options could not be loaded.
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void catalog.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {items.length ? (
        <div className="grid max-h-80 gap-2 overflow-y-auto rounded-md border border-border p-3">
          {items.map((item) => (
            <label
              className="flex cursor-pointer items-start gap-3 rounded p-2 hover:bg-surface-muted"
              key={item.id}
            >
              <Checkbox
                checked={selected.includes(item.id)}
                disabled={disabled}
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
          No available {kind === 'sources' ? 'sources' : 'capabilities'} match
          this search.
        </p>
      )}
      {catalog.data ? (
        <div className="flex justify-end gap-2">
          <Button
            disabled={catalog.data.catalog.page <= 1}
            size="sm"
            variant="secondary"
            onClick={() => setCatalogPage((page) => page - 1)}
          >
            Previous
          </Button>
          <Button
            disabled={!catalog.data.catalog.hasNext}
            size="sm"
            variant="secondary"
            onClick={() => setCatalogPage((page) => page + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
      {save.isError ? (
        <p className="text-sm text-destructive">{save.error.message}</p>
      ) : null}
      <div className="flex justify-end">
        <Button
          disabled={disabled || save.isPending}
          onClick={() => save.mutate()}
        >
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
      .map((id) => {
        const serverId = id.slice(4);
        return (
          current.mcpServers.find((source) => source.id === serverId) ?? {
            id: serverId,
          }
        );
      }),
    tools: current?.tools ?? [],
  };
}

const emptySources: AgentSource = { skills: [], mcpServers: [], tools: [] };
