import { ChevronRight, Pencil } from 'lucide-react';
import { useState } from 'react';

import { gantrySplashMark, knacklabsMark } from '../../assets/onboarding';
import { GantryMark } from './onboarding-mark';

const SPLASH_ROLES = [
  'HR assistant',
  'support desk',
  'research analyst',
  'ops watchdog',
  'note taker',
  'executive assistant',
] as const;

export function OnboardingSplash({
  name,
  onName,
  onStart,
  onTitle,
  resume,
  title,
}: {
  name: string;
  onName: (value: string) => void;
  onStart: () => void;
  onTitle: (value: string) => void;
  resume?: { name: string } | null;
  title: string;
}) {
  const [attemptedStart, setAttemptedStart] = useState(false);
  const nameError = attemptedStart && !name.trim();
  const titleError = attemptedStart && !title.trim();

  function start() {
    setAttemptedStart(true);
    if (!name.trim() || !title.trim()) return;
    onStart();
  }

  return (
    <main className="onboarding-splash">
      <div className="onboarding-splash-content">
        <div className="onboarding-splash-brand">
          <img
            className="onboarding-splash-mark"
            src={gantrySplashMark}
            alt=""
            aria-hidden="true"
          />
          <span className="onboarding-splash-mark-reduced" aria-hidden="true">
            <GantryMark />
          </span>
          <span>Gantry</span>
        </div>
        <h1>
          {resume
            ? `Finish setting up ${resume.name}`
            : 'Set Up Your First Agent'}
        </h1>
        <p className="onboarding-splash-role">
          <span>Your organisation’s new</span>
          <span className="onboarding-splash-role-window">
            <span className="onboarding-splash-role-list">
              {[...SPLASH_ROLES, SPLASH_ROLES[0]].map((role, index) => (
                <span key={`${role}-${index}`}>{role}</span>
              ))}
            </span>
          </span>
        </p>
        <p className="onboarding-splash-description">
          Hire one, tell it what it should handle, and it starts working where
          your team already talks. Takes about three minutes.
        </p>
        <div className="grid w-full max-w-[360px] gap-3">
          <label className="grid w-full justify-items-center gap-1 text-center">
            <span className="font-mono text-[9px] font-medium tracking-[0.13em] text-[#b5b1aa] uppercase">
              Give it a name
            </span>
            <span className="relative flex h-[40px] w-[170px] items-center rounded-[9px] border border-dashed border-[#f0eeea]/35 bg-white/[0.03] px-2.5 transition-[border-color,background,box-shadow] duration-[180ms] hover:border-[#f0eeea]/60 focus-within:border-[#60c39d] focus-within:bg-white/[0.06] focus-within:shadow-[0_0_0_3px_rgb(96_195_157_/_18%)]">
              <input
                aria-describedby={
                  nameError ? 'onboarding-name-error' : undefined
                }
                aria-invalid={nameError}
                className="peer min-w-0 w-full bg-transparent text-center font-display text-[25px] leading-none font-semibold tracking-[-0.03em] text-[#f0eeea] outline-none placeholder:text-[#807c75]"
                value={name}
                onChange={(event) => onName(event.target.value)}
                placeholder="Atlas"
              />
              <Pencil
                aria-hidden="true"
                className="pointer-events-none absolute right-2.5 size-3 text-[#b5b1aa] transition-opacity duration-150 peer-focus:opacity-0"
              />
            </span>
            {nameError ? (
              <small
                className="text-[11px] text-[#e69b80]"
                id="onboarding-name-error"
                role="alert"
              >
                Give your employee a name.
              </small>
            ) : null}
          </label>
          <label className="grid w-full max-w-[300px] justify-self-center gap-1 text-center">
            <span className="font-mono text-[8px] font-medium tracking-[0.12em] text-[#b5b1aa] uppercase">
              Job title
            </span>
            <input
              aria-describedby={
                titleError ? 'onboarding-title-error' : undefined
              }
              aria-invalid={titleError}
              className="h-9 w-full rounded-[8px] border border-[#f0eeea]/20 bg-white/[0.04] px-2.5 text-center text-[13px] font-medium text-[#f0eeea] outline-none transition-[border-color,background,box-shadow] duration-[180ms] placeholder:text-[#807c75] hover:border-[#f0eeea]/42 focus-visible:border-[#60c39d] focus-visible:bg-white/[0.07] focus-visible:shadow-[0_0_0_3px_rgb(96_195_157_/_18%)]"
              value={title}
              onChange={(event) => onTitle(event.target.value)}
              placeholder="e.g. General assistant"
            />
            {titleError ? (
              <small
                className="text-[11px] text-[#e69b80]"
                id="onboarding-title-error"
                role="alert"
              >
                Give your employee a job title.
              </small>
            ) : null}
          </label>
        </div>
        <button className="onboarding-splash-action" onClick={start}>
          {resume ? 'Resume setup' : 'Hire your first employee'}{' '}
          <ChevronRight size={16} />
        </button>
      </div>
      <footer className="onboarding-splash-footer">
        <span aria-hidden="true" />
        <a href="https://www.knacklabs.ai" target="_blank" rel="noreferrer">
          <span>Powered by</span>
          <img src={knacklabsMark} alt="" aria-hidden="true" />
          <strong>KnackLabs</strong>
        </a>
      </footer>
    </main>
  );
}
