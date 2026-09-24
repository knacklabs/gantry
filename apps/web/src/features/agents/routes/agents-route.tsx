import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bot, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { GantryMark } from '../../../ui/compositions/gantry-logo';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { Button } from '../../../ui/primitives/button';
import {
  channelAccountsQuery,
  channelProvidersQuery,
} from '../../channel-accounts/channel-account-queries';
import { agentDirectoryQuery } from '../agents-queries';
import { agentModelLabel } from '../agent-model-label';
import { AgentCreateDialog } from './agent-create-route';

export function AgentsRoute() {
  const [createOpen, setCreateOpen] = useState(false);
  const directory = useQuery(
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
  const accounts = useQuery(channelAccountsQuery());
  const providers = useQuery(channelProvidersQuery());
  const providerNames = new Map(
    (providers.data?.providers ?? []).map((provider) => [
      provider.id,
      provider.displayName,
    ]),
  );

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={15} />
            Onboard an AI employee
          </Button>
        }
        eyebrow="Employees"
        title="Roster"
        description="Review your AI employees, the channels they work in, and their current status."
      />
      <Panel className="border-white/20! bg-[linear-gradient(180deg,rgb(127_127_127_/_10%),rgb(127_127_127_/_4%))]! shadow-[inset_-1px_0_0_rgb(255_255_255_/_4%)]! backdrop-blur-[22px]! backdrop-saturate-150!">
        {directory.isLoading && !directory.data ? (
          <PageState
            description="Loading AI employees."
            icon={<Bot size={18} />}
            kind="loading"
            title="Loading roster"
          />
        ) : directory.isError || accounts.isError || providers.isError ? (
          <PageState
            action={
              <Button onClick={() => void directory.refetch()}>
                <RefreshCw size={15} />
                Retry
              </Button>
            }
            description="Try loading the roster again."
            icon={<Bot size={18} />}
            kind="error"
            title="Roster could not be loaded"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left">
              <thead className="border-b border-border bg-surface-muted font-mono text-[10px] font-medium tracking-[0.1em] text-text-muted uppercase">
                <tr>
                  <th className="px-6 py-3">Employee</th>
                  <th className="px-6 py-3">Channel</th>
                  <th className="px-6 py-3">AI provider / model</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3 text-right">Today</th>
                </tr>
              </thead>
              <tbody>
                {(directory.data?.data ?? []).map((agent) => {
                  const account = (accounts.data?.accounts ?? []).find(
                    (item) => item.agentId === agent.id,
                  );
                  return (
                    <tr
                      className="border-b border-border last:border-b-0 hover:bg-surface-muted/70"
                      key={agent.id}
                    >
                      <td className="px-6 py-4">
                        <Link
                          className="flex items-center gap-3 no-underline"
                          params={{ agentId: agent.id }}
                          search={{ tab: 'overview' }}
                          to="/agents/$agentId"
                        >
                          <span className="grid size-11 place-items-center rounded-[11px] border border-border bg-surface-strong text-text">
                            <GantryMark className="size-5" />
                          </span>
                          <span>
                            <span className="block text-[15px] font-semibold text-text">
                              {agent.name}
                            </span>
                            <span className="mt-0.5 block text-[12px] text-text-secondary">
                              {agent.roleName ?? 'AI employee'}
                            </span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-6 py-4">
                        <span className="block font-mono text-[12px] text-text-secondary">
                          {account
                            ? (providerNames.get(account.providerId) ??
                              account.providerId)
                            : 'Not assigned'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="block text-[12px] font-medium text-text-secondary">
                          {agent.modelProviderLabel ?? 'Deployment default'}
                        </span>
                        <span className="mt-1 block text-[11px] text-text-muted">
                          {agentModelLabel(
                            agent.modelDisplayName,
                            agent.modelProviderId,
                            agent.modelProviderLabel,
                          )}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center gap-2 text-[13px] text-text-secondary">
                          <i
                            className={`size-2 rounded-full ${agent.status === 'active' ? 'bg-emerald-400' : 'bg-text-muted'}`}
                          />
                          {agent.status === 'active' ? 'On shift' : 'Paused'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right font-mono text-[13px] text-text-secondary">
                        —
                      </td>
                    </tr>
                  );
                })}
                {!directory.data?.data.length ? (
                  <tr>
                    <td
                      className="px-6 py-16 text-center text-sm text-text-secondary"
                      colSpan={5}
                    >
                      No AI employees yet. Onboard one to start your roster.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {createOpen ? (
        <AgentCreateDialog onClose={() => setCreateOpen(false)} />
      ) : null}
    </div>
  );
}
