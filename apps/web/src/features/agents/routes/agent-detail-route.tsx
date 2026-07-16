import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ArrowLeft, Pause, Play, SearchX } from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { RouteTabs, type RouteTab } from '../../../ui/compositions/route-tabs';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import {
  AgentDetailSection,
  type AgentDetailTab,
} from '../components/agent-detail-section';
import { agentPreviewQuery, sourcePreviewQuery } from '../agents-queries';

export function AgentDetailRoute() {
  const { agentId } = useParams({ from: '/agents/$agentId' });
  const search = useSearch({ from: '/agents/$agentId' });
  const navigate = useNavigate({ from: '/agents/$agentId' });
  const { data: agents } = useQuery(agentPreviewQuery);
  const { data: sources } = useQuery(sourcePreviewQuery);
  const { requestConnection } = useConnectionGate();
  const agent = agents.find((item) => item.id === agentId);

  if (!agent) {
    return (
      <PageState
        kind="empty"
        icon={<SearchX size={18} aria-hidden="true" />}
        title="Agent not found"
        description="This preview snapshot does not contain that agent."
      />
    );
  }

  const tabs: RouteTab<AgentDetailTab>[] = [
    { value: 'identity', label: 'Identity' },
    { value: 'profile', label: 'Profile' },
    { value: 'sources', label: 'Sources', count: agent.sources.length },
    {
      value: 'capabilities',
      label: 'Capabilities',
      count: agent.capabilities.length,
    },
    { value: 'skills', label: 'Skills', count: agent.skills.length },
    { value: 'mcp', label: 'MCP', count: agent.mcpServers.length },
    { value: 'access', label: 'Access' },
    {
      value: 'conversations',
      label: 'Conversations',
      count: agent.conversations.length,
    },
  ];
  const pauseLabel = agent.status === 'paused' ? 'Resume agent' : 'Pause agent';

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <Link
        className="inline-flex w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
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
        eyebrow="Agent administration"
        title={agent.name}
        description={`${agent.description} · ${agent.runsToday} runs today · Last run ${agent.lastRun}`}
        action={
          <div className="flex items-center gap-2">
            <StatusBadge status={agent.status} />
            <Button
              variant="secondary"
              onClick={() => requestConnection(`${pauseLabel}: ${agent.name}`)}
            >
              {agent.status === 'paused' ? (
                <Play size={15} aria-hidden="true" />
              ) : (
                <Pause size={15} aria-hidden="true" />
              )}
              {pauseLabel}
            </Button>
          </div>
        }
      />

      <Panel
        title="Agent settings"
        description="Preview desired state. Changes stay local until connected."
      >
        <RouteTabs
          label="Agent settings"
          tabs={tabs}
          value={search.tab}
          onValueChange={(tab) => void navigate({ search: { tab } })}
        />
        <AgentDetailSection agent={agent} sources={sources} tab={search.tab} />
      </Panel>
    </div>
  );
}
