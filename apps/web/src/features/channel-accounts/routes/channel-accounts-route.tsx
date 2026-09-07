import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Link2, Plus, RefreshCw } from 'lucide-react';

import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import { agentDirectoryQuery } from '../../agents/agents-queries';
import {
  channelAccountsQuery,
  channelProvidersQuery,
} from '../channel-account-queries';

const agentSearch = {
  page: 1,
  pageSize: 100,
  search: '',
  status: 'all',
  role: 'all',
  sort: 'name',
  direction: 'asc' as const,
};

export function ChannelAccountsRoute() {
  const accounts = useQuery(channelAccountsQuery());
  const providers = useQuery(channelProvidersQuery());
  const agents = useQuery(agentDirectoryQuery(agentSearch));
  const failed = accounts.isError || providers.isError || agents.isError;
  const loading = !accounts.data || !providers.data || !agents.data;
  const providerById = new Map(
    (providers.data?.providers ?? []).map((provider) => [
      provider.id,
      provider,
    ]),
  );
  const agentById = new Map(
    (agents.data?.data ?? []).map((agent) => [agent.id, agent]),
  );

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-5">
      <PageHeader
        eyebrow="Configure"
        title="Channel accounts"
        description="Bot identities owned by AI employees. An account can connect its owner to several conversations."
        action={
          <Link
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
            to="/agents"
          >
            <Button>
              <Plus size={16} aria-hidden="true" />
              Onboard an AI employee
            </Button>
          </Link>
        }
      />
      {loading ? (
        <PageState
          description="Loading configured channel accounts."
          icon={<Link2 size={18} aria-hidden="true" />}
          kind="loading"
          title="Loading channel accounts"
        />
      ) : failed ? (
        <PageState
          action={
            <Button
              onClick={() => {
                void accounts.refetch();
                void providers.refetch();
                void agents.refetch();
              }}
            >
              <RefreshCw size={15} aria-hidden="true" /> Retry
            </Button>
          }
          description="No configuration was changed. Try loading this page again."
          icon={<Link2 size={18} aria-hidden="true" />}
          kind="error"
          title="Channel accounts could not be loaded"
        />
      ) : (
        <>
          <Panel
            title="Configured accounts"
            description="Credentials are write-only. This table shows configuration state, not live transport health."
          >
            {accounts.data.accounts.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="border-y border-border bg-surface-muted font-mono text-[10px] font-semibold tracking-[0.08em] text-text-muted uppercase">
                    <tr>
                      <th className="px-4 py-3">Account</th>
                      <th className="px-4 py-3">Provider</th>
                      <th className="px-4 py-3">AI employee</th>
                      <th className="px-4 py-3">Configuration</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.data.accounts.map((account) => {
                      const provider = providerById.get(account.providerId);
                      const agent = agentById.get(account.agentId);
                      return (
                        <tr
                          className="border-b border-border last:border-b-0 hover:bg-surface-muted"
                          key={account.id}
                        >
                          <td className="px-4 py-3">
                            <span className="block font-semibold text-text">
                              {account.label}
                            </span>
                            <span className="mt-0.5 block text-xs text-text-muted">
                              {account.credentialKeys.length
                                ? `${account.credentialKeys.length} credential field${account.credentialKeys.length === 1 ? '' : 's'} saved`
                                : 'No credential fields saved'}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {provider?.displayName ?? account.providerId}
                          </td>
                          <td className="px-4 py-3">
                            {agent ? (
                              <Link
                                className="font-semibold text-text hover:underline"
                                params={{ agentId: agent.id }}
                                search={{ tab: 'overview' }}
                                to="/agents/$agentId"
                              >
                                {agent.name}
                              </Link>
                            ) : (
                              <span className="text-text-muted">
                                AI employee unavailable
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge status={account.status} />
                            {provider?.status === 'setup_only' ? (
                              <span className="mt-1 block text-xs text-status-attention">
                                Setup only
                              </span>
                            ) : null}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Link
                              params={{ accountId: account.id }}
                              to="/channel-accounts/$accountId"
                            >
                              <Button size="sm" variant="secondary">
                                Manage
                              </Button>
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="grid min-h-40 place-items-center px-4 text-center">
                <div className="grid max-w-sm gap-2">
                  <strong>No channel accounts connected</strong>
                  <p className="m-0 text-sm text-text-secondary">
                    Onboard an AI employee, then connect its channel account in
                    the guided setup.
                  </p>
                </div>
              </div>
            )}
          </Panel>
          <Panel
            title="Provider availability"
            description="Only available runtime providers can activate a conversation. Setup-only providers remain visible so their limit is clear before configuration."
          >
            <div className="grid gap-2 p-1 sm:grid-cols-2 lg:grid-cols-3">
              {providers.data.providers.map((provider) => (
                <div
                  className="rounded-lg border border-border p-3"
                  key={provider.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <strong className="block text-sm">
                        {provider.displayName}
                      </strong>
                      <span className="mt-1 block text-xs text-text-secondary">
                        {provider.credentialKeys.length
                          ? provider.credentialKeys.join(', ')
                          : 'No external secret required'}
                      </span>
                    </div>
                    <StatusBadge status={provider.status} />
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
