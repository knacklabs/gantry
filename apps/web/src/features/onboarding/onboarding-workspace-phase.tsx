import { Check, CircleHelp, ExternalLink } from 'lucide-react';

import type { ChannelProvider } from '../channel-accounts/channel-account-queries';
import {
  SLACK_TOKEN_DETAILS,
  slackTokenError,
  type WorkspacePhase,
} from './onboarding-workspace-content';

export function OnboardingWorkspacePhase({
  phase,
  index,
  active,
  done,
  connect,
  slackCreate,
  slack,
  channel,
  connected,
  busy,
  connectDisabled,
  credentialKeys,
  credentialErrors,
  values,
  onSelect,
  onCredentialError,
  onCredentialValue,
  onConnect,
  onCreateSlackApp,
  onOpenManifest,
  onOpenTokenGuide,
  manifest,
}: {
  phase: WorkspacePhase;
  index: number;
  active: boolean;
  done: boolean;
  connect: boolean;
  slackCreate: boolean;
  slack: boolean;
  channel?: ChannelProvider;
  connected: boolean;
  busy: boolean;
  connectDisabled: boolean;
  credentialKeys: string[];
  credentialErrors: Record<string, string>;
  values: Record<string, string>;
  onSelect: () => void;
  onCredentialError: (key: string, error?: string) => void;
  onCredentialValue: (key: string, value: string) => void;
  onConnect: () => void;
  onCreateSlackApp: () => void;
  onOpenManifest: () => void;
  onOpenTokenGuide: () => void;
  manifest: { pending: boolean; ready: boolean; failed: boolean };
}) {
  return (
    <article
      className={`relative overflow-hidden rounded-[13px] border border-border bg-surface shadow-panel transition-[border-color] duration-200 motion-reduce:transition-none ${active ? "after:pointer-events-none after:absolute after:inset-[-1px] after:rounded-[14px] after:border-2 after:border-ink after:content-[''] after:[animation:onboarding-fade_0.22s_var(--ease)_both] motion-reduce:after:animate-none" : ''}`}
    >
      <button
        className="grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 border-0 bg-transparent px-3.5 py-[11px] text-left text-text"
        onClick={onSelect}
        aria-expanded={active}
      >
        <span
          className={`relative z-[1] grid size-[26px] place-items-center rounded-full border border-border-strong bg-surface-muted font-mono text-[11px] text-text-secondary ${done ? 'border-status-success bg-status-success-soft text-status-success' : ''}`}
        >
          {done ? <Check size={11} strokeWidth={2.2} /> : index + 1}
        </span>
        <span className="grid min-w-0 gap-0.5">
          <b className="text-[13.5px] font-medium">{phase.title}</b>
          <small className="text-[12px] leading-[1.45] text-text-secondary">
            {phase.summary}
          </small>
        </span>
        <em className="font-mono text-[10.5px] text-text-muted not-italic whitespace-nowrap">
          {phase.meta}
        </em>
      </button>
      {active ? (
        <div className="relative z-[1] grid gap-[11px] pt-0 pr-3.5 pb-[13px] pl-[50px] [animation:onboarding-rise_0.3s_var(--ease)_both] motion-reduce:animate-none">
          {phase.body ? (
            <p className="m-0 text-[13px] leading-[1.6] text-text-secondary [text-wrap:pretty]">
              {phase.body}
            </p>
          ) : null}
          {connect ? (
            channel?.status !== 'available' ? (
              <p className="onboarding-error" role="alert">
                This provider is{' '}
                {channel?.status === 'setup_only'
                  ? 'setup only'
                  : 'not available'}{' '}
                in this runtime.
              </p>
            ) : connected ? (
              <span className="inline-flex justify-self-start items-center gap-2.5 rounded-full border border-status-success bg-status-success-soft px-[13px] py-[9px] text-[12.5px] text-status-success [animation:onboarding-pop_0.32s_var(--ease)_both] motion-reduce:animate-none">
                <Check size={12} strokeWidth={2.4} /> Connected — conversations
                found
              </span>
            ) : (
              <div className="grid gap-[9px]">
                {credentialKeys.map((key) => {
                  const detail = slack ? SLACK_TOKEN_DETAILS[key] : undefined;
                  const error = credentialErrors[key];
                  const errorId = `onboarding-${key.toLowerCase()}-error`;
                  return (
                    <label
                      key={key}
                      className="grid gap-1.5 text-[12px] font-medium text-text"
                    >
                      <span className="grid gap-0.5">
                        <b className="text-[12px] font-medium text-text">
                          {detail?.label ?? key}
                        </b>
                        {detail ? (
                          <small className="font-mono text-[10px] font-normal tracking-[0.02em] text-text-muted">
                            {detail.path}
                          </small>
                        ) : null}
                      </span>
                      <input
                        aria-describedby={error ? errorId : undefined}
                        aria-invalid={Boolean(error)}
                        autoComplete="off"
                        className={`h-[38px] w-full rounded-[9px] border bg-surface-muted px-3 font-mono text-[12px] text-text placeholder:text-text-muted focus-visible:border-status-attention focus-visible:outline-2 focus-visible:outline-status-attention-soft focus-visible:outline-offset-1 ${error ? 'border-danger' : 'border-border-strong'}`}
                        placeholder={detail?.placeholder}
                        type="password"
                        value={values[key] ?? ''}
                        onBlur={() =>
                          onCredentialError(
                            key,
                            slack
                              ? slackTokenError(key, values[key] ?? '')
                              : undefined,
                          )
                        }
                        onChange={(event) =>
                          onCredentialValue(key, event.target.value)
                        }
                      />
                      {error ? (
                        <small
                          className="text-[11px] font-normal text-danger"
                          id={errorId}
                          role="alert"
                        >
                          {error}
                        </small>
                      ) : null}
                    </label>
                  );
                })}
                {slack ? (
                  <button
                    className="inline-flex h-[30px] items-center gap-1.5 justify-self-start border-0 bg-transparent p-0 text-[12px] text-text-secondary underline decoration-text-muted underline-offset-[3px] [@media(hover:hover)_and_(pointer:fine)]:hover:text-text"
                    onClick={onOpenTokenGuide}
                    type="button"
                  >
                    <CircleHelp aria-hidden="true" size={13} /> Where to find
                    the tokens
                  </button>
                ) : null}
                <button
                  className="inline-flex h-[40px] justify-self-start items-center gap-[9px] rounded-[9px] border border-ink bg-ink px-[17px] text-[13.5px] font-medium text-ink-on transition-[box-shadow,transform] duration-[160ms] [@media(hover:hover)_and_(pointer:fine)]:hover:translate-y-[-1px] [@media(hover:hover)_and_(pointer:fine)]:hover:shadow-lift active:translate-y-px active:scale-[0.98] disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none"
                  disabled={busy || connectDisabled}
                  onClick={onConnect}
                >
                  {busy ? 'Connecting…' : 'Connect'} <Check size={12} />
                </button>
              </div>
            )
          ) : slackCreate ? (
            <div className="grid justify-items-start gap-2">
              <button
                className="inline-flex h-[40px] items-center gap-[9px] rounded-[9px] border border-ink bg-ink px-[17px] text-[13.5px] font-medium text-ink-on transition-[box-shadow,transform] duration-[160ms] [@media(hover:hover)_and_(pointer:fine)]:hover:translate-y-[-1px] [@media(hover:hover)_and_(pointer:fine)]:hover:shadow-lift active:translate-y-px active:scale-[0.98] disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none"
                disabled={manifest.pending || !manifest.ready}
                onClick={onCreateSlackApp}
                type="button"
              >
                {manifest.pending
                  ? 'Preparing Slack app…'
                  : 'Create Gantry Slack App'}{' '}
                <ExternalLink size={12} />
              </button>
              {manifest.ready ? (
                <button
                  className="inline-flex h-[30px] items-center gap-1.5 border-0 bg-transparent p-0 text-[12px] text-text-secondary underline decoration-text-muted underline-offset-[3px] [@media(hover:hover)_and_(pointer:fine)]:hover:text-text"
                  onClick={onOpenManifest}
                  type="button"
                >
                  <CircleHelp aria-hidden="true" size={13} /> See what it sets
                  up
                </button>
              ) : null}
              {manifest.failed ? (
                <p className="onboarding-error" role="alert">
                  Slack app details could not be loaded. Try again after
                  refreshing the page.
                </p>
              ) : null}
            </div>
          ) : (
            <a
              className="inline-flex h-[40px] justify-self-start items-center gap-[9px] rounded-[9px] border border-ink bg-ink px-[17px] text-[13.5px] font-medium text-ink-on no-underline transition-[box-shadow,transform] duration-[160ms] [@media(hover:hover)_and_(pointer:fine)]:hover:translate-y-[-1px] [@media(hover:hover)_and_(pointer:fine)]:hover:shadow-lift active:translate-y-px active:scale-[0.98] motion-reduce:transform-none motion-reduce:transition-none"
              href={phase.guideUrl}
              target="_blank"
              rel="noreferrer"
            >
              {phase.guideLabel} <ExternalLink size={12} />
            </a>
          )}
        </div>
      ) : null}
    </article>
  );
}
