import { ChevronRight, Pencil } from 'lucide-react';

import { gantrySplashMark, knacklabsMark } from '../../../assets/onboarding';
import type { OnboardingDraft } from '../onboarding-state';
import { GantryMark } from './onboarding-shell';

type OnboardingSplashProps = {
  draft: OnboardingDraft;
  onChange: (update: Partial<OnboardingDraft>) => void;
  onStart: () => void;
  paused: boolean;
  setPaused: (paused: boolean) => void;
};

const roles = [
  'HR assistant',
  'support desk',
  'research analyst',
  'ops watchdog',
  'note taker',
  'executive assistant',
] as const;

export function OnboardingSplash({
  draft,
  onChange,
  onStart,
}: OnboardingSplashProps) {
  return (
    <main className="onboarding-splash">
      <div className="onboarding-splash-content">
        <div className="onboarding-splash-brand">
          <img
            alt=""
            aria-hidden="true"
            className="onboarding-splash-mark"
            src={gantrySplashMark}
          />
          <span aria-hidden="true" className="onboarding-splash-mark-reduced">
            <GantryMark large />
          </span>
          <span>Gantry</span>
        </div>
        <h1>Set Up Your First Agent</h1>
        <p className="onboarding-splash-role">
          <span>Your organisation’s new</span>
          <span className="onboarding-splash-role-window">
            <span className="onboarding-splash-role-list">
              {[...roles, roles[0]].map((role, index) => (
                <span key={`${role}-${index}`}>{role}</span>
              ))}
            </span>
          </span>
        </p>
        <p className="onboarding-splash-description">
          Hire one, tell it what it should handle, and it starts working where
          your team already talks. Takes about three minutes.
        </p>
        <div className="onboarding-splash-fields">
          <label>
            <span>Give it a name</span>
            <span className="onboarding-splash-name-field">
              <input
                aria-label="Employee name"
                onChange={(event) => onChange({ name: event.target.value })}
                placeholder="Atlas"
                value={draft.name}
              />
              <Pencil aria-hidden="true" size={12} />
            </span>
          </label>
          <label className="onboarding-splash-title-field">
            <span>Job title</span>
            <input
              aria-label="Job title"
              onChange={(event) => onChange({ title: event.target.value })}
              placeholder="e.g. General assistant"
              value={draft.title}
            />
          </label>
        </div>
        <button
          className="onboarding-splash-action"
          onClick={onStart}
          type="button"
        >
          Hire your first employee <ChevronRight aria-hidden="true" size={16} />
        </button>
      </div>
      <footer className="onboarding-splash-footer">
        <span aria-hidden="true" />
        <a href="https://www.knacklabs.ai" rel="noreferrer" target="_blank">
          <span>Powered by</span>
          <img alt="" aria-hidden="true" src={knacklabsMark} />
          <strong>KnackLabs</strong>
        </a>
      </footer>
    </main>
  );
}
