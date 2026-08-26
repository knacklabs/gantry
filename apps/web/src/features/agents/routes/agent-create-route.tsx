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
import { SelectField } from '../../../ui/compositions/select-field';
import { Button } from '../../../ui/primitives/button';
import { roleDirectoryQuery } from '../agents-queries';
import { AgentSetupManager } from '../components/agent-setup-manager';

export function AgentCreateRoute() {
  const navigate = useNavigate({ from: '/agents/new' });
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState('built-in:developer');
  const [agentId, setAgentId] = useState<string>();
  const [step, setStep] = useState<
    'base' | 'sources' | 'capabilities' | 'review'
  >('base');
  const roles = useQuery(roleDirectoryQuery({ page: 1, search: '' }));
  const create = useMutation({
    mutationFn: async () => {
      const response = await browserFetch('/ui/api/agents', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...browserCsrfHeader() },
        body: JSON.stringify({ name, roleId }),
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
    if (name.trim()) create.mutate();
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
            <h2 className="font-semibold">Ready to configure</h2>
            <p className="mt-1 text-sm text-text-secondary">
              The base agent is saved. Sources and capabilities can be changed
              later from Access.
            </p>
          </div>
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
              Open agent <ArrowRight size={16} aria-hidden="true" />
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
          <SelectField
            label="Role"
            value={roleId}
            options={(roles.data?.data ?? []).map((role) => ({
              value: role.id,
              label: `${role.name}${role.kind === 'custom' ? ' (custom)' : ''}`,
            }))}
            onValueChange={setRoleId}
          />
          <div className="flex justify-end">
            <Button disabled={!name.trim() || create.isPending} type="submit">
              {create.isPending ? 'Creating…' : 'Create base agent'}{' '}
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
