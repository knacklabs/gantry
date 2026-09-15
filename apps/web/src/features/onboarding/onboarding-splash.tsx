import { ChevronRight } from 'lucide-react';

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
  onStart,
  resume,
}: {
  onStart: () => void;
  resume?: { name: string } | null;
}) {
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
        <button className="onboarding-splash-action" onClick={onStart}>
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
