import { ArrowRight, Pause, Play } from 'lucide-react';

import { gantrySplashMark, knacklabsMark } from '../../../assets/onboarding';
import { Button } from '../../../ui/primitives/button';
import { Input } from '../../../ui/primitives/input';
import type { OnboardingDraft } from '../onboarding-state';

type OnboardingSplashProps = {
  draft: OnboardingDraft;
  onChange: (update: Partial<OnboardingDraft>) => void;
  onStart: () => void;
  paused: boolean;
  setPaused: (paused: boolean) => void;
};

export function OnboardingSplash({
  draft,
  onChange,
  onStart,
  paused,
  setPaused,
}: OnboardingSplashProps) {
  return (
    <main className="onboarding-splash min-h-dvh overflow-y-auto px-5 pt-8 text-[#f0eeea] sm:px-10 sm:pt-12">
      <section className="mx-auto grid min-h-[calc(100dvh-2rem)] max-w-[52ch] content-center justify-items-center gap-5 py-12 text-center">
        <div className="grid justify-items-center gap-4">
          <img
            alt="Gantry"
            className="size-24"
            height="96"
            src={gantrySplashMark}
            width="96"
          />
          <span className="font-display text-[clamp(32px,5vw,46px)] font-bold tracking-[-0.05em]">
            Gantry
          </span>
        </div>
        <h1 className="m-0 text-balance font-display text-[clamp(26px,3.2vw,34px)] font-bold leading-[1.1] tracking-[-0.04em]">
          Set Up Your First Agent
        </h1>
        <div className="grid gap-2 text-[clamp(14px,1.8vw,16px)] leading-[1.5] text-[#b5b1aa]">
          <span>Your organisation’s new</span>
          <span className="flex items-center justify-center gap-2">
            <span aria-live="off" className="onboarding-role-roll">
              <span
                className={`onboarding-role-roll ${paused ? 'is-paused' : ''}`}
              >
                {[
                  'HR assistant',
                  'support desk',
                  'research analyst',
                  'ops watchdog',
                  'note taker',
                  'executive assistant',
                  'HR assistant',
                ].map((role, index) => (
                  <span className="block h-6" key={`${role}-${index}`}>
                    {role}
                  </span>
                ))}
              </span>
            </span>
            <button
              aria-label={
                paused ? 'Play role animation' : 'Pause role animation'
              }
              className="grid size-7 place-items-center rounded-full border border-white/20 text-[#f0eeea] hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              onClick={() => setPaused(!paused)}
              type="button"
            >
              {paused ? (
                <Play aria-hidden="true" className="size-3" />
              ) : (
                <Pause aria-hidden="true" className="size-3" />
              )}
            </button>
          </span>
        </div>
        <p className="m-0 max-w-[45ch] text-pretty text-[clamp(14px,1.8vw,16px)] leading-6 text-[#b5b1aa]">
          Hire one, tell it what it should handle, and it starts working where
          your team already talks. Takes about three minutes.
        </p>
        <div className="grid w-full max-w-sm gap-3 text-left">
          <label
            className="grid gap-1.5 text-sm font-medium text-[#f0eeea]"
            htmlFor="onboarding-name"
          >
            Employee name
            <Input
              id="onboarding-name"
              name="employee-name"
              onChange={(event) => onChange({ name: event.target.value })}
              value={draft.name}
            />
          </label>
          <label
            className="grid gap-1.5 text-sm font-medium text-[#f0eeea]"
            htmlFor="onboarding-title"
          >
            Job title
            <Input
              id="onboarding-title"
              name="employee-title"
              onChange={(event) => onChange({ title: event.target.value })}
              value={draft.title}
            />
          </label>
        </div>
        <Button
          className="h-12 rounded-full border-[#f0eeea] bg-[#f0eeea] px-6 text-[15px] text-[#131211] hover:bg-white"
          onClick={onStart}
          type="button"
        >
          Hire your first employee
          <ArrowRight aria-hidden="true" />
        </Button>
      </section>
      <footer className="mx-auto grid max-w-[520px] justify-items-center gap-4 pb-8">
        <span
          aria-hidden="true"
          className="h-px w-full bg-gradient-to-r from-transparent via-[#6defa6]/25 to-transparent"
        />
        <a
          className="inline-flex items-center gap-2 text-[#f0eeea]/90 no-underline hover:text-white"
          href="https://www.knacklabs.ai"
          rel="noreferrer"
          target="_blank"
        >
          <span className="font-mono text-[9.5px] tracking-[0.16em] uppercase text-[#807c75]">
            Powered by
          </span>
          <img
            alt="KnackLabs"
            className="size-5"
            height="20"
            src={knacklabsMark}
            width="20"
          />
          <span className="font-display text-[13.5px] font-bold tracking-[-0.02em]">
            KnackLabs
          </span>
        </a>
      </footer>
    </main>
  );
}
