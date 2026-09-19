import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { CopyButton } from '../../../ui/primitives/copy-button';
import { GantryMark } from '../components/onboarding-shell';
import { onboardingGet, onboardingMutation } from '../onboarding-http-client';
import { onboardingStatusQuery } from '../first-run';
import type { OnboardingDraft } from '../onboarding-state';
import { Heading } from './create-employee-step';

type ChallengeState =
  | 'waiting_for_message'
  | 'queued'
  | 'running'
  | 'awaiting_delivery'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'superseded';

type Challenge = {
  id: string;
  state: ChallengeState;
  message: string;
  expiresAt: string;
  deploymentVersion: number;
};

const labels: Record<ChallengeState, string> = {
  waiting_for_message: 'Waiting for your Slack message',
  queued: 'Message received',
  running: 'Employee is responding',
  awaiting_delivery: 'Reply is being delivered',
  succeeded: 'Ready',
  failed: 'The verification run failed',
  expired: 'This challenge expired',
  superseded: 'A newer challenge replaced this one',
};

export function SayHelloStep({ draft }: { draft: OnboardingDraft }) {
  const queryClient = useQueryClient();
  const autoCreateStarted = useRef(false);
  const challenge = useQuery({
    queryKey: ['onboarding', 'challenge'],
    queryFn: () => onboardingGet<{ challenge: Challenge | null }>('/challenge'),
    refetchInterval: (query) =>
      query.state.data?.challenge &&
      !['succeeded', 'failed', 'expired', 'superseded'].includes(
        query.state.data.challenge.state,
      )
        ? 5_000
        : false,
  });
  const create = useMutation({
    mutationFn: () =>
      onboardingMutation<{ challenge: Challenge }>('/challenge', {}),
    onSuccess: (data) => {
      queryClient.setQueryData(['onboarding', 'challenge'], data);
    },
  });
  const current = challenge.data?.challenge ?? null;

  useEffect(() => {
    if (!challenge.isSuccess || current || autoCreateStarted.current) return;
    autoCreateStarted.current = true;
    create.mutate();
  }, [challenge.isSuccess, create, current]);

  useEffect(() => {
    if (current?.state !== 'succeeded') return;
    void queryClient.invalidateQueries({
      queryKey: onboardingStatusQuery.queryKey,
    });
  }, [current?.state, queryClient]);

  return (
    <>
      <Heading
        body="Open the selected Slack conversation and send this exact message from the approver account. Gantry waits here until it lands."
        title={`Ping ${draft.name || 'your agent'}`}
      />
      <article className="onboarding-card onboarding-hello">
        <div className="onboarding-ping">
          {current ? (
            <code>{current.message}</code>
          ) : (
            <code>Preparing your Slack message…</code>
          )}
          {current ? (
            <CopyButton
              label="Copy"
              size="sm"
              value={current.message}
              variant="outline"
            />
          ) : null}
        </div>
        <GantryMark hero />
        {!current || current.state !== 'succeeded' ? (
          <span className="onboarding-sweep">
            <i />
          </span>
        ) : null}
        {current ? (
          <p aria-live="polite" role="status">
            {['queued', 'succeeded'].includes(current.state) ? (
              <Check
                aria-hidden
                className="onboarding-status-check"
                size={16}
              />
            ) : null}
            {labels[current.state]}
          </p>
        ) : (
          <p aria-live="polite" role="status">
            Preparing your Slack message…
          </p>
        )}
        {(current && ['failed', 'expired'].includes(current.state)) ||
        (!current && create.isError) ? (
          <button
            className="onboarding-secondary"
            disabled={create.isPending}
            onClick={() => create.mutate()}
            type="button"
          >
            Retry with a new challenge
          </button>
        ) : null}
        {create.isError || challenge.isError ? (
          <small className="onboarding-inline-error" role="alert">
            {(create.error ?? challenge.error)?.message}
          </small>
        ) : null}
      </article>
    </>
  );
}
