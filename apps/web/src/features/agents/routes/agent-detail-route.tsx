import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Pause,
  Pencil,
  Play,
  Save,
  SearchX,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { useRuntimeConnection } from '../../../lib/api/runtime-connection';
import { RuntimeApiError } from '../../../lib/api/runtime-transport';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import { IconButton } from '../../../ui/primitives/icon-button';
import {
  loadAgent,
  loadAgentSoul,
  updateAgent,
  updateAgentSoul,
} from '../agents-api';
import { agentQueryKeys } from '../agents-queries';

type AgentHarness = 'auto' | 'anthropic_sdk' | 'deepagents';

export function AgentDetailRoute() {
  const { agentId } = useParams({ from: '/agents/$agentId' });
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [showProtected, setShowProtected] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'active' | 'disabled'>('active');
  const [agentHarness, setAgentHarness] = useState<AgentHarness>('auto');
  const [soulContent, setSoulContent] = useState('');
  const {
    data: agent,
    isPending,
    isError,
  } = useQuery({
    queryKey: [...agentQueryKeys.list(), agentId],
    enabled: Boolean(connection.transport),
    queryFn: () => loadAgent(connection.transport!, agentId),
  });
  const soul = useQuery({
    queryKey: [...agentQueryKeys.list(), agentId, 'soul'],
    enabled: Boolean(connection.transport && agent),
    queryFn: () => loadAgentSoul(connection.transport!, agentId),
  });

  useEffect(() => {
    if (!agent) return;
    setName(agent.name);
    setDescription(agent.description ?? '');
    setStatus(agent.status);
    setAgentHarness(agent.agentHarness);
  }, [agent]);
  useEffect(() => {
    if (soul.data) setSoulContent(soul.data.content);
  }, [soul.data]);

  const saveAgent = useMutation({
    mutationFn: () =>
      updateAgent(connection.transport!, agentId, {
        name,
        description,
        status,
        agentHarness,
      }),
    onSuccess: async () => {
      await invalidateAgent(queryClient, agentId);
    },
  });
  const saveSoul = useMutation({
    mutationFn: () =>
      updateAgentSoul(connection.transport!, agentId, {
        content: soulContent,
        expectedVersion: soul.data!.version,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...agentQueryKeys.list(), agentId, 'soul'],
      });
    },
  });
  const toggle = useMutation({
    mutationFn: () =>
      updateAgent(connection.transport!, agentId, {
        status: agent?.status === 'active' ? 'disabled' : 'active',
      }),
    onSuccess: async () => {
      await invalidateAgent(queryClient, agentId);
    },
  });

  if (isPending) return <LoadingState />;
  if (isError || !agent) return <NotFoundState />;

  const discardEdits = () => {
    setName(agent.name);
    setDescription(agent.description ?? '');
    setStatus(agent.status);
    setAgentHarness(agent.agentHarness);
    setSoulContent(soul.data?.content ?? '');
    setIsEditing(false);
  };
  const saveAll = async () => {
    await saveAgent.mutateAsync();
    if (soul.data && soulContent !== soul.data.content)
      await saveSoul.mutateAsync();
    setIsEditing(false);
  };
  const pause = agent.status === 'active';
  const error = mutationError(saveAgent.error) ?? mutationError(saveSoul.error);

  return (
    <div className="mx-auto grid w-full max-w-[960px] gap-6">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        to="/agents"
        search={{
          q: '',
          status: 'all',
          model: 'all',
          page: 1,
          sort: 'name',
          desc: false,
          setup: undefined,
        }}
      >
        <ArrowLeft size={15} />
        Agents
      </Link>
      <PageHeader
        eyebrow="Agent administration"
        title={agent.name}
        description={agent.description ?? 'No purpose has been set.'}
        action={
          <div className="flex flex-wrap justify-end gap-2">
            <StatusBadge status={agent.status} />
            {isEditing ? (
              <>
                <Button variant="secondary" onClick={discardEdits}>
                  <X size={15} /> Cancel
                </Button>
                <Button
                  disabled={
                    !name.trim() || saveAgent.isPending || saveSoul.isPending
                  }
                  variant="primary"
                  onClick={() => void saveAll()}
                >
                  <Save size={15} />
                  {saveAgent.isPending || saveSoul.isPending
                    ? 'Saving…'
                    : 'Save changes'}
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={() => toggle.mutate()}>
                  {pause ? <Pause size={15} /> : <Play size={15} />}
                  {pause ? 'Pause agent' : 'Resume agent'}
                </Button>
                <Button variant="primary" onClick={() => setIsEditing(true)}>
                  <Pencil size={15} /> Edit
                </Button>
              </>
            )}
          </div>
        }
      />
      {error ? (
        <p className="m-0 rounded-md border border-danger bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <IdentityPanel
        editing={isEditing}
        name={name}
        description={description}
        onNameChange={setName}
        onDescriptionChange={setDescription}
      />
      <RuntimePanel
        editing={isEditing}
        status={status}
        harness={agentHarness}
        createdAt={agent.createdAt}
        updatedAt={agent.updatedAt}
        onStatusChange={setStatus}
        onHarnessChange={setAgentHarness}
      />
      <ProfilePanel
        editing={isEditing}
        content={soulContent}
        isLoading={soul.isPending}
        error={soul.isError ? 'SOUL.md could not be loaded.' : undefined}
        onChange={setSoulContent}
      />
      <ProtectedPanel
        agentId={agent.id}
        profilePath={soul.data?.path ?? 'SOUL.md'}
        revealed={showProtected}
        onRevealToggle={() => setShowProtected((value) => !value)}
      />
    </div>
  );
}

function IdentityPanel(props: {
  editing: boolean;
  name: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
}) {
  return (
    <Panel
      title="Identity"
      description="Name and purpose shown to people using this agent."
    >
      {props.editing ? (
        <div className="grid gap-4 p-5">
          <TextField
            id="agent-name"
            label="Agent name"
            required
            value={props.name}
            onChange={(event) => props.onNameChange(event.target.value)}
          />
          <TextArea
            label="Purpose"
            value={props.description}
            onChange={props.onDescriptionChange}
          />
        </div>
      ) : (
        <ReadOnlyGrid
          values={[
            ['Agent name', props.name],
            ['Purpose', props.description || 'Not set'],
          ]}
        />
      )}
    </Panel>
  );
}

function RuntimePanel(props: {
  editing: boolean;
  status: 'active' | 'disabled';
  harness: AgentHarness;
  createdAt: string;
  updatedAt: string;
  onStatusChange: (value: 'active' | 'disabled') => void;
  onHarnessChange: (value: AgentHarness) => void;
}) {
  return (
    <Panel
      title="Runtime"
      description="How this agent runs. Changes take effect after saving."
    >
      {props.editing ? (
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <SelectField
            label="Status"
            value={props.status}
            onChange={(value) =>
              props.onStatusChange(value as 'active' | 'disabled')
            }
            options={[
              ['active', 'Active'],
              ['disabled', 'Paused'],
            ]}
          />
          <SelectField
            label="Agent harness"
            value={props.harness}
            onChange={(value) => props.onHarnessChange(value as AgentHarness)}
            options={[
              ['auto', 'Auto'],
              ['anthropic_sdk', 'Anthropic SDK'],
              ['deepagents', 'DeepAgents'],
            ]}
          />
        </div>
      ) : (
        <ReadOnlyGrid
          values={[
            ['Status', props.status === 'active' ? 'Active' : 'Paused'],
            ['Agent harness', harnessLabel(props.harness)],
            ['Created', dateLabel(props.createdAt)],
            ['Last updated', dateLabel(props.updatedAt)],
          ]}
        />
      )}
    </Panel>
  );
}

function ProfilePanel(props: {
  editing: boolean;
  content: string;
  isLoading: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Panel
      title="SOUL.md"
      description="This agent’s persona, voice, boundaries, and working style."
    >
      {props.isLoading ? (
        <p className="m-0 p-5 text-sm text-text-secondary">Loading profile…</p>
      ) : props.error ? (
        <p className="m-0 p-5 text-sm text-danger">{props.error}</p>
      ) : props.editing ? (
        <div className="p-5">
          <TextArea
            label="SOUL.md"
            rows={18}
            value={props.content}
            onChange={props.onChange}
            hint="This changes only this agent’s profile."
          />
        </div>
      ) : (
        <pre className="m-0 max-h-[420px] overflow-auto whitespace-pre-wrap p-5 font-mono text-xs leading-6 text-text">
          {props.content || 'No SOUL.md content has been set.'}
        </pre>
      )}
    </Panel>
  );
}

function ProtectedPanel(props: {
  agentId: string;
  profilePath: string;
  revealed: boolean;
  onRevealToggle: () => void;
}) {
  const value = (source: string) => (props.revealed ? source : '*****');
  return (
    <Panel
      title="Protected details"
      description="Identifiers are hidden by default. Credential values are never sent to the browser."
    >
      <div className="grid gap-4 p-5 sm:grid-cols-[1fr_auto] sm:items-end">
        <ReadOnlyGrid
          values={[
            ['Agent ID', value(props.agentId)],
            ['Profile file', value(props.profilePath)],
            [
              'Credentials',
              props.revealed ? 'Stored securely (not revealable)' : '*****',
            ],
          ]}
        />
        <IconButton
          aria-label={
            props.revealed ? 'Hide protected details' : 'Show protected details'
          }
          title={
            props.revealed ? 'Hide protected details' : 'Show protected details'
          }
          onClick={props.onRevealToggle}
        >
          {props.revealed ? <EyeOff size={16} /> : <Eye size={16} />}
        </IconButton>
      </div>
    </Panel>
  );
}

function ReadOnlyGrid({ values }: { values: Array<[string, string]> }) {
  return (
    <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      {values.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs font-semibold text-text-secondary">{label}</dt>
          <dd className="mt-1 break-words text-sm text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TextArea({
  label,
  value,
  onChange,
  rows = 5,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: string;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-semibold text-text">{label}</span>
      <textarea
        className="w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] leading-5 text-text"
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <span className="text-xs text-text-muted">{hint}</span> : null}
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-semibold text-text">{label}</span>
      <select
        className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] text-text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function LoadingState() {
  return (
    <PageState
      kind="loading"
      icon={<SearchX size={18} />}
      title="Loading agent…"
      description="Fetching the current agent configuration."
    />
  );
}
function NotFoundState() {
  return (
    <PageState
      kind="empty"
      icon={<SearchX size={18} />}
      title="Agent not found"
      description="This agent may have been removed or is unavailable."
    />
  );
}
function harnessLabel(value: AgentHarness) {
  return value === 'anthropic_sdk'
    ? 'Anthropic SDK'
    : value === 'deepagents'
      ? 'DeepAgents'
      : 'Auto';
}
function dateLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
function mutationError(error: unknown) {
  return error instanceof RuntimeApiError ? error.message : undefined;
}
async function invalidateAgent(
  queryClient: ReturnType<typeof useQueryClient>,
  agentId: string,
) {
  await queryClient.invalidateQueries({ queryKey: agentQueryKeys.list() });
  await queryClient.invalidateQueries({
    queryKey: [...agentQueryKeys.list(), agentId],
  });
}
