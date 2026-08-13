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
  isTerminalActivityStatus,
  uiApiErrorMessage,
  type UiAgentSummary,
  type UiAgentRelation,
} from '../../../lib/ui-api';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';

type AgentTab = 'summary' | 'delegation' | 'skills' | 'access' | 'activity';
const tabs: Array<{ value: AgentTab; label: string }> = [
  { value: 'summary', label: 'Summary' },
  { value: 'delegation', label: 'Delegation' },
  { value: 'skills', label: 'Skills & capabilities' },
  { value: 'access', label: 'Access' },
  { value: 'activity', label: 'Activity' },
];

function canonicalTab(value: string): AgentTab {
  if (value === 'sources') return 'delegation';
  if (value === 'skills' || value === 'capabilities') return 'skills';
  if (value === 'access') return 'access';
  if (value === 'conversations' || value === 'activity') return 'activity';
  return 'summary';
}

export function RuntimeAgentDetailRoute() {
  const { agentId } = useParams({ from: '/agents/$agentId' });
  const search = useSearch({ from: '/agents/$agentId' });
  const navigate = useNavigate({ from: '/agents/$agentId' });
  const tab = canonicalTab(search.tab);
  const summary = useQuery(agentSummaryQuery(agentId));
  const delegation = useQuery({
    ...agentRelationQuery(agentId, 'delegation'),
    enabled: tab === 'delegation',
  });
  const skills = useQuery({
    ...agentRelationQuery(agentId, 'skills'),
    enabled: tab === 'skills',
  });
  const capabilities = useQuery({
    ...agentRelationQuery(agentId, 'capabilities'),
    enabled: tab === 'skills',
  });
  const access = useQuery({
    ...agentRelationQuery(agentId, 'access'),
    enabled: tab === 'access',
  });
  const activity = useQuery({
    ...agentRelationQuery(agentId, 'activity'),
    enabled: tab === 'activity',
    refetchInterval: (query) => {
      const value = query.state.data;
      return value &&
        'runs' in value &&
        value.runs.some((run) => !isTerminalActivityStatus(run.status))
        ? 30_000
        : false;
    },
  });

  if (summary.isPending)
    return (
      <PageState
        description="Reading this agent from Gantry."
        icon={<Bot aria-hidden="true" />}
        kind="loading"
        title="Loading agent"
      />
    );
  if (!summary.data)
    return (
      <PageState
        action={<Button onClick={() => void summary.refetch()}>Retry</Button>}
        description={uiApiErrorMessage(summary.error)}
        icon={<CircleOff aria-hidden="true" />}
        kind="offline"
        title="Agent is unavailable"
      />
    );

  const refresh =
    tab === 'summary'
      ? null
      : {
          delegation,
          skills,
          access,
          activity,
        }[tab];
  return (
    <div className="agent-profile mx-auto grid w-full max-w-[1120px] gap-6">
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
        <ArrowLeft size={15} aria-hidden="true" /> Agents
      </Link>
      <PageHeader
        eyebrow="Read-only agent profile"
        title={summary.data.agent.name}
        description="Configuration and observed work for this agent."
        action={<StatusBadge status={summary.data.agent.status} />}
      />
      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-dashed border-border py-3 text-xs text-text-secondary">
        <span>This deployment's instance health is tracked separately.</span>
        <Link
          className="font-semibold text-text no-underline hover:underline"
          to="/instances"
        >
          View instances
        </Link>
      </div>
      <Panel
        title="Agent record"
        description="Read-only configuration and observed work."
        action={
          tab === 'summary' ? null : (
            <Button
              disabled={refresh?.isFetching}
              size="sm"
              variant="secondary"
              onClick={() => void refresh?.refetch()}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Refresh
            </Button>
          )
        }
      >
        <div
          aria-label="Agent profile sections"
          className="flex flex-wrap gap-1 border-b border-dashed border-border p-3"
          role="tablist"
        >
          {tabs.map((item) => (
            <button
              aria-selected={tab === item.value}
              className={`rounded-md px-3 py-2 text-xs font-semibold ${tab === item.value ? 'bg-surface-muted text-text shadow-sm' : 'text-text-secondary hover:text-text'}`}
              key={item.value}
              role="tab"
              type="button"
              onClick={() => void navigate({ search: { tab: item.value } })}
            >
              {item.label}
            </button>
          ))}
        </div>
        {tab === 'summary' ? <Summary data={summary.data} /> : null}
        {tab === 'delegation' ? (
          <Async
            data={delegation.data}
            error={delegation.error}
            pending={delegation.isPending}
          >
            <Delegation data={delegation.data} rootId={agentId} />
          </Async>
        ) : null}
        {tab === 'skills' ? (
          <SkillsCapabilities skills={skills} capabilities={capabilities} />
        ) : null}
        {tab === 'access' ? (
          <Async
            data={access.data}
            error={access.error}
            pending={access.isPending}
          >
            <Access data={access.data} />
          </Async>
        ) : null}
        {tab === 'activity' ? (
          <Async
            data={activity.data}
            error={activity.error}
            pending={activity.isPending}
          >
            <Activity data={activity.data} />
          </Async>
        ) : null}
      </Panel>
    </div>
  );
}

function Summary({ data }: { data: UiAgentSummary }) {
  const tiles = [
    ['Configured delegates', data.counts.configuredDelegates],
    ['Bound skills', data.counts.boundSkills],
    ['Selected capabilities', data.counts.selectedCapabilities],
    ['Access needing attention', data.counts.access?.needsAttention ?? null],
  ];
  return (
    <div className="grid gap-4 p-4">
      <dl className="grid gap-3 text-sm md:grid-cols-2">
        <Detail label="Persisted status" value={data.agent.status} />
        <Detail label="Agent ID" value={data.agent.id} />
        <Detail
          label="Updated"
          value={new Date(data.agent.updatedAt).toLocaleString()}
        />
        <Detail
          label="Bound conversations"
          value={String(data.boundConversationCount)}
        />
      </dl>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map(([label, value]) => (
          <div
            className="rounded-lg border border-dashed border-border bg-surface-muted p-3"
            key={String(label)}
          >
            <div className="text-xs text-text-secondary">{label}</div>
            <div className="mt-1 text-lg font-semibold text-text">
              {value === null ? 'Unavailable' : value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Async({
  data,
  error,
  pending,
  children,
}: {
  data: UiAgentRelation | undefined;
  error: unknown;
  pending: boolean;
  children: import('react').ReactNode;
}) {
  if (pending)
    return (
      <div className="p-4 text-sm text-text-secondary">Loading section…</div>
    );
  if (!data)
    return (
      <div className="p-4">
        <PageState
          description={uiApiErrorMessage(error)}
          icon={<CircleOff aria-hidden="true" />}
          kind="offline"
          title="Section unavailable"
        />
      </div>
    );
  return <>{children}</>;
}

function Delegation({
  data,
  rootId,
}: {
  data: UiAgentRelation | undefined;
  rootId: string;
}) {
  if (!data || !('configured' in data)) return null;
  return (
    <div className="grid gap-4 p-4">
      <p className="m-0 text-sm text-text-secondary">
        Configured delegation is intended composition, not live execution.
      </p>
      <div className="rounded-lg border border-dashed border-border p-4">
        <div className="font-semibold text-text">{rootId}</div>
        {data.configured.map((ref) => (
          <div
            className="ml-4 mt-3 border-l border-dashed border-border pl-4"
            key={ref}
          >
            {data.resolved.find((item) => item.ref === ref)?.agentId ? (
              <Link
                className="font-semibold text-text"
                params={{
                  agentId: data.resolved.find((item) => item.ref === ref)!
                    .agentId,
                }}
                search={{ tab: 'summary' }}
                to="/agents/$agentId"
              >
                {data.resolved.find((item) => item.ref === ref)!.displayName}
              </Link>
            ) : (
              <span className="text-text-secondary">{ref}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SkillsCapabilities({
  skills,
  capabilities,
}: {
  skills: UseQueryResult<UiAgentRelation, Error>;
  capabilities: UseQueryResult<UiAgentRelation, Error>;
}) {
  if (skills.isPending || capabilities.isPending)
    return (
      <div className="p-4 text-sm text-text-secondary">
        Loading skills and capabilities…
      </div>
    );
  const skillData =
    skills.data && 'skills' in skills.data ? skills.data.skills : [];
  const capData =
    capabilities.data && 'capabilities' in capabilities.data
      ? capabilities.data.capabilities
      : [];
  return (
    <div className="grid gap-6 p-4">
      <section>
        <h3 className="mt-0 text-sm font-semibold text-text">Bound skills</h3>
        {skillData.length ? (
          skillData.map((item) => (
            <div
              className="border-b border-dashed border-border py-3"
              key={item.id}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-text">{item.name}</span>
                <Badge>{item.status}</Badge>
              </div>
              {item.description ? (
                <p className="mb-1 text-xs text-text-secondary">
                  {item.description}
                </p>
              ) : null}
              <time className="text-xs text-text-secondary">
                {new Date(item.updatedAt).toLocaleString()}
              </time>
            </div>
          ))
        ) : (
          <p className="text-sm text-text-secondary">
            No skills are bound to this agent.
          </p>
        )}
      </section>
      <section>
        <h3 className="mt-0 text-sm font-semibold text-text">
          Selected capabilities
        </h3>
        {capData.length ? (
          capData.map((item) => (
            <div
              className="border-b border-dashed border-border py-3"
              key={item.id}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-text">
                  {item.displayName}
                </span>
                <Badge>{item.category ?? 'Unavailable'}</Badge>
                <Badge>{item.risk ?? 'Unavailable'}</Badge>
                <span className="text-xs text-text-secondary">
                  v{item.version}
                </span>
              </div>
              {item.can ? (
                <p className="mb-1 text-xs text-text-secondary">
                  Can: {item.can}
                </p>
              ) : null}
              {item.cannot ? (
                <p className="m-0 text-xs text-text-secondary">
                  Cannot: {item.cannot}
                </p>
              ) : null}
            </div>
          ))
        ) : (
          <p className="text-sm text-text-secondary">
            No capabilities are selected.
          </p>
        )}
      </section>
    </div>
  );
}

function Access({ data }: { data: UiAgentRelation | undefined }) {
  if (!data || !('summary' in data)) return null;
  return (
    <div className="grid gap-5 p-4 md:grid-cols-2">
      {Object.entries(data.summary).map(([group, entries]) => (
        <section key={group}>
          <h3 className="mt-0 text-sm font-semibold capitalize text-text">
            {group.replaceAll(/([A-Z])/g, ' $1')}
          </h3>
          {entries.length ? (
            entries.map((entry) => (
              <div className="mb-3" key={entry.label}>
                <div className="text-sm font-semibold text-text">
                  {entry.label}
                </div>
                <div className="text-xs text-text-secondary">
                  {entry.detail}
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-text-secondary">Nothing reported.</p>
          )}
        </section>
      ))}
    </div>
  );
}

function Activity({ data }: { data: UiAgentRelation | undefined }) {
  if (!data || !('runs' in data)) return null;
  return (
    <div className="divide-y divide-dashed divide-border">
      {data.runs.length ? (
        data.runs.map((run) => (
          <Link
            className="grid gap-1 px-4 py-3 no-underline hover:bg-surface-muted md:grid-cols-[1fr_auto]"
            key={run.id}
            params={{ runId: run.id }}
            to="/activity/$runId"
          >
            <div>
              <div className="font-semibold text-text">{run.cause}</div>
              <div className="text-xs text-text-secondary">
                {new Date(run.createdAt).toLocaleString()}
              </div>
            </div>
            <StatusBadge status={run.status} />
          </Link>
        ))
      ) : (
        <p className="p-4 text-sm text-text-secondary">
          No recent runs for this agent.
        </p>
      )}
      {data.jobs.map((job) => (
        <div
          className="grid gap-1 px-4 py-3 md:grid-cols-[1fr_auto]"
          key={job.id}
        >
          <div>
            <div className="font-semibold text-text">{job.name}</div>
            <div className="text-xs text-text-secondary">{job.kind}</div>
          </div>
          <StatusBadge status={job.status} />
        </div>
      ))}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="m-0 truncate font-semibold text-text">{value}</dd>
    </div>
  );
}
