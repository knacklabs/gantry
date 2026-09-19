import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, LoaderCircle, MessageCircle } from 'lucide-react';
import { useEffect } from 'react';

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
  const challenge = useQuery({
    queryKey: ['onboarding', 'challenge'],
    queryFn: () => onboardingGet<{ challenge: Challenge | null }>('/challenge'),
    refetchInterval: (query) =>
      query.state.data?.challenge &&
      !['succeeded', 'failed', 'expired', 'superseded'].includes(
        query.state.data.challenge.state,
      )
        ? 1_000
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
    if (current?.state !== 'succeeded') return;
    void queryClient.invalidateQueries({
      queryKey: onboardingStatusQuery.queryKey,
    });
  }, [current?.state, queryClient]);

  return (
    <>
      <Heading
        body="Send one exact message from the selected approver. Gantry will confirm the matching run and every delivered final-answer segment."
        title={`Ping ${draft.name || 'your agent'}`}
      />
      <article className="onboarding-card onboarding-hello">
        {current ? (
          <div className="onboarding-ping">
            <code>{current.message}</code>
            <CopyButton
              label="Copy Slack challenge"
              size="xs"
              value={current.message}
              variant="ghost"
            />
          </div>
        ) : (
          <button
            className="onboarding-primary"
            disabled={create.isPending}
            onClick={() => create.mutate()}
            type="button"
          >
            <MessageCircle aria-hidden size={14} />
            {create.isPending ? 'Creating challenge…' : 'Say hello'}
          </button>
        )}
        <GantryMark hero />
        {current && current.state !== 'succeeded' ? (
          <span className="onboarding-sweep">
            <i />
          </span>
        ) : null}
        {current ? (
          <p aria-live="polite" role="status">
            {current.state === 'succeeded' ? (
              <Check aria-hidden size={15} />
            ) : (
              <LoaderCircle
                aria-hidden
                className="animate-spin motion-reduce:animate-none"
                size={15}
              />
            )}
            {labels[current.state]}
          </p>
        ) : (
          <p>Create a single-use, 10-minute Slack challenge to continue.</p>
        )}
        {current && ['failed', 'expired'].includes(current.state) ? (
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
