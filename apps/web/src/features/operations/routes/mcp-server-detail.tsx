import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PackageCheck } from 'lucide-react';
import { useRef, useState } from 'react';

import { titleCaseLabel } from '../../../lib/utils';
import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { agentQueryKeys } from '../../agents/agents-queries';
import { PageState } from '../../../ui/compositions/page-state';
import { RouteTabs } from '../../../ui/compositions/route-tabs';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../ui/primitives/alert-dialog';
import { Button } from '../../../ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import type { McpTab } from '../operations-search';
import { mcpServerQuery, type McpServer } from '../operations-queries';
import { navigationSummaryQuery } from '../../navigation/navigation-summary-query';
import { McpAgentAttachmentsDialog } from './mcp-agent-attachments-dialog';

type BrowserResponse = { error?: { message?: string }; message?: string };

export function McpServerDetailDialog({
  canManage,
  onOpenChange,
  onReplace,
  onStatusChanged,
  onTabChange,
  open,
  server,
  tab,
}: {
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
  onReplace: () => void;
  onStatusChanged: (server: McpServer, message: string) => void;
  onTabChange: (tab: McpTab) => void;
  open: boolean;
  server: McpServer | undefined;
  tab: McpTab;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="grid max-h-[calc(100dvh-32px)] w-[min(760px,calc(100vw-32px))] max-w-none grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden p-0 sm:max-w-none">
        {server ? (
          <McpServerDetailBody
            canManage={canManage}
            onReplace={onReplace}
            onStatusChanged={onStatusChanged}
            onTabChange={onTabChange}
            server={server}
            tab={tab}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function McpServerDetailBody({
  canManage,
  onReplace,
  onStatusChanged,
  onTabChange,
  server,
  tab,
}: {
  canManage: boolean;
  onReplace: () => void;
  onStatusChanged: (server: McpServer, message: string) => void;
  onTabChange: (tab: McpTab) => void;
  server: McpServer;
  tab: McpTab;
}) {
  return (
    <>
      <div className="grid gap-1 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <DialogTitle className="truncate text-sm font-semibold">
            {titleCaseLabel(server.displayName ?? server.name)}
          </DialogTitle>
          <StatusBadge status={server.status} />
        </div>
        <DialogDescription className="line-clamp-2 text-ui text-text-secondary">
          {server.description || 'No description provided.'}
        </DialogDescription>
      </div>
      <RouteTabs
        label="MCP server details"
        onValueChange={onTabChange}
        tabs={[
          { label: 'Overview', value: 'overview' },
          {
            label: 'AI employees',
            value: 'agents',
            count: server.bindings.length,
          },
        ]}
        value={tab}
      />
      <div className="min-h-0 overflow-y-auto p-5">
        {tab === 'overview' ? (
          <OverviewTab
            canManage={canManage}
            onReplace={onReplace}
            onStatusChanged={onStatusChanged}
            server={server}
          />
        ) : null}
        {tab === 'agents' ? (
          <AgentsTab canManage={canManage} server={server} />
        ) : null}
      </div>
    </>
  );
}

function OverviewTab({
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
      if (refreshAfter)
        await Promise.all([
          client.invalidateQueries({ queryKey: mcpServerQuery.queryKey }),
          client.invalidateQueries({
            queryKey: navigationSummaryQuery.queryKey,
          }),
        ]);
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
          'Source reconnected. Attach AI employees explicitly.',
        );
      }
    } finally {
      setReconnecting(false);
    }
  }
  return (
    <div className="grid gap-4 text-sm">
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
          'None declared. AI employees can see this source but cannot call any of its tools until at least one tool name is declared here.'
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
          <Button onClick={() => void diagnose()} size="sm" variant="secondary">
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
              server or discover tools. Any previous AI employee attachments
              remain disabled and must be attached again explicitly.
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
    </div>
  );
}

function AgentsTab({
  canManage,
  server,
}: {
  canManage: boolean;
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
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: mcpServerQuery.queryKey }),
      client.invalidateQueries({ queryKey: navigationSummaryQuery.queryKey }),
    ]);
  async function detach(id: string) {
    setError(undefined);
    try {
      const response = await browserFetch(
        `/ui/api/mcp-servers/${encodeURIComponent(server.id)}/agents/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { ...browserCsrfHeader() },
        },
      );
      if (!response.ok) {
        const data = (await response
          .json()
          .catch(() => null)) as BrowserResponse | null;
        setError(
          data?.message ?? data?.error?.message ?? 'Detach could not be saved.',
        );
        return;
      }
      await Promise.all([
        refresh(),
        client.invalidateQueries({
          queryKey: [...agentQueryKeys.all, 'sources', id],
        }),
      ]);
      setDetachTarget(undefined);
      setNotice('MCP source detached.');
    } catch {
      setError(
        'Detach could not be saved. Check the Gantry service and try again.',
      );
    }
  }
  const manageButton =
    canManage && server.status === 'active' ? (
      <Button onClick={() => setAttachOpen(true)}>Attach AI employees</Button>
    ) : null;
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="m-0 min-w-0 flex-1 text-sm leading-6 text-text-secondary">
          Connected sources make MCP tools visible. They do not grant authority
          to act.
        </p>
        {manageButton ? <div className="shrink-0">{manageButton}</div> : null}
      </div>
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
      {!server.bindings.length ? (
        <PageState
          description="This MCP server is not attached to an AI employee."
          icon={<PackageCheck aria-hidden="true" />}
          kind="empty"
          title="No attached AI employees"
        />
      ) : (
        <ul className="m-0 grid list-none divide-y divide-border overflow-hidden rounded-lg border border-border p-0">
          {server.bindings.map(({ agentId: id, name }) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 bg-surface-muted px-4 py-3"
              key={id}
            >
              <span className="truncate text-sm font-semibold text-text">
                {name}
              </span>
              <div className="flex items-center gap-3">
                <Link
                  className="text-xs font-semibold text-text underline-offset-4 hover:underline"
                  params={{ agentId: id }}
                  search={{ tab: 'access' }}
                  to="/agents/$agentId"
                >
                  Open AI employee access
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
        </ul>
      )}
      <McpAgentAttachmentsDialog
        onAttached={async (count) => {
          await refresh();
          setNotice(
            `MCP source attached to ${count} AI employee${count === 1 ? '' : 's'}. It becomes available on each AI employee’s next run.`,
          );
        }}
        onOpenChange={setAttachOpen}
        open={attachOpen}
        serverId={server.id}
      />
      <AlertDialog
        onOpenChange={(nextOpen) => !nextOpen && setDetachTarget(undefined)}
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
export function transportLabel(server: McpServer) {
  return server.transport === 'stdio_template'
    ? `Local process${server.templateId ? ` · ${server.templateId}` : ''}`
    : server.transport.toUpperCase();
}
