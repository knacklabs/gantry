import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ArrowLeft, Bot, CircleOff, RefreshCw } from 'lucide-react';

import {
  agentRelationQuery,
  agentSummaryQuery,
  uiApiErrorMessage,
  type UiAgentRelation,
} from '../../../lib/ui-api';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { RouteTabs, type RouteTab } from '../../../ui/compositions/route-tabs';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';

type AgentTab =
  | 'identity'
  | 'sources'
  | 'skills'
  | 'capabilities'
  | 'access'
  | 'conversations';

const tabs: RouteTab<AgentTab>[] = [
  { value: 'identity', label: 'Summary' },
  { value: 'sources', label: 'Delegation' },
  { value: 'skills', label: 'Skills' },
  { value: 'capabilities', label: 'Capabilities' },
  { value: 'access', label: 'Access' },
  { value: 'conversations', label: 'Recent activity' },
];

export function RuntimeAgentDetailRoute() {
  const { agentId } = useParams({ from: '/agents/$agentId' });
  const search = useSearch({ from: '/agents/$agentId' });
  const navigate = useNavigate({ from: '/agents/$agentId' });
  const summary = useQuery(agentSummaryQuery(agentId));
  const tab = tabs.some((item) => item.value === search.tab)
    ? (search.tab as AgentTab)
    : 'identity';
  const relation =
    tab === 'identity'
      ? null
      : tab === 'sources'
        ? 'delegation'
        : tab === 'conversations'
          ? 'activity'
          : tab;
  const detail = useQuery({
    ...agentRelationQuery(agentId, relation ?? 'delegation'),
    enabled: relation !== null,
  });

  if (summary.isPending) {
    return (
      <PageState
        description="Reading this agent from Gantry."
        icon={<Bot aria-hidden="true" />}
        kind="loading"
        title="Loading agent"
      />
    );
  }

  if (!summary.data) {
    return (
      <PageState
        action={<Button onClick={() => void summary.refetch()}>Retry</Button>}
        description={uiApiErrorMessage(summary.error)}
        icon={<CircleOff aria-hidden="true" />}
        kind="offline"
        title="Agent is unavailable"
      />
    );
  }

  const agent = summary.data.agent;
  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        search={{
          q: '',
          status: 'all',
          model: 'all',
          page: 1,
          sort: 'name',
          desc: false,
        }}
        to="/agents"
      >
        <ArrowLeft size={15} aria-hidden="true" />
        Agents
      </Link>
      <PageHeader
        eyebrow="Read-only agent"
        title={agent.name}
        description={`${summary.data.boundConversationCount} bound conversations · Updated ${new Date(agent.updatedAt).toLocaleString()}`}
        action={<StatusBadge status={agent.status} />}
      />

      <Panel
        title="Agent inventory"
        description="Configuration and bounded activity load only when selected."
        action={
          tab === 'identity' ? null : (
            <Button
              disabled={detail.isFetching}
              size="sm"
              variant="secondary"
              onClick={() => void detail.refetch()}
            >
              <RefreshCw size={14} aria-hidden="true" />
              {detail.isFetching ? 'Refreshing' : 'Refresh tab'}
            </Button>
          )
        }
      >
        <RouteTabs
          label="Agent inventory"
          tabs={tabs}
          value={tab}
          onValueChange={(tab) => void navigate({ search: { tab } })}
        />
        {tab === 'identity' ? (
          <dl className="m-0 divide-y divide-border px-4">
            <Detail label="Agent ID" value={agent.id} />
            <Detail label="Status" value={agent.status} />
            <Detail
              label="Created"
              value={new Date(agent.createdAt).toLocaleString()}
            />
            <Detail
              label="Updated"
              value={new Date(agent.updatedAt).toLocaleString()}
            />
          </dl>
        ) : (
          <RelationState query={detail} relation={tab} />
        )}
      </Panel>
    </div>
  );
}

function RelationState({
  query,
  relation,
}: {
  query: UseQueryResult<UiAgentRelation, Error>;
  relation: Exclude<AgentTab, 'identity'>;
}) {
  if (query.isPending) {
    return (
      <div className="p-4">
        <PageState
          description={`Reading ${relation} for this agent.`}
          icon={<Bot aria-hidden="true" />}
          kind="loading"
          title={`Loading ${relation}`}
        />
      </div>
    );
  }
  if (!query.data) {
    return (
      <div className="p-4">
        <PageState
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
          description={uiApiErrorMessage(query.error)}
          icon={<CircleOff aria-hidden="true" />}
          kind="offline"
          title={`${relation} is unavailable`}
        />
      </div>
    );
  }
  return <RelationContent data={query.data} />;
}

function RelationContent({ data }: { data: UiAgentRelation }) {
  if ('configured' in data) {
    return (
      <div className="grid gap-5 p-4">
        <section>
          <h3 className="mt-0 text-sm font-semibold text-text">
            Configured delegation
          </h3>
          <p className="text-xs text-text-secondary">
            Desired delegate references, separate from live execution hierarchy.
          </p>
          <BadgeList
            values={data.configured}
            empty="No delegates configured."
          />
        </section>
        <section>
          <h3 className="mt-0 text-sm font-semibold text-text">
            Resolved callable agents
          </h3>
          <BadgeList
            values={data.resolved.map(
              (item) => `${item.displayName} · ${item.persona}`,
            )}
            empty="No configured delegates resolve to callable agents."
          />
        </section>
      </div>
    );
  }
  if ('skills' in data) {
    return (
      <BadgeListPanel
        values={data.skills.map((item) => `${item.skillId} · ${item.status}`)}
        empty="No skills are bound to this agent."
      />
    );
  }
  if ('capabilities' in data) {
    return (
      <BadgeListPanel
        values={data.capabilities.map(
          (item) => `${item.id} · v${item.version}`,
        )}
        empty="No capabilities are selected."
      />
    );
  }
  if ('summary' in data) {
    const groups = Object.entries(data.summary);
    return (
      <div className="grid gap-5 p-4 md:grid-cols-2">
        {groups.map(([group, entries]) => (
          <section key={group}>
            <h3 className="mt-0 text-sm font-semibold capitalize text-text">
              {group.replaceAll(/([A-Z])/g, ' $1')}
            </h3>
            {entries.length ? (
              entries.map((entry) => (
                <div className="mb-3" key={`${entry.label}-${entry.detail}`}>
                  <div className="text-[13px] font-semibold text-text">
                    {entry.label}
                  </div>
                  <div className="text-xs text-text-secondary">
                    {entry.detail}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-xs text-text-secondary">Nothing reported.</p>
            )}
          </section>
        ))}
      </div>
    );
  }
  return data.activity.length ? (
    <div className="divide-y divide-border">
      {data.activity.map((item) => (
        <div
          className="grid gap-1 px-4 py-3 text-[13px] md:grid-cols-[1fr_auto]"
          key={item.id}
        >
          <div>
            <span className="font-semibold text-text">{item.name}</span>
            <span className="ml-2 text-text-secondary">{item.kind}</span>
          </div>
          <StatusBadge status={item.status} />
          <div className="text-xs text-text-secondary md:col-span-2">
            Last run{' '}
            {item.lastRun
              ? new Date(item.lastRun).toLocaleString()
              : 'not reported'}
          </div>
        </div>
      ))}
    </div>
  ) : (
    <BadgeListPanel values={[]} empty="No recent job activity was reported." />
  );
}

function BadgeListPanel({
  values,
  empty,
}: {
  values: string[];
  empty: string;
}) {
  return (
    <div className="p-4">
      <BadgeList values={values} empty={empty} />
    </div>
  );
}

function BadgeList({ values, empty }: { values: string[]; empty: string }) {
  return values.length ? (
    <div className="flex flex-wrap gap-2">
      {values.map((value) => (
        <Badge key={value}>{value}</Badge>
      ))}
    </div>
  ) : (
    <p className="text-sm text-text-secondary">{empty}</p>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-h-14 grid-cols-[120px_minmax(0,1fr)] items-center gap-4 py-3 text-[13px]">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="m-0 truncate font-semibold text-text">{value}</dd>
    </div>
  );
}
