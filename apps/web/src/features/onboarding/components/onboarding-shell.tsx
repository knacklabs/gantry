import { Check, ChevronLeft, ChevronRight, Moon, Sun } from 'lucide-react';
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
import { Button } from '../../../ui/primitives/button';
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
  const nextLabel = step === 4 ? 'Open Console' : 'Continue';

  return (
    <main className="min-h-dvh bg-canvas text-text">
      <header className="sticky top-0 z-20 flex min-h-[58px] items-center justify-between gap-4 border-b border-border bg-canvas px-4 py-3 sm:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="onboarding-brand-mark" />
          <span className="font-display text-[19px] font-bold tracking-[-0.045em]">
            Gantry
          </span>
          <span aria-hidden="true" className="h-4 w-px bg-border-strong" />
          <button
            aria-label={`Switch to ${effectiveTheme === 'dark' ? 'light' : 'dark'} theme`}
            className="relative inline-flex h-7 w-[50px] items-center rounded-full border border-border-strong bg-surface-muted p-[3px] transition-colors duration-200 ease-[var(--ease-gantry)] hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            onClick={() =>
              setTheme(effectiveTheme === 'dark' ? 'light' : 'dark')
            }
            type="button"
          >
            <span
              className={`grid size-[22px] place-items-center rounded-full bg-surface text-status-attention shadow-panel transition-transform duration-200 ease-[var(--ease-gantry)] ${effectiveTheme === 'dark' ? 'translate-x-5 bg-ink text-ink-on' : ''}`}
            >
              {effectiveTheme === 'dark' ? (
                <Moon aria-hidden="true" className="size-3" />
              ) : (
                <Sun aria-hidden="true" className="size-3" />
              )}
            </span>
          </button>
        </div>
      </header>

      <div className="grid min-h-[calc(100dvh-58px)] lg:grid-cols-[266px_minmax(0,1fr)]">
        <aside className="hidden border-r border-border bg-surface-muted px-6 py-6 lg:flex lg:min-h-0 lg:flex-col">
          <div className="grid place-items-center border-b border-border pb-[22px]">
            <img
              alt=""
              className="size-[57px]"
              height="57"
              src={railMarks[step - 1][preferences.reduceMotion ? 1 : 0]}
              width="57"
            />
          </div>
          <ol className="my-auto list-none space-y-0 p-0">
            {onboardingSteps.map(([title, description], index) => {
              const number = (index + 1) as OnboardingStep;
              const complete = number < step;
              const active = number === step;
              return (
                <li className="relative pb-6 last:pb-0" key={title}>
                  {number < 4 ? (
                    <span
                      aria-hidden="true"
                      className={`absolute top-[30px] bottom-0 left-[14px] w-px ${complete ? 'bg-status-success' : 'bg-border-strong'}`}
                    />
                  ) : null}
                  <button
                    className="relative grid w-full grid-cols-[30px_minmax(0,1fr)] gap-3 text-left"
                    disabled={number > step}
                    onClick={() => onStepChange(number)}
                    type="button"
                  >
                    <span
                      className={`grid size-[30px] place-items-center rounded-full border font-mono text-xs ${complete ? 'border-status-success bg-status-success text-surface' : active ? 'border-ink bg-ink text-ink-on shadow-[0_0_0_4px_color-mix(in_srgb,var(--ink)_12%,transparent)]' : 'border-border-strong bg-surface text-text-muted'}`}
                    >
                      {complete ? (
                        <Check aria-hidden="true" className="size-3.5" />
                      ) : (
                        number
                      )}
                    </span>
                    <span className="min-w-0 pt-1">
                      <b className="block text-[13.5px] tracking-[-0.015em]">
                        {title}
                      </b>
                      <small className="mt-0.5 block text-[11.5px] leading-[1.45] text-text-secondary">
                        {description}
                      </small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <a
            className="mx-auto inline-flex items-center gap-2 text-sm font-bold tracking-[-0.02em] text-text/50 no-underline hover:text-text"
            href="https://www.knacklabs.ai"
            rel="noreferrer"
            target="_blank"
          >
            <span className="font-mono text-[9px] font-medium tracking-[0.14em] uppercase">
              Powered by
            </span>
            <img
              alt="KnackLabs"
              className="size-5"
              height="20"
              src={knacklabsMark}
              width="20"
            />
          </a>
        </aside>

        <section className="grid min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-auto px-4 py-6 sm:px-8 sm:py-7">
          <div className="mx-auto grid w-full max-w-[760px] content-center py-4">
            {children}
          </div>
          <nav
            aria-label="Onboarding navigation"
            className="mx-auto flex w-full max-w-[760px] items-center justify-between gap-3 border-t border-border pt-4"
          >
            <Button onClick={onBack} type="button" variant="ghost">
              <ChevronLeft aria-hidden="true" />
              Back
            </Button>
            <Button
              className="rounded-full px-5 shadow-lift"
              onClick={onNext}
              type="button"
            >
              {nextLabel}
              <ChevronRight aria-hidden="true" />
            </Button>
          </nav>
        </section>
      </div>
    </main>
  );
}
