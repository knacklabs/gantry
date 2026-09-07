import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Power,
  RefreshCw,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { PageState } from '../../../ui/compositions/page-state';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../ui/primitives/alert-dialog';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import {
  agentAuditQuery,
  agentCapabilitiesQuery,
  agentDetailQuery,
  agentQueryKeys,
  agentSourcesQuery,
  agentUsageQuery,
  type AgentDirectoryItem,
  type BrowserRole,
} from '../agents-queries';
import { navigationSummaryQuery } from '../../navigation/navigation-summary-query';
import {
  agentConversationInstallsQuery,
  channelAccountsQuery,
  channelConversationsQuery,
  channelProvidersQuery,
  conversationApproversQuery,
} from '../../channel-accounts/channel-account-queries';
import { AgentRoleSelector } from '../components/agent-role-selector';
import { AgentSetupManager } from '../components/agent-setup-manager';
import { AgentSettings } from '../components/agent-settings';
import { AgentVersionHistory } from '../components/agent-version-history';
import {
  RoleEditorDialog,
  type RoleEditorTarget,
} from '../components/role-editor-dialog';
import { AgentCreateDialog } from './agent-create-route';

export function AgentDetailRoute() {
  const { agentId } = useParams({ from: '/agents/$agentId' });
  const search = useSearch({ from: '/agents/$agentId' });
  const navigate = useNavigate({ from: '/agents/$agentId' });
  const queryClient = useQueryClient();
  const detail = useQuery(agentDetailQuery(agentId));
  const channelAccounts = useQuery(channelAccountsQuery());
  const conversationInstalls = useQuery(
    agentConversationInstallsQuery(agentId),
  );
  const [statusOpen, setStatusOpen] = useState(false);
  const [deploymentOpen, setDeploymentOpen] = useState(false);
  const status = useMutation({
    mutationFn: async (action: 'enable' | 'disable') => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}/${action}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: browserCsrfHeader(),
        },
      );
      if (!response.ok) throw new Error(`AI employee could not be ${action}d.`);
    },
    onSuccess: () =>
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: agentQueryKeys.all }),
        queryClient.invalidateQueries({
          queryKey: navigationSummaryQuery.queryKey,
        }),
      ]),
  });
  if (detail.isError)
    return (
      <PageState
        action={
          <Button onClick={() => void detail.refetch()}>
            <RefreshCw size={15} />
            Retry
          </Button>
        }
        description="Try loading this AI employee again."
        icon={<Power size={18} />}
        kind="error"
        title="AI employee could not be loaded"
      />
    );
  if (!detail.data)
    return (
      <PageState
        description="Loading the selected AI employee."
        icon={<Power size={18} />}
        kind="loading"
        title="Loading AI employee"
      />
    );

  const agent = detail.data.agent;
  const ownedAccounts = (channelAccounts.data?.accounts ?? []).filter(
    (account) => account.agentId === agent.id,
  );
  const installedCount = conversationInstalls.data?.installs.length ?? 0;
  const action =
    agent.status === 'offboarded'
      ? null
      : agent.status === 'active'
        ? 'disable'
        : 'enable';
  const label = action === 'disable' ? 'Disable' : 'Enable';
  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-4">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-1 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        to="/agents"
        search={{
          tab: 'agents',
          kind: 'all',
          q: '',
          status: 'all',
          page: 1,
          pageSize: 25,
          role: 'all',
          sort: 'name',
          desc: false,
        }}
      >
        <ArrowLeft size={15} aria-hidden="true" /> Back to AI employees
      </Link>
      <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-panel">
        <header className="flex flex-col gap-4 border-b border-border px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-lg border border-status-attention/40 bg-status-attention-soft font-mono text-sm font-semibold text-status-attention">
              {initials(agent.name)}
            </span>
            <div className="min-w-0">
              <p className="mb-1 font-mono text-[10px] font-semibold tracking-[0.14em] text-text-secondary uppercase">
                AI employee · {agent.id}
              </p>
              <h1 className="m-0 text-2xl font-semibold tracking-tight text-text">
                {agent.name}
              </h1>
              <p className="mt-1 mb-2 text-sm text-text-secondary">
                {agent.roleName ?? 'No role selected'} · {installedCount}{' '}
                conversation{installedCount === 1 ? '' : 's'} ·{' '}
                {ownedAccounts.length} channel account
                {ownedAccounts.length === 1 ? '' : 's'}
              </p>
              <div className="flex flex-wrap gap-2">
                <StatusPill status={agent.status} />
                {!agent.roleName ? (
                  <Badge variant="attention">No role assigned</Badge>
                ) : null}
                <Badge variant="attention">
                  {agent.conversationCount
                    ? `${agent.conversationCount} conversations`
                    : 'Not connected'}
                </Badge>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              className="inline-flex h-8 items-center justify-center rounded-md border border-border-strong bg-surface px-3 text-xs font-semibold text-text no-underline shadow-panel hover:bg-surface-muted"
              to="/channel-accounts"
            >
              Channel accounts
            </Link>
            <AgentVersionHistory agent={agent} />
            {action ? (
              <Button
                disabled={status.isPending}
                className={
                  action === 'disable'
                    ? 'border-danger/60 bg-surface px-3 text-xs font-semibold text-danger shadow-panel hover:bg-danger-soft'
                    : 'border-border-strong bg-surface px-3 text-xs font-semibold shadow-panel hover:bg-surface-muted'
                }
                size="sm"
                variant="outline"
                onClick={() => setStatusOpen(true)}
              >
                {label}
              </Button>
            ) : null}
          </div>
        </header>
        <DetailTabs
          value={search.tab}
          onValueChange={(tab) => void navigate({ search: { tab } })}
        />
        <Content
          agent={agent}
          tab={search.tab}
          onDeployRequest={() => setDeploymentOpen(true)}
          onStatusRequest={() => action && setStatusOpen(true)}
        />
      </section>
      {action ? (
        <StatusDialog
          action={action}
          agent={agent}
          open={statusOpen}
          pending={status.isPending}
          onOpenChange={setStatusOpen}
          onConfirm={() =>
            status.mutate(action, { onSuccess: () => setStatusOpen(false) })
          }
        />
      ) : null}
      {deploymentOpen ? (
        <AgentCreateDialog
          existingAgent={agent}
          startAt="account"
          onClose={() => setDeploymentOpen(false)}
        />
      ) : null}
    </div>
  );
}

function DetailTabs({
  onValueChange,
  value,
}: {
  onValueChange: (
    value:
      | 'overview'
      | 'conversations'
      | 'instructions'
      | 'access'
      | 'audit'
      | 'approvals'
      | 'usage'
      | 'settings',
  ) => void;
  value:
    | 'overview'
    | 'conversations'
    | 'instructions'
    | 'access'
    | 'audit'
    | 'approvals'
    | 'usage'
    | 'settings';
}) {
  const tabs = [
    'overview',
    'conversations',
    'access',
    'audit',
    'approvals',
    'usage',
    'settings',
  ] as const;
  return (
    <nav
      aria-label="AI employee detail"
      className="flex gap-0 border-y border-border bg-surface-muted px-[18px]"
    >
      {tabs.map((tab) => (
        <button
          aria-current={value === tab ? 'page' : undefined}
          className="border-b-2 border-transparent bg-transparent px-[13px] pt-[11px] pb-[10px] text-xs font-semibold text-text-muted capitalize hover:text-text data-[active=true]:border-text data-[active=true]:bg-surface data-[active=true]:text-text"
          data-active={value === tab}
          key={tab}
          type="button"
          onClick={() => onValueChange(tab)}
        >
          {tab}
        </button>
      ))}
    </nav>
  );
}

function Content({
  agent,
  tab,
  onDeployRequest,
  onStatusRequest,
}: {
  agent: AgentDirectoryItem;
  tab:
    | 'overview'
    | 'conversations'
    | 'instructions'
    | 'access'
    | 'audit'
    | 'approvals'
    | 'usage'
    | 'settings';
  onDeployRequest: () => void;
  onStatusRequest: () => void;
}) {
  if (tab === 'overview')
    return <Overview agent={agent} onDeployRequest={onDeployRequest} />;
  if (tab === 'conversations')
    return <Conversations agent={agent} onDeployRequest={onDeployRequest} />;
  if (tab === 'access') return <Access agent={agent} />;
  if (tab === 'audit') return <Audit agent={agent} />;
  if (tab === 'approvals') return <Approvals agent={agent} />;
  if (tab === 'usage') return <Usage agent={agent} />;
  return (
    <>
      <Instructions agent={agent} />
      <AgentSettings agent={agent} onStatusRequest={onStatusRequest} />
    </>
  );
}

function Audit({ agent }: { agent: AgentDirectoryItem }) {
  const audit = useQuery(agentAuditQuery(agent.id));
  return (
    <div className="p-5">
      <InfoCard
        title="Audit record"
        description="Recorded runtime events for this AI employee. Payload values are deliberately not shown in the console."
      >
        {audit.isLoading ? (
          <p className="m-0 text-sm text-text-secondary">
            Loading audit events…
          </p>
        ) : audit.isError ? (
          <p className="m-0 text-sm text-danger">{audit.error.message}</p>
        ) : audit.data?.events.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead className="border-y border-border bg-surface-muted font-mono text-[10px] font-semibold tracking-[0.08em] text-text-muted uppercase">
                <tr>
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Actor</th>
                  <th className="px-3 py-2">Conversation</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.events.map((event) => (
                  <tr
                    className="border-b border-border last:border-b-0"
                    key={event.eventId}
                  >
                    <td className="px-3 py-2 text-text-secondary">
                      {formatDate(event.createdAt)}
                    </td>
                    <td className="px-3 py-2 font-semibold">
                      {event.eventType}
                    </td>
                    <td className="px-3 py-2 text-text-secondary">
                      {principalLabel(event.actor)}
                    </td>
                    <td className="px-3 py-2 text-text-secondary">
                      {event.conversationId ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="m-0 text-sm text-text-secondary">
            No runtime events have been recorded for this AI employee.
          </p>
        )}
      </InfoCard>
    </div>
  );
}

function Approvals({ agent }: { agent: AgentDirectoryItem }) {
  const installs = useQuery(agentConversationInstallsQuery(agent.id));
  const conversations = useQuery(channelConversationsQuery());
  const conversationById = new Map(
    (conversations.data?.conversations ?? []).map((conversation) => [
      conversation.id,
      conversation,
    ]),
  );
  return (
    <div className="p-5">
      <InfoCard
        title="Conversation approvers"
        description="Approval authority is scoped to each conversation. Directory recognition does not grant a person approval authority."
      >
        {installs.isLoading ? (
          <p className="m-0 text-sm text-text-secondary">
            Loading conversations…
          </p>
        ) : installs.data?.installs.length ? (
          <ul className="m-0 grid list-none divide-y divide-border p-0">
            {installs.data.installs.map((install) => (
              <ApproverRow
                conversationId={install.conversationId}
                key={install.id}
                name={
                  conversationById.get(install.conversationId)?.title ??
                  install.displayName
                }
              />
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-text-secondary">
            Install this AI employee in a conversation before assigning
            approvers.
          </p>
        )}
      </InfoCard>
    </div>
  );
}

function ApproverRow({
  conversationId,
  name,
}: {
  conversationId: string;
  name: string;
}) {
  const approvers = useQuery(conversationApproversQuery(conversationId));
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <strong className="text-sm">{name}</strong>
      <span className="text-xs text-text-secondary">
        {approvers.isLoading
          ? 'Loading approvers…'
          : approvers.isError
            ? 'Approvers unavailable'
            : `${approvers.data?.approvers.length ?? 0} assigned`}
      </span>
    </li>
  );
}

function Usage({ agent }: { agent: AgentDirectoryItem }) {
  const [range, setRange] = useState<'seven_days' | 'today'>('seven_days');
  const usage = useQuery(agentUsageQuery(agent.id, range));
  const totals = (usage.data?.usage ?? []).reduce(
    (total, row) => ({
      inputTokens: total.inputTokens + row.inputTokens,
      outputTokens: total.outputTokens + row.outputTokens,
      requestCount: total.requestCount + row.requestCount,
    }),
    { inputTokens: 0, outputTokens: 0, requestCount: 0 },
  );
  return (
    <div className="grid gap-4 p-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="m-0 text-base font-semibold">Usage</h2>
          <p className="mt-1 mb-0 text-sm text-text-secondary">
            Agent-scoped model usage recorded by Gantry.
          </p>
        </div>
        <label className="grid gap-1 text-xs font-semibold text-text">
          Range
          <select
            className="h-8 rounded-md border border-border bg-surface px-2 text-xs font-medium"
            value={range}
            onChange={(event) =>
              setRange(event.target.value as 'seven_days' | 'today')
            }
          >
            <option value="seven_days">Last 7 days</option>
            <option value="today">Today</option>
          </select>
        </label>
      </div>
      <section className="grid overflow-hidden rounded-lg border border-border bg-surface sm:grid-cols-3">
        <Metric
          detail="Recorded"
          label="Input tokens"
          value={totals.inputTokens.toLocaleString()}
        />
        <Metric
          detail="Recorded"
          label="Output tokens"
          value={totals.outputTokens.toLocaleString()}
        />
        <Metric
          detail="Recorded"
          label="Requests"
          last
          value={String(totals.requestCount)}
        />
      </section>
      <InfoCard
        title="Daily usage"
        description="Only usage events attributed to this AI employee appear here."
      >
        {usage.isLoading ? (
          <p className="m-0 text-sm text-text-secondary">Loading usage…</p>
        ) : usage.isError ? (
          <p className="m-0 text-sm text-danger">{usage.error.message}</p>
        ) : usage.data?.usage.length ? (
          <ul className="m-0 grid list-none divide-y divide-border p-0">
            {usage.data.usage.map((row) => (
              <li
                className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                key={row.day}
              >
                <span className="text-sm font-semibold">
                  {row.day ?? 'Recorded'}
                </span>
                <span className="text-xs text-text-secondary">
                  {row.requestCount} requests ·{' '}
                  {row.inputTokens.toLocaleString()} in ·{' '}
                  {row.outputTokens.toLocaleString()} out
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-text-secondary">
            No usage has been recorded in this range.
          </p>
        )}
      </InfoCard>
    </div>
  );
}

function Conversations({
  agent,
  onDeployRequest,
}: {
  agent: AgentDirectoryItem;
  onDeployRequest: () => void;
}) {
  const accounts = useQuery(channelAccountsQuery());
  const conversations = useQuery(channelConversationsQuery());
  const installs = useQuery(agentConversationInstallsQuery(agent.id));
  const accountById = new Map(
    (accounts.data?.accounts ?? []).map((account) => [account.id, account]),
  );
  const conversationById = new Map(
    (conversations.data?.conversations ?? []).map((conversation) => [
      conversation.id,
      conversation,
    ]),
  );
  return (
    <div className="grid gap-4 p-5">
      <InfoCard
        title="Conversations"
        description="Each installation assigns this AI employee to one provider conversation with its own memory scope and approvers."
      >
        {installs.isLoading ? (
          <p className="m-0 text-sm text-text-secondary">
            Loading conversation installs…
          </p>
        ) : installs.data?.installs.length ? (
          <ul className="m-0 grid list-none divide-y divide-border p-0">
            {installs.data.installs.map((install) => {
              const account = accountById.get(install.providerAccountId);
              const conversation = conversationById.get(install.conversationId);
              return (
                <li
                  className="flex flex-wrap items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                  key={install.id}
                >
                  <div className="min-w-0">
                    <strong className="block text-sm">
                      {conversation?.title ?? install.displayName}
                    </strong>
                    <span className="block text-xs text-text-secondary">
                      {account?.label ?? 'Channel account unavailable'} ·{' '}
                      {install.memoryScope} memory
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill
                      status={
                        install.status === 'active' ? 'active' : 'disabled'
                      }
                    />
                    {account ? (
                      <Link
                        className="text-xs font-semibold text-text underline underline-offset-2"
                        params={{ accountId: account.id }}
                        to="/channel-accounts/$accountId"
                      >
                        Manage account
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="grid gap-3">
            <p className="m-0 text-sm text-text-secondary">
              This AI employee is not installed in a conversation yet.
            </p>
            <Button type="button" onClick={onDeployRequest}>
              Connect a channel account
            </Button>
          </div>
        )}
      </InfoCard>
      <p className="m-0 text-xs text-text-secondary">
        A channel account is the bot identity. A conversation installation is
        the place where that identity may respond; it does not make a reply
        delivery claim.
      </p>
    </div>
  );
}

function Overview({
  agent,
  onDeployRequest,
}: {
  agent: AgentDirectoryItem;
  onDeployRequest: () => void;
}) {
  const sources = useQuery(agentSourcesQuery(agent.id));
  const capabilities = useQuery(agentCapabilitiesQuery(agent.id));
  const accounts = useQuery(channelAccountsQuery());
  const providers = useQuery(channelProvidersQuery());
  const installs = useQuery(agentConversationInstallsQuery(agent.id));
  const conversations = useQuery(channelConversationsQuery());
  const sourceCount = sources.data
    ? sources.data.sources.sources.skills.length +
      sources.data.sources.sources.mcpServers.length
    : null;
  const capabilityCount =
    capabilities.data?.capabilities.capabilities.length ?? null;
  const ownedAccounts = (accounts.data?.accounts ?? []).filter(
    (account) => account.agentId === agent.id,
  );
  const providerById = new Map(
    (providers.data?.providers ?? []).map((provider) => [
      provider.id,
      provider.displayName,
    ]),
  );
  const conversationById = new Map(
    (conversations.data?.conversations ?? []).map((conversation) => [
      conversation.id,
      conversation,
    ]),
  );
  const installed = installs.data?.installs ?? [];
  return (
    <div className="grid gap-4 p-5">
      {!installed.length ? (
        <section className="flex flex-col justify-between gap-4 rounded-lg border border-border-strong bg-status-attention-soft p-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="m-0 text-sm font-semibold">
              {ownedAccounts.length
                ? 'Choose a conversation'
                : 'Connect a channel account'}
            </h2>
            <p className="mt-1 mb-0 text-xs text-text-secondary">
              {ownedAccounts.length
                ? 'This AI employee has an account but is not installed in a conversation yet.'
                : 'Connect the bot identity this AI employee will use before choosing where it works.'}
            </p>
          </div>
          <Button className="shrink-0" type="button" onClick={onDeployRequest}>
            {ownedAccounts.length
              ? 'Choose conversation'
              : 'Connect channel account'}
          </Button>
        </section>
      ) : null}
      <section className="grid overflow-hidden rounded-lg border border-border bg-surface sm:grid-cols-3">
        <Metric
          label="Conversations"
          value={String(installed.length)}
          detail={`${agent.conversationCount} configured`}
        />
        <Metric
          label="Channel accounts"
          value={String(ownedAccounts.length)}
          detail={`${ownedAccounts.filter((account) => account.status === 'active').length} enabled`}
        />
        <Metric
          label="Configuration"
          value={agent.configVersion ? `v${agent.configVersion}` : '—'}
          detail={
            agent.status === 'active'
              ? 'Available for new work'
              : 'Not available'
          }
          last
        />
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <InfoCard
          title="Seats and accounts"
          description="One account is this employee’s bot identity; each install chooses where it works."
        >
          {ownedAccounts.length ? (
            <ul className="m-0 grid list-none divide-y divide-border p-0">
              {ownedAccounts.map((account) => (
                <li
                  className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  key={account.id}
                >
                  <div className="min-w-0">
                    <strong className="block truncate text-sm">
                      {account.label}
                    </strong>
                    <span className="block text-xs text-text-secondary">
                      {providerById.get(account.providerId) ??
                        account.providerId}{' '}
                      ·{' '}
                      {
                        installed.filter(
                          (install) => install.providerAccountId === account.id,
                        ).length
                      }{' '}
                      conversation installs
                    </span>
                  </div>
                  <Link
                    className="shrink-0 text-xs font-semibold text-text underline underline-offset-2"
                    params={{ accountId: account.id }}
                    to="/channel-accounts/$accountId"
                  >
                    Manage
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-sm text-text-secondary">
              No channel accounts connected.
            </p>
          )}
        </InfoCard>
        <InfoCard
          title="Configuration and access"
          description="Sources expose inventory; capabilities and runtime policy determine what may execute."
        >
          <dl className="grid gap-3 sm:grid-cols-2">
            <Fact label="Role" value={agent.roleName ?? 'No role selected'} />
            <Fact
              label="Model"
              value={agent.modelAlias ?? 'Deployment default'}
            />
            <Fact
              label="Sources"
              value={
                sourceCount === null ? 'Loading' : `${sourceCount} attached`
              }
            />
            <Fact
              label="Capabilities"
              value={
                capabilityCount === null
                  ? 'Loading'
                  : `${capabilityCount} selected`
              }
            />
          </dl>
          <p className="mt-4 mb-0 text-xs text-text-secondary">
            Approvers are assigned per conversation. This profile does not give
            a human global approval authority.
          </p>
        </InfoCard>
      </div>
      {installed.length ? (
        <InfoCard
          title="Current conversation installs"
          description="These are configuration records, not proof that a provider delivered a reply."
        >
          <ul className="m-0 grid list-none divide-y divide-border p-0">
            {installed.map((install) => {
              const conversation = conversationById.get(install.conversationId);
              return (
                <li
                  className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  key={install.id}
                >
                  <div>
                    <strong className="block text-sm">
                      {conversation?.title ?? install.displayName}
                    </strong>
                    <span className="block text-xs text-text-secondary">
                      {conversation?.kind ?? 'Conversation'} ·{' '}
                      {install.memoryScope} memory
                    </span>
                  </div>
                  <StatusPill
                    status={install.status === 'active' ? 'active' : 'disabled'}
                  />
                </li>
              );
            })}
          </ul>
        </InfoCard>
      ) : null}
    </div>
  );
}

function Metric({
  detail,
  label,
  last = false,
  value,
}: {
  detail: string;
  label: string;
  last?: boolean;
  value: string;
}) {
  return (
    <div
      className={`border-border px-5 py-4 ${last ? '' : 'border-b sm:border-r sm:border-b-0'}`}
    >
      <span className="block text-xs text-text-secondary">{label}</span>
      <strong className="mt-1 block text-2xl tracking-tight">{value}</strong>
      <span className="mt-1 block text-xs text-text-muted">{detail}</span>
    </div>
  );
}

function Instructions({ agent }: { agent: AgentDirectoryItem }) {
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const hasRole = Boolean(agent.roleName && agent.rolePrompt);
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1.4fr_0.9fr]">
      <InfoCard
        title={hasRole ? 'Role snapshot' : 'No role assigned'}
        description={
          hasRole && agent.configVersion
            ? `Copied into this AI employee at v${agent.configVersion}.`
            : 'This AI employee currently uses Gantry’s default Developer behavior.'
        }
      >
        {hasRole ? (
          <>
            <p className="mb-2 text-sm font-semibold">{agent.roleName}</p>
            <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-muted p-3 text-xs leading-5 text-text-secondary">
              {agent.rolePrompt}
            </pre>
          </>
        ) : (
          <p className="m-0 text-sm text-text-secondary">
            Assign a role to give this AI employee a reusable, visible behavior
            prompt. Its runtime, safety, and access rules remain separate.
          </p>
        )}
        <Button
          className="mt-4"
          variant="secondary"
          onClick={() => setRoleDialogOpen(true)}
        >
          {hasRole ? 'Update role' : 'Assign role'}
        </Button>
      </InfoCard>
      <InfoCard
        title="How role changes work"
        description="Role changes are versioned with this AI employee."
      >
        <p className="m-0 text-sm text-text-secondary">
          New work uses the saved role snapshot. Work already running keeps its
          current prompt.
        </p>
        <div className="mt-4 border-t border-border pt-3 text-xs text-text-secondary">
          Last changed {formatDate(agent.updatedAt)}
        </div>
      </InfoCard>
      <RoleAssignmentDialog
        agent={agent}
        open={roleDialogOpen}
        onOpenChange={setRoleDialogOpen}
      />
    </div>
  );
}

function RoleAssignmentDialog({
  agent,
  onOpenChange,
  open,
}: {
  agent: AgentDirectoryItem;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedRole, setSelectedRole] = useState<BrowserRole>();
  const [roleEditor, setRoleEditor] = useState<RoleEditorTarget>();
  const hasRole = Boolean(agent.roleName && agent.rolePrompt);
  useEffect(() => {
    if (!open || !agent.roleId || !agent.roleName || !agent.rolePrompt) return;
    setSelectedRole({
      id: agent.roleId,
      name: agent.roleName,
      prompt: agent.rolePrompt,
      kind: agent.roleId.startsWith('built-in:') ? 'built-in' : 'custom',
    });
  }, [agent.roleId, agent.roleName, agent.rolePrompt, open]);
  const saveRole = useMutation({
    mutationFn: async () => {
      if (!selectedRole) throw new Error('Select a role.');
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agent.id)}`,
        {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            ...browserCsrfHeader(),
          },
          body: JSON.stringify({ name: agent.name, roleId: selectedRole.id }),
        },
      );
      if (!response.ok) throw new Error('Role could not be updated.');
    },
    onSuccess: async () => {
      await queryClient.refetchQueries({
        queryKey: agentDetailQuery(agent.id).queryKey,
        type: 'active',
      });
      await queryClient.invalidateQueries({
        queryKey: agentQueryKeys.all,
        refetchType: 'active',
      });
      await queryClient.invalidateQueries({
        queryKey: navigationSummaryQuery.queryKey,
      });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="grid max-h-[calc(100dvh-46px)] w-[min(940px,calc(100vw-32px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="grid gap-1">
            <DialogTitle className="text-lg font-semibold">
              {hasRole ? 'Update role' : 'Assign role'}
            </DialogTitle>
            <DialogDescription className="text-xs text-text-secondary">
              Choose the reusable behavior prompt for {agent.name}.
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              aria-label="Close role dialog"
              size="icon-sm"
              variant="ghost"
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </DialogClose>
        </header>
        <div className="min-h-0 overflow-y-auto p-5">
          <AgentRoleSelector
            currentRoleId={agent.roleId}
            error={saveRole.isError ? saveRole.error.message : undefined}
            value={selectedRole}
            onChange={setSelectedRole}
            onCreateCustom={() => setRoleEditor({ mode: 'create' })}
          />
          <p className="mt-4 mb-0 text-xs text-text-secondary">
            A changed role creates a new configuration version. New work uses
            it; running work is unchanged.
          </p>
          <RoleEditorDialog
            target={roleEditor}
            onOpenChange={(nextOpen) => !nextOpen && setRoleEditor(undefined)}
            onSaved={setSelectedRole}
          />
        </div>
        <footer className="flex items-center justify-end gap-3 border-t border-border bg-surface-muted px-5 py-3">
          <DialogClose asChild>
            <Button disabled={saveRole.isPending} variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={!selectedRole || saveRole.isPending}
            onClick={() => saveRole.mutate()}
          >
            {saveRole.isPending
              ? 'Saving…'
              : hasRole
                ? 'Update role'
                : 'Assign role'}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function Access({ agent }: { agent: AgentDirectoryItem }) {
  const [editor, setEditor] = useState<'sources' | 'capabilities' | null>(null);
  const sources = useQuery(agentSourcesQuery(agent.id));
  const capabilities = useQuery(agentCapabilitiesQuery(agent.id));
  const sourceItems = sources.data?.sources.sources;
  const sourceRows = sourceItems
    ? [
        ...sourceItems.skills.map((item) => ({
          id: `skill:${item.id}`,
          label: item.name ?? item.id,
          kind: 'Skill',
          status: item.status ?? 'disabled',
        })),
        ...sourceItems.mcpServers.map((item) => ({
          id: `mcp:${item.id}`,
          label: item.name ?? item.id,
          kind: 'MCP server',
          status: item.status ?? 'disabled',
        })),
      ]
    : [];
  const allowed = capabilities.data?.capabilities.capabilities ?? [];
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-2">
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="m-0 text-base font-semibold">Connected</h2>
        <p className="mt-1 mb-4 text-sm text-text-secondary">
          Reviewed sources make tools visible. They do not grant authority by
          themselves.
        </p>
        {sources.isLoading ? (
          <p className="m-0 text-sm text-text-secondary">
            Loading connected sources…
          </p>
        ) : sources.isError ? (
          <p className="m-0 text-sm text-destructive">
            Connected sources could not be loaded.
          </p>
        ) : sourceRows.length ? (
          <ul className="m-0 max-h-52 list-none divide-y divide-border overflow-y-auto p-0">
            {sourceRows.map((source) => (
              <li
                className="flex min-h-10 items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                key={source.id}
              >
                <div className="min-w-0">
                  <p className="m-0 truncate text-sm font-semibold">
                    {source.label}
                  </p>
                  <p className="m-0 text-xs text-text-secondary">
                    {source.kind}
                  </p>
                </div>
                <Badge
                  className="h-6 text-[10px]"
                  variant={
                    source.status === 'disabled' ? 'attention' : 'success'
                  }
                >
                  {source.status === 'installed'
                    ? 'Installed'
                    : source.status === 'active'
                      ? 'Active'
                      : 'Disabled'}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-text-secondary">
            No sources connected.
          </p>
        )}
        <Button
          className="mt-4"
          disabled={agent.status !== 'active'}
          variant="secondary"
          onClick={() => setEditor('sources')}
        >
          Edit sources
        </Button>
      </section>
      <InfoCard
        title="Capabilities"
        description="Tool capabilities this AI employee is allowed to use."
      >
        <SummaryList
          empty="No capabilities allowed."
          items={allowed.map((item) => `${item.id}@${item.version}`)}
        />
        <Button
          className="mt-4"
          disabled={agent.status !== 'active'}
          variant="secondary"
          onClick={() => setEditor('capabilities')}
        >
          Edit capabilities
        </Button>
      </InfoCard>
      <AgentAccessEditorDialog
        agent={agent}
        kind={editor}
        onOpenChange={(open) => !open && setEditor(null)}
        onSaved={async () => {
          await Promise.all([sources.refetch(), capabilities.refetch()]);
          setEditor(null);
        }}
      />
    </div>
  );
}

function AgentAccessEditorDialog({
  agent,
  kind,
  onOpenChange,
  onSaved,
}: {
  agent: AgentDirectoryItem;
  kind: 'sources' | 'capabilities' | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const isSources = kind === 'sources';
  const formId = `agent-${kind ?? 'sources'}-edit-form`;
  const title = isSources ? 'Connect existing sources' : 'Allow capabilities';
  const description = isSources
    ? 'Optional · select reviewed skills and MCP servers. Sources expose inventory; they do not grant actions.'
    : 'Optional · choose durable actions for this AI employee. Risky use may still ask for approval.';
  return (
    <Dialog open={kind !== null} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="grid h-fit max-h-[min(900px,calc(100dvh-46px))] w-[min(940px,calc(100vw-32px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="grid gap-1">
            <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
            <DialogDescription className="text-xs text-text-secondary">
              {description}
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              aria-label="Close access editor"
              size="icon-sm"
              variant="ghost"
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </DialogClose>
        </header>
        <div className="min-h-0 overflow-y-auto p-5">
          {kind ? (
            <AgentSetupManager
              agentId={agent.id}
              formId={formId}
              kind={kind}
              onSaved={() => void onSaved()}
              onSavingChange={setSaving}
            />
          ) : null}
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-border bg-surface-muted px-5 py-3">
          <p className="m-0 text-xs text-text-secondary">
            {isSources
              ? 'Sources become available on the next run.'
              : 'Saved capabilities are durable AI employee authority.'}
          </p>
          <div className="flex items-center gap-3">
            <DialogClose asChild>
              <Button disabled={saving} variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button disabled={saving} form={formId} type="submit">
              {saving
                ? 'Saving…'
                : `Save ${isSources ? 'sources' : 'capabilities'}`}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function StatusDialog({
  action,
  agent,
  onConfirm,
  onOpenChange,
  open,
  pending,
}: {
  action: 'enable' | 'disable';
  agent: AgentDirectoryItem;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  pending: boolean;
}) {
  const disabling = action === 'disable';
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-[min(860px,calc(100vw-32px))] gap-5 p-5 sm:max-w-[min(860px,calc(100vw-32px))]">
        <AlertDialogHeader className="items-start text-left">
          <p className="m-0 font-mono text-xs font-semibold tracking-[0.14em] text-text-secondary uppercase">
            Availability change
          </p>
          <AlertDialogTitle className="text-2xl font-semibold">
            {disabling ? 'Disable' : 'Enable'} {agent.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {disabling
              ? 'Gantry will reject new sessions and delegation to this AI employee.'
              : 'Gantry will allow new sessions and delegation to this AI employee again.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {disabling ? (
          <>
            <div className="grid gap-3 rounded-lg border border-border bg-surface-muted p-4 text-sm text-text-secondary">
              <Impact
                icon={<X size={16} />}
                text="New sessions and delegation will be rejected."
              />
              <Impact
                icon={<Check size={16} />}
                text="Configuration, history, memory, and audit records remain available."
              />
              <Impact
                icon={<ArrowRight size={16} />}
                text="Work already running is not cancelled."
              />
            </div>
            <div className="rounded-lg border border-status-attention/40 bg-status-attention-soft p-4 text-sm">
              <strong className="block">
                This does not delete the AI employee.
              </strong>
              <span>You can enable it again from Settings.</span>
            </div>
          </>
        ) : (
          <div className="rounded-lg border border-status-success/40 bg-status-success-soft p-4 text-sm">
            Existing configuration, history, and access remain unchanged.
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button disabled={pending} variant="secondary">
              Cancel
            </Button>
          </AlertDialogCancel>
          <Button
            disabled={pending}
            variant={disabling ? 'destructive' : 'default'}
            onClick={onConfirm}
          >
            {pending
              ? 'Saving…'
              : `${disabling ? 'Disable' : 'Enable'} AI employee`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function InfoCard({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="m-0 text-base font-semibold">{title}</h2>
      <p className="mt-1 mb-4 text-sm text-text-secondary">{description}</p>
      {children}
    </section>
  );
}
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted p-3">
      <dt className="font-mono text-[10px] font-semibold tracking-wide text-text-secondary uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold text-text">{value}</dd>
    </div>
  );
}
function StatusPill({ status }: { status: AgentDirectoryItem['status'] }) {
  return (
    <Badge variant={status === 'active' ? 'success' : 'danger'}>
      <span className="size-1.5 rounded-full bg-current" />
      {status === 'active' ? 'Active' : 'Disabled'}
    </Badge>
  );
}
function SummaryList({ empty, items }: { empty: string; items: string[] }) {
  return items.length ? (
    <ul className="m-0 grid max-h-40 list-none gap-2 overflow-auto p-0">
      {items.map((item) => (
        <li
          className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm"
          key={item}
        >
          {item}
        </li>
      ))}
    </ul>
  ) : (
    <p className="m-0 text-sm text-text-secondary">{empty}</p>
  );
}
function Impact({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <p className="m-0 flex items-center gap-4">
      <span className="text-text">{icon}</span>
      {text}
    </p>
  );
}
function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(date);
}

function principalLabel(
  actor:
    | { kind: 'human'; personId: string; aliasId?: string }
    | { kind: 'service'; personId: string; aliasId?: string }
    | { kind: 'system'; source: string },
) {
  if (actor.kind === 'system') return `System · ${actor.source}`;
  return `${actor.kind === 'human' ? 'Person' : 'Service'} · ${actor.personId}`;
}
