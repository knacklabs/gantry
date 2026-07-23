import {
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  WifiOff,
} from 'lucide-react';
import { useState } from 'react';

import { useRuntimeConnection } from '../../../lib/api/runtime-connection';
import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { Button } from '../../../ui/primitives/button';
import { useConversationDashboard } from '../../operations/use-conversations';
import { useModelDashboard } from '../../runtime/use-model-dashboard';
import { SetupAgentDetails } from '../components/setup-agent-details';
import { SetupConnectionDetails } from '../components/setup-connection-details';
import { SetupConversationDetails } from '../components/setup-conversation-details';
import { SetupModelSave } from '../components/setup-model-save';
import { SetupProfileDetails } from '../components/setup-profile-details';
import { SetupReviewDetails } from '../components/setup-review-details';

const stages = [
  {
    id: 'agent',
    title: 'Agent',
    description: 'Name the agent and describe the work it should own.',
    fields: [
      {
        label: 'Agent name',
        placeholder: 'e.g. Operations Assistant',
        required: true,
      },
      {
        label: 'Purpose',
        placeholder: 'What should this agent help with?',
        required: true,
      },
    ],
  },
  {
    id: 'model',
    title: 'Model access',
    description: 'Choose a model from the live catalog and confirm access.',
    fields: [
      {
        label: 'Model',
        placeholder: 'Available models load when connected',
        required: false,
      },
    ],
  },
  {
    id: 'connection',
    title: 'Channel connection',
    description: 'Connect a provider and verify that Gantry can use it.',
    fields: [
      {
        label: 'Provider connection',
        placeholder: 'Available connections load when connected',
        required: false,
      },
    ],
  },
  {
    id: 'conversation',
    title: 'Conversation access',
    description:
      'Choose where the agent can respond and set its access policy.',
    fields: [
      {
        label: 'Conversation',
        placeholder: 'Search available conversations when connected',
        required: false,
      },
    ],
  },
  {
    id: 'profile',
    title: 'Profile',
    description: 'Review the agent’s operating instructions and boundaries.',
    fields: [
      {
        label: 'Profile summary',
        placeholder: 'Profile loading is available when connected',
        required: false,
      },
    ],
  },
  {
    id: 'review',
    title: 'Review',
    description: 'Review the changes made in the earlier setup steps.',
    fields: [],
  },
] as const;

export function SetupRoute() {
  const [activeStage, setActiveStage] = useState(0);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [createdAgentId, setCreatedAgentId] = useState<string>();
  const [showValidation, setShowValidation] = useState(false);
  const connection = useRuntimeConnection();
  const { requestConnection } = useConnectionGate();
  const modelQuery = useModelDashboard();
  const conversationQuery = useConversationDashboard();
  const stage = stages[activeStage];
  const isFinalStage = activeStage === stages.length - 1;
  const invalidFields = stage.fields.filter(
    (field) => field.required && !draft[field.label]?.trim(),
  );

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <PageHeader
        eyebrow="Administration"
        title="Set up an agent"
        description="Create a focused agent with the right model, connection, conversation access, and operating profile."
      />

      <SetupProgress activeStage={activeStage} />

      {!connection.transport ? (
        <PageState
          action={
            <Button onClick={() => requestConnection('Load setup options')}>
              Connect Gantry
            </Button>
          }
          description="You can prepare this local draft now. Model, provider, conversation, profile, and readiness details load after Gantry is connected."
          icon={<WifiOff size={18} aria-hidden="true" />}
          kind="offline"
          title="Runtime not connected"
        />
      ) : null}

      <Panel title={stage.title} description={stage.description}>
        <div className="grid gap-5 p-5">
          {stage.id === 'agent' ? (
            <SetupAgentDetails
              connected={Boolean(connection.transport)}
              name={draft['Agent name'] ?? ''}
              purpose={draft.Purpose ?? ''}
              onChange={(field, value) =>
                setDraft((current) => ({
                  ...current,
                  [field === 'name' ? 'Agent name' : 'Purpose']: value,
                }))
              }
              onCreated={setCreatedAgentId}
              showValidation={showValidation}
            />
          ) : stage.id === 'model' ? (
            <div className="grid gap-3">
              <LiveSelect
                label="Model"
                value={draft.Model ?? ''}
                options={(modelQuery.data?.models ?? []).map((model) => ({
                  label: `${model.alias} — ${model.displayName}`,
                  value: model.alias,
                }))}
                loading={modelQuery.isPending}
                emptyMessage="No models are available for this runtime."
                onChange={(value) =>
                  setDraft((current) => ({ ...current, Model: value }))
                }
              />
              <ModelReadiness
                readiness={
                  modelQuery.data?.models.find(
                    (model) => model.alias === draft.Model,
                  )?.readiness
                }
              />
              <SetupModelSave
                agentId={createdAgentId}
                modelAlias={draft.Model ?? ''}
              />
            </div>
          ) : stage.id === 'connection' ? (
            <SetupConnectionDetails
              agentId={createdAgentId}
              selectedAccountId={draft['Provider connection'] ?? ''}
              onSelect={(value) =>
                setDraft((current) => ({
                  ...current,
                  'Provider connection': value,
                }))
              }
            />
          ) : stage.id === 'conversation' ? (
            conversationQuery.isPending ? (
              <p className="m-0 text-sm text-text-secondary">
                Loading conversations…
              </p>
            ) : (
              <SetupConversationDetails
                agentId={createdAgentId}
                conversations={conversationQuery.data?.conversations ?? []}
                selectedConversationId={draft.Conversation ?? ''}
                onSelect={(value) =>
                  setDraft((current) => ({ ...current, Conversation: value }))
                }
              />
            )
          ) : stage.id === 'profile' ? (
            <SetupProfileDetails agentId={createdAgentId} />
          ) : null}
          {isFinalStage ? (
            <SetupReviewDetails
              agentCreated={Boolean(createdAgentId)}
              modelAlias={draft.Model ?? ''}
              providerAccountId={draft['Provider connection'] ?? ''}
              conversationId={draft.Conversation ?? ''}
            />
          ) : null}
          <div className="flex flex-wrap justify-between gap-3 border-t border-border pt-4">
            <Button
              disabled={activeStage === 0}
              variant="secondary"
              onClick={() => setActiveStage((current) => current - 1)}
            >
              <ChevronLeft size={16} aria-hidden="true" /> Back
            </Button>
            <Button
              onClick={() => {
                if (isFinalStage && !connection.transport) {
                  requestConnection('Review agent setup');
                  return;
                }
                if (invalidFields.length) {
                  setShowValidation(true);
                  return;
                }
                setShowValidation(false);
                setActiveStage((current) =>
                  Math.min(current + 1, stages.length - 1),
                );
              }}
            >
              {isFinalStage ? 'Finish review' : 'Continue'}
              {!isFinalStage ? (
                <ChevronRight size={16} aria-hidden="true" />
              ) : null}
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function LiveSelect({
  emptyMessage,
  label,
  loading,
  onChange,
  options,
  value,
}: {
  emptyMessage: string;
  label: string;
  loading: boolean;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  value: string;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-semibold text-text">
      {label}
      <select
        className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text disabled:text-text-muted"
        disabled={loading || options.length === 0}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{loading ? 'Loading options…' : emptyMessage}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SetupProgress({ activeStage }: { activeStage: number }) {
  return (
    <ol
      className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6"
      aria-label="Setup progress"
    >
      {stages.map((stage, index) => {
        const complete = index < activeStage;
        const current = index === activeStage;

        return (
          <li
            className={`flex min-h-12 items-center gap-2 rounded-md border px-3 text-xs ${current ? 'border-border-strong bg-surface-strong text-text' : 'border-border bg-surface text-text-secondary'}`}
            key={stage.title}
          >
            {complete ? (
              <Check
                className="shrink-0 text-status-ready"
                size={15}
                aria-hidden="true"
              />
            ) : (
              <Circle className="shrink-0" size={15} aria-hidden="true" />
            )}
            <span className="font-medium">{stage.title}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ModelReadiness({ readiness }: { readiness?: 'ready' | 'attention' }) {
  if (!readiness) return null;
  return (
    <p
      className={`m-0 text-sm ${readiness === 'ready' ? 'text-status-ready' : 'text-text-secondary'}`}
    >
      {readiness === 'ready'
        ? 'Model access is ready for this runtime.'
        : 'This model needs attention before the agent can use it.'}
    </p>
  );
}
