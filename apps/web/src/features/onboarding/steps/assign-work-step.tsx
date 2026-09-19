import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { toast } from '../../../ui/primitives/toast';
import type { OnboardingDraft } from '../onboarding-state';
import { onboardingGet, onboardingMutation } from '../onboarding-http-client';
import { onboardingStatusQuery } from '../first-run';
import { Heading } from './create-employee-step';

type Conversation = {
  id: string;
  title: string | null;
  kind: string;
  status: string;
  membership: 'joined' | 'joinable' | 'invite_required';
};

type ConversationResponse = {
  conversations: Conversation[];
  nextCursor: null;
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
  const [joining, setJoining] = useState(false);
  const conversationQueryKey = ['onboarding', 'conversations'] as const;
  const conversations = useQuery({
    queryKey: conversationQueryKey,
    queryFn: () => onboardingGet<ConversationResponse>('/conversations'),
    retry: false,
  });
  const selectedConversation = conversations.data?.conversations.find(
    (conversation) => conversation.id === conversationId,
  );
  const joined = selectedConversation?.membership === 'joined';
  const members = useQuery({
    queryKey: ['onboarding', 'conversation-members', conversationId],
    enabled: Boolean(conversationId && joined),
    queryFn: () =>
      onboardingGet<{ memberIds: string[] }>(
        `/conversations/${encodeURIComponent(conversationId)}/members`,
      ),
  });

  useEffect(() => {
    if (!conversations.isError) return;
    toast.error(conversations.error.message, {
      id: 'onboarding-conversations-error',
    });
  }, [conversations.error, conversations.isError]);

  useEffect(() => {
    if (!members.isError) return;
    toast.error(members.error.message, {
      id: 'onboarding-conversation-members-error',
    });
  }, [members.error, members.isError]);

  async function joinChannel() {
    if (!selectedConversation || selectedConversation.membership !== 'joinable')
      return;
    setJoining(true);
    try {
      await onboardingMutation(
        `/conversations/${encodeURIComponent(selectedConversation.id)}/join`,
        {},
      );
      queryClient.setQueryData<ConversationResponse>(
        conversationQueryKey,
        (current) =>
          current
            ? {
                ...current,
                conversations: current.conversations.map((conversation) =>
                  conversation.id === selectedConversation.id
                    ? { ...conversation, membership: 'joined' }
                    : conversation,
                ),
              }
            : current,
      );
      toast.success(`Joined #${selectedConversation.title}.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Slack channel join failed.',
      );
    } finally {
      setJoining(false);
    }
  }

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
          <span className="flex items-center justify-between gap-3">
            <span>Give it one place to start</span>
            {conversations.isPending ? (
              <span
                aria-live="polite"
                className="flex items-center gap-1.5 text-[11px] font-normal text-text-secondary"
                role="status"
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="onboarding-spinner shrink-0"
                  size={13}
                />
                Loading conversations…
              </span>
            ) : null}
          </span>
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
            <option value="">Choose a conversation</option>
            {(conversations.data?.conversations ?? []).map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.kind === 'channel' ? '# ' : ''}
                {conversation.title ?? conversation.id}
              </option>
            ))}
          </select>
        </label>
        {selectedConversation?.membership === 'joinable' ? (
          <div className="grid justify-items-start gap-2">
            <small className="onboarding-help">
              Gantry must join this public channel before it can read members or
              reply.
            </small>
            <button
              className="onboarding-primary"
              disabled={joining}
              onClick={() => void joinChannel()}
              type="button"
            >
              {joining ? 'Joining channel…' : 'Join channel'}
            </button>
          </div>
        ) : selectedConversation?.membership === 'invite_required' ? (
          <small className="onboarding-help">
            Invite the Gantry app to this private channel in Slack, then refresh
            this page.
          </small>
        ) : null}
        <label className="onboarding-field">
          <span>Who approves its riskier actions?</span>
          <select
            disabled={
              !conversationId || !joined || members.isPending || members.isError
            }
            onChange={(event) => {
              setApproverId(event.target.value);
              onChange({ approver: event.target.value });
            }}
            value={approverId}
          >
            <option value="">
              {selectedConversation?.membership === 'joinable'
                ? 'Join the channel first'
                : members.isPending && conversationId
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
        <small className="onboarding-help">
          Continue refreshes Slack membership, then saves the conversation,
          verified person, approver policy and installation together.
        </small>
      </article>
    </>
  );
}
