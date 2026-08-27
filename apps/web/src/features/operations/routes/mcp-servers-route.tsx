import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { SelectField } from '../../../ui/compositions/select-field';
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
import { mcpServerQuery, type McpServer } from '../operations-queries';
import { navigationSummaryQuery } from '../../navigation/navigation-summary-query';
import { ConnectMcpServerDialog } from './mcp-connect-server-dialog';
import { McpServerDetail } from './mcp-server-detail';

export function McpServersRoute() {
  const query = useQuery(mcpServerQuery);
  const client = useQueryClient();
  const receiptRef = useRef<HTMLParagraphElement>(null);
  const disableReplacementTriggerRef = useRef<HTMLButtonElement>(null);
  const disableReplacementCancelRef = useRef<HTMLButtonElement>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all');
  const [search, setSearch] = useState('');
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
      {receipt ? (
        <Panel>
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
            <p aria-live="polite" className="m-0 px-4 pb-4 text-sm text-danger">
              {receiptError}
            </p>
          ) : null}
        </Panel>
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
      {query.isLoading ? (
        <Panel>
          <p className="p-4 text-sm text-text-secondary">
            Loading MCP servers…
          </p>
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
                    onClick={() => {
                      setSelectedId(server.id);
                      setReceipt(undefined);
                      setReceiptError(undefined);
                    }}
                    type="button"
                  >
                    <span className="flex items-center justify-between gap-2 font-medium">
                      <span>{server.displayName ?? server.name}</span>
                      <span
                        className={
                          server.status === 'active'
                            ? 'text-status-success'
                            : 'text-text-secondary'
                        }
                      >
                        {server.status === 'active' ? 'Active' : 'Disabled'}
                      </span>
                    </span>
                    <span className="text-xs text-text-secondary">
                      {server.transport === 'stdio_template'
                        ? `Local process${server.templateId ? ` · ${server.templateId}` : ''}`
                        : server.transport.toUpperCase()}{' '}
                      · {server.bindings.length} agent
                      {server.bindings.length === 1 ? '' : 's'}
                    </span>
                  </button>
                </li>
              ))}
              {servers.length === 0 ? (
                <li className="p-4 text-sm text-text-secondary">
                  No MCP servers match these filters.
                </li>
              ) : null}
            </ul>
          </Panel>
          {selected ? (
            <McpServerDetail
              canManage={Boolean(canManage)}
              key={selected.id}
              onReplace={() => {
                setReplacement(selected);
                setConnectOpen(true);
              }}
              onStatusChanged={(server, message) => {
                setStatus('all');
                setSelectedId(server.id);
                setReceipt({ message });
                void client.invalidateQueries({
                  queryKey: mcpServerQuery.queryKey,
                });
                void client.invalidateQueries({
                  queryKey: navigationSummaryQuery.queryKey,
                });
                window.requestAnimationFrame(() => receiptRef.current?.focus());
              }}
              server={selected}
            />
          ) : (
            <Panel>
              <p className="p-4 text-sm text-text-secondary">
                Select a server to inspect its source definition.
              </p>
            </Panel>
          )}
        </div>
      ) : null}
      <ConnectMcpServerDialog
        key={replacement?.id ?? 'new'}
        open={connectOpen}
        replacement={replacement}
        onConnected={(server) => {
          setSelectedId(server.id);
          setReceipt({
            message: replacement
              ? `Replacement connected. ${replacement.displayName ?? replacement.name} remains ${replacement.status} and no bindings were copied.`
              : 'Server connected. You can attach an agent below or manage it later.',
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
