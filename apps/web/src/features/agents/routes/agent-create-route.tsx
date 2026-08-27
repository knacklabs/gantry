import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowRight, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
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
  agentSourcesQuery,
  type AgentCapabilities,
  type AgentDirectoryItem,
  type AgentSource,
  type BrowserRole,
  type CapabilityCatalog,
} from '../agents-queries';
import { AgentRoleSelector } from '../components/agent-role-selector';
import { AgentSetupManager } from '../components/agent-setup-manager';
import {
  RoleEditorDialog,
  type RoleEditorTarget,
} from '../components/role-editor-dialog';

export function AgentCreateRoute() {
  const navigate = useNavigate({ from: '/agents/new' });
  return (
    <AgentCreateDialog
      onClose={() =>
        void navigate({
          to: '/agents',
          search: {
            tab: 'agents',
            q: '',
            status: 'all',
            page: 1,
            pageSize: 25,
            role: 'all',
            sort: 'name',
            desc: false,
          },
          replace: true,
        })
      }
    />
  );
}

export function AgentCreateDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [selectedRole, setSelectedRole] = useState<BrowserRole>();
  const [instructions, setInstructions] = useState('');
  const [baseErrors, setBaseErrors] = useState<{
    name?: string;
    role?: string;
  }>({});
  const [roleEditor, setRoleEditor] = useState<RoleEditorTarget>();
  const [agentId, setAgentId] = useState<string>();
  const [step, setStep] = useState<
    'base' | 'sources' | 'capabilities' | 'review'
  >('base');
  const savedAgent = useQuery({
    ...agentDetailQuery(agentId ?? ''),
    enabled: step === 'review' && !!agentId,
  });
  const savedSources = useQuery({
    ...agentSourcesQuery(agentId ?? ''),
    enabled: step === 'review' && !!agentId,
  });
  const savedCapabilities = useQuery({
    ...agentCapabilitiesQuery(agentId ?? ''),
    enabled: step === 'review' && !!agentId,
  });
  const create = useMutation({
    mutationFn: async () => {
      const response = await browserFetch('/ui/api/agents', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...browserCsrfHeader() },
        body: JSON.stringify({ name, roleId: selectedRole?.id }),
      });
      if (!response.ok) throw new Error('The base agent could not be created.');
      return response.json() as Promise<{ agent: { id: string } }>;
    },
    onSuccess: ({ agent }) => {
      setAgentId(agent.id);
      setStep('sources');
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = {
      name: name.trim() ? undefined : 'Enter an agent name.',
      role: selectedRole ? undefined : 'Select a role.',
    };
    setBaseErrors(errors);
    if (!errors.name && !errors.role) create.mutate();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="h-[calc(100dvh-46px)] max-h-[900px] w-[min(940px,calc(100vw-32px))] max-w-none grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="grid gap-1">
            <DialogTitle className="text-lg font-semibold">
              Create agent
            </DialogTitle>
            <DialogDescription className="text-xs text-text-secondary">
              Build the identity first, then optionally connect sources and
              allow actions.
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              aria-label="Close create agent dialog"
              size="icon-sm"
              variant="ghost"
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </DialogClose>
        </header>
        <ol
          className="grid grid-cols-4 border-b border-border bg-surface-muted text-xs font-semibold text-text-secondary"
          aria-label="Creation steps"
        >
          {(['base', 'sources', 'capabilities', 'review'] as const).map(
            (item, index) => (
              <li
                className={
                  item === step
                    ? 'border-r border-border bg-surface px-3 py-3 text-text last:border-r-0'
                    : 'border-r border-border px-3 py-3 last:border-r-0'
                }
                key={item}
              >
                <span className="block font-mono text-[10px]">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="mt-1 block">
                  {item === 'base'
                    ? 'Agent'
                    : item[0].toUpperCase() + item.slice(1)}
                </span>
              </li>
            ),
          )}
        </ol>
        <div className="min-h-0 overflow-y-auto p-5">
          {step === 'sources' && agentId ? (
            <section className="grid gap-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="m-0 text-lg font-semibold">
                    Connect existing sources
                  </h2>
                  <p className="mt-1 mb-0 text-sm text-text-secondary">
                    Sources expose reviewed inventory. They do not grant
                    actions.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setStep('capabilities')}
                >
                  Skip for now
                </Button>
              </div>
              <AgentSetupManager
                agentId={agentId}
                kind="sources"
                onBack={() => setStep('base')}
                onSaved={() => setStep('capabilities')}
              />
            </section>
          ) : null}
          {step === 'capabilities' && agentId ? (
            <section className="grid gap-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="m-0 text-lg font-semibold">
                    Allow capabilities
                  </h2>
                  <p className="mt-1 mb-0 text-sm text-text-secondary">
                    Choose durable actions for this agent. Risky use may still
                    ask for approval.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setStep('review')}
                >
                  Skip for now
                </Button>
              </div>
              <AgentSetupManager
                agentId={agentId}
                kind="capabilities"
                onBack={() => setStep('sources')}
                onSaved={() => setStep('review')}
              />
            </section>
          ) : null}
          {step === 'review' && agentId ? (
            <section className="grid gap-4 rounded-lg border border-border bg-surface p-6">
              <div>
                <h2 className="font-semibold">Review setup</h2>
                <p className="mt-1 text-sm text-text-secondary">
                  These are the saved settings that will apply on the agent’s
                  next run.
                </p>
              </div>
              {savedAgent.data &&
              savedSources.data &&
              savedCapabilities.data ? (
                <ReviewSummary
                  agent={savedAgent.data.agent}
                  capabilities={savedCapabilities.data}
                  sources={savedSources.data}
                />
              ) : (
                <p className="text-sm text-text-secondary">
                  Loading saved setup…
                </p>
              )}
              <div className="flex justify-between">
                <Button
                  variant="secondary"
                  onClick={() => setStep('capabilities')}
                >
                  Back
                </Button>
                <Button
                  onClick={() =>
                    void navigate({
                      to: '/agents/$agentId',
                      params: { agentId },
                      search: { tab: 'overview' },
                    })
                  }
                >
                  Finish setup <ArrowRight size={16} aria-hidden="true" />
                </Button>
              </div>
            </section>
          ) : null}
          {step === 'base' ? (
            <form id="agent-base-form" className="grid gap-4" onSubmit={submit}>
              <div className="grid gap-3 md:grid-cols-[1.2fr_.8fr]">
                <TextField
                  id="agent-name"
                  aria-required="true"
                  label={
                    <>
                      Agent name{' '}
                      <span className="text-danger" aria-hidden="true">
                        *
                      </span>
                    </>
                  }
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setBaseErrors((errors) => ({ ...errors, name: undefined }));
                  }}
                  error={
                    baseErrors.name ??
                    (create.isError ? create.error.message : undefined)
                  }
                  placeholder="Customer research"
                  autoFocus
                />
                <label className="grid gap-1.5 text-xs font-semibold text-text">
                  Model
                  <select
                    className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] text-text"
                    disabled
                    value="default"
                  >
                    <option value="default">Use deployment default</option>
                  </select>
                </label>
              </div>
              <AgentRoleSelector
                error={baseErrors.role}
                value={selectedRole}
                onChange={(role) => {
                  setSelectedRole(role);
                  setBaseErrors((errors) => ({ ...errors, role: undefined }));
                }}
                onCreateCustom={() => setRoleEditor({ mode: 'create' })}
              />
              <label className="grid gap-1.5 text-xs font-semibold text-text">
                Additional instructions{' '}
                <span className="font-normal text-text-secondary">
                  Optional · applies only to this agent
                </span>
                <textarea
                  className="min-h-24 rounded-md border border-border-strong bg-surface p-3 text-[13px] text-text"
                  placeholder="Example: Keep every report under two pages and finish with three recommended actions…"
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </label>
            </form>
          ) : null}
          <RoleEditorDialog
            target={roleEditor}
            onOpenChange={(open) => !open && setRoleEditor(undefined)}
            onSaved={setSelectedRole}
          />
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-border bg-surface-muted px-5 py-3">
          <span className="text-xs text-text-secondary">
            Step{' '}
            {step === 'base'
              ? 1
              : step === 'sources'
                ? 2
                : step === 'capabilities'
                  ? 3
                  : 4}{' '}
            of 4 ·{' '}
            {step === 'base'
              ? 'Create the reusable identity first.'
              : step === 'sources'
                ? 'Optional · select existing reviewed sources.'
                : step === 'capabilities'
                  ? 'Optional · choose durable agent authority.'
                  : 'Review saved configuration and finish.'}
          </span>
          {step === 'base' ? (
            <Button
              disabled={create.isPending}
              form="agent-base-form"
              type="submit"
            >
              {create.isPending ? 'Creating…' : 'Create and continue'}{' '}
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          ) : null}
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function ReviewSummary({
  agent,
  capabilities,
  sources,
}: {
  agent: AgentDirectoryItem;
  capabilities: { capabilities: AgentCapabilities; catalog: CapabilityCatalog };
  sources: { sources: { sources: AgentSource }; catalog: CapabilityCatalog };
}) {
  const skills = sources.sources.sources.skills;
  const mcpServers = sources.sources.sources.mcpServers;
  const selectedCapabilities = capabilities.capabilities.capabilities;
  const sourceLabels = new Map<string, string>([
    ...(sources.catalog.skills ?? []).map(
      (source) => [source.id, source.name] as const,
    ),
    ...(sources.catalog.mcpServers ?? []).map(
      (source) => [source.id, source.displayName ?? source.name] as const,
    ),
  ]);
  const capabilityLabels = new Map<string, string>(
    (capabilities.catalog.capabilities ?? []).map(
      (capability) =>
        [`${capability.id}:${capability.version}`, capability.label] as const,
    ),
  );
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <ReviewCard
        title="Identity & behavior"
        lines={[
          ['Name', agent.name],
          ['Role snapshot', agent.roleName ?? 'No role selected'],
          ['Model', 'Deployment default'],
          ['Instructions', 'Not configured'],
        ]}
      />
      <ReviewCard
        title="Sources"
        lines={[
          [
            'Skills',
            skills.length
              ? skills
                  .map((item) => sourceLabels.get(item.id) ?? item.id)
                  .join(', ')
              : 'None selected',
          ],
          [
            'MCP servers',
            mcpServers.length
              ? mcpServers
                  .map((item) => sourceLabels.get(item.id) ?? item.id)
                  .join(', ')
              : 'None selected',
          ],
        ]}
      />
      <ReviewCard
        title="Allowed capabilities"
        lines={
          selectedCapabilities.length
            ? selectedCapabilities.map((capability) => [
                capabilityLabels.get(
                  `${capability.id}:${capability.version}`,
                ) ?? capability.id,
                capability.id.includes('write') ? 'Write' : 'Read',
              ])
            : [['Access', 'None selected']]
        }
      />
      <section className="rounded-lg border border-border p-4">
        <h3 className="m-0 text-sm font-semibold">Activation</h3>
        <p className="mt-3 mb-0 rounded-lg border border-status-attention/40 bg-status-attention-soft p-3 text-sm">
          Source and capability changes are <strong>available next run</strong>.
          No conversations or scheduled jobs use this agent yet.
        </p>
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 rounded-lg border border-border bg-surface-muted p-3 text-center text-xs">
          <span>
            <strong className="block">{agent.roleName ?? 'None'}</strong>
            <small className="text-text-secondary">Role snapshot</small>
          </span>
          <span>→</span>
          <span>
            <strong className="block">
              {skills.length + mcpServers.length} selected
            </strong>
            <small className="text-text-secondary">Sources</small>
          </span>
          <span>→</span>
          <span>
            <strong className="block">
              {selectedCapabilities.length} allowed
            </strong>
            <small className="text-text-secondary">Capabilities</small>
          </span>
        </div>
      </section>
    </div>
  );
}

function ReviewCard({
  title,
  lines,
}: {
  title: string;
  lines: [string, string][];
}) {
  return (
    <section className="rounded-lg border border-border p-4">
      <h3 className="m-0 text-sm font-semibold">{title}</h3>
      <dl className="mt-3">
        {lines.map(([label, value]) => (
          <div
            className="flex min-h-8 items-center justify-between gap-4 border-t border-border py-2 text-sm first:border-t-0 first:pt-0"
            key={label}
          >
            <dt>{label}</dt>
            <dd className="m-0 text-right font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
