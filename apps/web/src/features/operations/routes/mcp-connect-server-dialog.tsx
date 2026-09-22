import { useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { agentQueryKeys } from '../../agents/agents-queries';
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
import { navigationSummaryQuery } from '../../navigation/navigation-summary-query';
import { McpEligibleAgentsPicker } from './mcp-eligible-agents-picker';

const splitLines = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
type CredentialRef = { name: string; target: 'env' | 'header'; key: string };
type BrowserResponse = { error?: { message?: string }; server?: McpServer };

function returnFocus(ref: RefObject<HTMLElement | null> | undefined) {
  if (ref?.current?.isConnected) ref.current.focus();
}

export function ConnectMcpServerDialog({
  onConnected,
  onOpenChange,
  open,
  replacement,
  returnFocusRef,
}: {
  onConnected: (server: McpServer) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  replacement?: McpServer;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const client = useQueryClient();
  const skipRef = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState<'connect' | 'attach'>('connect');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [connectedServer, setConnectedServer] = useState<McpServer>();
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string>();

  useEffect(() => {
    if (open) return;
    setStep('connect');
    setError(undefined);
    setConnectedServer(undefined);
    setSelected(new Set());
    setAttachError(undefined);
  }, [open]);

  useEffect(() => {
    if (step === 'attach') skipRef.current?.focus();
  }, [step]);

  function changeOpen(next: boolean) {
    if (!next && (saving || attaching)) return;
    onOpenChange(next);
  }

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
      await Promise.all([
        client.invalidateQueries({ queryKey: mcpServerQuery.queryKey }),
        client.invalidateQueries({ queryKey: navigationSummaryQuery.queryKey }),
      ]);
      onConnected(data.server);
      setConnectedServer(data.server);
      setStep('attach');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setError(
        'MCP server could not be connected. Check the Gantry service and try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  function toggle(agentId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  async function finishAttach() {
    if (!connectedServer || selected.size === 0) {
      changeOpen(false);
      return;
    }
    setAttaching(true);
    setAttachError(undefined);
    try {
      const response = await browserFetch(
        `/ui/api/mcp-servers/${encodeURIComponent(connectedServer.id)}/agents`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            ...browserCsrfHeader(),
          },
          body: JSON.stringify({ agentIds: [...selected] }),
        },
      );
      const data = (await response.json().catch(() => null)) as {
        attached?: number;
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setAttachError(
          data?.error?.message ?? 'AI employees could not be attached.',
        );
        return;
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: mcpServerQuery.queryKey }),
        ...[...selected].map((agentId) =>
          client.invalidateQueries({
            queryKey: [...agentQueryKeys.all, 'sources', agentId],
          }),
        ),
      ]);
      changeOpen(false);
    } catch {
      setAttachError(
        'AI employees could not be attached. Check the Gantry service and try again.',
      );
    } finally {
      setAttaching(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus(returnFocusRef);
        }}
        onEscapeKeyDown={(event) => {
          if (saving || attaching) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (saving || attaching) event.preventDefault();
        }}
        showCloseButton={!saving && !attaching}
      >
        {step === 'connect' ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {replacement
                  ? 'Replace MCP configuration'
                  : 'Connect MCP server'}
              </DialogTitle>
              <DialogDescription>
                {replacement
                  ? 'Connect a new reviewed source. The old source remains unchanged and no bindings are copied.'
                  : 'Connect a reviewed source, then choose which AI employees receive it.'}
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
                      Required for AI employees to actually call this
                      source&apos;s tools. Leaving this blank makes the source
                      visible but not executable by any AI employee.
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
                      Review metadata, not an allowlist. The global egress
                      denylist applies.
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
          </>
        ) : (
          <>
            <div className="grid gap-1">
              <DialogTitle className="text-lg font-semibold">
                Attach AI employees
              </DialogTitle>
              <DialogDescription>
                Choose which AI employees can use{' '}
                {connectedServer?.displayName ?? connectedServer?.name}. You can
                skip this and attach it later.
              </DialogDescription>
            </div>
            <div className="grid gap-4">
              <McpEligibleAgentsPicker
                enabled={step === 'attach'}
                onToggle={toggle}
                selected={selected}
                serverId={connectedServer?.id}
              />
              {attachError ? (
                <p
                  aria-live="assertive"
                  className="m-0 text-sm text-danger"
                  role="alert"
                >
                  {attachError}
                </p>
              ) : null}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  disabled={attaching}
                  onClick={() => changeOpen(false)}
                  ref={skipRef}
                  type="button"
                  variant="secondary"
                >
                  Skip
                </Button>
                <Button
                  disabled={attaching}
                  onClick={() => void finishAttach()}
                  type="button"
                >
                  {attaching ? 'Saving…' : 'Done'}
                </Button>
              </div>
            </div>
          </>
        )}
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
