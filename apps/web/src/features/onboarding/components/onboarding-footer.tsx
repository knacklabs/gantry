import { ChevronRight, LoaderCircle } from 'lucide-react';

import type { OnboardingStep } from '../onboarding-state';

export function OnboardingFooter({
  disabled = false,
  onBack,
  onNext,
  pending = false,
  step,
}: {
  disabled?: boolean;
  onBack: () => void;
  onNext: () => void;
  pending?: boolean;
  step: OnboardingStep;
}) {
  return (
    <footer className="onboarding-actions">
      <button
        className="onboarding-secondary"
        disabled={pending}
        onClick={onBack}
        type="button"
      >
        Back
      </button>
      <button
        className="onboarding-primary"
        disabled={disabled || pending}
        onClick={onNext}
        type="button"
      >
        {pending ? (
          <LoaderCircle
            aria-hidden="true"
            className="onboarding-spinner"
            size={15}
          />
        ) : null}
        {pending ? 'Saving…' : step === 4 ? 'Open the console' : 'Continue'}
        {!pending ? <ChevronRight aria-hidden="true" size={15} /> : null}
      </button>
    </footer>
  );
}
