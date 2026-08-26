import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ArrowLeft, Power, RefreshCw } from 'lucide-react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { RouteTabs } from '../../../ui/compositions/route-tabs';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../../../ui/primitives/alert-dialog';
import {
  agentDetailQuery,
  agentQueryKeys,
  type AgentDirectoryItem,
} from '../agents-queries';
import { AgentSetupManager } from '../components/agent-setup-manager';

export function AgentDetailRoute() {
  const { agentId } = useParams({ from: '/agents/$agentId' });
  const search = useSearch({ from: '/agents/$agentId' });
  const navigate = useNavigate({ from: '/agents/$agentId' });
  const queryClient = useQueryClient();
  const detail = useQuery(agentDetailQuery(agentId));
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
      if (!response.ok) throw new Error(`Agent could not be ${action}d.`);
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: agentQueryKeys.all }),
  });
  if (detail.isError)
    return (
      <PageState
        action={
          <Button onClick={() => void detail.refetch()}>
            <RefreshCw size={15} aria-hidden="true" />
            Retry
          </Button>
        }
        description="Try loading this agent again."
        icon={<Power size={18} aria-hidden="true" />}
        kind="error"
        title="Agent could not be loaded"
      />
    );
  if (!detail.data)
    return (
      <PageState
        description="Loading the selected agent."
        icon={<Power size={18} aria-hidden="true" />}
        kind="loading"
        title="Loading agent"
      />
    );
  const agent = detail.data.agent;
  const action = agent.status === 'active' ? 'disable' : 'enable';
  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        to="/agents"
        search={{
          tab: 'agents',
          q: '',
          status: 'all',
          page: 1,
          pageSize: 25,
          role: 'all',
          sort: 'name',
          desc: false,
        }}
      >
        <ArrowLeft size={15} aria-hidden="true" />
        Agents
      </Link>
      <PageHeader
        eyebrow="Agent"
        title={agent.name}
        description={`Reusable configuration · ${agent.conversationCount} connected conversations`}
        action={
          <div className="flex gap-2">
            <StatusBadge status={agent.status} />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="secondary" disabled={status.isPending}>
                  <Power size={15} aria-hidden="true" />
                  {action === 'disable' ? 'Disable' : 'Enable'}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {action === 'disable'
                      ? `Disable ${agent.name}?`
                      : `Enable ${agent.name}?`}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {action === 'disable'
                      ? 'It will not be available for new work. Existing configuration is kept.'
                      : 'It will become available for new work again.'}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <Button
                    disabled={status.isPending}
                    onClick={() => status.mutate(action)}
                  >
                    {status.isPending
                      ? 'Saving…'
                      : action === 'disable'
                        ? 'Disable agent'
                        : 'Enable agent'}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        }
      />
      <Panel
        title="Agent configuration"
        description="Only saved configuration is shown."
      >
        <RouteTabs
          label="Agent detail"
          tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'instructions', label: 'Instructions' },
            { value: 'access', label: 'Access' },
            { value: 'settings', label: 'Settings' },
          ]}
          value={search.tab}
          onValueChange={(tab) => void navigate({ search: { tab } })}
        />
        <Content agent={agent} tab={search.tab} />
      </Panel>
    </div>
  );
}

function Content({
  agent,
  tab,
}: {
  agent: AgentDirectoryItem;
  tab: 'overview' | 'instructions' | 'access' | 'settings';
}) {
  if (tab === 'instructions')
    return (
      <pre className="m-0 max-h-96 overflow-auto whitespace-pre-wrap p-5 text-xs leading-5 text-text-secondary">
        {agent.rolePrompt ?? 'No role prompt was saved for this agent.'}
      </pre>
    );
  if (tab === 'access')
    return (
      <div className="grid divide-y divide-border">
        <section>
          <div className="px-5 pt-5">
            <h3 className="text-sm font-semibold">Sources</h3>
          </div>
          <AgentSetupManager
            agentId={agent.id}
            kind="sources"
            disabled={agent.status !== 'active'}
          />
        </section>
        <section>
          <div className="px-5 pt-5">
            <h3 className="text-sm font-semibold">Capabilities</h3>
          </div>
          <AgentSetupManager
            agentId={agent.id}
            kind="capabilities"
            disabled={agent.status !== 'active'}
          />
        </section>
      </div>
    );
  if (tab === 'settings')
    return (
      <div className="grid gap-2 p-5 text-sm text-text-secondary">
        <span>Status: {agent.status}</span>
        <span>
          Configuration version: {agent.configVersion ?? 'No saved version'}
        </span>
        <span>Model: {agent.modelAlias ?? 'Deployment default'}</span>
      </div>
    );
  return (
    <div className="grid gap-2 p-5 text-sm text-text-secondary">
      <span>Role: {agent.roleName ?? 'No role selected'}</span>
      <span>Model: {agent.modelAlias ?? 'Deployment default'}</span>
      <span>{agent.conversationCount} connected conversations</span>
    </div>
  );
}
