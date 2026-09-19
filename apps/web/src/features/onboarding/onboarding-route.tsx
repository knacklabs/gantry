import { Navigate, useNavigate } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';

import { AuthLoadingPage } from '../auth/auth-pages';
import { toast } from '../../ui/primitives/toast';
import {
  useCompleteOnboarding,
  useOnboardingEligibility,
  type OnboardingStatus,
} from './first-run';
import { OnboardingShell } from './components/onboarding-shell';
import { OnboardingSplash } from './components/onboarding-splash';
import {
  initialOnboardingDraft,
  modelOptions,
  type OnboardingDraft,
  type OnboardingStep,
} from './onboarding-state';
import { AssignWorkStep } from './steps/assign-work-step';
import { ConnectWorkspaceStep } from './steps/connect-workspace-step';
import { CreateEmployeeStep } from './steps/create-employee-step';
import { SayHelloStep } from './steps/say-hello-step';
import './onboarding.css';

export function OnboardingRoute() {
  const eligibility = useOnboardingEligibility();
  if (eligibility.status === 'loading') return <AuthLoadingPage />;
  if (eligibility.status === 'fallback') return <AuthLoadingPage />;
  if (eligibility.status === 'complete')
    return <Navigate replace to="/overview" />;
  return <OnboardingPreview status={eligibility.onboarding} />;
}

function OnboardingPreview({ status }: { status: OnboardingStatus }) {
  const navigate = useNavigate();
  const completion = useCompleteOnboarding();
  const modelCandidate = status.deployment?.modelCandidate ?? null;
  const candidateProvider = isDraftProvider(modelCandidate?.providerId)
    ? modelCandidate.providerId
    : initialOnboardingDraft.provider;
  const [draft, setDraft] = useState<OnboardingDraft>({
    ...initialOnboardingDraft,
    provider: candidateProvider,
    model:
      modelCandidate?.modelAlias ??
      (modelCandidate
        ? (modelOptions[candidateProvider][0] ?? '')
        : initialOnboardingDraft.model),
  });
  const [paused, setPaused] = useState(false);
  const [started, setStarted] = useState(Boolean(status.deployment));
  const [step, setStep] = useState<OnboardingStep>(
    status.deployment?.step ?? 1,
  );
  const [workspaceConnected, setWorkspaceConnected] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const continueAction = useRef<(() => Promise<void>) | null>(null);
  const [stepActionDisabled, setStepActionDisabled] = useState(step === 1);
  const registerContinueAction = useCallback(
    (action: (() => Promise<void>) | null, disabled: boolean) => {
      continueAction.current = action;
      setStepActionDisabled(disabled);
    },
    [],
  );
  const updateDraft = (update: Partial<OnboardingDraft>) =>
    setDraft((current) => ({ ...current, ...update }));

  if (!started)
    return (
      <OnboardingSplash
        draft={draft}
        onChange={updateDraft}
        onStart={() => setStarted(true)}
        paused={paused}
        setPaused={setPaused}
      />
    );

  function back() {
    if (step === 1) setStarted(false);
    else setStep((current) => (current - 1) as OnboardingStep);
  }

  async function next() {
    if (advancing) return;
    if (step === 4) {
      if (!status.deployment || status.deployment.state !== 'ready') {
        toast.error('Complete the Slack reply check before opening Console.');
        return;
      }
      completion.mutate(status.deployment.version, {
        onSuccess: () => void navigate({ to: '/overview' }),
        onError: () =>
          toast.error('Gantry could not save your onboarding progress.', {
            action: { label: 'Retry', onClick: next },
          }),
      });
      return;
    }
    if (continueAction.current) {
      setAdvancing(true);
      try {
        await continueAction.current();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Onboarding step failed.',
        );
        return;
      } finally {
        setAdvancing(false);
      }
    }
    setStep((current) => (current + 1) as OnboardingStep);
    setStepActionDisabled(false);
  }

  return (
    <OnboardingShell
      onBack={back}
      onNext={next}
      onStepChange={setStep}
      nextDisabled={
        advancing ||
        ((step === 1 || step === 3) && stepActionDisabled) ||
        (step === 2 && !workspaceConnected) ||
        (step === 4 &&
          (completion.isPending || status.deployment?.state !== 'ready'))
      }
      nextPending={advancing || completion.isPending}
      step={step}
    >
      {step === 1 ? (
        <CreateEmployeeStep
          candidate={modelCandidate}
          draft={draft}
          onChange={updateDraft}
          onContinueActionChange={registerContinueAction}
        />
      ) : null}
      {step === 2 ? (
        <ConnectWorkspaceStep
          agentId={status.deployment?.agentId ?? null}
          agentName={draft.name}
          channelId={draft.channel}
          connected={workspaceConnected}
          onChannelChange={(channel) => {
            updateDraft({ channel: channel as OnboardingDraft['channel'] });
            setWorkspaceConnected(false);
          }}
          onConnect={() => setWorkspaceConnected(true)}
        />
      ) : null}
      {step === 3 ? (
        <AssignWorkStep
          onChange={updateDraft}
          onContinueActionChange={registerContinueAction}
        />
      ) : null}
      {step === 4 ? <SayHelloStep draft={draft} /> : null}
    </OnboardingShell>
  );
}

function isDraftProvider(
  providerId: string | null | undefined,
): providerId is OnboardingDraft['provider'] {
  return Boolean(providerId && providerId in modelOptions);
}
