import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Link2, RefreshCw } from 'lucide-react';

import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import { agentDirectoryQuery } from '../../agents/agents-queries';
import {
  agentConversationInstallsQuery,
  channelAccountsQuery,
  channelConversationsQuery,
  channelProvidersQuery,
} from '../channel-account-queries';

export function ChannelAccountDetailRoute() {
  const { accountId } = useParams({ from: '/channel-accounts/$accountId' });
  const accounts = useQuery(channelAccountsQuery());
  const providers = useQuery(channelProvidersQuery());
  const conversations = useQuery(channelConversationsQuery());
  const account = accounts.data?.accounts.find((item) => item.id === accountId);
  const installs = useQuery(
    agentConversationInstallsQuery(account?.agentId ?? ''),
  );
  const agents = useQuery(
    agentDirectoryQuery({
      page: 1,
      pageSize: 100,
      search: '',
      status: 'all',
      role: 'all',
      sort: 'name',
      direction: 'asc',
    }),
  );

  if (
    accounts.isError ||
    providers.isError ||
    conversations.isError ||
    agents.isError
  ) {
    return (
      <LoadError
        onRetry={() => {
          void accounts.refetch();
          void providers.refetch();
          void conversations.refetch();
          void agents.refetch();
        }}
      />
    );
  }
  if (
    !accounts.data ||
    !providers.data ||
    !conversations.data ||
    !agents.data
  ) {
    return (
      <PageState
        description="Loading the channel account."
        icon={<Link2 size={18} />}
        kind="loading"
        title="Loading channel account"
      />
    );
  }
  if (!account) {
    return (
      <PageState
        description="This account is unavailable in the current workspace."
        icon={<Link2 size={18} />}
        kind="empty"
        title="Channel account unavailable"
      />
    );
  }
  const provider = providers.data.providers.find(
    (item) => item.id === account.providerId,
  );
  const agent = agents.data.data.find((item) => item.id === account.agentId);
  const conversationById = new Map(
    conversations.data.conversations.map((item) => [item.id, item]),
  );
  const affected = (installs.data?.installs ?? []).filter(
    (install) => install.providerAccountId === account.id,
  );

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-4">
      <Link
        className="inline-flex w-fit items-center gap-1 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        to="/channel-accounts"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Channel accounts
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-surface px-5 py-5 shadow-panel">
        <div className="min-w-0">
          <p className="mb-1 font-mono text-[10px] font-semibold tracking-[0.14em] text-text-secondary uppercase">
            Channel account
          </p>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">
            {account.label}
          </h1>
          <p className="mt-1 mb-0 text-sm text-text-secondary">
            {provider?.displayName ?? account.providerId} · owned by{' '}
            {agent?.name ?? 'an unavailable AI employee'}
          </p>
        </div>
        <StatusBadge status={account.status} />
      </header>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Connection configuration"
          description="Credential values are never shown after submission."
        >
          <dl className="grid gap-3 p-4 sm:grid-cols-2">
            <Fact
              label="Provider"
              value={provider?.displayName ?? account.providerId}
            />
            <Fact
              label="Runtime status"
              value={
                provider?.status === 'available'
                  ? 'Available'
                  : provider?.status === 'setup_only'
                    ? 'Setup only'
                    : 'Unavailable'
              }
            />
            <Fact
              label="Credentials"
              value={
                account.credentialKeys.length
                  ? account.credentialKeys.join(', ')
                  : 'None saved'
              }
            />
            <Fact
              label="Configuration"
              value={account.status === 'active' ? 'Enabled' : 'Disabled'}
            />
          </dl>
        </Panel>
        <Panel
          title="AI employee"
          description="A channel account belongs to one AI employee."
        >
          <div className="grid gap-3 p-4">
            {agent ? (
              <Link
                params={{ agentId: agent.id }}
                search={{ tab: 'overview' }}
                to="/agents/$agentId"
              >
                <Button variant="secondary">Open {agent.name}</Button>
              </Link>
            ) : (
              <span className="text-sm text-text-secondary">
                The owning AI employee is unavailable.
              </span>
            )}
            <p className="m-0 text-xs text-text-secondary">
              Add or change conversations from the AI employee’s guided setup.
            </p>
          </div>
        </Panel>
      </div>
      <Panel
        title="Affected conversations"
        description="Each installation is a separate conversation assignment for this account."
      >
        {installs.isLoading ? (
          <p className="m-0 p-4 text-sm text-text-secondary">
            Loading conversation installs…
          </p>
        ) : affected.length ? (
          <ul className="m-0 grid list-none divide-y divide-border p-0">
            {affected.map((install) => {
              const conversation = conversationById.get(install.conversationId);
              return (
                <li
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  key={install.id}
                >
                  <div>
                    <strong className="block text-sm">
                      {conversation?.title ?? install.displayName}
                    </strong>
                    <span className="text-xs text-text-secondary">
                      {conversation?.kind ?? 'Conversation'} ·{' '}
                      {install.memoryScope} memory
                    </span>
                  </div>
                  <StatusBadge status={install.status} />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="m-0 p-4 text-sm text-text-secondary">
            This account is not installed in a conversation yet.
          </p>
        )}
      </Panel>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-border pb-2 last:border-b-0">
      <dt className="font-mono text-[10px] font-semibold tracking-[0.08em] text-text-muted uppercase">
        {label}
      </dt>
      <dd className="mt-1 ml-0 text-sm font-semibold">{value}</dd>
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <PageState
      action={
        <Button onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" /> Retry
        </Button>
      }
      description="No configuration was changed. Try loading this account again."
      icon={<Link2 size={18} />}
      kind="error"
      title="Channel account could not be loaded"
    />
  );
}
