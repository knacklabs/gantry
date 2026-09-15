import { useQueryClient } from '@tanstack/react-query';
import siAmazonWebServices from '@iconify-icons/simple-icons/amazonwebservices';
import siAnthropic from '@iconify-icons/simple-icons/anthropic';
import siGoogleCloud from '@iconify-icons/simple-icons/googlecloud';
import siOpenAi from '@iconify-icons/simple-icons/openai';
import siOpenRouter from '@iconify-icons/simple-icons/openrouter';
import { Icon } from '@iconify/react';
import { Check, ChevronDown, KeyRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { agentModelsQuery, type AgentModel } from '../agents/agents-queries';
import type { ModelProvider } from '../operations/operations-queries';
import { browserCsrfHeader, browserFetch } from '../../lib/auth/browser-auth';
import { toast } from 'sonner';

export const ONBOARDING_PROVIDER_IDS = [
  'anthropic',
  'bedrock',
  'openai',
  'openrouter',
  'vertex',
] as const;

const ONBOARDING_PROVIDER_ICONS: Record<string, typeof siAnthropic> = {
  anthropic: siAnthropic,
  bedrock: siAmazonWebServices,
  openai: siOpenAi,
  openrouter: siOpenRouter,
  vertex: siGoogleCloud,
};

export function OnboardingProviderMark({ providerId }: { providerId: string }) {
  const icon = ONBOARDING_PROVIDER_ICONS[providerId];
  return (
    <span className="onboarding-provider-mark" aria-hidden="true">
      {icon ? <Icon icon={icon} /> : null}
    </span>
  );
}

type CredentialMode = ModelProvider['credentialModes'][number];

export function onboardingProviders(providers: ModelProvider[]) {
  return ONBOARDING_PROVIDER_IDS.flatMap((providerId) => {
    const provider = providers.find((item) => item.providerId === providerId);
    return provider ? [provider] : [];
  });
}

export function requiredCredentialFieldErrors(
  mode: CredentialMode | undefined,
  values: Record<string, string>,
) {
  if (!mode) return { authMode: 'Choose an authentication method.' };
  return Object.fromEntries(
    mode.fields.flatMap((field) =>
      field.required && !values[field.name]?.trim()
        ? [[field.name, `${field.label} is required.`]]
        : [],
    ),
  );
}

export function OnboardingModelSetup({
  credentialValidated,
  model,
  models,
  onCredentialValidated,
  onModelChange,
  providerId,
  providers,
}: {
  credentialValidated: boolean;
  model: string;
  models: AgentModel[];
  onCredentialValidated: (validated: boolean) => void;
  onModelChange: (model: string) => void;
  providerId: string;
  providers: ModelProvider[];
}) {
  const queryClient = useQueryClient();
  const provider = onboardingProviders(providers).find(
    (item) => item.providerId === providerId,
  );
  const [modeId, setModeId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [changingCredential, setChangingCredential] = useState(false);
  const validationRequest = useRef(0);

  useEffect(() => {
    validationRequest.current += 1;
    const nextModeId =
      provider?.authMode ??
      (provider?.credentialModes.length === 1
        ? (provider.credentialModes[0]?.id ?? '')
        : '');
    setModeId(nextModeId);
    setValues({});
    setFieldErrors({});
    setCredentialError(null);
    setChangingCredential(false);
    onCredentialValidated(false);
  }, [onCredentialValidated, provider?.authMode, provider?.health, providerId]);

  const mode = useMemo(
    () => provider?.credentialModes.find((item) => item.id === modeId),
    [modeId, provider?.credentialModes],
  );
  const credentialIsStored =
    provider?.health === 'ready' && !changingCredential;
  const modelLocked = !credentialValidated || loadingModels;

  function resetValidation() {
    onCredentialValidated(false);
    onModelChange('');
    setCredentialError(null);
  }

  function changeMode(nextModeId: string) {
    setModeId(nextModeId);
    setValues({});
    setFieldErrors({});
    resetValidation();
  }

  function changeValue(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => {
      const remaining = { ...current };
      delete remaining[name];
      return remaining;
    });
    resetValidation();
  }

  async function validateCredential() {
    if (!provider) return;
    if (!credentialIsStored && !mode) {
      setFieldErrors({ authMode: 'Choose an authentication method.' });
      toast.error('Choose an authentication method first.');
      return;
    }
    const nextErrors = credentialIsStored
      ? {}
      : requiredCredentialFieldErrors(mode, values);
    if (Object.keys(nextErrors).length) {
      setFieldErrors(nextErrors);
      toast.error('Complete the required credential fields.');
      return;
    }
    const request = validationRequest.current + 1;
    validationRequest.current = request;
    setValidating(true);
    setCredentialError(null);
    const payload = Object.fromEntries(
      (mode?.fields ?? []).flatMap((field) => {
        const value = values[field.name]?.trim();
        return value ? [[field.name, value]] : [];
      }),
    );
    try {
      const verification = await browserFetch(
        `/ui/api/model-providers/${encodeURIComponent(provider.providerId)}/verify`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            ...(credentialIsStored
              ? {}
              : { 'content-type': 'application/json' }),
            ...browserCsrfHeader(),
          },
          ...(credentialIsStored
            ? {}
            : {
                body: JSON.stringify({
                  authMode: mode!.id,
                  payload,
                  agentHarness: 'auto',
                }),
              }),
        },
      );
      const verificationBody = (await verification
        .json()
        .catch(() => null)) as {
        message?: string;
        status?: 'pass' | 'fail' | 'skipped';
      } | null;
      if (!verification.ok || verificationBody?.status !== 'pass') {
        throw new Error(
          verificationBody?.message ??
            'Gantry could not validate this connection.',
        );
      }
      setLoadingModels(true);
      await queryClient.fetchQuery({ ...agentModelsQuery, staleTime: 0 });
      if (request !== validationRequest.current) return;
      setValues({});
      setChangingCredential(false);
      onCredentialValidated(true);
      toast.success('Configuration validated. Choose a model to continue.');
    } catch (error) {
      if (request !== validationRequest.current) return;
      const message =
        error instanceof Error
          ? error.message
          : 'Gantry could not validate this connection.';
      setCredentialError(message);
      toast.error('Credential validation failed.');
      onCredentialValidated(false);
      onModelChange('');
    } finally {
      if (request === validationRequest.current) {
        setLoadingModels(false);
        setValidating(false);
      }
    }
  }

  return (
    <section className="onboarding-model-setup onboarding-model-pane">
      <div className="onboarding-provider-heading">
        <span className="onboarding-selected-provider">
          {provider ? (
            <OnboardingProviderMark providerId={provider.providerId} />
          ) : null}
          <span>
            <b>{provider?.label ?? 'Choose a provider'}</b>
            <small>{mode?.label ?? 'Configure credentials'}</small>
          </span>
        </span>
        <span className={credentialValidated ? 'is-ready' : ''}>
          {credentialValidated ? <Check aria-hidden="true" /> : <i />}
          {credentialValidated ? 'Connected' : 'Needs a key'}
        </span>
      </div>
      <div className="onboarding-model-scroll">
        {provider ? (
          <div className="onboarding-credential-fields">
            {credentialIsStored && !credentialValidated ? (
              <div className="onboarding-stored-credential">
                <span>
                  <Check size={13} /> A credential is stored.
                </span>
                <button onClick={() => void validateCredential()} type="button">
                  {validating
                    ? 'Validating configuration…'
                    : 'Validate configuration'}
                </button>
                <button
                  onClick={() => {
                    setChangingCredential(true);
                    resetValidation();
                  }}
                  type="button"
                >
                  Change credential
                </button>
              </div>
            ) : (
              <>
                {provider.credentialModes.length > 1 ? (
                  <label className="onboarding-field">
                    <span>Authentication method</span>
                    <span className="onboarding-select-wrap">
                      <select
                        aria-invalid={Boolean(fieldErrors.authMode)}
                        onChange={(event) => changeMode(event.target.value)}
                        value={modeId}
                      >
                        <option value="">Choose a method</option>
                        {provider.credentialModes.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown aria-hidden="true" />
                    </span>
                    {fieldErrors.authMode ? (
                      <small className="onboarding-inline-error" role="alert">
                        {fieldErrors.authMode}
                      </small>
                    ) : null}
                  </label>
                ) : null}
                {mode ? (
                  <>
                    <p className="onboarding-credential-help">
                      {mode.helpText}
                    </p>
                    {mode.fields.map((field) => (
                      <label className="onboarding-field" key={field.name}>
                        <span>{field.label}</span>
                        {field.multiline ? (
                          <textarea
                            aria-invalid={Boolean(fieldErrors[field.name])}
                            onChange={(event) =>
                              changeValue(field.name, event.target.value)
                            }
                            value={values[field.name] ?? ''}
                          />
                        ) : (
                          <input
                            aria-invalid={Boolean(fieldErrors[field.name])}
                            onChange={(event) =>
                              changeValue(field.name, event.target.value)
                            }
                            type={field.secret ? 'password' : 'text'}
                            value={values[field.name] ?? ''}
                          />
                        )}
                        {fieldErrors[field.name] ? (
                          <small
                            className="onboarding-inline-error"
                            role="alert"
                          >
                            {fieldErrors[field.name]}
                          </small>
                        ) : null}
                      </label>
                    ))}
                    {credentialError ? (
                      <p className="onboarding-credential-error" role="alert">
                        {credentialError}
                      </p>
                    ) : null}
                    <button
                      className="onboarding-validate"
                      disabled={validating}
                      onClick={() => void validateCredential()}
                      type="button"
                    >
                      <KeyRound size={13} />
                      {validating
                        ? 'Validating configuration…'
                        : 'Validate configuration'}
                    </button>
                  </>
                ) : null}
              </>
            )}
            <label className="onboarding-field onboarding-model-choice">
              <span>Which one should it use?</span>
              <span className="onboarding-select-wrap">
                <select
                  disabled={modelLocked}
                  onChange={(event) => onModelChange(event.target.value)}
                  value={model}
                >
                  <option value="">
                    {loadingModels
                      ? 'Loading available models…'
                      : modelLocked
                        ? 'Validate credentials first'
                        : 'Select a model'}
                  </option>
                  {models.map((item) => (
                    <option key={item.alias} value={item.alias}>
                      {item.displayName}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden="true" />
              </span>
            </label>
          </div>
        ) : null}
      </div>
    </section>
  );
}
