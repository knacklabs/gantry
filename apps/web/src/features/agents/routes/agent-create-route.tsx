import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Bot } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { PageHeader } from '../../../ui/compositions/page-header';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
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
  const [name, setName] = useState('');
  const [selectedRole, setSelectedRole] = useState<BrowserRole>();
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
    if (name.trim() && selectedRole) create.mutate();
  }

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-6">
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
        <ArrowLeft size={15} aria-hidden="true" /> Agents
      </Link>
      <PageHeader
        eyebrow="New agent"
        title="Create an agent"
        description="Start with a durable base configuration. Sources and capabilities are added separately after it is saved."
      />
      <ol
        className="grid grid-cols-4 gap-2 text-xs font-semibold text-text-secondary"
        aria-label="Creation steps"
      >
        {(['base', 'sources', 'capabilities', 'review'] as const).map(
          (item, index) => (
            <li
              className={
                item === step
                  ? 'rounded bg-surface-muted px-2 py-1 text-text'
                  : 'px-2 py-1'
              }
              key={item}
            >
              {index + 1}.{' '}
              {item === 'base'
                ? 'Base agent'
                : item[0].toUpperCase() + item.slice(1)}
            </li>
          ),
        )}
      </ol>
      {step === 'sources' && agentId ? (
        <section className="rounded-lg border border-border bg-surface">
          <div className="border-b border-border p-5">
            <h2 className="font-semibold">Sources</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Save this independently, then select authority.
            </p>
          </div>
          <AgentSetupManager
            agentId={agentId}
            kind="sources"
            onSaved={() => setStep('capabilities')}
          />
          <div className="flex justify-between border-t border-border p-4">
            <Button variant="secondary" onClick={() => setStep('base')}>
              Back
            </Button>
            <Button variant="secondary" onClick={() => setStep('capabilities')}>
              Skip for now
            </Button>
          </div>
        </section>
      ) : null}
      {step === 'capabilities' && agentId ? (
        <section className="rounded-lg border border-border bg-surface">
          <div className="border-b border-border p-5">
            <h2 className="font-semibold">Capabilities</h2>
            <p className="mt-1 text-sm text-text-secondary">
              This is the agent’s saved tool authority.
            </p>
          </div>
          <AgentSetupManager
            agentId={agentId}
            kind="capabilities"
            onSaved={() => setStep('review')}
          />
          <div className="flex justify-between border-t border-border p-4">
            <Button variant="secondary" onClick={() => setStep('sources')}>
              Back
            </Button>
            <Button variant="secondary" onClick={() => setStep('review')}>
              Skip for now
            </Button>
          </div>
        </section>
      ) : null}
      {step === 'review' && agentId ? (
        <section className="grid gap-4 rounded-lg border border-border bg-surface p-6">
          <div>
            <h2 className="font-semibold">Review setup</h2>
            <p className="mt-1 text-sm text-text-secondary">
              These are the saved settings that will apply on the agent’s next
              run.
            </p>
          </div>
          {savedAgent.data && savedSources.data && savedCapabilities.data ? (
            <ReviewSummary
              agent={savedAgent.data.agent}
              capabilities={savedCapabilities.data}
              sources={savedSources.data}
            />
          ) : (
            <p className="text-sm text-text-secondary">Loading saved setup…</p>
          )}
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep('capabilities')}>
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
        <form
          className="grid gap-6 rounded-lg border border-border bg-surface p-6"
          onSubmit={submit}
        >
          <div className="flex items-start gap-3 rounded-md bg-surface-muted p-4 text-sm text-text-secondary">
            <Bot className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
            <span>
              An agent is a reusable configuration, not an always-running bot.
              It becomes available for new work as soon as its base
              configuration is saved.
            </span>
          </div>
          <TextField
            id="agent-name"
            label="Agent name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={create.isError ? create.error.message : undefined}
            placeholder="Customer research"
            autoFocus
          />
          <AgentRoleSelector
            value={selectedRole}
            onChange={setSelectedRole}
            onCreateCustom={() => setRoleEditor({ mode: 'create' })}
          />
          {selectedRole ? (
            <section className="grid gap-2 rounded-md bg-surface-muted p-4">
              <span className="text-xs font-semibold text-text">
                {selectedRole.name} prompt
              </span>
              <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap text-xs leading-5 text-text-secondary">
                {selectedRole.prompt}
              </pre>
            </section>
          ) : null}
          <p className="m-0 text-xs text-text-secondary">
            This agent uses the deployment default model. Agent-specific
            instructions are not available until Gantry can save them as a
            versioned runtime configuration.
          </p>
          <div className="flex justify-end">
            <Button
              disabled={!name.trim() || !selectedRole || create.isPending}
              type="submit"
            >
              {create.isPending ? 'Creating…' : 'Create and continue'}{' '}
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </div>
        </form>
      ) : null}
      <RoleEditorDialog
        target={roleEditor}
        onOpenChange={(open) => !open && setRoleEditor(undefined)}
        onSaved={setSelectedRole}
      />
    </div>
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
  const selectedSources = [
    ...sources.sources.sources.skills.map((source) => source.id),
    ...sources.sources.sources.mcpServers.map((source) => source.id),
  ];
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
    <dl className="grid gap-3 rounded-md bg-surface-muted p-4 text-sm">
      <div>
        <dt className="text-xs font-semibold text-text-secondary">Agent</dt>
        <dd className="m-0 text-text">{agent.name}</dd>
      </div>
      <div>
        <dt className="text-xs font-semibold text-text-secondary">Role</dt>
        <dd className="m-0 text-text">
          {agent.roleName ?? 'No role selected'}
        </dd>
        {agent.rolePrompt ? (
          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-xs leading-5 text-text-secondary">
            {agent.rolePrompt}
          </pre>
        ) : null}
      </div>
      <div>
        <dt className="text-xs font-semibold text-text-secondary">Model</dt>
        <dd className="m-0 text-text">Deployment default</dd>
      </div>
      <div>
        <dt className="text-xs font-semibold text-text-secondary">Sources</dt>
        <dd className="m-0 text-text">
          {selectedSources.length
            ? selectedSources
                .map((source) => sourceLabels.get(source) ?? source)
                .join(', ')
            : 'Skipped'}
        </dd>
      </div>
      <div>
        <dt className="text-xs font-semibold text-text-secondary">
          Allowed capabilities
        </dt>
        <dd className="m-0 text-text">
          {selectedCapabilities.length
            ? selectedCapabilities
                .map(
                  (capability) =>
                    capabilityLabels.get(
                      `${capability.id}:${capability.version}`,
                    ) ?? capability.id,
                )
                .join(', ')
            : 'Skipped'}
        </dd>
      </div>
    </dl>
  );
}
