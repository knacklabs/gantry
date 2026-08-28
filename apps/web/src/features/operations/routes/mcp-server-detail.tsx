import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { Panel } from '../../../ui/compositions/panel';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../ui/primitives/alert-dialog';
import { Button } from '../../../ui/primitives/button';
import { mcpServerQuery, type McpServer } from '../operations-queries';
import { navigationSummaryQuery } from '../../navigation/navigation-summary-query';
import { McpAgentAttachmentsDialog } from './mcp-agent-attachments-dialog';

type BrowserResponse = { error?: { message?: string }; message?: string };

export function McpServerDetail({
  canManage,
  onReplace,
  onStatusChanged,
  server,
}: {
  canManage: boolean;
  onReplace: () => void;
  onStatusChanged: (server: McpServer, message: string) => void;
  server: McpServer;
}) {
  const client = useQueryClient();
  const [attachOpen, setAttachOpen] = useState(false);
  const [detachTarget, setDetachTarget] = useState<{
    id: string;
    name: string;
  }>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [disableOpen, setDisableOpen] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const disableTriggerRef = useRef<HTMLButtonElement>(null);
  const disableCancelRef = useRef<HTMLButtonElement>(null);
  const reconnectTriggerRef = useRef<HTMLButtonElement>(null);
  const reconnectCancelRef = useRef<HTMLButtonElement>(null);
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: mcpServerQuery.queryKey }),
      client.invalidateQueries({ queryKey: navigationSummaryQuery.queryKey }),
    ]);
  async function request(
    path: string,
    method: string,
    body?: unknown,
    refreshAfter = true,
  ) {
    setError(undefined);
    setNotice(undefined);
    try {
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
        setError(
          data?.message ??
            data?.error?.message ??
            'This change could not be saved.',
        );
        return false;
      }
      if (refreshAfter) await refresh();
      return data?.message;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setError(
        'This change could not be saved. Check the Gantry service and try again.',
      );
      return false;
    }
  }
  async function diagnose() {
    const result = await request(
      `/ui/api/mcp-servers/${encodeURIComponent(server.id)}/test`,
      'POST',
      {},
    );
    if (result !== false) setNotice(result || 'Diagnostic completed.');
  }
  async function disable() {
    setDisabling(true);
    try {
      const result = await request(
        `/ui/api/mcp-servers/${encodeURIComponent(server.id)}/disable`,
        'POST',
        {},
        false,
      );
      if (result !== false) {
        setDisableOpen(false);
        onStatusChanged(server, 'Server disabled.');
      }
    } finally {
      setDisabling(false);
    }
  }
  async function reconnect() {
    setReconnecting(true);
    try {
      const result = await request(
        `/ui/api/mcp-servers/${encodeURIComponent(server.id)}/reconnect`,
        'POST',
        {},
        false,
      );
      if (result !== false) {
        setReconnectOpen(false);
        onStatusChanged(
          server,
          'Source reconnected. Attach agents explicitly.',
        );
      }
    } finally {
      setReconnecting(false);
    }
  }
  async function detach(id: string) {
    const result = await request(
      `/ui/api/mcp-servers/${encodeURIComponent(server.id)}/agents/${encodeURIComponent(id)}`,
      'DELETE',
    );
    if (result !== false) {
      setDetachTarget(undefined);
      setNotice('MCP source detached.');
    }
  }
  return (
    <div className="grid gap-4">
      <Panel
        title={server.displayName ?? server.name}
        action={
          <span
            className={
              server.status === 'active'
                ? 'text-status-success'
                : 'text-text-secondary'
            }
          >
            {server.status === 'active' ? 'Active' : 'Disabled'}
          </span>
        }
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
          <Definition
            label="Allowed tool names"
            value={
              server.allowedToolPatterns.join(', ') ||
              'All discovered tools are visible. This does not grant execution authority.'
            }
          />
          {server.credentialRefs.length ? (
            <Definition
              label="Credential mappings"
              value={server.credentialRefs
                .map((ref) => `${ref.name} → ${ref.target}:${ref.key}`)
                .join(', ')}
            />
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
                Validate configuration
              </Button>
              <Button onClick={onReplace} size="sm" variant="secondary">
                Replace configuration
              </Button>
              <Button
                onClick={() => setDisableOpen(true)}
                ref={disableTriggerRef}
                size="sm"
                variant="secondary"
              >
                Disable server
              </Button>
            </div>
          ) : null}
          {canManage && server.status === 'disabled' ? (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => setReconnectOpen(true)}
                ref={reconnectTriggerRef}
                size="sm"
                variant="secondary"
              >
                Revalidate & reconnect
              </Button>
              <Button onClick={onReplace} size="sm" variant="secondary">
                Replace configuration
              </Button>
            </div>
          ) : null}
        </div>
      </Panel>
      <AlertDialog onOpenChange={setDisableOpen} open={disableOpen}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            disableTriggerRef.current?.focus();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            disableCancelRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Disable MCP server?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops future materialization for{' '}
              {server.displayName ?? server.name}. Its definition and bindings
              remain available for review.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="m-0 text-sm text-danger">{error}</p> : null}
          <AlertDialogFooter>
            <Button
              disabled={disabling}
              onClick={() => setDisableOpen(false)}
              ref={disableCancelRef}
              variant="secondary"
            >
              Cancel
            </Button>
            <Button
              disabled={disabling}
              onClick={() => void disable()}
              variant="destructive"
            >
              {disabling ? 'Disabling…' : 'Disable server'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog onOpenChange={setReconnectOpen} open={reconnectOpen}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            reconnectTriggerRef.current?.focus();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            reconnectCancelRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Revalidate and reconnect?</AlertDialogTitle>
            <AlertDialogDescription>
              Gantry will recheck the stored reviewed configuration for{' '}
              {server.displayName ?? server.name}. It will not contact the
              server or discover tools. Any previous agent attachments remain
              disabled and must be attached again explicitly.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="m-0 text-sm text-danger">{error}</p> : null}
          <AlertDialogFooter>
            <Button
              disabled={reconnecting}
              onClick={() => setReconnectOpen(false)}
              ref={reconnectCancelRef}
              variant="secondary"
            >
              Cancel
            </Button>
            <Button disabled={reconnecting} onClick={() => void reconnect()}>
              {reconnecting ? 'Reconnecting…' : 'Reconnect source'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Panel
        title="Attached agents"
        description="Connected sources make MCP tools visible. They do not grant authority to act."
        action={
          canManage && server.status === 'active' ? (
            <Button onClick={() => setAttachOpen(true)} size="sm">
              Attach agents
            </Button>
          ) : null
        }
      >
        <div className="grid">
          <ul className="m-0 grid max-h-64 list-none divide-y divide-border overflow-y-auto p-0">
            {server.bindings.map(({ agentId: id, name, binding }) => (
              <li
                className="flex items-center justify-between gap-3 p-4"
                key={id}
              >
                <div>
                  <p className="m-0 font-medium">{name}</p>
                  <p className="m-0 text-xs text-text-secondary">
                    Source attached
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    className="text-xs font-medium text-text underline-offset-4 hover:underline"
                    params={{ agentId: id }}
                    search={{ tab: 'access' }}
                    to="/agents/$agentId"
                  >
                    Open agent
                  </Link>
                  {canManage ? (
                    <Button
                      onClick={() => setDetachTarget({ id, name })}
                      size="sm"
                      variant="ghost"
                    >
                      Detach
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
            {server.bindings.length === 0 ? (
              <li className="p-4 text-sm text-text-secondary">
                No agents are attached to this MCP server.
              </li>
            ) : null}
          </ul>
        </div>
      </Panel>
      <McpAgentAttachmentsDialog
        open={attachOpen}
        onOpenChange={setAttachOpen}
        serverId={server.id}
        onAttached={async (count) => {
          await refresh();
          setNotice(
            `MCP source attached to ${count} agent${count === 1 ? '' : 's'}. It becomes available on each agent’s next run.`,
          );
        }}
      />
      <AlertDialog
        onOpenChange={(open) => !open && setDetachTarget(undefined)}
        open={Boolean(detachTarget)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Detach {server.displayName ?? server.name} from{' '}
              {detachTarget?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the source from future runs. Existing capability
              policy is unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              onClick={() => setDetachTarget(undefined)}
              variant="secondary"
            >
              Cancel
            </Button>
            <Button
              onClick={() => detachTarget && void detach(detachTarget.id)}
              variant="destructive"
            >
              Detach source
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-text-secondary">{label}</dt>
      <dd className="m-0 break-words text-text">{value}</dd>
    </div>
  );
}
function Definition({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-text">{label}</p>
      <p className="m-0 text-xs text-text-secondary">{value}</p>
    </div>
  );
}
function transportLabel(server: McpServer) {
  return server.transport === 'stdio_template'
    ? `Local process${server.templateId ? ` · ${server.templateId}` : ''}`
    : server.transport.toUpperCase();
}
