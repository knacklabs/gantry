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
import { type ReactNode, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { PageState } from '../../../ui/compositions/page-state';
import { RouteTabs } from '../../../ui/compositions/route-tabs';
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
  agentCapabilitiesQuery,
  agentDetailQuery,
  agentQueryKeys,
  agentSourcesQuery,
  type AgentDirectoryItem,
} from '../agents-queries';
import { AgentSetupManager } from '../components/agent-setup-manager';
import { AgentSettings } from '../components/agent-settings';
import { AgentVersionHistory } from '../components/agent-version-history';

export function AgentDetailRoute() {
  const { agentId } = useParams({ from: '/agents/$agentId' });
  const search = useSearch({ from: '/agents/$agentId' });
  const navigate = useNavigate({ from: '/agents/$agentId' });
  const queryClient = useQueryClient();
  const detail = useQuery(agentDetailQuery(agentId));
  const [statusOpen, setStatusOpen] = useState(false);
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
            <RefreshCw size={15} />
            Retry
          </Button>
        }
        description="Try loading this agent again."
        icon={<Power size={18} />}
        kind="error"
        title="Agent could not be loaded"
      />
    );
  if (!detail.data)
    return (
      <PageState
        description="Loading the selected agent."
        icon={<Power size={18} />}
        kind="loading"
        title="Loading agent"
      />
    );

  const agent = detail.data.agent;
  const action = agent.status === 'active' ? 'disable' : 'enable';
  const label = action === 'disable' ? 'Disable' : 'Enable';
  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-4">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-1 text-xs font-semibold text-text-secondary no-underline hover:text-text"
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
        <ArrowLeft size={15} aria-hidden="true" /> Back to agents
      </Link>
      <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-panel">
        <header className="flex flex-col gap-4 border-b border-border px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-lg border border-status-attention/40 bg-status-attention-soft font-mono text-sm font-semibold text-status-attention">
              {initials(agent.name)}
            </span>
            <div className="min-w-0">
              <p className="mb-1 font-mono text-[10px] font-semibold tracking-[0.14em] text-text-secondary uppercase">
                Agent configuration
              </p>
              <h1 className="m-0 text-2xl font-semibold tracking-tight text-text">
                {agent.name}
              </h1>
              <p className="mt-1 mb-2 text-sm text-text-secondary">
                {agent.roleName
                  ? `${agent.roleName} role configuration.`
                  : 'Reusable agent configuration.'}
              </p>
              <div className="flex flex-wrap gap-2">
                <StatusPill status={agent.status} />
                <Badge variant="attention">
                  {agent.conversationCount
                    ? `${agent.conversationCount} conversations`
                    : 'Not connected'}
                </Badge>
                <Badge variant="neutral">Scheduled jobs unavailable</Badge>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <AgentVersionHistory agent={agent} />
            <Button
              disabled={status.isPending}
              variant={action === 'disable' ? 'destructive' : 'secondary'}
              onClick={() => setStatusOpen(true)}
            >
              {label}
            </Button>
          </div>
        </header>
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
        <Content
          agent={agent}
          tab={search.tab}
          onStatusRequest={() => setStatusOpen(true)}
        />
      </section>
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
    </div>
  );
}

function Content({
  agent,
  tab,
  onStatusRequest,
}: {
  agent: AgentDirectoryItem;
  tab: 'overview' | 'instructions' | 'access' | 'settings';
  onStatusRequest: () => void;
}) {
  if (tab === 'overview') return <Overview agent={agent} />;
  if (tab === 'instructions') return <Instructions agent={agent} />;
  if (tab === 'access') return <Access agent={agent} />;
  return <AgentSettings agent={agent} onStatusRequest={onStatusRequest} />;
}

function Overview({ agent }: { agent: AgentDirectoryItem }) {
  const sources = useQuery(agentSourcesQuery(agent.id));
  const capabilities = useQuery(agentCapabilitiesQuery(agent.id));
  const sourceCount = sources.data
    ? sources.data.sources.sources.skills.length +
      sources.data.sources.sources.mcpServers.length
    : null;
  const capabilityCount =
    capabilities.data?.capabilities.capabilities.length ?? null;
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1.7fr_0.9fr]">
      <InfoCard
        title="Configuration overview"
        description="The current reusable identity and its runtime-facing setup."
      >
        <dl className="grid gap-2 sm:grid-cols-2">
          <Fact
            label="Status"
            value={agent.status === 'active' ? 'Active' : 'Disabled'}
          />
          <Fact
            label="Role snapshot"
            value={agent.roleName ?? 'No role selected'}
          />
          <Fact
            label="Model"
            value={agent.modelAlias ?? 'Deployment default'}
          />
          <Fact
            label="Config version"
            value={
              agent.configVersion
                ? `v${agent.configVersion}`
                : 'No saved version'
            }
          />
        </dl>
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center rounded-md border border-border bg-surface-muted px-3 py-3 text-center text-xs">
          <Assembly label="Role" value={agent.roleName ?? 'None'} />
          <ArrowRight className="text-text-muted" size={15} />
          <Assembly
            label="Sources"
            value={
              sourceCount === null ? 'Loading' : `${sourceCount} connected`
            }
          />
          <ArrowRight className="text-text-muted" size={15} />
          <Assembly
            label="Capabilities"
            value={
              capabilityCount === null
                ? 'Loading'
                : `${capabilityCount} allowed`
            }
          />
        </div>
      </InfoCard>
      <div className="grid content-start gap-4">
        <InfoCard
          title="Connections"
          description="Conversation and scheduled-job ownership stay separate."
        >
          <dl className="grid gap-2 text-sm">
            <FactRow
              label="Conversations"
              value={
                agent.conversationCount
                  ? `${agent.conversationCount} connected`
                  : 'Not connected'
              }
            />
            <FactRow
              label="Scheduled jobs"
              value="Not available in this view"
            />
          </dl>
        </InfoCard>
        <InfoCard
          title="Current setup"
          description="Only concrete status signals appear here."
        >
          <StatusPill status={agent.status} />
        </InfoCard>
      </div>
    </div>
  );
}

function Instructions({ agent }: { agent: AgentDirectoryItem }) {
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1.4fr_0.9fr]">
      <InfoCard
        title="Role snapshot"
        description={
          agent.configVersion
            ? `Copied into this agent at v${agent.configVersion}.`
            : 'No saved configuration version.'
        }
      >
        <p className="mb-2 text-sm font-semibold">
          {agent.roleName ?? 'No role selected'}
        </p>
        <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-muted p-3 text-xs leading-5 text-text-secondary">
          {agent.rolePrompt ?? 'No role prompt was saved for this agent.'}
        </pre>
      </InfoCard>
      <InfoCard
        title="Agent-specific instructions"
        description="Additional instructions are not currently stored separately."
      >
        <p className="m-0 text-sm text-text-secondary">
          This agent uses its saved role snapshot only.
        </p>
        <div className="mt-4 border-t border-border pt-3 text-xs text-text-secondary">
          Last changed {formatDate(agent.updatedAt)}
        </div>
      </InfoCard>
    </div>
  );
}

function Access({ agent }: { agent: AgentDirectoryItem }) {
  const [editing, setEditing] = useState<'sources' | 'capabilities' | null>(
    null,
  );
  const sources = useQuery(agentSourcesQuery(agent.id));
  const capabilities = useQuery(agentCapabilitiesQuery(agent.id));
  const sourceItems = sources.data?.sources.sources;
  const allowed = capabilities.data?.capabilities.capabilities ?? [];
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-2">
      <InfoCard
        title="Sources"
        description="Installed skills and active MCP servers connected to this agent."
      >
        <SummaryList
          empty="No sources connected."
          items={[
            ...(sourceItems?.skills.map((item) => item.name ?? item.id) ?? []),
            ...(sourceItems?.mcpServers.map((item) => item.id) ?? []),
          ]}
        />
        <Button
          className="mt-4"
          disabled={agent.status !== 'active'}
          variant="secondary"
          onClick={() => setEditing(editing === 'sources' ? null : 'sources')}
        >
          {editing === 'sources' ? 'Done editing sources' : 'Edit sources'}
        </Button>
        {editing === 'sources' ? (
          <AgentSetupManager
            agentId={agent.id}
            kind="sources"
            onSaved={() => setEditing(null)}
          />
        ) : null}
      </InfoCard>
      <InfoCard
        title="Capabilities"
        description="Tool capabilities this agent is allowed to use."
      >
        <SummaryList
          empty="No capabilities allowed."
          items={allowed.map((item) => `${item.id}@${item.version}`)}
        />
        <Button
          className="mt-4"
          disabled={agent.status !== 'active'}
          variant="secondary"
          onClick={() =>
            setEditing(editing === 'capabilities' ? null : 'capabilities')
          }
        >
          {editing === 'capabilities'
            ? 'Done editing capabilities'
            : 'Edit capabilities'}
        </Button>
        {editing === 'capabilities' ? (
          <AgentSetupManager
            agentId={agent.id}
            kind="capabilities"
            onSaved={() => setEditing(null)}
          />
        ) : null}
      </InfoCard>
    </div>
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
              ? 'Gantry will reject new sessions and delegation to this agent.'
              : 'Gantry will allow new sessions and delegation to this agent again.'}
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
              <strong className="block">This does not delete the agent.</strong>
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
            {pending ? 'Saving…' : `${disabling ? 'Disable' : 'Enable'} agent`}
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
function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border pb-2 last:border-0 last:pb-0">
      <dt>{label}</dt>
      <dd className="text-right font-semibold">{value}</dd>
    </div>
  );
}
function Assembly({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <strong className="block text-xs">{value}</strong>
      <span className="mt-1 block font-mono text-[9px] tracking-wide text-text-secondary uppercase">
        {label}
      </span>
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
