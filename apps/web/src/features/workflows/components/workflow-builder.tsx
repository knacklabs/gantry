import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '../../../ui/primitives/badge';
import { IconButton } from '../../../ui/primitives/icon-button';
import type {
  WorkflowStepPreview,
  WorkflowStepType,
} from '../workflows-preview';

const palette: {
  type: WorkflowStepType;
  label: string;
  description: string;
}[] = [
  {
    type: 'agent',
    label: 'Agent step',
    description: 'Ask an agent to produce an outcome.',
  },
  {
    type: 'approval',
    label: 'Approval',
    description: 'Pause for an owner decision.',
  },
  {
    type: 'external',
    label: 'External wait',
    description: 'Wait for an external system or person.',
  },
  {
    type: 'notification',
    label: 'Notification',
    description: 'Deliver a terminal outcome.',
  },
];

export function WorkflowBuilder({
  initialSteps,
}: {
  initialSteps: WorkflowStepPreview[];
}) {
  const [steps, setSteps] = useState(() =>
    initialSteps.map((step) => ({ ...step })),
  );
  const [selectedId, setSelectedId] = useState(initialSteps[0]?.id ?? '');
  const selected = steps.find((step) => step.id === selectedId);
  const errors = useMemo(() => validateSteps(steps), [steps]);

  function addStep(type: WorkflowStepType) {
    const id = `draft-step-${steps.length + 1}`;
    const next: WorkflowStepPreview = {
      id,
      name: palette.find((item) => item.type === type)?.label ?? 'New step',
      type,
      description: '',
    };
    setSteps((current) => [...current, next]);
    setSelectedId(id);
  }

  function updateSelected(patch: Partial<WorkflowStepPreview>) {
    setSteps((current) =>
      current.map((step) =>
        step.id === selectedId ? { ...step, ...patch } : step,
      ),
    );
  }

  function moveStep(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    setSteps((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  function removeStep(id: string) {
    setSteps((current) => current.filter((step) => step.id !== id));
    if (selectedId === id)
      setSelectedId(steps.find((step) => step.id !== id)?.id ?? '');
  }

  return (
    <div className="grid min-w-0 gap-4 p-4 xl:grid-cols-[220px_minmax(300px,1fr)_320px]">
      <section
        aria-labelledby="palette-title"
        className="grid content-start gap-3"
      >
        <div>
          <h2
            className="m-0 text-xs font-semibold text-text"
            id="palette-title"
          >
            Step palette
          </h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-text-secondary">
            Add a semantic step to the draft.
          </p>
        </div>
        {palette.map((item) => (
          <button
            className="grid gap-1 rounded-md border border-border p-3 text-left hover:bg-surface-muted"
            key={item.type}
            type="button"
            onClick={() => addStep(item.type)}
          >
            <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-text">
              <Plus size={14} aria-hidden="true" />
              {item.label}
            </span>
            <span className="text-xs leading-5 text-text-secondary">
              {item.description}
            </span>
          </button>
        ))}
      </section>

      <section
        aria-labelledby="canvas-title"
        className="min-w-0 rounded-md border border-border bg-surface-muted p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 text-xs font-semibold text-text" id="canvas-title">
            Ordered canvas
          </h2>
          <Badge tone={errors.length ? 'attention' : 'success'}>
            {errors.length ? `${errors.length} issues` : 'Valid draft'}
          </Badge>
        </div>
        <ol className="mt-4 grid list-none gap-3 p-0">
          {steps.map((step, index) => (
            <li className="relative" key={step.id}>
              {index < steps.length - 1 ? (
                <span
                  className="absolute top-full left-6 h-3 border-l border-border-strong"
                  aria-hidden="true"
                />
              ) : null}
              <div
                className={`grid grid-cols-[minmax(0,1fr)_auto] items-center rounded-md border p-1 ${selectedId === step.id ? 'border-ink bg-surface' : 'border-border bg-surface hover:border-border-strong'}`}
              >
                <button
                  aria-pressed={selectedId === step.id}
                  className="grid min-h-12 min-w-0 grid-cols-[32px_minmax(0,1fr)] items-center gap-3 rounded-md bg-transparent px-2 text-left"
                  type="button"
                  onClick={() => setSelectedId(step.id)}
                >
                  <span className="flex size-8 items-center justify-center rounded-md bg-surface-strong font-mono text-xs text-text">
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate text-[13px] text-text">
                      {step.name || 'Unnamed step'}
                    </strong>
                    <span className="text-xs text-text-muted">{step.type}</span>
                  </span>
                </button>
                <span className="flex gap-1 pr-1">
                  <ControlButton
                    label="Move up"
                    disabled={index === 0}
                    onClick={() => moveStep(index, -1)}
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                  </ControlButton>
                  <ControlButton
                    label="Move down"
                    disabled={index === steps.length - 1}
                    onClick={() => moveStep(index, 1)}
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                  </ControlButton>
                  <ControlButton
                    label="Remove step"
                    onClick={() => removeStep(step.id)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </ControlButton>
                </span>
              </div>
            </li>
          ))}
        </ol>
        {steps.length === 0 ? (
          <p className="m-0 py-12 text-center text-xs text-text-secondary">
            Add a step from the palette.
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="properties-title"
        className="grid content-start gap-4"
      >
        <div>
          <h2
            className="m-0 text-xs font-semibold text-text"
            id="properties-title"
          >
            Properties
          </h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-text-secondary">
            Configure the selected local step.
          </p>
        </div>
        {selected ? (
          <div className="grid gap-4 rounded-md border border-border p-4">
            <Field label="Name">
              <input
                className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] text-text"
                value={selected.name}
                onChange={(event) =>
                  updateSelected({ name: event.target.value })
                }
              />
            </Field>
            <Field label="Description">
              <textarea
                className="min-h-24 rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] leading-5 text-text"
                value={selected.description}
                onChange={(event) =>
                  updateSelected({ description: event.target.value })
                }
              />
            </Field>
            {selected.type === 'agent' ? (
              <Field label="Required capability">
                <input
                  className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] text-text"
                  value={selected.capability ?? ''}
                  onChange={(event) =>
                    updateSelected({ capability: event.target.value })
                  }
                />
              </Field>
            ) : null}
            {selected.type === 'external' ? (
              <Field label="External system">
                <input
                  className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] text-text"
                  value={selected.externalSystem ?? ''}
                  onChange={(event) =>
                    updateSelected({ externalSystem: event.target.value })
                  }
                />
              </Field>
            ) : null}
            {selected.type === 'notification' ? (
              <Field label="Notification route">
                <input
                  className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] text-text"
                  value={selected.notificationRoute ?? ''}
                  onChange={(event) =>
                    updateSelected({ notificationRoute: event.target.value })
                  }
                />
              </Field>
            ) : null}
          </div>
        ) : (
          <p className="m-0 rounded-md border border-border p-4 text-xs text-text-secondary">
            Select a step to edit properties.
          </p>
        )}
        <div className="rounded-md border border-border p-4">
          <h3 className="m-0 text-xs font-semibold text-text">Validation</h3>
          {errors.length ? (
            <ul className="mb-0 grid gap-2 pl-5 text-xs leading-5 text-danger">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 mb-0 text-xs text-status-success">
              All local validation checks pass.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function validateSteps(steps: WorkflowStepPreview[]) {
  const errors: string[] = [];
  if (!steps.length) errors.push('Workflow: add at least one step.');
  steps.forEach((step, index) => {
    const label = `Step ${index + 1} (${step.name || 'unnamed'})`;
    if (!step.name.trim()) errors.push(`${label}: name is required.`);
    if (!step.description.trim())
      errors.push(`${label}: description is required.`);
    if (step.type === 'agent' && !step.capability?.trim())
      errors.push(`${label}: required capability is missing.`);
    if (step.type === 'external' && !step.externalSystem?.trim())
      errors.push(`${label}: external system is missing.`);
    if (step.type === 'notification' && !step.notificationRoute?.trim())
      errors.push(`${label}: notification route is missing.`);
  });
  return errors;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-semibold text-text">
      {label}
      {children}
    </label>
  );
}

function ControlButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  children: React.ReactNode;
}) {
  return (
    <IconButton
      aria-label={label}
      disabled={disabled}
      title={label}
      onClick={onClick}
    >
      {children}
    </IconButton>
  );
}
