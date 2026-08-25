import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { SelectField } from '../../../ui/compositions/select-field';
import { TextField } from '../../../ui/compositions/text-field';
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
import { Textarea } from '../../../ui/primitives/textarea';
import { mcpServerQuery, type McpServer } from '../operations-queries';

const splitLines = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
type CredentialRef = { name: string; target: 'env' | 'header'; key: string };
type BrowserResponse = { error?: { message?: string }; server?: McpServer };

export function ConnectMcpServerDialog({
  onConnected,
  onOpenChange,
  open,
  replacement,
}: {
  onConnected: (server: McpServer) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
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
    setError(undefined);
    if (credentialRefs.some((ref) => !ref.name || !ref.key)) {
      setError('Complete or remove each credential mapping.');
      return;
    }
    setSaving(true);
    try {
      const form = new FormData(event.currentTarget);
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
        headers: {
          'content-type': 'application/json',
          ...browserCsrfHeader(),
        },
        body: JSON.stringify({
          name: String(form.get('name') ?? ''),
          transport: config.transport,
          config,
          allowedToolPatterns: splitLines(String(form.get('tools') ?? '')),
          credentialRefs,
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
      if (!response.ok || !data?.server) {
        setError(data?.error?.message ?? 'MCP server could not be connected.');
        return;
      }
      await client.invalidateQueries({ queryKey: mcpServerQuery.queryKey });
      onConnected(data.server);
      onOpenChange(false);
    } catch {
      setError(
        'MCP server could not be connected. Check the Gantry service and try again.',
      );
    } finally {
      setSaving(false);
    }
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
              HTTP/SSE endpoint
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
          <div className="contents" key={kind}>
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
                  defaultValue={
                    replacement?.endpointHasParameters
                      ? undefined
                      : replacement?.endpoint
                  }
                  placeholder="https://example.com/mcp"
                  hint={
                    replacement?.endpointHasParameters
                      ? 'This endpoint has private URL parameters. Re-enter them to replace it.'
                      : 'Public endpoints require HTTPS. HTTP is allowed only for a local loopback endpoint.'
                  }
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
                  hint="Local-process sources run only with worker agents."
                />
              </>
            )}
          </div>
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
                  defaultValue={
                    replacement?.transport === 'stdio_template'
                      ? replacement.networkHosts.join('\n')
                      : undefined
                  }
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
        Enter an existing credential name; secret values are never entered here.
      </p>
    </div>
  );
}
