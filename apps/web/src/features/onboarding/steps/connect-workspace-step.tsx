import { Icon } from '@iconify/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleHelp, ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { browserFetch } from '../../../lib/auth/browser-auth';
import { channelProvidersQuery } from '../../channel-accounts/channel-account-queries';
import { SlackManifestDrawer } from '../slack-manifest-drawer';
import { SlackTokenGuideDrawer } from '../slack-token-guide-drawer';
import {
  CHANNEL_CONTENT,
  onboardingChannels,
  onboardingPhases,
  SLACK_TOKEN_DETAILS,
  slackTokenError,
} from '../onboarding-workspace-content';
import {
  onboardingMutation,
  type LifecycleCheck,
} from '../onboarding-http-client';
import { onboardingStatusQuery } from '../first-run';

const previewCredentialKeys: Record<string, string[]> = {
  slack: ['app_token', 'bot_token'],
  teams: ['tenant_id', 'client_id', 'client_secret'],
  discord: ['bot_token'],
  telegram: ['bot_token'],
};

export function ConnectWorkspaceStep({
  agentName,
  agentId,
  channelId,
  onChannelChange,
  connected,
  onConnect,
}: {
  agentName: string;
  agentId: string | null;
  channelId: string;
  onChannelChange: (id: string) => void;
  connected: boolean;
  onConnect: () => void;
}) {
  const queryClient = useQueryClient();
  const providers = useQuery(channelProvidersQuery()).data?.providers ?? [];
  const available = onboardingChannels(providers);
  const channel =
    available.find((item) => item.id === channelId) ?? available[0];
  const id = channel?.id ?? channelId;
  const content = CHANNEL_CONTENT[id] ?? CHANNEL_CONTENT.slack;
  const phases = onboardingPhases(id);
  const slack = id === 'slack';
  const [activePhase, setActivePhase] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [manifestOpen, setManifestOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [slackCreated, setSlackCreated] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [validationChecks, setValidationChecks] = useState<LifecycleCheck[]>(
    [],
  );
  const keys = previewCredentialKeys[id] ?? [];
  const ready = useMemo(
    () => keys.every((key) => Boolean(values[key]?.trim())),
    [keys, values],
  );
  const manifest = useQuery({
    queryKey: ['onboarding', 'slack-manifest', agentName],
    enabled: slack,
    queryFn: async (): Promise<{
      manifestJson: string;
      createUrl: string;
      permissionGroups: Array<{
        title: string;
        description: string;
        scopes: string[];
      }>;
    }> => {
      const response = await browserFetch(
        `/ui/api/onboarding/channel-manifest?providerId=slack&employeeName=${encodeURIComponent(agentName)}`,
        { credentials: 'same-origin' },
      );
      if (!response.ok)
        throw new Error('Slack app manifest could not be prepared.');
      return response.json();
    },
  });

  useEffect(() => () => setValues({}), []);
  useEffect(() => {
    setActivePhase(0);
    setValues({});
    setErrors({});
    setSlackCreated(false);
    setManifestOpen(false);
    setGuideOpen(false);
    setValidationChecks([]);
  }, [id]);

  async function connect() {
    const nextErrors = slack
      ? Object.fromEntries(
          keys
            .map((key) => [key, slackTokenError(key, values[key] ?? '')])
            .filter(([, error]) => Boolean(error)),
        )
      : {};
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !ready || !agentId || !slack)
      return;
    setConnecting(true);
    try {
      const staged = await onboardingMutation<{
        candidate: { id: string };
      }>('/provider-candidates', {
        providerId: 'slack',
        agentId,
        credentials: values,
      });
      const validated = await onboardingMutation<{
        candidate: { checks: LifecycleCheck[] };
      }>(`/provider-candidates/${staged.candidate.id}/validate`, {});
      setValidationChecks(validated.candidate.checks);
      await onboardingMutation(
        `/provider-candidates/${staged.candidate.id}/activate`,
        {},
      );
      setValues({});
      await queryClient.invalidateQueries({
        queryKey: onboardingStatusQuery.queryKey,
      });
      onConnect();
    } catch (error) {
      const payload = (
        error as {
          payload?: { error?: { details?: { checks?: LifecycleCheck[] } } };
        }
      ).payload;
      setValidationChecks(payload?.error?.details?.checks ?? []);
      setErrors({
        form:
          error instanceof Error ? error.message : 'Slack validation failed.',
      });
    } finally {
      setConnecting(false);
    }
  }

  return (
    <section className="grid min-h-0 w-full justify-items-center gap-[13px] md:h-full md:grid-rows-[auto_auto_minmax(0,1fr)]">
      <div className="onboarding-heading mx-auto w-full max-w-[58ch] text-center">
        <h1>Give {agentName || 'your agent'} a place to work</h1>
        <p>{content.intro}</p>
      </div>
      <div
        aria-label="Choose a workspace"
        className="flex flex-wrap justify-center gap-2"
      >
        {available.map((item) => {
          const itemContent = CHANNEL_CONTENT[item.id];
          if (!itemContent) return null;
          return (
            <button
              key={item.id}
              aria-pressed={id === item.id}
              className={`relative inline-flex h-[34px] items-center gap-[9px] rounded-full border border-border bg-surface px-[13px] text-[12.5px] font-medium text-text transition-[background-color,transform] duration-[160ms] [@media(hover:hover)_and_(pointer:fine)]:hover:translate-y-[-1px] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-muted active:translate-y-px active:scale-[0.98] motion-reduce:transform-none motion-reduce:transition-none ${id === item.id ? "after:pointer-events-none after:absolute after:inset-[-1px] after:rounded-[inherit] after:border-2 after:border-ink after:content-[''] after:[animation:onboarding-fade_0.22s_var(--ease-gantry)_both] motion-reduce:after:animate-none" : ''}`}
              onClick={() => onChannelChange(item.id)}
              type="button"
            >
              <span className="relative grid size-6 place-items-center overflow-hidden rounded-[7px] border border-border-strong bg-surface-muted [&_svg]:size-3.5">
                <Icon icon={itemContent.icon} />
              </span>
              {item.displayName}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 w-full p-0.5 md:overflow-y-auto">
        {' '}
        <div className="grid gap-[9px]">
          {phases.map((phase, index) => {
            const active = activePhase === index;
            const isConnect = index === phases.length - 1;
            const done = connected || (slack && slackCreated && index === 0);
            return (
              <article
                key={phase.title}
                className={`relative overflow-hidden rounded-[13px] border border-border bg-surface shadow-panel transition-[border-color] duration-200 motion-reduce:transition-none ${active ? "after:pointer-events-none after:absolute after:inset-[-1px] after:rounded-[14px] after:border-2 after:border-ink after:content-['']" : ''}`}
              >
                <button
                  aria-expanded={active}
                  className="grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 border-0 bg-transparent px-3.5 py-[11px] text-left text-text"
                  onClick={() => setActivePhase(index)}
                  type="button"
                >
                  <span
                    className={`relative z-[1] grid size-[26px] place-items-center rounded-full border border-border-strong bg-surface-muted font-mono text-[11px] text-text-secondary ${done ? 'border-status-success bg-status-success-soft text-status-success' : ''}`}
                  >
                    {done ? (
                      <Check aria-hidden size={11} strokeWidth={2.2} />
                    ) : (
                      index + 1
                    )}
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
                  <div className="relative z-[1] grid gap-[11px] pt-0 pr-3.5 pb-[13px] pl-[50px] [animation:onboarding-rise_0.3s_var(--ease-gantry)_both] motion-reduce:animate-none">
                    {phase.body ? (
                      <p className="m-0 text-[13px] leading-[1.6] text-text-secondary [text-wrap:pretty]">
                        {phase.body}
                      </p>
                    ) : null}
                    {isConnect ? (
                      connected ? (
                        <span className="inline-flex justify-self-start items-center gap-2.5 rounded-full border border-status-success bg-status-success-soft px-[13px] py-[9px] text-[12.5px] text-status-success">
                          <Check aria-hidden size={12} strokeWidth={2.4} />
                          Slack connected
                        </span>
                      ) : (
                        <div className="grid gap-[9px]">
                          {keys.map((key) => {
                            const detail = slack
                              ? SLACK_TOKEN_DETAILS[key]
                              : undefined;
                            const error = errors[key];
                            return (
                              <label
                                key={key}
                                className="grid gap-1.5 text-[12px] font-medium text-text"
                              >
                                <span className="grid gap-0.5">
                                  <b className="text-[12px] font-medium text-text">
                                    {detail?.label ?? key.replaceAll('_', ' ')}
                                  </b>
                                  {detail ? (
                                    <small className="font-mono text-[10px] font-normal tracking-[0.02em] text-text-muted">
                                      {detail.path}
                                    </small>
                                  ) : null}
                                </span>
                                <input
                                  aria-invalid={Boolean(error)}
                                  autoComplete="off"
                                  className={`h-[38px] w-full rounded-[9px] border bg-surface-muted px-3 font-mono text-[12px] text-text placeholder:text-text-muted ${error ? 'border-danger' : 'border-border-strong'}`}
                                  placeholder={detail?.placeholder}
                                  type="password"
                                  value={values[key] ?? ''}
                                  onBlur={() => {
                                    const error = slack
                                      ? slackTokenError(key, values[key] ?? '')
                                      : undefined;
                                    setErrors((current) => {
                                      const next = { ...current };
                                      if (error) next[key] = error;
                                      else delete next[key];
                                      return next;
                                    });
                                  }}
                                  onChange={(event) =>
                                    setValues((current) => ({
                                      ...current,
                                      [key]: event.target.value,
                                    }))
                                  }
                                />
                                {error ? (
                                  <small
                                    className="text-[11px] font-normal text-danger"
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
                              className="inline-flex h-[30px] items-center gap-1.5 justify-self-start border-0 bg-transparent p-0 text-[12px] text-text-secondary underline"
                              onClick={() => setGuideOpen(true)}
                              type="button"
                            >
                              <CircleHelp aria-hidden size={13} />
                              Where to find the tokens
                            </button>
                          ) : null}
                          <button
                            className="onboarding-primary justify-self-start"
                            disabled={
                              !ready || !agentId || !slack || connecting
                            }
                            onClick={() => void connect()}
                            type="button"
                          >
                            {connecting ? 'Validating Slack…' : 'Connect'}{' '}
                            <Check aria-hidden size={12} />
                          </button>
                          {errors.form ? (
                            <p className="onboarding-error" role="alert">
                              {errors.form}
                            </p>
                          ) : null}
                          {validationChecks.length ? (
                            <ul
                              className="onboarding-validation-checks"
                              aria-live="polite"
                            >
                              {validationChecks.map((check) => (
                                <li key={check.id}>
                                  <Check aria-hidden size={12} /> {check.label}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      )
                    ) : slack ? (
                      <div className="grid justify-items-start gap-2">
                        <button
                          className="onboarding-primary"
                          disabled={manifest.isPending || !manifest.data}
                          onClick={() => {
                            if (!manifest.data) return;
                            window.open(
                              manifest.data.createUrl,
                              '_blank',
                              'noopener,noreferrer',
                            );
                            setSlackCreated(true);
                            setActivePhase(1);
                          }}
                          type="button"
                        >
                          {manifest.isPending
                            ? 'Preparing Slack app…'
                            : 'Create Gantry Slack App'}{' '}
                          <ExternalLink aria-hidden size={12} />
                        </button>
                        {manifest.data ? (
                          <button
                            className="inline-flex h-[30px] items-center gap-1.5 border-0 bg-transparent p-0 text-[12px] text-text-secondary underline"
                            onClick={() => setManifestOpen(true)}
                            type="button"
                          >
                            <CircleHelp aria-hidden size={13} />
                            See what it sets up
                          </button>
                        ) : null}
                        {manifest.isError ? (
                          <p className="onboarding-error" role="alert">
                            Slack app details could not be loaded. Try again
                            after refreshing the page.
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <a
                        className="onboarding-primary justify-self-start no-underline"
                        href={phase.guideUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {phase.guideLabel}{' '}
                        <ExternalLink aria-hidden size={12} />
                      </a>
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </div>
      {manifest.data ? (
        <SlackManifestDrawer
          employeeName={agentName}
          manifestJson={manifest.data.manifestJson}
          onOpenChange={setManifestOpen}
          open={manifestOpen}
          permissionGroups={manifest.data.permissionGroups}
        />
      ) : null}
      <SlackTokenGuideDrawer onOpenChange={setGuideOpen} open={guideOpen} />
    </section>
  );
}
