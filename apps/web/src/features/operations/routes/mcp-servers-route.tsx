import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { TextField } from '../../../ui/compositions/text-field';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import { Input } from '../../../ui/primitives/input';
import { SelectField } from '../../../ui/compositions/select-field';
import { Textarea } from '../../../ui/primitives/textarea';
import {
  mcpServerQuery,
  type McpInventory,
  type McpServer,
} from '../operations-queries';

const splitLines = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

type BrowserResponse = {
  error?: { message?: string };
  message?: string;
};

function browserMessage(data: BrowserResponse | null): string | undefined {
  return data?.message ?? data?.error?.message;
}

type CredentialRef = {
  name: string;
  target: 'env' | 'header';
  key: string;
};

export function McpServersRoute() {
  const query = useQuery(mcpServerQuery);
  const [selectedId, setSelectedId] = useState<string>();
  const [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all');
  const [search, setSearch] = useState('');
  const [connectOpen, setConnectOpen] = useState(false);
  const [replacement, setReplacement] = useState<McpServer>();
  const inventory = query.data;
  const servers = useMemo(
    () =>
      (inventory?.servers ?? []).filter(
        (server) =>
          (status === 'all' || server.status === status) &&
          `${server.name} ${server.displayName ?? ''} ${server.transport}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [inventory?.servers, search, status],
  );
  const selected =
    servers.find((server) => server.id === selectedId) ?? servers[0];
  const canManage = inventory?.role === 'administrator';

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Configure"
        title="MCP servers"
        description="Connect reviewed source inventory. Source access never grants tool execution authority."
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid flex-1 gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
          <TextField
            id="mcp-search"
            label="Search servers"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name or transport"
          />
          <SelectField
            label="Status"
            value={status}
            onValueChange={setStatus}
            options={[
              { value: 'all', label: 'All servers' },
              { value: 'active', label: 'Active' },
              { value: 'disabled', label: 'Disabled' },
            ]}
          />
        </div>
        {canManage ? (
          <Button onClick={() => setConnectOpen(true)}>
            Connect MCP server
          </Button>
        ) : null}
      </div>
      {query.isLoading ? (
        <Panel>
          <p className="p-4 text-sm text-text-muted">Loading MCP servers…</p>
        </Panel>
      ) : null}
      {query.isError ? (
        <Panel>
          <p className="p-4 text-sm text-danger">
            MCP servers could not be loaded.
          </p>
        </Panel>
      ) : null}
      {!query.isLoading && !query.isError ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.4fr)]">
          <Panel title="Server inventory">
            <ul className="m-0 grid list-none divide-y divide-border p-0">
              {servers.map((server) => (
                <li key={server.id}>
                  <button
                    className={`grid w-full gap-1 p-4 text-left hover:bg-surface-muted ${selected?.id === server.id ? 'bg-surface-muted' : ''}`}
                    onClick={() => setSelectedId(server.id)}
                    type="button"
                  >
                    <span className="flex items-center justify-between gap-2 font-medium">
                      <span>{server.displayName ?? server.name}</span>
                      <StatusBadge status={server.status} />
                    </span>
                    <span className="text-xs text-text-muted">
                      {transportLabel(server)} · {server.bindings.length} agent
                      {server.bindings.length === 1 ? '' : 's'}
                    </span>
                  </button>
                </li>
              ))}
              {servers.length === 0 ? (
                <li className="p-4 text-sm text-text-muted">
                  No MCP servers match these filters.
                </li>
              ) : null}
            </ul>
          </Panel>
          {selected ? (
            <ServerDetail
              canManage={Boolean(canManage)}
              inventory={inventory!}
              onReplace={() => {
                setReplacement(selected);
                setConnectOpen(true);
              }}
              server={selected}
            />
          ) : (
            <Panel>
              <p className="p-4 text-sm text-text-muted">
                Select a server to inspect its source definition.
              </p>
            </Panel>
          )}
        </div>
      ) : null}
      <ConnectDialog
        key={replacement?.id ?? 'new'}
        open={connectOpen}
        replacement={replacement}
        onOpenChange={(next) => {
          setConnectOpen(next);
          if (!next) setReplacement(undefined);
        }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: McpServer['status'] }) {
  return (
    <Badge variant={status === 'active' ? 'success' : 'neutral'}>
      {status === 'active' ? 'Active' : 'Disabled'}
    </Badge>
  );
}

function transportLabel(server: McpServer) {
  return server.transport === 'stdio_template'
    ? `Local process${server.templateId ? ` · ${server.templateId}` : ''}`
    : server.transport.toUpperCase();
}

function ServerDetail({
  canManage,
  inventory,
  onReplace,
  server,
}: {
  canManage: boolean;
  inventory: McpInventory;
  onReplace: () => void;
  server: McpServer;
}) {
  const client = useQueryClient();
  const [agentId, setAgentId] = useState('');
  const [patterns, setPatterns] = useState('');
  const [required, setRequired] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const refresh = () =>
    client.invalidateQueries({ queryKey: mcpServerQuery.queryKey });
  async function request(path: string, method: string, body?: unknown) {
    setError(undefined);
    setNotice(undefined);
    const response = await browserFetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...browserCsrfHeader(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await response
      .json()
      .catch(() => null)) as BrowserResponse | null;
    if (!response.ok) {
      setError(browserMessage(data) ?? 'This change could not be saved.');
      return false;
    }
    await refresh();
    return browserMessage(data);
  }
  async function diagnose() {
    const message = await request(
      `/ui/api/mcp-servers/${encodeURIComponent(server.id)}/test`,
      'POST',
      {},
    );
    if (message !== false) setNotice(message || 'Diagnostic completed.');
  }
  async function disable() {
    if (
      !window.confirm(
        `Disable ${server.displayName ?? server.name}? Future source materialization will stop.`,
      )
    )
      return;
    const result = await request(
      `/ui/api/mcp-servers/${encodeURIComponent(server.id)}/disable`,
      'POST',
      {},
    );
    if (result !== false) setNotice('Server disabled.');
  }
  async function bind(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agentId) return;
    const result = await request(
      `/ui/api/mcp-servers/${encodeURIComponent(server.id)}/agents/${encodeURIComponent(agentId)}`,
      'PUT',
      { required, allowedToolPatterns: splitLines(patterns) },
    );
    if (result !== false) {
      setNotice('Agent binding saved.');
      setPatterns('');
    }
  }
  async function detach(id: string) {
    const result = await request(
      `/ui/api/mcp-servers/${encodeURIComponent(server.id)}/agents/${encodeURIComponent(id)}`,
      'DELETE',
    );
    if (result !== false) setNotice('Agent detached.');
  }
  const unboundAgents = inventory.agents.filter(
    (agent) => !server.bindings.some((binding) => binding.agentId === agent.id),
  );
  return (
    <div className="grid gap-4">
      <Panel
        title={server.displayName ?? server.name}
        action={<StatusBadge status={server.status} />}
      >
        <div className="grid gap-4 p-4 text-sm">
          <p className="m-0 text-text-secondary">
            {server.description || 'No description provided.'}
          </p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label="Transport" value={transportLabel(server)} />
            <Detail label="Risk" value={server.riskClass} />
            <Detail
              label="Endpoint"
              value={server.endpoint ?? server.args?.join(' ') ?? 'Not exposed'}
            />
            <Detail
              label="Network destinations"
              value={server.networkHosts.join(', ') || 'None declared'}
            />
          </dl>
          <div>
            <p className="mb-1 text-xs font-semibold text-text">
              Allowed tool names
            </p>
            <p className="m-0 text-xs text-text-muted">
              {server.allowedToolPatterns.join(', ') ||
                'All discovered tools are visible. This does not grant execution authority.'}
            </p>
          </div>
          {server.credentialRefs.length ? (
            <div>
              <p className="mb-1 text-xs font-semibold text-text">
                Credential mappings
              </p>
              <p className="m-0 text-xs text-text-muted">
                {server.credentialRefs
                  .map((ref) => `${ref.name} → ${ref.target}:${ref.key}`)
                  .join(', ')}
              </p>
            </div>
          ) : null}
          {notice ? (
            <p aria-live="polite" className="m-0 text-sm text-status-success">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p aria-live="polite" className="m-0 text-sm text-danger">
              {error}
            </p>
          ) : null}
          {canManage && server.status === 'active' ? (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void diagnose()}
                size="sm"
                variant="secondary"
              >
                Run diagnostic
              </Button>
              <Button onClick={onReplace} size="sm" variant="secondary">
                Replace configuration
              </Button>
              <Button
                onClick={() => void disable()}
                size="sm"
                variant="destructive"
              >
                Disable server
              </Button>
            </div>
          ) : null}
        </div>
      </Panel>
      <Panel
        title="Attached agents"
        description="Bindings narrow source visibility; they never grant tool execution authority."
      >
        <div className="grid divide-y divide-border">
          <ul className="m-0 grid list-none p-0">
            {server.bindings.map(({ agentId: id, name, binding }) => (
              <li
                className="flex items-center justify-between gap-3 p-4"
                key={id}
              >
                <div>
                  <p className="m-0 font-medium">{name}</p>
                  <p className="m-0 text-xs text-text-muted">
                    {binding.required ? 'Required at startup' : 'Optional'} ·{' '}
                    {binding.allowedToolPatterns.join(', ') ||
                      'Inherits source scope'}
                  </p>
                </div>
                {canManage ? (
                  <Button
                    onClick={() => void detach(id)}
                    size="sm"
                    variant="ghost"
                  >
                    Detach
                  </Button>
                ) : null}
              </li>
            ))}
            {server.bindings.length === 0 ? (
              <li className="p-4 text-sm text-text-muted">
                No agents are attached.
              </li>
            ) : null}
          </ul>
          {canManage && server.status === 'active' && unboundAgents.length ? (
            <form
              className="grid gap-3 border-t border-border p-4"
              onSubmit={bind}
            >
              <SelectField
                label="Attach agent"
                value={agentId}
                onValueChange={setAgentId}
                options={[
                  { value: '', label: 'Choose an agent' },
                  ...unboundAgents.map((agent) => ({
                    value: agent.id,
                    label: agent.name,
                  })),
                ]}
              />
              <label className="grid gap-1.5 text-xs font-semibold">
                Narrow allowed tool names (optional)
                <Textarea
                  value={patterns}
                  onChange={(event) => setPatterns(event.target.value)}
                  placeholder="read_*"
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Input
                  checked={required}
                  className="size-4"
                  onChange={(event) => setRequired(event.target.checked)}
                  type="checkbox"
                />
                Required at startup
              </label>
              <div>
                <Button disabled={!agentId} size="sm" type="submit">
                  Attach agent
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-text-muted">{label}</dt>
      <dd className="m-0 break-words text-text">{value}</dd>
    </div>
  );
}

function ConnectDialog({
  open,
  onOpenChange,
  replacement,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  replacement?: McpServer;
}) {
  const client = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [kind, setKind] = useState<'remote' | 'local'>(
    replacement?.transport === 'stdio_template' ? 'local' : 'remote',
  );
  const [transport, setTransport] = useState<'http' | 'sse'>(
    replacement?.transport === 'sse' ? 'sse' : 'http',
  );
  const [riskClass, setRiskClass] = useState<'low' | 'medium' | 'high'>(
    replacement?.riskClass ?? 'medium',
  );
  const [credentialRefs, setCredentialRefs] = useState<CredentialRef[]>(
    replacement?.credentialRefs ?? [],
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '');
    const config =
      kind === 'remote'
        ? { transport, url: String(form.get('url') ?? '') }
        : {
            transport: 'stdio_template' as const,
            templateId: 'npx-package',
            args: [String(form.get('package') ?? '')],
          };
    const response = await browserFetch('/ui/api/mcp-servers', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...browserCsrfHeader() },
      body: JSON.stringify({
        name,
        transport: config.transport,
        config,
        allowedToolPatterns: splitLines(String(form.get('tools') ?? '')),
        credentialRefs: credentialRefs.filter((ref) => ref.name && ref.key),
        networkHosts: splitLines(String(form.get('networkHosts') ?? '')),
        riskClass,
        ...(kind === 'local'
          ? { sandboxProfileId: String(form.get('sandboxProfileId') ?? '') }
          : {}),
      }),
    });
    const data = (await response
      .json()
      .catch(() => null)) as BrowserResponse | null;
    setSaving(false);
    if (!response.ok) {
      setError(browserMessage(data) ?? 'MCP server could not be connected.');
      return;
    }
    await client.invalidateQueries({ queryKey: mcpServerQuery.queryKey });
    onOpenChange(false);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {replacement ? 'Replace MCP configuration' : 'Connect MCP server'}
          </DialogTitle>
          <DialogDescription>
            {replacement
              ? 'Connect a new reviewed source. The old source stays active and no bindings are copied.'
              : 'Connect a reviewed source. This does not grant an agent authority to execute its tools.'}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="flex gap-2">
            <Button
              onClick={() => setKind('remote')}
              type="button"
              variant={kind === 'remote' ? 'default' : 'secondary'}
            >
              Remote server
            </Button>
            <Button
              onClick={() => {
                setKind('local');
                setCredentialRefs(
                  credentialRefs.map((ref) => ({ ...ref, target: 'env' })),
                );
              }}
              type="button"
              variant={kind === 'local' ? 'default' : 'secondary'}
            >
              Local process
            </Button>
          </div>
          <TextField
            id="mcp-name"
            label="Source name"
            name="name"
            required
            defaultValue={
              replacement ? `${replacement.name}-replacement` : undefined
            }
            placeholder="github"
          />
          {kind === 'remote' ? (
            <>
              <SelectField
                label="Protocol"
                value={transport}
                onValueChange={setTransport}
                options={[
                  { value: 'http', label: 'HTTP' },
                  { value: 'sse', label: 'SSE' },
                ]}
              />
              <TextField
                id="mcp-url"
                label="Server URL"
                name="url"
                required
                defaultValue={replacement?.endpoint}
                placeholder="https://example.com/mcp"
              />
            </>
          ) : (
            <>
              <TextField
                id="mcp-package"
                label="npm package (npx)"
                name="package"
                required
                defaultValue={replacement?.args?.[0]}
                placeholder="@modelcontextprotocol/server-github"
                hint="Only a safe registry package name is accepted."
              />
              <TextField
                id="mcp-sandbox"
                label="Sandbox profile"
                name="sandboxProfileId"
                required
                defaultValue={replacement?.sandboxProfileId}
                placeholder="mcp-stdio"
              />
            </>
          )}
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Advanced
            </summary>
            <div className="mt-4 grid gap-4">
              <label className="grid gap-1.5 text-xs font-semibold">
                Allowed tool names (optional)
                <Textarea
                  defaultValue={replacement?.allowedToolPatterns.join('\n')}
                  name="tools"
                  placeholder={'read_*\nsearch'}
                />
                <span className="font-normal text-text-muted">
                  Limits source visibility; it never grants execution authority.
                </span>
              </label>
              <CredentialMappings
                kind={kind}
                refs={credentialRefs}
                setRefs={setCredentialRefs}
              />
              <SelectField
                label="Source risk"
                value={riskClass}
                onValueChange={setRiskClass}
                options={[
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'high', label: 'High' },
                ]}
              />
              <label className="grid gap-1.5 text-xs font-semibold">
                Expected network destinations (optional)
                <Textarea
                  defaultValue={replacement?.networkHosts.join('\n')}
                  name="networkHosts"
                  placeholder="api.example.com:443"
                />
                <span className="font-normal text-text-muted">
                  Review metadata, not an allowlist. The global egress denylist
                  applies.
                </span>
              </label>
            </div>
          </details>
          {error ? (
            <p aria-live="polite" className="m-0 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter showCloseButton>
            <Button disabled={saving} type="submit">
              {saving ? 'Connecting…' : 'Connect server'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CredentialMappings({
  kind,
  refs,
  setRefs,
}: {
  kind: 'remote' | 'local';
  refs: CredentialRef[];
  setRefs: (refs: CredentialRef[]) => void;
}) {
  const update = (index: number, patch: Partial<CredentialRef>) =>
    setRefs(
      refs.map((ref, current) =>
        current === index ? { ...ref, ...patch } : ref,
      ),
    );
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <p className="m-0 text-xs font-semibold">Credentials (optional)</p>
        <Button
          onClick={() =>
            setRefs([...refs, { name: '', target: 'env', key: '' }])
          }
          size="sm"
          type="button"
          variant="secondary"
        >
          Add credential mapping
        </Button>
      </div>
      {refs.map((ref, index) => (
        <div
          className="grid gap-2 sm:grid-cols-[1fr_130px_1fr_auto]"
          key={index}
        >
          <Input
            aria-label="Credential name"
            onChange={(event) => update(index, { name: event.target.value })}
            placeholder="Credential name"
            value={ref.name}
          />
          <select
            aria-label="Credential target"
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
            disabled={kind === 'local'}
            onChange={(event) =>
              update(index, {
                target: event.target.value as CredentialRef['target'],
              })
            }
            value={ref.target}
          >
            <option value="env">Environment</option>
            <option value="header">HTTP header</option>
          </select>
          <Input
            aria-label="Credential target key"
            onChange={(event) => update(index, { key: event.target.value })}
            placeholder={ref.target === 'env' ? 'API_TOKEN' : 'Authorization'}
            value={ref.key}
          />
          <Button
            aria-label="Remove credential mapping"
            onClick={() =>
              setRefs(refs.filter((_, current) => current !== index))
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            Remove
          </Button>
        </div>
      ))}
      <p className="m-0 text-xs text-text-muted">
        Select an existing credential name; secret values are never entered
        here.
      </p>
    </div>
  );
}
