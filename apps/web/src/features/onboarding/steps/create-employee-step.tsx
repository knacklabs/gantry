import siAmazonWebServices from '@iconify-icons/simple-icons/amazonwebservices';
import siAnthropic from '@iconify-icons/simple-icons/anthropic';
import siOpenAi from '@iconify-icons/simple-icons/openai';
import siOpenRouter from '@iconify-icons/simple-icons/openrouter';
import { Icon } from '@iconify/react';
import { Check, KeyRound } from 'lucide-react';

import { toast } from '../../../ui/primitives/toast';
import { modelOptions, type OnboardingDraft } from '../onboarding-state';

const providers = [
  ['anthropic', 'Anthropic', siAnthropic],
  ['bedrock', 'Amazon Bedrock', siAmazonWebServices],
  ['openai', 'OpenAI', siOpenAi],
  ['openrouter', 'OpenRouter', siOpenRouter],
] as const;

export function CreateEmployeeStep({
  draft,
  onChange,
  previewReady,
  setPreviewReady,
}: {
  draft: OnboardingDraft;
  onChange: (update: Partial<OnboardingDraft>) => void;
  previewReady: boolean;
  setPreviewReady: (value: boolean) => void;
}) {
  return (
    <div className="grid gap-4">
      <Heading
        body="Give it a model to think with. All of it can change later."
        title="Onboard Your First Agent"
      />
      <article className="onboarding-card onboarding-model-card">
        <div className="onboarding-provider-heading">
          <span>Choose a model provider</span>
          <span>
            <i /> Preview only
          </span>
        </div>
        <div className="onboarding-provider-options">
          {providers.map(([id, label, icon]) => (
            <button
              className={draft.provider === id ? 'is-selected' : ''}
              key={id}
              onClick={() => {
                const provider = id as OnboardingDraft['provider'];
                onChange({ model: modelOptions[provider][0], provider });
                setPreviewReady(false);
              }}
              type="button"
            >
              <span className="onboarding-provider-mark">
                <Icon icon={icon} />
              </span>
              {label}
            </button>
          ))}
        </div>
        <div className="onboarding-model-choice">
          <label className="onboarding-field">
            <span>Which one should it use?</span>
            <select
              onChange={(event) => onChange({ model: event.target.value })}
              value={draft.model}
            >
              {modelOptions[draft.provider].map((model) => (
                <option key={model}>{model}</option>
              ))}
            </select>
          </label>
          <button
            className="onboarding-validate"
            onClick={() => {
              setPreviewReady(true);
              toast.success(
                'Preview connection marked ready. No provider request was made.',
              );
            }}
            type="button"
          >
            {previewReady ? (
              <Check aria-hidden="true" size={13} />
            ) : (
              <KeyRound aria-hidden="true" size={13} />
            )}
            {previewReady ? 'Tested & connected' : 'Validate connection'}
          </button>
        </div>
      </article>
    </div>
  );
}

export function Heading({ body, title }: { body: string; title: string }) {
  return (
    <header className="onboarding-heading">
      <h1>{title}</h1>
      <p>{body}</p>
    </header>
  );
}
