import siAmazonWebServices from '@iconify-icons/simple-icons/amazonwebservices';
import siAnthropic from '@iconify-icons/simple-icons/anthropic';
import siOpenAi from '@iconify-icons/simple-icons/openai';
import siOpenRouter from '@iconify-icons/simple-icons/openrouter';
import { Icon } from '@iconify/react';
import { Check, KeyRound } from 'lucide-react';

import { Button } from '../../../ui/primitives/button';
import { Input } from '../../../ui/primitives/input';
import { Textarea } from '../../../ui/primitives/textarea';
import { toast } from '../../../ui/primitives/toast';
import { modelOptions, type OnboardingDraft } from '../onboarding-state';

const providers = [
  ['anthropic', 'Anthropic', siAnthropic],
  ['openai', 'OpenAI', siOpenAi],
  ['openrouter', 'OpenRouter', siOpenRouter],
  ['bedrock', 'Amazon Bedrock', siAmazonWebServices],
] as const;

type CreateEmployeeStepProps = {
  draft: OnboardingDraft;
  onChange: (update: Partial<OnboardingDraft>) => void;
  previewReady: boolean;
  setPreviewReady: (value: boolean) => void;
};

export function CreateEmployeeStep({
  draft,
  onChange,
  previewReady,
  setPreviewReady,
}: CreateEmployeeStepProps) {
  const models = modelOptions[draft.provider];
  return (
    <div className="grid gap-6">
      <Heading
        body="Give your employee a name, say what it handles, and choose a model for this local preview. Nothing is saved yet."
        title="Create your first employee"
      />
      <div className="grid gap-5 rounded-2xl border border-border bg-surface p-5 shadow-panel sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Employee name"
            name="employee-name"
            value={draft.name}
            onChange={(name) => onChange({ name })}
          />
          <Field
            label="Job title"
            name="employee-title"
            value={draft.title}
            onChange={(title) => onChange({ title })}
          />
        </div>
        <label
          className="grid gap-2 text-sm font-medium"
          htmlFor="employee-responsibilities"
        >
          Responsibilities
          <Textarea
            id="employee-responsibilities"
            name="employee-responsibilities"
            onChange={(event) =>
              onChange({ responsibilities: event.target.value })
            }
            rows={5}
            value={draft.responsibilities}
          />
        </label>
      </div>
      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-panel">
        <div className="border-b border-border bg-surface-muted px-5 py-4 sm:px-6">
          <h2 className="m-0 font-display text-xl font-bold tracking-[-0.035em]">
            Model access
          </h2>
          <p className="mt-1 mb-0 text-sm leading-6 text-text-secondary">
            Pick the shape of the setup. Connection actions are preview-only in
            this UI version.
          </p>
        </div>
        <div className="grid gap-5 p-5 sm:p-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {providers.map(([id, label, icon]) => {
              const selected = draft.provider === id;
              return (
                <button
                  className={`grid min-w-0 justify-items-center gap-2 rounded-xl border p-3 text-sm font-medium transition-colors duration-200 ease-[var(--ease-gantry)] ${selected ? 'border-status-attention bg-status-attention-soft text-text' : 'border-border bg-surface hover:border-border-strong hover:bg-surface-muted'}`}
                  key={id}
                  onClick={() => {
                    const provider = id as OnboardingDraft['provider'];
                    onChange({ model: modelOptions[provider][0], provider });
                    setPreviewReady(false);
                  }}
                  type="button"
                >
                  <Icon aria-hidden="true" className="size-6" icon={icon} />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </div>
          <div className="grid gap-4 rounded-xl border border-border bg-surface-muted p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor="onboarding-model"
            >
              Chat model
              <select
                className="h-9 rounded-lg border border-border-strong bg-surface px-2.5 text-sm text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                id="onboarding-model"
                name="model"
                onChange={(event) => onChange({ model: event.target.value })}
                value={draft.model}
              >
                {models.map((model) => (
                  <option key={model}>{model}</option>
                ))}
              </select>
            </label>
            <Button
              onClick={() => {
                setPreviewReady(true);
                toast.success(
                  'Preview connection marked ready. No provider request was made.',
                );
              }}
              type="button"
              variant="outline"
            >
              {previewReady ? (
                <Check aria-hidden="true" />
              ) : (
                <KeyRound aria-hidden="true" />
              )}
              {previewReady ? 'Preview ready' : 'Test preview'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  name,
  onChange,
  value,
}: {
  label: string;
  name: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="grid gap-2 text-sm font-medium" htmlFor={name}>
      {label}
      <Input
        id={name}
        name={name}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </label>
  );
}

export function Heading({ body, title }: { body: string; title: string }) {
  return (
    <header className="grid justify-items-center gap-1 text-center">
      <h1 className="m-0 text-balance font-display text-[clamp(26px,3.2vw,34px)] font-bold leading-[1.05] tracking-[-0.04em]">
        {title}
      </h1>
      <p className="m-0 max-w-[48ch] text-pretty text-[14.5px] leading-6 text-text-secondary">
        {body}
      </p>
    </header>
  );
}
