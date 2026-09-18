import { ChevronRight } from 'lucide-react';

import type { OnboardingStep } from '../onboarding-state';

export function OnboardingFooter({
  busy = false,
  onBack,
  onNext,
  step,
}: {
  busy?: boolean;
  onBack: () => void;
  onNext: () => void;
  step: OnboardingStep;
}) {
  return (
    <footer className="onboarding-actions">
      <button className="onboarding-secondary" onClick={onBack} type="button">
        Back
      </button>
      <button
        className="onboarding-primary"
        disabled={busy}
        onClick={onNext}
        type="button"
      >
        {step === 4 ? 'Open the console' : 'Continue'}
        <ChevronRight aria-hidden="true" size={15} />
      </button>
    </footer>
  );
}
