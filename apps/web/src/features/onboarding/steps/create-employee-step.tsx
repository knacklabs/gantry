import siAmazonWebServices from '@iconify-icons/simple-icons/amazonwebservices';
import siAnthropic from '@iconify-icons/simple-icons/anthropic';
import siGoogleCloud from '@iconify-icons/simple-icons/googlecloud';
import siOpenAi from '@iconify-icons/simple-icons/openai';
import siOpenRouter from '@iconify-icons/simple-icons/openrouter';
import { Icon } from '@iconify/react';
import { Check, ChevronDown, KeyRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { toast } from '../../../ui/primitives/toast';
import { modelOptions, type OnboardingDraft } from '../onboarding-state';

const providers = [
  ['anthropic', 'Anthropic', siAnthropic],
  ['bedrock', 'Amazon Bedrock', siAmazonWebServices],
  ['openai', 'OpenAI', siOpenAi],
  ['openrouter', 'OpenRouter', siOpenRouter],
  ['vertex', 'Google Vertex AI', siGoogleCloud],
] as const;

type PreviewField = {
  label: string;
  multiline?: boolean;
  name: string;
  optional?: boolean;
  secret?: boolean;
};

type ProviderSetup = {
  modes: readonly {
    fields: readonly PreviewField[];
    help: string;
    label: string;
  }[];
};

const providerSetup: Record<OnboardingDraft['provider'], ProviderSetup> = {
  anthropic: {
    modes: [
      {
        fields: [{ label: 'Anthropic key', name: 'apiKey', secret: true }],
        help: 'Use an Anthropic account key for direct Anthropic access.',
        label: 'API key',
      },
      {
        fields: [
          {
            label: 'Claude Code OAuth token',
            name: 'oauthToken',
            secret: true,
          },
        ],
        help: 'Use a Claude Code OAuth token. Gantry stores it and uses it only inside the Model Gateway.',
        label: 'Claude Code OAuth',
      },
    ],
  },
  bedrock: {
    modes: [
      {
        fields: [
          {
            label: 'AWS region',
            name: 'region',
          },
          {
            label: 'AWS profile (optional)',
            name: 'profile',
            optional: true,
            secret: false,
          },
        ],
        help: 'Use the host AWS credential chain for SigV4 Bedrock Chat Completions. In production, prefer an ECS task role, EC2 instance profile, EKS IRSA, or assumed role.',
        label: 'AWS role or profile',
      },
      {
        fields: [
          {
            label: 'AWS region',
            name: 'region',
          },
          {
            label: 'AWS Secrets Manager ref (aws-sm:...)',
            name: 'apiKeyRef',
            secret: false,
          },
        ],
        help: 'Resolve an Amazon Bedrock API key from AWS Secrets Manager at gateway time.',
        label: 'Bedrock API key in AWS Secrets Manager',
      },
      {
        fields: [
          {
            label: 'AWS region',
            name: 'region',
          },
          { label: 'Bedrock API key', name: 'apiKey', secret: true },
        ],
        help: 'Use an Amazon Bedrock API key for OpenAI-compatible chat completions.',
        label: 'Bedrock API key',
      },
    ],
  },
  openai: {
    modes: [
      {
        fields: [{ label: 'OpenAI key', name: 'apiKey', secret: true }],
        help: 'Use an OpenAI account key for OpenAI API access.',
        label: 'API key',
      },
    ],
  },
  openrouter: {
    modes: [
      {
        fields: [{ label: 'OpenRouter key', name: 'apiKey', secret: true }],
        help: 'Use an OpenRouter key for Anthropic-compatible routing.',
        label: 'API key',
      },
    ],
  },
  vertex: {
    modes: [
      {
        fields: [
          {
            label: 'Google Cloud location (currently global)',
            name: 'region',
            secret: false,
          },
          {
            label: 'Google Cloud project ID',
            name: 'projectId',
            secret: false,
          },
        ],
        help: 'Use Google Application Default Credentials to mint a host-side OAuth token for Vertex AI.',
        label: 'Google ADC or workload identity',
      },
      {
        fields: [
          {
            label: 'Google Cloud location (currently global)',
            name: 'region',
            secret: false,
          },
          {
            label: 'Google Cloud project ID',
            name: 'projectId',
            secret: false,
          },
          {
            label: 'Google Secret Manager ref (gcp-sm:...)',
            name: 'serviceAccountJsonRef',
            secret: false,
          },
        ],
        help: 'Resolve a Google service account JSON key from Google Secret Manager at gateway time.',
        label: 'Service account JSON in Google Secret Manager',
      },
      {
        fields: [
          {
            label: 'Google Cloud location (currently global)',
            name: 'region',
            secret: false,
          },
          {
            label: 'Google Cloud project ID',
            name: 'projectId',
            secret: false,
          },
          {
            label: 'Service account JSON',
            multiline: true,
            name: 'serviceAccountJson',
            secret: true,
          },
        ],
        help: 'Use a Google Cloud service account JSON key for OpenAI-compatible chat completions.',
        label: 'Service account',
      },
    ],
  },
};

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
  const [modeIndex, setModeIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldError, setFieldError] = useState<string | null>(null);
  const setup = providerSetup[draft.provider];
  const mode = setup.modes[modeIndex] ?? setup.modes[0];
  const selectedProvider = providers.find(([id]) => id === draft.provider);

  useEffect(() => {
    setModeIndex(0);
    setValues({});
    setFieldError(null);
    setPreviewReady(false);
  }, [draft.provider, setPreviewReady]);

  const complete = useMemo(
    () =>
      mode.fields.every(
        (field) => field.optional || values[field.name]?.trim(),
      ),
    [mode.fields, values],
  );

  function changeMode(index: number) {
    setModeIndex(index);
    setValues({});
    setFieldError(null);
    setPreviewReady(false);
  }

  function changeValue(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
    setFieldError(null);
    setPreviewReady(false);
  }

  return (
    <div className="grid gap-4">
      <Heading
        body="Give it a model to think with. All of it can change later."
        title="Onboard Your First Agent"
      />
      <article className="onboarding-card onboarding-model-card onboarding-split-card">
        <aside className="onboarding-identity-pane">
          <div className="onboarding-identity-pane-scroll">
            <div className="onboarding-provider-list">
              <span>Model provider</span>
              {providers.map(([id, label, icon]) => (
                <button
                  className={draft.provider === id ? 'is-selected' : ''}
                  key={id}
                  onClick={() => {
                    const provider = id as OnboardingDraft['provider'];
                    onChange({ model: modelOptions[provider][0], provider });
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
          </div>
        </aside>
        <section className="onboarding-model-pane">
          <div className="onboarding-provider-heading">
            <span className="onboarding-selected-provider">
              <span className="onboarding-provider-mark">
                {selectedProvider ? <Icon icon={selectedProvider[2]} /> : null}
              </span>
              <span>
                <b>{selectedProvider?.[1]}</b>
                <small>{mode.label}</small>
              </span>
            </span>
          </div>
          <div className="onboarding-model-scroll onboarding-credential-fields">
            {setup.modes.length > 1 ? (
              <label className="onboarding-field">
                <span>Authentication method</span>
                <span className="onboarding-select-wrap">
                  <select
                    onChange={(event) => changeMode(Number(event.target.value))}
                    value={modeIndex}
                  >
                    {setup.modes.map((item, index) => (
                      <option key={item.label} value={index}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown aria-hidden="true" />
                </span>
              </label>
            ) : null}
            <p className="onboarding-credential-help">{mode.help}</p>
            {mode.fields.map((field) => (
              <label className="onboarding-field" key={field.name}>
                <span>{field.label}</span>
                {field.multiline ? (
                  <textarea
                    onChange={(event) =>
                      changeValue(field.name, event.target.value)
                    }
                    value={values[field.name] ?? ''}
                  />
                ) : (
                  <input
                    onChange={(event) =>
                      changeValue(field.name, event.target.value)
                    }
                    type={field.secret ? 'password' : 'text'}
                    value={values[field.name] ?? ''}
                  />
                )}
              </label>
            ))}
            {fieldError ? (
              <small className="onboarding-inline-error" role="alert">
                {fieldError}
              </small>
            ) : null}
            <button
              className="onboarding-validate"
              onClick={() => {
                if (!complete) {
                  setFieldError(
                    'Complete the required fields to validate this preview.',
                  );
                  return;
                }
                setPreviewReady(true);
                toast.success(
                  'Connected — preview only. No provider request was made.',
                );
              }}
              type="button"
            >
              {previewReady ? (
                <Check aria-hidden="true" size={13} />
              ) : (
                <KeyRound aria-hidden="true" size={13} />
              )}
              {previewReady
                ? 'Connected — preview only'
                : 'Validate configuration'}
            </button>
            <div className="onboarding-model-choice">
              <label className="onboarding-field">
                <span>Which one should it use?</span>
                <span className="onboarding-select-wrap">
                  <select
                    onChange={(event) =>
                      onChange({ model: event.target.value })
                    }
                    value={draft.model}
                  >
                    {modelOptions[draft.provider].map((model) => (
                      <option key={model}>{model}</option>
                    ))}
                  </select>
                  <ChevronDown aria-hidden="true" />
                </span>
              </label>
            </div>
          </div>
        </section>
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
