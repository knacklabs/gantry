import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowRight, PlugZap, SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { titleCaseLabel } from '../../../lib/utils';
import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { SelectField } from '../../../ui/compositions/select-field';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
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
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../../../ui/primitives/card';
import { mcpServerQuery, type McpServer } from '../operations-queries';
import { navigationSummaryQuery } from '../../navigation/navigation-summary-query';
import { ConnectMcpServerDialog } from './mcp-connect-server-dialog';
import { McpServerDetailDialog, transportLabel } from './mcp-server-detail';

const SOURCE_LABELS: Record<McpServer['createdSource'], string> = {
  admin: 'Admin configured',
  agent_request: 'Requested by an AI employee',
};

const CARD_PAGE_SIZE = 24;

export function filterMcpServers(
  servers: readonly McpServer[],
  query: string,
  status: 'all' | 'active' | 'disabled',
): McpServer[] {
  const normalized = query.trim().toLowerCase();
  return servers.filter(
    (server) =>
      (status === 'all' || server.status === status) &&
      (!normalized ||
        `${server.name} ${server.displayName ?? ''} ${server.transport}`
          .toLowerCase()
          .includes(normalized)),
  );
}

export function resolveMcpServerSelection(
  visibleServers: readonly McpServer[],
  requestedId: string | undefined,
): McpServer | undefined {
  if (!requestedId) return undefined;
  return visibleServers.find((server) => server.id === requestedId);
}

export function McpServersRoute() {
  const search = useSearch({ from: '/mcp-servers' });
  const navigate = useNavigate({ from: '/mcp-servers' });
  const query = useQuery(mcpServerQuery);
  const client = useQueryClient();
  const receiptRef = useRef<HTMLParagraphElement>(null);
  const disableReplacementTriggerRef = useRef<HTMLButtonElement>(null);
  const disableReplacementCancelRef = useRef<HTMLButtonElement>(null);
  const connectTriggerRef = useRef<HTMLButtonElement>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [replacement, setReplacement] = useState<McpServer>();
  const [receipt, setReceipt] = useState<{
    message: string;
    replacement?: McpServer;
  }>();
  const [receiptError, setReceiptError] = useState<string>();
  const [disableReplacementOpen, setDisableReplacementOpen] = useState(false);
  const [disablingReplacement, setDisablingReplacement] = useState(false);

  const inventory = query.data;
  const canManage = inventory?.role === 'administrator';
  const visibleServers = useMemo(
    () => filterMcpServers(inventory?.servers ?? [], search.q, search.status),
    [inventory?.servers, search.q, search.status],
  );
  const selectedServer = resolveMcpServerSelection(
    visibleServers,
    search.server,
  );

  const [visibleCount, setVisibleCount] = useState(CARD_PAGE_SIZE);
  useEffect(() => {
    setVisibleCount(CARD_PAGE_SIZE);
  }, [search.q, search.status]);
  const cards = visibleServers.slice(0, visibleCount);
  const hasMoreCards = visibleCount < visibleServers.length;
  const loadMoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMoreCards) return;
    const sentinel = loadMoreRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setVisibleCount((current) => current + CARD_PAGE_SIZE);
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreCards]);

  const detailOpen = Boolean(selectedServer);

  function closeDetail() {
    void navigate({
      search: (previous) => ({ ...previous, server: undefined }),
    });
  }

  async function disableReplacement() {
    if (!receipt?.replacement) return;
    const old = receipt.replacement;
    setReceiptError(undefined);
    setDisablingReplacement(true);
    try {
      const response = await browserFetch(
        `/ui/api/mcp-servers/${encodeURIComponent(old.id)}/disable`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            ...browserCsrfHeader(),
          },
          body: JSON.stringify({}),
        },
      );
      if (!response.ok) {
        setReceiptError(
          'The old source could not be disabled. It remains active.',
        );
        return;
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: mcpServerQuery.queryKey }),
        client.invalidateQueries({ queryKey: navigationSummaryQuery.queryKey }),
      ]);
      setDisableReplacementOpen(false);
      setReceipt({
        message: 'Old source disabled. The replacement remains connected.',
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setReceiptError(
        'The old source could not be disabled. It remains active.',
      );
    } finally {
      setDisablingReplacement(false);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        action={
          canManage ? (
            <Button
              onClick={() => setConnectOpen(true)}
              ref={connectTriggerRef}
            >
              Connect MCP server
            </Button>
          ) : null
        }
        eyebrow="Configure"
        title="MCP servers"
        description="Connect reviewed source inventory. Source access never grants tool execution authority."
      />

      {receipt ? (
        <div className="rounded-lg border border-status-success/40 bg-status-success-soft">
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p
              aria-live="polite"
              className="m-0 text-sm text-status-success"
              ref={receiptRef}
              tabIndex={-1}
            >
              {receipt.message}
            </p>
            {receipt.replacement?.status === 'active' ? (
              <Button
                onClick={() => setDisableReplacementOpen(true)}
                ref={disableReplacementTriggerRef}
                size="sm"
                variant="secondary"
              >
                Disable old source
              </Button>
            ) : null}
          </div>
          {receiptError ? (
            <p className="m-0 px-4 pb-4 text-sm text-danger">{receiptError}</p>
          ) : null}
        </div>
      ) : null}
      <AlertDialog
        onOpenChange={setDisableReplacementOpen}
        open={disableReplacementOpen}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            disableReplacementTriggerRef.current?.focus();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            disableReplacementCancelRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Disable old MCP source?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops future materialization for{' '}
              {receipt?.replacement?.displayName ?? receipt?.replacement?.name}.
              The replacement remains connected, and no bindings will be copied.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {receiptError ? (
            <p className="m-0 text-sm text-danger">{receiptError}</p>
          ) : null}
          <AlertDialogFooter>
            <Button
              disabled={disablingReplacement}
              onClick={() => setDisableReplacementOpen(false)}
              ref={disableReplacementCancelRef}
              variant="secondary"
            >
              Cancel
            </Button>
            <Button
              disabled={disablingReplacement}
              onClick={() => void disableReplacement()}
              variant="destructive"
            >
              {disablingReplacement ? 'Disabling…' : 'Disable old source'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
        <TextField
          id="mcp-search"
          label="Search servers"
          name="q"
          onChange={(event) =>
            void navigate({
              replace: true,
              search: (previous) => ({
                ...previous,
                q: event.target.value,
              }),
            })
          }
          placeholder="Name or transport"
          value={search.q}
        />
        <SelectField
          label="Status"
          onValueChange={(value) =>
            void navigate({
              replace: true,
              search: (previous) => ({
                ...previous,
                status: value as 'all' | 'active' | 'disabled',
              }),
            })
          }
          options={[
            { value: 'all', label: 'All servers' },
            { value: 'active', label: 'Active' },
            { value: 'disabled', label: 'Disabled' },
          ]}
          value={search.status}
        />
      </div>

      {query.isLoading ? (
        <PageState
          description="Reading the connected MCP server inventory."
          icon={<PlugZap aria-hidden="true" />}
          kind="loading"
          title="Loading MCP servers"
        />
      ) : null}
      {query.isError ? (
        <PageState
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
          description="Refresh the page to try loading the inventory again."
          icon={<PlugZap aria-hidden="true" />}
          kind="error"
          title="MCP servers could not be loaded"
        />
      ) : null}
      {!query.isLoading && !query.isError && !inventory?.servers.length ? (
        <PageState
          description="Connected MCP servers will appear here when an administrator adds them."
          icon={<PlugZap aria-hidden="true" />}
          kind="empty"
          title="No MCP servers connected"
        />
      ) : null}
      {!query.isLoading &&
      !query.isError &&
      Boolean(inventory?.servers.length) &&
      !visibleServers.length ? (
        <PageState
          description="Try a different name, transport, or status filter."
          icon={<SearchX aria-hidden="true" />}
          kind="empty"
          title="No MCP servers match these filters"
        />
      ) : null}

      {visibleServers.length ? (
        <>
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4"
            data-layout="mcp-server-card-grid"
          >
            {cards.map((server) => (
              <McpServerCard
                key={server.id}
                onManage={() =>
                  void navigate({
                    search: (previous) => ({
                      ...previous,
                      server: server.id,
                      tab: 'overview',
                    }),
                  })
                }
                server={server}
              />
            ))}
          </div>
          {hasMoreCards ? <div aria-hidden="true" ref={loadMoreRef} /> : null}
        </>
      ) : null}

      <McpServerDetailDialog
        canManage={Boolean(canManage)}
        onOpenChange={(next) => {
          if (!next) closeDetail();
        }}
        onReplace={() => {
          if (!selectedServer) return;
          setReplacement(selectedServer);
          setConnectOpen(true);
        }}
        onStatusChanged={(server, message) => {
          void navigate({
            search: (previous) => ({ ...previous, status: 'all' }),
          });
          setReceipt({ message });
          window.requestAnimationFrame(() => receiptRef.current?.focus());
        }}
        onTabChange={(nextTab) =>
          void navigate({
            search: (previous) => ({ ...previous, tab: nextTab }),
          })
        }
        open={detailOpen}
        server={selectedServer}
        tab={search.tab}
      />
      <ConnectMcpServerDialog
        key={replacement?.id ?? 'new'}
        open={connectOpen}
        replacement={replacement}
        returnFocusRef={connectTriggerRef}
        onConnected={(server) => {
          setReceipt({
            message: replacement
              ? `Replacement connected. ${replacement.displayName ?? replacement.name} remains ${replacement.status} and no bindings were copied.`
              : `${server.displayName ?? server.name} connected.`,
            replacement,
          });
          window.requestAnimationFrame(() => receiptRef.current?.focus());
        }}
        onOpenChange={(next) => {
          setConnectOpen(next);
          if (!next) setReplacement(undefined);
        }}
      />
    </div>
  );
}

function McpServerCard({
  onManage,
  server,
}: {
  onManage: () => void;
  server: McpServer;
}) {
  return (
    <Card className="h-full gap-3 bg-[linear-gradient(180deg,rgb(127_127_127_/_10%),rgb(127_127_127_/_4%))] shadow-[inset_-1px_0_0_rgb(255_255_255_/_4%)] ring-white/20 backdrop-blur-[22px] backdrop-saturate-150">
      <CardHeader>
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle className="truncate text-sm">
            {titleCaseLabel(server.displayName ?? server.name)}
          </CardTitle>
          <StatusBadge status={server.status} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <dl className="m-0 grid min-h-[3.9rem] gap-1 text-ui text-text-secondary">
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-text-muted">Transport</dt>
            <dd className="m-0 truncate text-right">
              {transportLabel(server)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-text-muted">Endpoint</dt>
            <dd className="m-0 truncate text-right">
              {server.endpoint ?? server.args?.join(' ') ?? 'Not exposed'}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="shrink-0 text-text-muted">Risk</dt>
            <dd className="m-0 truncate text-right capitalize">
              {server.riskClass}
            </dd>
          </div>
        </dl>
        <div className="mt-auto flex items-center justify-between gap-3">
          <span className="text-xs text-text-secondary">
            {SOURCE_LABELS[server.createdSource]}
          </span>
          <Button
            className="h-auto w-fit gap-1 p-0 text-status-success hover:text-status-success"
            onClick={onManage}
            type="button"
            variant="link"
          >
            Manage
            <ArrowRight aria-hidden="true" size={14} />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
