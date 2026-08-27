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
import { type ReactNode, useEffect, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { PageState } from '../../../ui/compositions/page-state';
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import {
  agentCapabilitiesQuery,
  agentDetailQuery,
  agentQueryKeys,
  agentSourcesQuery,
  type AgentDirectoryItem,
  type BrowserRole,
} from '../agents-queries';
import { AgentRoleSelector } from '../components/agent-role-selector';
import { AgentSetupManager } from '../components/agent-setup-manager';
import { AgentSettings } from '../components/agent-settings';
import { AgentVersionHistory } from '../components/agent-version-history';
import {
  RoleEditorDialog,
  type RoleEditorTarget,
} from '../components/role-editor-dialog';

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
                {!agent.roleName ? (
                  <Badge variant="attention">No role assigned</Badge>
                ) : null}
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
              className={
                action === 'disable'
                  ? 'border-danger/60 bg-surface px-3 text-xs font-semibold text-danger shadow-panel hover:bg-danger-soft'
                  : 'border-border-strong bg-surface px-3 text-xs font-semibold shadow-panel hover:bg-surface-muted'
              }
              size="sm"
              variant="outline"
              onClick={() => setStatusOpen(true)}
            >
              {label}
            </Button>
          </div>
        </header>
        <DetailTabs
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

function DetailTabs({
  onValueChange,
  value,
}: {
  onValueChange: (
    value: 'overview' | 'instructions' | 'access' | 'settings',
  ) => void;
  value: 'overview' | 'instructions' | 'access' | 'settings';
}) {
  const tabs = ['overview', 'instructions', 'access', 'settings'] as const;
  return (
    <nav
      aria-label="Agent detail"
      className="flex gap-0 border-y border-border bg-surface-muted px-[18px]"
    >
      {tabs.map((tab) => (
        <button
          aria-current={value === tab ? 'page' : undefined}
          className="border-b-2 border-transparent bg-transparent px-[13px] pt-[11px] pb-[10px] text-xs font-semibold text-text-muted capitalize hover:text-text data-[active=true]:border-text data-[active=true]:bg-surface data-[active=true]:text-text"
          data-active={value === tab}
          key={tab}
          type="button"
          onClick={() => onValueChange(tab)}
        >
          {tab}
        </button>
      ))}
    </nav>
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
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const hasRole = Boolean(agent.roleName && agent.rolePrompt);
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1.4fr_0.9fr]">
      <InfoCard
        title={hasRole ? 'Role snapshot' : 'No role assigned'}
        description={
          hasRole && agent.configVersion
            ? `Copied into this agent at v${agent.configVersion}.`
            : 'This agent currently uses Gantry’s default Developer behavior.'
        }
      >
        {hasRole ? (
          <>
            <p className="mb-2 text-sm font-semibold">{agent.roleName}</p>
            <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-muted p-3 text-xs leading-5 text-text-secondary">
              {agent.rolePrompt}
            </pre>
          </>
        ) : (
          <p className="m-0 text-sm text-text-secondary">
            Assign a role to give this agent a reusable, visible behavior
            prompt. Its runtime, safety, and access rules remain separate.
          </p>
        )}
        <Button
          className="mt-4"
          variant="secondary"
          onClick={() => setRoleDialogOpen(true)}
        >
          {hasRole ? 'Update role' : 'Assign role'}
        </Button>
      </InfoCard>
      <InfoCard
        title="How role changes work"
        description="Role changes are versioned with this agent."
      >
        <p className="m-0 text-sm text-text-secondary">
          New work uses the saved role snapshot. Work already running keeps its
          current prompt.
        </p>
        <div className="mt-4 border-t border-border pt-3 text-xs text-text-secondary">
          Last changed {formatDate(agent.updatedAt)}
        </div>
      </InfoCard>
      <RoleAssignmentDialog
        agent={agent}
        open={roleDialogOpen}
        onOpenChange={setRoleDialogOpen}
      />
    </div>
  );
}

function RoleAssignmentDialog({
  agent,
  onOpenChange,
  open,
}: {
  agent: AgentDirectoryItem;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedRole, setSelectedRole] = useState<BrowserRole>();
  const [roleEditor, setRoleEditor] = useState<RoleEditorTarget>();
  const hasRole = Boolean(agent.roleName && agent.rolePrompt);
  useEffect(() => {
    if (!open || !agent.roleId || !agent.roleName || !agent.rolePrompt) return;
    setSelectedRole({
      id: agent.roleId,
      name: agent.roleName,
      prompt: agent.rolePrompt,
      kind: agent.roleId.startsWith('built-in:') ? 'built-in' : 'custom',
    });
  }, [agent.roleId, agent.roleName, agent.rolePrompt, open]);
  const saveRole = useMutation({
    mutationFn: async () => {
      if (!selectedRole) throw new Error('Select a role.');
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agent.id)}`,
        {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            ...browserCsrfHeader(),
          },
          body: JSON.stringify({ name: agent.name, roleId: selectedRole.id }),
        },
      );
      if (!response.ok) throw new Error('Role could not be updated.');
    },
    onSuccess: async () => {
      await queryClient.refetchQueries({
        queryKey: agentDetailQuery(agent.id).queryKey,
        type: 'active',
      });
      await queryClient.invalidateQueries({
        queryKey: agentQueryKeys.all,
        refetchType: 'active',
      });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="grid max-h-[calc(100dvh-46px)] w-[min(940px,calc(100vw-32px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="grid gap-1">
            <DialogTitle className="text-lg font-semibold">
              {hasRole ? 'Update role' : 'Assign role'}
            </DialogTitle>
            <DialogDescription className="text-xs text-text-secondary">
              Choose the reusable behavior prompt for {agent.name}.
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              aria-label="Close role dialog"
              size="icon-sm"
              variant="ghost"
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </DialogClose>
        </header>
        <div className="min-h-0 overflow-y-auto p-5">
          <AgentRoleSelector
            currentRoleId={agent.roleId}
            error={saveRole.isError ? saveRole.error.message : undefined}
            value={selectedRole}
            onChange={setSelectedRole}
            onCreateCustom={() => setRoleEditor({ mode: 'create' })}
          />
          <p className="mt-4 mb-0 text-xs text-text-secondary">
            A changed role creates a new configuration version. New work uses
            it; running work is unchanged.
          </p>
          <RoleEditorDialog
            target={roleEditor}
            onOpenChange={(nextOpen) => !nextOpen && setRoleEditor(undefined)}
            onSaved={setSelectedRole}
          />
        </div>
        <footer className="flex items-center justify-end gap-3 border-t border-border bg-surface-muted px-5 py-3">
          <DialogClose asChild>
            <Button disabled={saveRole.isPending} variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={!selectedRole || saveRole.isPending}
            onClick={() => saveRole.mutate()}
          >
            {saveRole.isPending
              ? 'Saving…'
              : hasRole
                ? 'Update role'
                : 'Assign role'}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function Access({ agent }: { agent: AgentDirectoryItem }) {
  const [editor, setEditor] = useState<'sources' | 'capabilities' | null>(null);
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
          onClick={() => setEditor('sources')}
        >
          Edit sources
        </Button>
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
          onClick={() => setEditor('capabilities')}
        >
          Edit capabilities
        </Button>
      </InfoCard>
      <AgentAccessEditorDialog
        agent={agent}
        kind={editor}
        onOpenChange={(open) => !open && setEditor(null)}
        onSaved={async () => {
          await Promise.all([sources.refetch(), capabilities.refetch()]);
          setEditor(null);
        }}
      />
    </div>
  );
}

function AgentAccessEditorDialog({
  agent,
  kind,
  onOpenChange,
  onSaved,
}: {
  agent: AgentDirectoryItem;
  kind: 'sources' | 'capabilities' | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const isSources = kind === 'sources';
  const formId = kind ? `agent-${kind}-edit-form` : undefined;
  const title = isSources ? 'Connect existing sources' : 'Allow capabilities';
  const description = isSources
    ? 'Optional · select reviewed skills and MCP servers. Sources expose inventory; they do not grant actions.'
    : 'Optional · choose durable actions for this agent. Risky use may still ask for approval.';
  return (
    <Dialog open={kind !== null} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="grid h-fit max-h-[min(900px,calc(100dvh-46px))] w-[min(940px,calc(100vw-32px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="grid gap-1">
            <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
            <DialogDescription className="text-xs text-text-secondary">
              {description}
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button aria-label="Close access editor" size="icon-sm" variant="ghost">
              <X size={16} aria-hidden="true" />
            </Button>
          </DialogClose>
        </header>
        <div className="min-h-0 overflow-y-auto p-5">
          {kind ? (
            <AgentSetupManager
              agentId={agent.id}
              formId={formId}
              kind={kind}
              onSaved={() => void onSaved()}
              onSavingChange={setSaving}
            />
          ) : null}
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-border bg-surface-muted px-5 py-3">
          <p className="m-0 text-xs text-text-secondary">
            {isSources
              ? 'Sources become available on the next run.'
              : 'Saved capabilities are durable agent authority.'}
          </p>
          <div className="flex items-center gap-3">
            <DialogClose asChild>
              <Button disabled={saving} variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button disabled={saving} form={formId} type="submit">
              {saving ? 'Saving…' : `Save ${isSources ? 'sources' : 'capabilities'}`}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
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
