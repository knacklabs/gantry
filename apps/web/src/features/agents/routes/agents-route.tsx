import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Bot, ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-react';
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
import { AgentDirectoryTable } from '../components/agent-directory-table';
import { AgentsDirectoryToolbar } from '../components/agents-directory-toolbar';
import { RolesLibrary } from '../components/roles-library';
import { RolesLibraryToolbar } from '../components/roles-library-toolbar';
import { AgentCreateDialog } from './agent-create-route';

export function AgentsRoute() {
  const search = useSearch({ from: '/agents' });
  const navigate = useNavigate({ from: '/agents' });
  const [createOpen, setCreateOpen] = useState(false);
  const roles = useQuery(roleDirectoryQuery({ page: 1, search: '' }));
  const builtInRoles = useQuery(
    roleDirectoryQuery({ page: 1, search: '', kind: 'built-in' }),
  );
  const customRoles = useQuery(
    roleDirectoryQuery({ page: search.page, search: search.q, kind: 'custom' }),
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

  return (
    <div className="mx-auto w-full max-w-[1240px]">
      <PageHeader
        eyebrow="Administration"
        title="Agents"
        description="Reusable identities, instructions, models, and access for work Gantry runs."
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} aria-hidden="true" />
            New agent
          </Button>
        }
      />
      <div className="mt-5">
        <RouteTabs
          label="Agents administration"
          tabs={[
            { value: 'agents', label: 'Agents' },
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
            <RolesLibraryToolbar
              search={search.q}
              onChange={(q) =>
                void navigate({ search: { ...search, q, page: 1 } })
              }
            />
            {search.q ? (
              <div>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void navigate({ search: { ...search, q: '', page: 1 } })
                  }
                >
                  Clear search
                </Button>
              </div>
            ) : null}
            <RolesLibrary
              builtIns={builtInRoles.data}
              data={customRoles.data}
              error={builtInRoles.isError || customRoles.isError}
              loading={builtInRoles.isLoading || customRoles.isLoading}
              onPageChange={(page) =>
                void navigate({ search: { ...search, page } })
              }
              onRetry={() => {
                void builtInRoles.refetch();
                void customRoles.refetch();
              }}
            />
          </>
        ) : (
          <>
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
            {directory.isError ? (
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
                title="Agents could not be loaded"
              />
            ) : (
              <>
                <MobileAgentList
                  agents={directory.data?.data ?? []}
                  emptyMessage={
                    hasFilters
                      ? 'No agents match these filters.'
                      : 'Create an agent to give Gantry a reusable configuration for work.'
                  }
                  page={search.page}
                  pageCount={
                    directory.data
                      ? Math.max(
                          1,
                          Math.ceil(
                            directory.data.total / directory.data.pageSize,
                          ),
                        )
                      : 1
                  }
                  total={directory.data?.total ?? 0}
                  onPageChange={(page) =>
                    void navigate({ search: { ...search, page } })
                  }
                />
                <AgentDirectoryTable
                  agents={directory.data?.data ?? []}
                  emptyMessage={
                    hasFilters
                      ? 'No agents match these filters.'
                      : 'Create an agent to give Gantry a reusable configuration for work.'
                  }
                  page={search.page}
                  pageSize={search.pageSize}
                  total={directory.data?.total ?? 0}
                  onPageChange={(page) =>
                    void navigate({ search: { ...search, page } })
                  }
                  onPageSizeChange={(pageSize) =>
                    void navigate({
                      search: {
                        ...search,
                        pageSize: pageSize as typeof search.pageSize,
                        page: 1,
                      },
                    })
                  }
                  onRowClick={(agent) =>
                    void navigate({
                      to: '/agents/$agentId',
                      params: { agentId: agent.id },
                      search: { tab: 'overview' },
                    })
                  }
                />
              </>
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

function MobileAgentList({
  agents,
  emptyMessage,
  page,
  pageCount,
  total,
  onPageChange,
}: {
  agents: AgentDirectoryItem[];
  emptyMessage: string;
  page: number;
  pageCount: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <Panel
      className="md:hidden"
      title="Agent directory"
      description={`${total} agents`}
    >
      <div className="grid max-h-[calc(100vh-25rem)] min-h-56 overflow-y-auto">
        {agents.length ? (
          agents.map((agent) => (
            <Link
              className="grid gap-1 border-b border-border p-4 text-sm text-text no-underline last:border-0 hover:bg-surface-muted"
              key={agent.id}
              params={{ agentId: agent.id }}
              search={{ tab: 'overview' }}
              to="/agents/$agentId"
            >
              <span className="font-semibold">{agent.name}</span>
              <span className="flex items-center gap-2 text-xs text-text-secondary">
                <StatusBadge status={agent.status} />
                {agent.roleName ?? 'No role selected'}
              </span>
              <span className="text-xs text-text-secondary">
                {agent.conversationCount} connected ·{' '}
                {agent.modelAlias ?? 'Deployment default'}
              </span>
            </Link>
          ))
        ) : (
          <p className="m-0 p-4 text-center text-sm text-text-secondary">
            {emptyMessage}
          </p>
        )}
      </div>
      <div className="flex min-h-14 items-center justify-between border-t border-border px-4 text-xs text-text-secondary">
        <span>
          Page {page} of {pageCount}
        </span>
        <div className="flex gap-1">
          <Button
            aria-label="Previous page"
            disabled={page <= 1}
            size="icon"
            title="Previous page"
            variant="outline"
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </Button>
          <Button
            aria-label="Next page"
            disabled={page >= pageCount}
            size="icon"
            title="Next page"
            variant="outline"
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </Panel>
  );
}
