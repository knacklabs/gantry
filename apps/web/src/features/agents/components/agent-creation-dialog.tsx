import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import {
  agentCreationOptionsQuery,
  createAgentCreationDraft,
  createOrResumeAgent,
  deleteAgentCreationDraft,
  preflightAgentCreationDraft,
  type UiAgentCreationDraft,
  type UiAgentCreationOptions,
  updateAgentCreationDraft,
} from '../../../lib/ui-api';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '../../../ui/primitives/alert';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../ui/primitives/alert-dialog';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import { Field, FieldLabel } from '../../../ui/primitives/field';
import { Input } from '../../../ui/primitives/input';
import { Textarea } from '../../../ui/primitives/textarea';

type Step = 0 | 1 | 2 | 3 | 4 | 5;
type Values = {
  name: string;
  agentHarness: 'auto' | 'anthropic_sdk' | 'deepagents';
  modelAlias: string;
  capabilities: string[];
  skillIds: string[];
  mcpServerIds: string[];
  toolIds: string[];
  delegateIds: string[];
  workSourceKind: 'configure_later' | 'conversation' | 'scheduled_job';
  conversationId: string;
  jobName: string;
  jobInstructions: string;
  schedule: string;
};

const steps = [
  'Identity',
  'Model',
  'Access',
  'Delegation',
  'Work source',
  'Review',
] as const;

function defaults(draft?: UiAgentCreationDraft): Values {
  const document = draft?.document;
  const workSource = document?.workSource ?? { kind: 'configure_later' };
  return {
    name: document?.name ?? '',
    agentHarness: document?.agentHarness ?? 'auto',
    modelAlias: document?.modelAlias ?? '',
    capabilities: document?.capabilities.map((item) => item.id) ?? [],
    skillIds: document?.skillIds ?? [],
    mcpServerIds: document?.mcpServerIds ?? [],
    toolIds: document?.toolSources.map((item) => item.id) ?? [],
    delegateIds: document?.delegateIds ?? [],
    workSourceKind: workSource.kind,
    conversationId:
      workSource.kind === 'configure_later' ? '' : workSource.conversationId,
    jobName: workSource.kind === 'scheduled_job' ? workSource.name : '',
    jobInstructions:
      workSource.kind === 'scheduled_job' ? workSource.instructions : '',
    schedule: workSource.kind === 'scheduled_job' ? workSource.schedule : '',
  };
}

function documentFrom(values: Values, options?: UiAgentCreationOptions) {
  const workSource =
    values.workSourceKind === 'configure_later'
      ? { kind: 'configure_later' as const }
      : values.workSourceKind === 'conversation'
        ? {
            kind: 'conversation' as const,
            conversationId: values.conversationId,
          }
        : {
            kind: 'scheduled_job' as const,
            conversationId: values.conversationId,
            name: values.jobName,
            instructions: values.jobInstructions,
            schedule: values.schedule,
          };
  return {
    name: values.name.trim(),
    agentHarness: values.agentHarness,
    modelAlias: values.modelAlias || null,
    capabilities: values.capabilities.map((id) => ({
      id,
      version:
        options?.capabilities.find((capability) => capability.id === id)
          ?.version ?? 'catalog',
    })),
    skillIds: values.skillIds,
    mcpServerIds: values.mcpServerIds,
    toolSources: values.toolIds.map((id) => {
      const tool = options?.tools.find((item) => item.id === id);
      return { id, kind: tool?.kind ?? 'gantry_tool' };
    }),
    delegateIds: values.delegateIds,
    workSource,
  };
}

function toggle(values: string[], value: string) {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

export function AgentCreationDialog({
  draft,
  open,
  onOpenChange,
  onCreated,
}: {
  draft?: UiAgentCreationDraft;
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(agentId: string): void;
}) {
  const [step, setStep] = useState<Step>(0);
  const [saved, setSaved] = useState(draft);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const queryClient = useQueryClient();
  const form = useForm<Values>({ defaultValues: defaults(draft) });
  const options = useQuery({
    ...agentCreationOptionsQuery,
    enabled: open && step > 0,
  });
  const values = form.watch();
  const canSave =
    values.name.trim().length >= 1 && values.name.trim().length <= 80;

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setSaved(draft);
    form.reset(defaults(draft));
  }, [draft, form, open]);

  const save = useMutation({
    mutationFn: async () => {
      if (!canSave) throw new Error('Enter an agent name before saving.');
      const document = documentFrom(form.getValues(), options.data);
      return saved
        ? updateAgentCreationDraft(saved.id, {
            document,
            currentStep: steps[step].toLowerCase().replaceAll(' ', '_'),
            expectedRevision: saved.revision,
          })
        : createAgentCreationDraft({
            document,
            currentStep: steps[step].toLowerCase().replaceAll(' ', '_'),
          });
    },
    onSuccess: (next) => {
      setSaved(next);
      form.reset(defaults(next));
      void queryClient.invalidateQueries({
        queryKey: ['ui-api', 'agent-creation-drafts'],
      });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteAgentCreationDraft(saved!.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['ui-api', 'agent-creation-drafts'],
      });
      onOpenChange(false);
    },
  });
  const create = useMutation({
    mutationFn: async () => {
      const current = await save.mutateAsync();
      const preflight = await preflightAgentCreationDraft(current.id);
      if (!preflight.ok) throw new Error(preflight.blockers.join(' '));
      return createOrResumeAgent(current.id);
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['ui-api', 'agents'] });
      void queryClient.invalidateQueries({
        queryKey: ['ui-api', 'agent-creation-drafts'],
      });
      if (result.agentId) onCreated(result.agentId);
    },
  });
  const error = save.error ?? create.error ?? remove.error;

  function requestClose() {
    if (form.formState.isDirty) setLeaveConfirm(true);
    else onOpenChange(false);
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}
      >
        <DialogContent
          className="grid h-[min(760px,calc(100dvh-2rem))] max-w-[calc(100%-1rem)] grid-rows-[auto_1fr_auto] gap-0 overflow-hidden p-0 sm:max-w-5xl"
          showCloseButton={false}
        >
          <DialogHeader className="flex-row items-start justify-between gap-4 border-b border-dashed border-border p-5 pr-14">
            <div>
              <DialogTitle>Create agent</DialogTitle>
              <DialogDescription className="mt-1 text-xs">
                {create.isPending
                  ? 'Creating agent'
                  : saved
                    ? form.formState.isDirty
                      ? 'Unsaved changes'
                      : 'Draft saved'
                    : 'Unsaved setup'}
              </DialogDescription>
            </div>
            <Button
              disabled={!canSave || save.isPending || create.isPending}
              size="sm"
              variant="secondary"
              onClick={() => void save.mutateAsync()}
            >
              <Save size={14} aria-hidden="true" /> Save draft
            </Button>
          </DialogHeader>
          <div className="grid min-h-0 md:grid-cols-[170px_1fr]">
            <StepRail step={step} />
            <div className="min-h-0 overflow-y-auto p-5">
              {error ? (
                <Alert className="mb-5 border-status-attention/50 bg-status-attention-soft">
                  <AlertTitle>Setup needs attention</AlertTitle>
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
              ) : null}
              {create.isPending ? <CreationProgress /> : null}
              <StepContent
                form={form}
                options={options.data}
                step={step}
                onEdit={setStep}
              />
            </div>
          </div>
          <DialogFooter className="m-0 rounded-none bg-surface p-4">
            {saved ? (
              <Button
                disabled={remove.isPending || create.isPending}
                size="sm"
                variant="ghost"
                onClick={() => void remove.mutateAsync()}
              >
                <Trash2 size={14} aria-hidden="true" /> Delete draft
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                disabled={step === 0 || create.isPending}
                size="sm"
                variant="secondary"
                onClick={() => setStep((step - 1) as Step)}
              >
                Back
              </Button>
              {step < 5 ? (
                <Button
                  disabled={step === 0 && !canSave}
                  size="sm"
                  onClick={() => setStep((step + 1) as Step)}
                >
                  Continue
                </Button>
              ) : (
                <Button
                  disabled={!canSave || create.isPending}
                  size="sm"
                  onClick={() => void create.mutateAsync()}
                >
                  <Plus size={14} aria-hidden="true" />{' '}
                  {create.isPending ? 'Creating…' : 'Create agent'}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={leaveConfirm} onOpenChange={setLeaveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Leave without saving these changes?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your last saved draft will remain unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="secondary" onClick={() => setLeaveConfirm(false)}>
              Keep editing
            </Button>
            <Button
              onClick={() => {
                setLeaveConfirm(false);
                onOpenChange(false);
              }}
            >
              Discard unsaved changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function StepRail({ step }: { step: Step }) {
  return (
    <ol className="m-0 hidden list-none border-r border-dashed border-border bg-surface-muted p-3 md:grid md:content-start md:gap-1">
      {steps.map((label, index) => (
        <li key={label}>
          <span
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs font-semibold ${index === step ? 'bg-surface text-text shadow-sm' : index < step ? 'text-text' : 'text-text-secondary'}`}
          >
            <Badge>{index + 1}</Badge>
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepContent({
  form,
  options,
  step,
  onEdit,
}: {
  form: ReturnType<typeof useForm<Values>>;
  options: UiAgentCreationOptions | undefined;
  step: Step;
  onEdit(step: Step): void;
}) {
  const values = form.watch();
  const selectedCapabilities = values.capabilities;
  const optionsAvailable = options !== undefined;
  if (step === 0)
    return (
      <section className="grid max-w-2xl gap-5">
        <div>
          <h2 className="m-0 text-base font-semibold text-text">Identity</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Choose the durable name and execution harness for this agent.
          </p>
        </div>
        <Field>
          <FieldLabel htmlFor="agent-creation-name">Agent name</FieldLabel>
          <Input
            id="agent-creation-name"
            maxLength={80}
            {...form.register('name')}
          />
        </Field>
        <fieldset className="grid gap-2 border-0 p-0">
          <legend className="text-xs font-semibold text-text">Harness</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                [
                  'auto',
                  'Auto',
                  'Gantry selects the safest compatible harness.',
                ],
                [
                  'anthropic_sdk',
                  'Anthropic SDK',
                  'Claude-native execution through the Claude Agent SDK.',
                ],
                [
                  'deepagents',
                  'DeepAgents',
                  'Planning, skills, and filesystem workflows under Gantry permissions.',
                ],
              ] as const
            ).map(([value, label, description]) => (
              <OptionCard
                key={value}
                active={values.agentHarness === value}
                label={label}
                description={description}
                onClick={() =>
                  form.setValue('agentHarness', value, { shouldDirty: true })
                }
              />
            ))}
          </div>
        </fieldset>
      </section>
    );
  if (step === 1)
    return (
      <section className="grid max-w-2xl gap-5">
        <div>
          <h2 className="m-0 text-base font-semibold text-text">Model</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Use the deployment default or select an available chat model.
          </p>
        </div>
        <OptionCard
          active={!values.modelAlias}
          label="Use deployment default"
          description="The agent inherits Gantry’s configured chat model."
          onClick={() => form.setValue('modelAlias', '', { shouldDirty: true })}
        />
        {optionsAvailable ? (
          options!.models.map((model) => (
            <OptionCard
              key={model.id}
              active={values.modelAlias === (model.aliases[0] ?? model.id)}
              disabled={!model.available}
              label={model.label}
              description={
                model.available
                  ? model.supportsTools
                    ? 'Available · tools supported'
                    : 'Available · tool support is limited'
                  : 'Unavailable on this deployment'
              }
              onClick={() =>
                form.setValue('modelAlias', model.aliases[0] ?? model.id, {
                  shouldDirty: true,
                })
              }
            />
          ))
        ) : (
          <p className="text-sm text-text-secondary">Loading model options…</p>
        )}
      </section>
    );
  if (step === 2)
    return (
      <section className="grid gap-6">
        <div>
          <h2 className="m-0 text-base font-semibold text-text">Access</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Access is optional. Choose the safe catalog items this agent can
            use.
          </p>
        </div>
        {!optionsAvailable ? (
          <p className="text-sm text-text-secondary">
            Loading access inventory…
          </p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <SelectionGroup
              title="Capabilities"
              items={options!.capabilities}
              selected={selectedCapabilities}
              onToggle={(id) =>
                form.setValue(
                  'capabilities',
                  toggle(selectedCapabilities, id),
                  { shouldDirty: true },
                )
              }
            />
            <SelectionGroup
              title="Installed skills"
              items={options!.skills}
              selected={values.skillIds}
              onToggle={(id) =>
                form.setValue('skillIds', toggle(values.skillIds, id), {
                  shouldDirty: true,
                })
              }
            />
            <SelectionGroup
              title="Active MCP sources"
              items={options!.mcpServers}
              selected={values.mcpServerIds}
              onToggle={(id) =>
                form.setValue('mcpServerIds', toggle(values.mcpServerIds, id), {
                  shouldDirty: true,
                })
              }
            />
            <SelectionGroup
              title="Selectable tools"
              items={options!.tools}
              selected={values.toolIds}
              onToggle={(id) =>
                form.setValue('toolIds', toggle(values.toolIds, id), {
                  shouldDirty: true,
                })
              }
            />
          </div>
        )}
      </section>
    );
  if (step === 3)
    return (
      <section className="grid max-w-2xl gap-5">
        <div>
          <h2 className="m-0 text-base font-semibold text-text">Delegation</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Configured delegation is intended composition, not live execution.
          </p>
        </div>
        {optionsAvailable ? (
          <SelectionGroup
            title="Active agents"
            items={options!.delegates}
            selected={values.delegateIds}
            onToggle={(id) =>
              form.setValue('delegateIds', toggle(values.delegateIds, id), {
                shouldDirty: true,
              })
            }
          />
        ) : (
          <p className="text-sm text-text-secondary">Loading active agents…</p>
        )}
      </section>
    );
  if (step === 4)
    return (
      <section className="grid max-w-2xl gap-5">
        <div>
          <h2 className="m-0 text-base font-semibold text-text">Work source</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Choose when this agent becomes available for work.
          </p>
        </div>
        <div className="grid gap-2">
          {(
            [
              [
                'configure_later',
                'Configure later',
                'The agent will be created without a work route.',
              ],
              [
                'conversation',
                'Existing conversation',
                'Available after an agent-owned provider connection is configured.',
              ],
              [
                'scheduled_job',
                'Scheduled job',
                'Available after an agent-owned provider connection is configured.',
              ],
            ] as const
          ).map(([kind, label, description]) => (
            <OptionCard
              key={kind}
              active={values.workSourceKind === kind}
              disabled={kind !== 'configure_later'}
              label={label}
              description={description}
              onClick={() =>
                form.setValue('workSourceKind', kind, { shouldDirty: true })
              }
            />
          ))}
        </div>
        {values.workSourceKind !== 'configure_later' ? (
          <Field>
            <FieldLabel htmlFor="agent-creation-conversation">
              Conversation
            </FieldLabel>
            <select
              className="h-9 w-full rounded-md border border-input bg-surface px-3 text-sm"
              id="agent-creation-conversation"
              {...form.register('conversationId')}
            >
              <option value="">Choose a conversation</option>
              {options?.conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.name} · {conversation.kind}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {values.workSourceKind === 'scheduled_job' ? (
          <div className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="agent-creation-job-name">
                Job name
              </FieldLabel>
              <Input
                id="agent-creation-job-name"
                maxLength={80}
                {...form.register('jobName')}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-creation-schedule">
                Schedule
              </FieldLabel>
              <Input
                id="agent-creation-schedule"
                placeholder="0 9 * * 1-5"
                {...form.register('schedule')}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-creation-instructions">
                Instructions
              </FieldLabel>
              <Textarea
                id="agent-creation-instructions"
                rows={4}
                {...form.register('jobInstructions')}
              />
            </Field>
          </div>
        ) : null}
      </section>
    );
  return <Review values={values} onEdit={onEdit} />;
}

function OptionCard({
  active,
  description,
  disabled,
  label,
  onClick,
}: {
  active: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      className={`rounded-lg border border-dashed p-3 text-left transition-colors ${active ? 'border-text bg-surface-muted' : 'border-border hover:bg-surface-muted'} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      disabled={disabled}
      type="button"
      onClick={onClick}
    >
      <div className="text-sm font-semibold text-text">{label}</div>
      <div className="mt-1 text-xs leading-5 text-text-secondary">
        {description}
      </div>
    </button>
  );
}

function SelectionGroup({
  items,
  onToggle,
  selected,
  title,
}: {
  items: Array<{
    id: string;
    name?: string;
    displayName?: string;
    label?: string;
    description?: string | null;
    risk?: string;
  }>;
  onToggle(id: string): void;
  selected: string[];
  title: string;
}) {
  return (
    <section>
      <h3 className="m-0 text-sm font-semibold text-text">
        {title} <Badge>{selected.length}</Badge>
      </h3>
      <div className="mt-2 grid divide-y divide-dashed rounded-lg border border-dashed border-border">
        {items.length ? (
          items.map((item) => (
            <label
              className="flex cursor-pointer items-start gap-3 p-3 text-sm hover:bg-surface-muted"
              key={item.id}
            >
              <input
                checked={selected.includes(item.id)}
                className="mt-1"
                type="checkbox"
                onChange={() => onToggle(item.id)}
              />
              <span>
                <span className="font-semibold text-text">
                  {item.displayName ?? item.name ?? item.label ?? item.id}
                </span>
                {item.risk ? <Badge>{item.risk}</Badge> : null}
                {item.description ? (
                  <span className="mt-1 block text-xs text-text-secondary">
                    {item.description}
                  </span>
                ) : null}
              </span>
            </label>
          ))
        ) : (
          <p className="m-0 p-3 text-sm text-text-secondary">
            No selectable items.
          </p>
        )}
      </div>
    </section>
  );
}

function Review({
  values,
  onEdit,
}: {
  values: Values;
  onEdit(step: Step): void;
}) {
  const work =
    values.workSourceKind === 'configure_later'
      ? 'Configure later'
      : values.workSourceKind === 'conversation'
        ? 'Existing conversation'
        : 'Scheduled job';
  return (
    <section className="grid max-w-2xl gap-5">
      <div>
        <h2 className="m-0 text-base font-semibold text-text">Review</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Save the current setup, run preflight, then create the agent.
        </p>
      </div>
      <dl className="grid divide-y divide-dashed rounded-lg border border-dashed border-border text-sm">
        <ReviewRow
          label="Name"
          value={values.name || 'Required'}
          onEdit={() => onEdit(0)}
        />
        <ReviewRow
          label="Harness"
          value={values.agentHarness}
          onEdit={() => onEdit(0)}
        />
        <ReviewRow
          label="Model"
          value={values.modelAlias || 'Deployment default'}
          onEdit={() => onEdit(1)}
        />
        <ReviewRow
          label="Access"
          value={`${values.capabilities.length} capabilities · ${values.skillIds.length} skills · ${values.mcpServerIds.length} MCP sources · ${values.toolIds.length} tools`}
          onEdit={() => onEdit(2)}
        />
        <ReviewRow
          label="Delegates"
          value={`${values.delegateIds.length} configured`}
          onEdit={() => onEdit(3)}
        />
        <ReviewRow label="Work source" value={work} onEdit={() => onEdit(4)} />
      </dl>
      <p className="m-0 text-xs text-text-secondary">
        Creation applies the saved setup in stages. If a durable stage cannot
        complete, this setup remains available to resume.
      </p>
    </section>
  );
}

function ReviewRow({
  label,
  value,
  onEdit,
}: {
  label: string;
  value: string;
  onEdit(): void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-3">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="m-0 flex items-center gap-3 font-semibold text-text">
        {value}
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
      </dd>
    </div>
  );
}

function CreationProgress() {
  return (
    <section className="mb-5 rounded-lg border border-dashed border-border bg-surface-muted p-4">
      <h2 className="m-0 text-sm font-semibold text-text">Creating agent</h2>
      <ol className="mt-3 grid gap-2 text-xs text-text-secondary">
        {[
          'Creating agent record',
          'Applying model and harness',
          'Applying access',
          'Applying delegation',
          'Connecting work source',
        ].map((label, index) => (
          <li className="flex items-center gap-2" key={label}>
            <Badge>{index === 0 ? 'Working' : 'Next'}</Badge>
            {label}
          </li>
        ))}
      </ol>
    </section>
  );
}
