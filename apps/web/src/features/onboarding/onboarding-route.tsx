import { Navigate, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { AuthLoadingPage } from '../auth/auth-pages';
import { toast } from '../../ui/primitives/toast';
import { useCompleteOnboarding, useOnboardingEligibility } from './first-run';
import { OnboardingShell } from './components/onboarding-shell';
import { OnboardingSplash } from './components/onboarding-splash';
import {
  initialOnboardingDraft,
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
  if (eligibility.status === 'complete')
    return <Navigate replace to="/overview" />;
  return <OnboardingPreview />;
}

function OnboardingPreview() {
  const navigate = useNavigate();
  const completion = useCompleteOnboarding();
  const [draft, setDraft] = useState(initialOnboardingDraft);
  const [paused, setPaused] = useState(false);
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState<OnboardingStep>(1);
  const [previewReady, setPreviewReady] = useState(false);
  const [workspaceConnected, setWorkspaceConnected] = useState(false);
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

  function next() {
    if (step === 4) {
      completion.mutate(undefined, {
        onSuccess: () => void navigate({ to: '/overview' }),
        onError: () =>
          toast.error('Gantry could not save your onboarding progress.', {
            action: { label: 'Retry', onClick: next },
          }),
      });
      return;
    }
    setStep((current) => (current + 1) as OnboardingStep);
  }

  return (
    <OnboardingShell
      onBack={back}
      onNext={next}
      onStepChange={setStep}
      nextDisabled={step === 4 && completion.isPending}
      step={step}
    >
      {step === 1 ? (
        <CreateEmployeeStep
          draft={draft}
          onChange={updateDraft}
          previewReady={previewReady}
          setPreviewReady={setPreviewReady}
        />
      ) : null}
      {step === 2 ? (
        <ConnectWorkspaceStep
          connected={workspaceConnected}
          draft={draft}
          onChange={updateDraft}
          setConnected={setWorkspaceConnected}
        />
      ) : null}
      {step === 3 ? (
        <AssignWorkStep
          draft={draft}
          onChange={updateDraft}
          onContinue={next}
        />
      ) : null}
      {step === 4 ? <SayHelloStep draft={draft} /> : null}
    </OnboardingShell>
  );
}
