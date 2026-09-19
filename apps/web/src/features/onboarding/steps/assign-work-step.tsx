import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import type { OnboardingDraft } from '../onboarding-state';
import { onboardingGet, onboardingMutation } from '../onboarding-http-client';
import { onboardingStatusQuery } from '../first-run';
import { Heading } from './create-employee-step';

type Conversation = {
  id: string;
  title: string | null;
  kind: string;
  status: string;
};

export function AssignWorkStep({
  onChange,
  onContinueActionChange,
}: {
  onChange: (update: Partial<OnboardingDraft>) => void;
  onContinueActionChange: (
    action: (() => Promise<void>) | null,
    disabled: boolean,
  ) => void;
}) {
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState('');
  const [approverId, setApproverId] = useState('');
  const conversations = useQuery({
    queryKey: ['onboarding', 'conversations'],
    queryFn: () =>
      onboardingGet<{ conversations: Conversation[]; nextCursor: null }>(
        '/conversations',
      ),
  });
  const members = useQuery({
    queryKey: ['onboarding', 'conversation-members', conversationId],
    enabled: Boolean(conversationId),
    queryFn: () =>
      onboardingGet<{ memberIds: string[] }>(
        `/conversations/${encodeURIComponent(conversationId)}/members`,
      ),
  });

  const bind = useCallback(async () => {
    if (!conversationId || !approverId) return;
    await onboardingMutation('/assignment', {
      conversationId,
      approverExternalUserId: approverId,
    });
    await queryClient.invalidateQueries({
      queryKey: onboardingStatusQuery.queryKey,
    });
  }, [approverId, conversationId, queryClient]);

  useEffect(() => {
    onContinueActionChange(
      conversationId && approverId ? bind : null,
      !conversationId || !approverId,
    );
    return () => onContinueActionChange(null, false);
  }, [approverId, bind, conversationId, onContinueActionChange]);

  return (
    <>
      <Heading
        body="Give it one place to start and choose who approves riskier actions."
        title="Put your agent to work"
      />
      <article className="onboarding-card">
        <label className="onboarding-field">
          <span>Give it one place to start</span>
          <select
            disabled={conversations.isPending || conversations.isError}
            onChange={(event) => {
              const id = event.target.value;
              const selected = conversations.data?.conversations.find(
                (conversation) => conversation.id === id,
              );
              setConversationId(id);
              setApproverId('');
              onChange({ workspace: selected?.title ?? id });
            }}
            value={conversationId}
          >
            <option value="">
              {conversations.isPending
                ? 'Discovering Slack conversations…'
                : 'Choose a conversation'}
            </option>
            {(conversations.data?.conversations ?? []).map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title ?? conversation.id}
              </option>
            ))}
          </select>
        </label>
        {conversations.isError ? (
          <p className="onboarding-error" role="alert">
            {conversations.error.message}
          </p>
        ) : null}
        <label className="onboarding-field">
          <span>Who approves its riskier actions?</span>
          <select
            disabled={!conversationId || members.isPending || members.isError}
            onChange={(event) => {
              setApproverId(event.target.value);
              onChange({ approver: event.target.value });
            }}
            value={approverId}
          >
            <option value="">
              {members.isPending && conversationId
                ? 'Refreshing Slack members…'
                : 'Choose one verified member'}
            </option>
            {(members.data?.memberIds ?? []).map((memberId) => (
              <option key={memberId} value={memberId}>
                {memberId}
              </option>
            ))}
          </select>
        </label>
        {members.isError ? (
          <p className="onboarding-error" role="alert">
            {members.error.message}
          </p>
        ) : null}
        <small className="onboarding-help">
          Continue refreshes Slack membership, then saves the conversation,
          verified person, approver policy and installation together.
        </small>
      </article>
    </>
  );
}
