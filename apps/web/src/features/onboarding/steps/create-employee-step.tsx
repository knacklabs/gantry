import siAmazonWebServices from '@iconify-icons/simple-icons/amazonwebservices';
import siAnthropic from '@iconify-icons/simple-icons/anthropic';
import siGoogleCloud from '@iconify-icons/simple-icons/googlecloud';
import siOpenAi from '@iconify-icons/simple-icons/openai';
import siOpenRouter from '@iconify-icons/simple-icons/openrouter';
import { Icon } from '@iconify/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, KeyRound, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { toast } from '../../../ui/primitives/toast';
import { modelProviderQuery } from '../../operations/operations-queries';
import { onboardingMutation } from '../onboarding-http-client';
import {
  onboardingCandidateModelsQuery,
  onboardingStatusQuery,
  type OnboardingStatus,
} from '../first-run';
import { defaultModelAliases, type OnboardingDraft } from '../onboarding-state';

const providers = [
  ['anthropic', 'Anthropic', siAnthropic],
  ['bedrock', 'Amazon Bedrock', siAmazonWebServices],
  ['openai', 'OpenAI', siOpenAi],
  ['openrouter', 'OpenRouter', siOpenRouter],
  ['vertex', 'Google Vertex AI', siGoogleCloud],
] as const;

type ModelCandidate = NonNullable<
  NonNullable<OnboardingStatus['deployment']>['modelCandidate']
>;
type StepPhase =
  | 'idle'
  | 'checking'
  | 'checked'
  | 'verifying'
  | 'verified'
  | 'activating';

export function CreateEmployeeStep({
  candidate,
  draft,
  onChange,
  onContinueActionChange,
}: {
  candidate: ModelCandidate | null;
  draft: OnboardingDraft;
  onChange: (update: Partial<OnboardingDraft>) => void;
  onContinueActionChange: (
    action: (() => Promise<void>) | null,
    disabled: boolean,
  ) => void;
}) {
  const queryClient = useQueryClient();
  const { data: registryProviders = [] } = useQuery(modelProviderQuery);
  const resumableCandidate = candidateIsCurrent(candidate) ? candidate : null;
  const [modeIndex, setModeIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [candidateId, setCandidateId] = useState<string | null>(
    resumableCandidate?.id ?? null,
  );
  const [phase, setPhase] = useState<StepPhase>(() =>
    phaseForCandidate(resumableCandidate),
  );
  const [verificationExpiresAt, setVerificationExpiresAt] = useState<
    string | null
  >(resumableCandidate?.verificationExpiresAt ?? null);
  const candidateModels = useQuery(onboardingCandidateModelsQuery(candidateId));
  const setup = registryProviders.find(
    (provider) => provider.providerId === draft.provider,
  );
  const mode = setup?.credentialModes[modeIndex] ?? setup?.credentialModes[0];
  const selectedProvider = providers.find(([id]) => id === draft.provider);
  const selectedModel = candidateModels.data?.models.find(
    (model) => model.alias === draft.model,
  );
  const availableEfforts = (selectedModel?.supportedEffortLevels ?? []).filter(
    (effort) => ['low', 'medium', 'high', 'xhigh'].includes(effort),
  );
  const pending =
    phase === 'checking' || phase === 'verifying' || phase === 'activating';
  const credentialsChecked =
    phase === 'checked' || phase === 'verifying' || phase === 'verified';
  const modelVerified = phase === 'verified' || phase === 'activating';

  useEffect(() => {
    if (!setup || !resumableCandidate) return;
    const resumedMode = setup.credentialModes.findIndex(
      (item) => item.id === resumableCandidate.authMode,
    );
    if (resumedMode >= 0) setModeIndex(resumedMode);
  }, [resumableCandidate, setup]);

  useEffect(() => {
    if (phase !== 'verified' || !verificationExpiresAt) return;
    const remaining = Date.parse(verificationExpiresAt) - Date.now();
    if (remaining <= 0) {
      setPhase('checked');
      return;
    }
    const timeout = window.setTimeout(() => setPhase('checked'), remaining);
    return () => window.clearTimeout(timeout);
  }, [phase, verificationExpiresAt]);

  const complete = useMemo(
    () =>
      Boolean(
        mode?.fields.every(
          (field) => !field.required || values[field.name]?.trim(),
        ),
      ),
    [mode, values],
  );

  const discardCandidate = useCallback(() => {
    if (candidateId) {
      void onboardingMutation(
        `/model-candidates/${candidateId}/cancel`,
        {},
      ).catch(() => undefined);
    }
    setCandidateId(null);
    setPhase('idle');
    setVerificationExpiresAt(null);
  }, [candidateId]);

  function changeProvider(provider: OnboardingDraft['provider']) {
    if (provider === draft.provider || pending) return;
    discardCandidate();
    setModeIndex(0);
    setValues({});
    setFieldError(null);
    onChange({
      model: defaultModelAliases[provider],
      provider,
      effort: undefined,
    });
  }

  function changeMode(index: number) {
    if (pending) return;
    discardCandidate();
    setModeIndex(index);
    setValues({});
    setFieldError(null);
  }

  function changeValue(name: string, value: string) {
    if (pending) return;
    if (phase !== 'idle') discardCandidate();
    setValues((current) =>
      phase === 'idle' ? { ...current, [name]: value } : { [name]: value },
    );
    setFieldError(null);
  }

  function changeModel(model: string) {
    if (pending) return;
    onChange({ model, effort: undefined });
    if (phase === 'verified') {
      setPhase('checked');
      setVerificationExpiresAt(null);
    }
  }

  const activate = useCallback(async () => {
    if (!candidateId || phase !== 'verified') return;
    setPhase('activating');
    try {
      await onboardingMutation(`/model-candidates/${candidateId}/activate`, {
        name: draft.name,
        title: draft.title,
        responsibilities: draft.responsibilities,
        effort: draft.effort,
      });
      setValues({});
      await queryClient.invalidateQueries({
        queryKey: onboardingStatusQuery.queryKey,
      });
      toast.success('Employee created with the verified model.');
    } catch (error) {
      setPhase('verified');
      throw error;
    }
  }, [
    candidateId,
    draft.name,
    draft.effort,
    draft.responsibilities,
    draft.title,
    phase,
    queryClient,
  ]);

  useEffect(() => {
    onContinueActionChange(
      phase === 'verified' ? activate : null,
      phase !== 'verified',
    );
    return () => onContinueActionChange(null, false);
  }, [activate, onContinueActionChange, phase]);

  async function checkCredentials() {
    if (!complete || pending) {
      setFieldError('Complete the required fields to check these credentials.');
      return;
    }
    setFieldError(null);
    setPhase('checking');
    try {
      const staged = await onboardingMutation<{
        candidate: { id: string };
      }>('/model-candidates', {
        providerId: draft.provider,
        authMode: mode?.id,
        credentials: values,
      });
      setCandidateId(staged.candidate.id);
      await onboardingMutation(
        `/model-candidates/${staged.candidate.id}/check`,
        {},
      );
      setValues({});
      setPhase('checked');
      await queryClient.invalidateQueries({
        queryKey: onboardingStatusQuery.queryKey,
      });
      toast.success('Credentials checked.');
    } catch (error) {
      setCandidateId(null);
      setValues({});
      setPhase('idle');
      setFieldError(
        error instanceof Error ? error.message : 'Credential check failed.',
      );
    }
  }

  async function testModel() {
    if (!candidateId || (phase !== 'checked' && phase !== 'verified')) return;
    setFieldError(null);
    setPhase('verifying');
    try {
      const verified = await onboardingMutation<{
        candidate: { verificationExpiresAt: string };
      }>(`/model-candidates/${candidateId}/verify`, {
        modelAlias: draft.model,
        effort: draft.effort,
      });
      setVerificationExpiresAt(verified.candidate.verificationExpiresAt);
      setPhase('verified');
      await queryClient.invalidateQueries({
        queryKey: onboardingStatusQuery.queryKey,
      });
      toast.success('Live model inference succeeded.');
    } catch (error) {
      setCandidateId(null);
      setValues({});
      setVerificationExpiresAt(null);
      setPhase('idle');
      setFieldError(
        error instanceof Error ? error.message : 'Model verification failed.',
      );
    }
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
                  disabled={pending}
                  key={id}
                  onClick={() =>
                    changeProvider(id as OnboardingDraft['provider'])
                  }
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
                <small>
                  {mode?.label ?? 'Loading authentication methods…'}
                </small>
              </span>
            </span>
          </div>
          <div className="onboarding-model-scroll onboarding-credential-fields">
            {(setup?.credentialModes.length ?? 0) > 1 ? (
              <label className="onboarding-field">
                <span>Authentication method</span>
                <span className="onboarding-select-wrap">
                  <select
                    disabled={pending}
                    onChange={(event) => changeMode(Number(event.target.value))}
                    value={modeIndex}
                  >
                    {setup?.credentialModes.map((item, index) => (
                      <option key={item.id} value={index}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown aria-hidden="true" />
                </span>
              </label>
            ) : null}
            <p className="onboarding-credential-help">{mode?.helpText}</p>
            {mode?.fields.map((field) => (
              <label className="onboarding-field" key={field.name}>
                <span>{field.label}</span>
                {field.multiline ? (
                  <textarea
                    disabled={pending}
                    onChange={(event) =>
                      changeValue(field.name, event.target.value)
                    }
                    placeholder={
                      credentialsChecked ? 'Checked for this setup' : undefined
                    }
                    value={values[field.name] ?? ''}
                  />
                ) : (
                  <input
                    disabled={pending}
                    onChange={(event) =>
                      changeValue(field.name, event.target.value)
                    }
                    placeholder={
                      credentialsChecked
                        ? field.secret
                          ? '••••••••'
                          : 'Checked for this setup'
                        : undefined
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
              className={`onboarding-validate ${credentialsChecked || modelVerified ? 'is-success' : ''}`}
              disabled={pending || credentialsChecked || modelVerified}
              onClick={() => void checkCredentials()}
              type="button"
            >
              {phase === 'checking' ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="onboarding-spinner"
                  size={13}
                />
              ) : credentialsChecked || modelVerified ? (
                <Check aria-hidden="true" size={13} />
              ) : (
                <KeyRound aria-hidden="true" size={13} />
              )}
              {phase === 'checking'
                ? 'Checking credentials…'
                : credentialsChecked || modelVerified
                  ? 'Credentials checked'
                  : 'Check credentials'}
            </button>
            <div
              className={`onboarding-model-choice ${!credentialsChecked && !modelVerified ? 'is-disabled' : ''}`}
            >
              <div className="onboarding-model-action-row">
                <label className="onboarding-field">
                  <span>Which one should it use?</span>
                  <span className="onboarding-select-wrap">
                    <select
                      disabled={
                        !credentialsChecked ||
                        pending ||
                        candidateModels.isPending ||
                        candidateModels.isError
                      }
                      onChange={(event) => changeModel(event.target.value)}
                      value={draft.model}
                    >
                      {(candidateModels.data?.models ?? []).map((model) => (
                        <option key={model.alias} value={model.alias}>
                          {model.displayName}
                        </option>
                      ))}
                    </select>
                    <ChevronDown aria-hidden="true" />
                  </span>
                </label>
                <button
                  className={`onboarding-test-model ${modelVerified ? 'is-success' : ''}`}
                  disabled={
                    !credentialsChecked ||
                    pending ||
                    modelVerified ||
                    candidateModels.isPending ||
                    candidateModels.isError
                  }
                  onClick={() => void testModel()}
                  type="button"
                >
                  {phase === 'verifying' ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="onboarding-spinner"
                      size={13}
                    />
                  ) : modelVerified ? (
                    <Check aria-hidden="true" size={13} />
                  ) : null}
                  {phase === 'verifying'
                    ? 'Testing model…'
                    : modelVerified
                      ? 'Model verified'
                      : 'Test model'}
                </button>
              </div>
              {draft.provider === 'openai' && availableEfforts.length > 0 ? (
                <label className="onboarding-field">
                  <span>Reasoning effort</span>
                  <span className="onboarding-select-wrap">
                    <select
                      disabled={!credentialsChecked || pending}
                      onChange={(event) => {
                        onChange({
                          effort: (event.target.value ||
                            undefined) as OnboardingDraft['effort'],
                        });
                        if (phase === 'verified') {
                          setPhase('checked');
                          setVerificationExpiresAt(null);
                        }
                      }}
                      value={draft.effort ?? ''}
                    >
                      <option value="">Model default</option>
                      {availableEfforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                    <ChevronDown aria-hidden="true" />
                  </span>
                </label>
              ) : null}
              <small className="onboarding-model-guidance">
                {candidateModels.isError
                  ? 'Models could not be loaded. Check the credentials again to retry.'
                  : candidateModels.isPending && credentialsChecked
                    ? 'Loading available models…'
                    : 'Add credentials and check the configuration, then select a model and test it.'}
              </small>
            </div>
          </div>
        </section>
      </article>
    </div>
  );
}

function candidateIsCurrent(candidate: ModelCandidate | null) {
  return Boolean(
    candidate &&
    Date.parse(candidate.expiresAt) > Date.now() &&
    (candidate.state === 'checked' || candidate.state === 'verified'),
  );
}

function phaseForCandidate(candidate: ModelCandidate | null): StepPhase {
  if (!candidate) return 'idle';
  if (
    candidate.state === 'verified' &&
    candidate.verificationExpiresAt &&
    Date.parse(candidate.verificationExpiresAt) > Date.now()
  ) {
    return 'verified';
  }
  return candidate.state === 'checked' || candidate.state === 'verified'
    ? 'checked'
    : 'idle';
}

export function Heading({ body, title }: { body: string; title: string }) {
  return (
    <header className="onboarding-heading">
      <h1>{title}</h1>
      <p>{body}</p>
    </header>
  );
}
