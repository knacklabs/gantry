import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { Button } from '../../../ui/primitives/button';
import {
  agentCapabilitiesQuery,
  agentCatalogQuery,
  agentQueryKeys,
  agentSourcesQuery,
  type AgentSource,
  type CapabilityCatalog,
} from '../agents-queries';
import { AgentSetupCatalog } from './agent-setup-catalog';

type SetupKind = 'sources' | 'capabilities';

export function AgentSetupManager({
  agentId,
  kind,
  onSaved,
  formId,
  onSavingChange,
}: {
  agentId: string;
  kind: SetupKind;
  onSaved: () => void;
  formId: string;
  onSavingChange: (saving: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const sources = useQuery({
    ...agentSourcesQuery(agentId),
    enabled: true,
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
        ...sourceCurrent.skills.map((item) => item.id),
        ...sourceCurrent.mcpServers.map((item) => item.id),
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
    onSuccess: async () => {
      await Promise.all([
        queryClient.refetchQueries({
          queryKey: agentSourcesQuery(agentId).queryKey,
          type: 'active',
        }),
        queryClient.refetchQueries({
          queryKey: agentCapabilitiesQuery(agentId).queryKey,
          type: 'active',
        }),
        queryClient.invalidateQueries({
          queryKey: agentQueryKeys.all,
          refetchType: 'active',
        }),
      ]);
      onSaved();
    },
  });
  useEffect(() => {
    onSavingChange(save.isPending);
    return () => onSavingChange(false);
  }, [onSavingChange, save.isPending]);
  const allItems =
    kind === 'sources'
      ? sourceTab === 'skills'
        ? (
            (catalog.data?.catalog.data ?? []) as NonNullable<
              CapabilityCatalog['skills']
            >
          ).map((item) => ({
            id: item.id,
            label: item.name,
            description: item.description,
            group: 'Skills',
            status: item.status,
          }))
        : (
            (catalog.data?.catalog.data ?? []) as NonNullable<
              CapabilityCatalog['mcpServers']
            >
          ).map((item) => ({
            id: item.id,
            label: item.displayName ?? item.name,
            description: item.description,
            group: 'MCP servers',
            status: item.status,
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
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate();
  }
  const content = (
    <>
      <AgentSetupCatalog
        failed={catalog.isError}
        hasNext={catalog.data?.catalog.hasNext}
        items={items}
        kind={kind}
        loading={catalog.isLoading}
        page={catalog.data?.catalog.page}
        search={catalogInput}
        selected={selected}
        sourceSummary={`${sourceCurrent?.skills.length ?? 0} skills · ${sourceCurrent?.mcpServers.length ?? 0} MCP servers`}
        sourceTab={sourceTab}
        onPageChange={setCatalogPage}
        onRetry={() => void catalog.refetch()}
        onSearchChange={setCatalogInput}
        onClearSelections={() => setSelected([])}
        onSourceTabChange={(tab) => {
          setSourceTab(tab);
          setCatalogPage(1);
        }}
        onToggle={(id) =>
          setSelected((value) =>
            value.includes(id)
              ? value.filter((selectedId) => selectedId !== id)
              : [...value, id],
          )
        }
      />
      {save.isError ? (
        <p className="text-sm text-destructive">{save.error.message}</p>
      ) : null}
    </>
  );
  return (
    <form id={formId} className="grid min-h-0 gap-4" onSubmit={submit}>
      {content}
    </form>
  );
}

function nextSources(selected: string[], current: AgentSource): AgentSource {
  return {
    skills: selected
      .filter((id) => id.startsWith('skill:'))
      .map((id) => ({ id })),
    mcpServers: selected
      .filter((id) => id.startsWith('mcp:'))
      .map((id) => {
        const source = current.mcpServers.find((item) => item.id === id);
        return {
          id,
          ...(source?.tools?.length ? { tools: source.tools } : {}),
        };
      }),
    tools: current?.tools ?? [],
  };
}

const emptySources: AgentSource = { skills: [], mcpServers: [], tools: [] };
