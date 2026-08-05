import { zodResolver } from '@hookform/resolvers/zod';
import { RotateCcw, Save } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { TextField } from '../../../ui/compositions/text-field';
import { SelectField } from '../../../ui/compositions/select-field';
import { Button } from '../../../ui/primitives/button';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '../../../ui/primitives/field';
import { Textarea } from '../../../ui/primitives/textarea';
import type { AgentPreview } from '../agents-preview';

const agentIdentitySchema = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters.').max(80),
  description: z
    .string()
    .trim()
    .min(12, 'Describe what this agent is responsible for.')
    .max(240),
  modelAlias: z.enum(['sonnet', 'opus', 'gpt-5']),
  agentHarness: z.enum(['auto', 'anthropic_sdk', 'deepagents']),
  persona: z.string().trim().min(12, 'Describe the agent persona.').max(300),
});

type AgentIdentityDraft = z.infer<typeof agentIdentitySchema>;

export function AgentIdentityForm({ agent }: { agent: AgentPreview }) {
  const { requestConnection } = useConnectionGate();
  const defaults: AgentIdentityDraft = {
    name: agent.name,
    description: agent.description,
    modelAlias: agent.modelAlias as AgentIdentityDraft['modelAlias'],
    agentHarness: agent.agentHarness,
    persona: agent.persona,
  };
  const {
    formState: { errors, isDirty },
    control,
    handleSubmit,
    register,
    reset,
  } = useForm<AgentIdentityDraft>({
    defaultValues: defaults,
    resolver: zodResolver(agentIdentitySchema),
  });

  return (
    <form
      className="grid gap-6 p-5"
      onSubmit={(event) =>
        void handleSubmit(() => requestConnection(`Save ${agent.name}`))(event)
      }
    >
      <section aria-labelledby="identity-heading" className="grid gap-4">
        <div>
          <h2
            className="m-0 text-sm font-semibold text-text"
            id="identity-heading"
          >
            Identity
          </h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-text-secondary">
            Human-readable identity shown in conversations and administration
            views.
          </p>
        </div>
        <TextField
          id="agent-name"
          label="Agent name"
          error={errors.name?.message}
          {...register('name')}
        />
        <TextAreaField
          id="agent-description"
          label="Purpose"
          rows={3}
          error={errors.description?.message}
          {...register('description')}
        />
      </section>

      <section
        aria-labelledby="model-heading"
        className="grid gap-4 border-t border-border pt-5"
      >
        <div>
          <h2
            className="m-0 text-sm font-semibold text-text"
            id="model-heading"
          >
            Model defaults
          </h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-text-secondary">
            Friendly aliases and provider-neutral harness intent only.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Controller
            control={control}
            name="modelAlias"
            render={({ field }) => (
              <SelectField
                label="Model alias"
                value={field.value}
                onValueChange={field.onChange}
                options={[
                  { value: 'sonnet', label: 'Sonnet' },
                  { value: 'opus', label: 'Opus' },
                  { value: 'gpt-5', label: 'GPT-5' },
                ]}
              />
            )}
          />
          <Controller
            control={control}
            name="agentHarness"
            render={({ field }) => (
              <SelectField
                label="Agent harness"
                value={field.value}
                onValueChange={field.onChange}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'anthropic_sdk', label: 'Anthropic SDK' },
                  { value: 'deepagents', label: 'DeepAgents' },
                ]}
              />
            )}
          />
        </div>
        <TextAreaField
          id="agent-persona"
          label="Persona"
          rows={4}
          error={errors.persona?.message}
          {...register('persona')}
        />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <span className="text-xs text-text-muted">
          {isDirty ? 'Unsaved local changes' : 'No local changes'}
        </span>
        <div className="flex gap-2">
          <Button
            disabled={!isDirty}
            type="button"
            variant="ghost"
            onClick={() => reset(defaults)}
          >
            <RotateCcw size={15} aria-hidden="true" />
            Reset
          </Button>
          <Button type="submit">
            <Save size={15} aria-hidden="true" />
            Save changes
          </Button>
        </div>
      </div>
    </form>
  );
}

function TextAreaField({
  error,
  id,
  label,
  ...props
}: React.ComponentPropsWithRef<'textarea'> & {
  error?: string;
  id: string;
  label: string;
}) {
  return (
    <Field data-invalid={error ? true : undefined} className="gap-1.5">
      <FieldLabel className="text-xs font-semibold text-text" htmlFor={id}>
        {label}
      </FieldLabel>
      <Textarea
        aria-invalid={error ? true : undefined}
        className="resize-y bg-surface text-[13px] leading-5 text-text"
        id={id}
        {...props}
      />
      {error ? (
        <FieldDescription className="text-xs text-danger">
          {error}
        </FieldDescription>
      ) : null}
    </Field>
  );
}
