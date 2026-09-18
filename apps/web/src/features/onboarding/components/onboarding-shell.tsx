import { Link } from '@tanstack/react-router';
import { Check, ChevronRight, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  gantryRailStepFour,
  gantryRailStepFourReduced,
  gantryRailStepOne,
  gantryRailStepOneReduced,
  gantryRailStepThree,
  gantryRailStepThreeReduced,
  gantryRailStepTwo,
  gantryRailStepTwoReduced,
  knacklabsMark,
} from '../../../assets/onboarding';
import { usePreferences } from '../../preferences/preferences-provider';
import { onboardingSteps, type OnboardingStep } from '../onboarding-state';

const railMarks = [
  [gantryRailStepOne, gantryRailStepOneReduced],
  [gantryRailStepTwo, gantryRailStepTwoReduced],
  [gantryRailStepThree, gantryRailStepThreeReduced],
  [gantryRailStepFour, gantryRailStepFourReduced],
] as const;

type OnboardingShellProps = {
  children: ReactNode;
  onBack: () => void;
  onNext: () => void;
  onStepChange: (step: OnboardingStep) => void;
  step: OnboardingStep;
};

export function OnboardingShell({
  children,
  onBack,
  onNext,
  onStepChange,
  step,
}: OnboardingShellProps) {
  const { effectiveTheme, preferences, setTheme } = usePreferences();

  return (
    <div className="onboarding-page">
      <header className="onboarding-header">
        <div className="onboarding-header-controls">
          <Link className="onboarding-brand" to="/overview">
            <GantryMark />
            <strong>Gantry</strong>
          </Link>
          <span className="onboarding-rule" />
        </div>
        <button
          aria-label="Toggle theme"
          className="onboarding-theme"
          onClick={() => setTheme(effectiveTheme === 'dark' ? 'light' : 'dark')}
          type="button"
        >
          <span className={effectiveTheme === 'dark' ? 'is-dark' : ''}>
            {effectiveTheme === 'dark' ? (
              <Moon aria-hidden="true" size={11} />
            ) : (
              <Sun aria-hidden="true" size={12} />
            )}
          </span>
        </button>
      </header>
      <div className="onboarding-grid">
        <aside className="onboarding-rail">
          <div className="onboarding-rail-mark">
            <img
              alt=""
              aria-hidden="true"
              src={railMarks[step - 1][preferences.reduceMotion ? 1 : 0]}
            />
          </div>
          <div className="onboarding-steps">
            {onboardingSteps.map(([label, blurb], index) => {
              const number = (index + 1) as OnboardingStep;
              const active = step === number;
              const complete = step > number;
              return (
                <button
                  className="onboarding-step"
                  disabled={number > step}
                  key={label}
                  onClick={() => onStepChange(number)}
                  type="button"
                >
                  <span
                    className={`onboarding-node ${active ? 'is-active' : ''} ${complete ? 'is-complete' : ''}`}
                  >
                    {complete ? <Check aria-hidden="true" size={13} /> : number}
                  </span>
                  <span>
                    <b>{label}</b>
                    <small>{blurb}</small>
                  </span>
                </button>
              );
            })}
          </div>
          <a
            className="onboarding-powered"
            href="https://www.knacklabs.ai"
            rel="noreferrer"
            target="_blank"
          >
            <img alt="" aria-hidden="true" src={knacklabsMark} />
            <strong>KnackLabs</strong>
          </a>
        </aside>
        <main className="onboarding-main">
          <section className="onboarding-content">{children}</section>
          <footer className="onboarding-actions">
            <button
              className="onboarding-secondary"
              onClick={onBack}
              type="button"
            >
              Back
            </button>
            <button
              className="onboarding-primary"
              onClick={onNext}
              type="button"
            >
              {step === 4 ? 'Open the console' : 'Continue'}
              <ChevronRight aria-hidden="true" size={15} />
            </button>
          </footer>
        </main>
      </div>
    </div>
  );
}

export function GantryMark({
  hero,
  large,
}: {
  hero?: boolean;
  large?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`gantry-mark ${large ? 'gantry-mark-large' : ''} ${hero ? 'gantry-mark-hero' : ''}`}
    >
      {Array.from({ length: 9 }, (_, index) => (
        <i key={index} />
      ))}
    </span>
  );
}
