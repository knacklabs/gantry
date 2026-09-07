import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Bot, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { RouteTabs } from '../../../ui/compositions/route-tabs';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import {
  agentDirectoryQuery,
  roleDirectoryQuery,
  type AgentDirectoryItem,
} from '../agents-queries';
import { AgentsDirectoryToolbar } from '../components/agents-directory-toolbar';
import { RolesLibrary } from '../components/roles-library';
import { AgentCreateDialog } from './agent-create-route';
import { peopleDirectoryQuery } from '../../people/people-queries';
import { Badge } from '../../../ui/primitives/badge';
import {
  channelAccountsQuery,
  channelProvidersQuery,
} from '../../channel-accounts/channel-account-queries';

export function AgentsRoute() {
  const search = useSearch({ from: '/agents' });
  const navigate = useNavigate({ from: '/agents' });
  const [createOpen, setCreateOpen] = useState(false);
  const people = useQuery(peopleDirectoryQuery);
  const accounts = useQuery(channelAccountsQuery());
  const providers = useQuery(channelProvidersQuery());
  const roles = useQuery(
    roleDirectoryQuery({ page: 1, pageSize: 25, search: '' }),
  );
  const builtInRoles = useQuery(
    roleDirectoryQuery({ page: 1, pageSize: 25, search: '', kind: 'built-in' }),
  );
  const customRoles = useQuery(
    roleDirectoryQuery({
      page: search.page,
      pageSize: search.pageSize,
      search: search.q,
      kind: 'custom',
    }),
  );
  const directory = useQuery(
    agentDirectoryQuery({
      page: search.page,
      pageSize: search.pageSize,
      search: search.q,
      status: search.status,
      role: search.role,
      sort: search.sort,
      direction: search.desc ? 'desc' : 'asc',
    }),
  );
  const hasFilters = Boolean(
    search.q || search.status !== 'all' || search.role !== 'all',
  );
  const peopleVisible = (people.data?.people ?? []).filter((person) => {
    const query = search.q.trim().toLowerCase();
    return (
      person.kind === 'human' &&
      (!query ||
        `${person.displayName} ${person.aliases.map((alias) => `${alias.provider} ${alias.displayName ?? ''}`).join(' ')}`
          .toLowerCase()
          .includes(query))
    );
  });
  const showEmployees = search.kind !== 'people';
  const showPeople = search.kind !== 'employees';

  return (
    <div className="mx-auto w-full max-w-[1240px]">
      <PageHeader
        eyebrow="Administration"
        title="Directory"
        description="People and AI employees. Review their identities, conversations, and access."
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} aria-hidden="true" />
            New AI employee
          </Button>
        }
      />
      <div className="mt-5">
        <RouteTabs
          label="AI employee administration"
          tabs={[
            { value: 'agents', label: 'Directory' },
            { value: 'roles', label: 'Roles' },
          ]}
          value={search.tab}
          onValueChange={(tab) =>
            void navigate({ search: { ...search, tab, page: 1 } })
          }
        />
      </div>

      <div className="mt-[18px] grid gap-[14px]">
        {search.tab === 'roles' ? (
          <>
            <RolesLibrary
              builtIns={builtInRoles.data}
              data={customRoles.data}
              error={builtInRoles.isError || customRoles.isError}
              loading={builtInRoles.isLoading || customRoles.isLoading}
              search={search.q}
              onSearchChange={(q) =>
                void navigate({ search: { ...search, q, page: 1 } })
              }
              onPageChange={(page) =>
                void navigate({ search: { ...search, page } })
              }
              onPageSizeChange={(pageSize) =>
                void navigate({
                  search: {
                    ...search,
                    page: 1,
                    pageSize: pageSize as typeof search.pageSize,
                  },
                })
              }
              onRetry={() => {
                void builtInRoles.refetch();
                void customRoles.refetch();
              }}
            />
          </>
        ) : (
          <>
            <DirectoryKindPicker
              counts={{
                employees: directory.data?.total ?? 0,
                people:
                  people.data?.people.filter(
                    (person) => person.kind === 'human',
                  ).length ?? 0,
              }}
              value={search.kind}
              onValueChange={(kind) =>
                void navigate({ search: { ...search, kind, page: 1 } })
              }
            />
            <AgentsDirectoryToolbar
              roleOptions={roles.data?.data ?? []}
              search={search}
              onChange={(next) =>
                void navigate({ search: { ...search, ...next } })
              }
            />
            {hasFilters ? (
              <div>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void navigate({
                      search: {
                        ...search,
                        q: '',
                        status: 'all',
                        role: 'all',
                        page: 1,
                      },
                    })
                  }
                >
                  Clear filters
                </Button>
              </div>
            ) : null}
            {directory.isLoading && !directory.data ? (
              <PageState
                description="Loading AI employees."
                icon={<Bot size={18} aria-hidden="true" />}
                kind="loading"
                title="Loading AI employees"
              />
            ) : directory.isError ||
              people.isError ||
              accounts.isError ||
              providers.isError ? (
              <PageState
                action={
                  <Button onClick={() => void directory.refetch()}>
                    <RefreshCw size={15} aria-hidden="true" />
                    Retry
                  </Button>
                }
                description="Your filters were kept. Try loading this directory again."
                icon={<Bot size={18} aria-hidden="true" />}
                kind="error"
                title="AI employees could not be loaded"
              />
            ) : (
              <DirectoryTable
                accounts={accounts.data?.accounts ?? []}
                agents={showEmployees ? (directory.data?.data ?? []) : []}
                emptyMessage={
                  hasFilters
                    ? 'No directory entries match these filters.'
                    : 'Create an AI employee or wait for a recognized person to appear in a connected conversation.'
                }
                people={showPeople ? peopleVisible : []}
                providerNames={
                  new Map(
                    (providers.data?.providers ?? []).map((provider) => [
                      provider.id,
                      provider.displayName,
                    ]),
                  )
                }
              />
            )}
          </>
        )}
      </div>
      {createOpen ? (
        <AgentCreateDialog onClose={() => setCreateOpen(false)} />
      ) : null}
    </div>
  );
}

function DirectoryKindPicker({
  counts,
  onValueChange,
  value,
}: {
  counts: { employees: number; people: number };
  onValueChange: (value: 'all' | 'employees' | 'people') => void;
  value: 'all' | 'employees' | 'people';
}) {
  const options = [
    ['all', 'All', counts.employees + counts.people],
    ['employees', 'AI employees', counts.employees],
    ['people', 'People', counts.people],
  ] as const;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Directory kind">
      {options.map(([next, label, count]) => (
        <Button
          className={
            value === next
              ? 'border-text bg-surface-strong text-text'
              : undefined
          }
          key={next}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => onValueChange(next)}
        >
          {label} · {count}
        </Button>
      ))}
    </div>
  );
}

function DirectoryTable({
  accounts,
  agents,
  emptyMessage,
  people,
  providerNames,
}: {
  accounts: Array<{
    agentId: string;
    id: string;
    label: string;
    providerId: string;
  }>;
  agents: AgentDirectoryItem[];
  emptyMessage: string;
  people: Array<{
    aliases: Array<{
      id: string;
      provider: string;
      verificationStatus: string;
    }>;
    displayName: string;
    id: string;
    status: string;
  }>;
  providerNames: Map<string, string>;
}) {
  return (
    <Panel
      title="Directory entries"
      description="People are recognized identities. Approval authority belongs to each conversation, not to a global directory role."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="border-y border-border bg-surface-muted font-mono text-[10px] font-semibold tracking-[0.08em] text-text-muted uppercase">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Seats & accounts</th>
              <th className="px-4 py-3">Access</th>
              <th className="px-4 py-3">Role / identity</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const ownedAccounts = accounts.filter(
                (account) => account.agentId === agent.id,
              );
              return (
                <tr
                  className="border-b border-border last:border-b-0 hover:bg-surface-muted"
                  key={`agent:${agent.id}`}
                >
                  <td className="px-4 py-3">
                    <Link
                      className="block font-semibold text-text no-underline hover:underline"
                      params={{ agentId: agent.id }}
                      search={{ tab: 'overview' }}
                      to="/agents/$agentId"
                    >
                      {agent.name}
                    </Link>
                    <span className="mt-0.5 block text-xs text-text-muted">
                      AI employee
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {ownedAccounts.length ? (
                      <div className="flex flex-wrap gap-1">
                        {ownedAccounts.map((account) => (
                          <Badge key={account.id} variant="outline">
                            {providerNames.get(account.providerId) ??
                              account.providerId}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      'No channel account'
                    )}
                    <span className="mt-1 block text-xs text-text-muted">
                      {agent.conversationCount} conversation
                      {agent.conversationCount === 1 ? '' : 's'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {agent.rolePrompt ? 'Configured' : 'Needs instructions'}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {agent.roleName ?? 'No role selected'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={agent.status} />
                  </td>
                </tr>
              );
            })}
            {people.map((person) => (
              <tr
                className="border-b border-border last:border-b-0 hover:bg-surface-muted"
                key={`person:${person.id}`}
              >
                <td className="px-4 py-3">
                  <span className="block font-semibold text-text">
                    {person.displayName}
                  </span>
                  <span className="mt-0.5 block text-xs text-text-muted">
                    Person
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {person.aliases.length ? (
                      person.aliases.map((alias) => (
                        <Badge key={alias.id} variant="outline">
                          {alias.provider}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-text-muted">No aliases</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-text-secondary">
                  Recognized identity
                </td>
                <td className="px-4 py-3 text-text-secondary">
                  Provider identity
                </td>
                <td className="px-4 py-3">
                  <StatusBadge
                    status={person.status === 'active' ? 'active' : 'disabled'}
                  />
                </td>
              </tr>
            ))}
            {!agents.length && !people.length ? (
              <tr>
                <td
                  className="px-4 py-16 text-center text-text-secondary"
                  colSpan={5}
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
