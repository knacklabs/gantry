import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
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
  onBack,
  disabled = false,
  formId,
  onSavingChange,
}: {
  agentId: string;
  kind: SetupKind;
  onSaved?: () => void;
  onBack?: () => void;
  disabled?: boolean;
  formId?: string;
  onSavingChange?: (saving: boolean) => void;
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
  useEffect(() => {
    onSavingChange?.(save.isPending);
    return () => onSavingChange?.(false);
  }, [onSavingChange, save.isPending]);
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
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate();
  }
  const content = (
    <>
      <AgentSetupCatalog
        disabled={disabled}
        failed={catalog.isError}
        hasNext={catalog.data?.catalog.hasNext}
        items={items}
        kind={kind}
        loading={catalog.isLoading}
        page={catalog.data?.catalog.page}
        search={catalogInput}
        selected={selected}
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
  if (formId)
    return (
      <form id={formId} className="grid min-h-0 gap-4" onSubmit={submit}>
        {content}
      </form>
    );
  return (
    <div className="grid gap-4">
      {content}
      <div className="flex items-center justify-between border-t border-border pt-4">
        {onBack ? (
          <Button type="button" variant="secondary" onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button
          disabled={disabled || save.isPending}
          type="button"
          onClick={() => save.mutate()}
        >
          <Save size={15} aria-hidden="true" />
          {save.isPending ? 'Saving…' : 'Continue'}
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
