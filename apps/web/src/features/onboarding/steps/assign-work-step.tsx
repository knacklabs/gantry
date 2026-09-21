import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw, XIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { MultiSelect } from '../../../ui/primitives/multi-select';
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

type ConversationMember = {
  id: string;
  displayName: string;
};

export function AssignWorkStep({
  draft,
  onChange,
  onContinueActionChange,
}: {
  draft: OnboardingDraft;
  onChange: (update: Partial<OnboardingDraft>) => void;
  onContinueActionChange: (
    action: (() => Promise<void>) | null,
    disabled: boolean,
  ) => void;
}) {
  const queryClient = useQueryClient();
  // Seeded from the draft (not '') so a user who advances to step 4 and comes
  // back finds their conversation/approver still selected — this component
  // unmounts whenever step !== 3, so plain useState('') would reset on every
  // return trip.
  const [conversationId, setConversationId] = useState(draft.conversationId);
  const [approverId, setApproverId] = useState(draft.approver);
  const [allowlist, setAllowlist] = useState<string[]>(draft.allowlist);
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
      onboardingGet<{ members: ConversationMember[] }>(
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
    if (!conversationId || !approverId || allowlist.length === 0) return;
    await onboardingMutation('/assignment', {
      conversationId,
      approverExternalUserId: approverId,
      allowlistExternalUserIds: allowlist,
    });
    await queryClient.invalidateQueries({
      queryKey: onboardingStatusQuery.queryKey,
    });
  }, [allowlist, approverId, conversationId, queryClient]);

  const canContinue = Boolean(
    conversationId && approverId && allowlist.length > 0,
  );
  useEffect(() => {
    onContinueActionChange(canContinue ? bind : null, !canContinue);
    return () => onContinueActionChange(null, false);
  }, [bind, canContinue, onContinueActionChange]);

  function reload() {
    setConversationId('');
    setApproverId('');
    setAllowlist([]);
    onChange({
      allowlist: [],
      approver: '',
      conversationId: '',
      workspace: '',
    });
    void conversations.refetch();
  }

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
            {conversations.isFetching ? (
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
            ) : (
              <Button
                aria-label="Reload conversations"
                onClick={reload}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <RefreshCw aria-hidden="true" size={15} />
              </Button>
            )}
          </span>
          <select
            disabled={conversations.isFetching || conversations.isError}
            onChange={(event) => {
              const id = event.target.value;
              const selected = conversations.data?.conversations.find(
                (conversation) => conversation.id === id,
              );
              setConversationId(id);
              setApproverId('');
              setAllowlist([]);
              onChange({
                allowlist: [],
                approver: '',
                conversationId: id,
                workspace: selected?.title ?? id,
              });
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
          <span className="flex items-center justify-between gap-3">
            <span>Who can talk to it?</span>
            {members.isFetching ? (
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
                Loading members…
              </span>
            ) : null}
          </span>
          <MultiSelect
            disabled={
              !conversationId || !joined || members.isPending || members.isError
            }
            emptyText="No matching members."
            onChange={(next) => {
              setAllowlist(next);
              const nextApprover = next.includes(approverId) ? approverId : '';
              setApproverId(nextApprover);
              onChange({ allowlist: next, approver: nextApprover });
            }}
            options={(members.data?.members ?? []).map((member) => ({
              label: member.displayName,
              value: member.id,
            }))}
            placeholder={
              selectedConversation?.membership === 'joinable'
                ? 'Join the channel first'
                : members.isPending && conversationId
                  ? 'Refreshing Slack members…'
                  : 'Choose who can converse with it'
            }
            searchPlaceholder="Search members…"
            selected={allowlist}
          />
          {allowlist.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {allowlist.map((id) => {
                const member = members.data?.members.find(
                  (candidate) => candidate.id === id,
                );
                return (
                  <Badge key={id} variant="secondary">
                    {member?.displayName ?? id}
                    <button
                      aria-label={`Remove ${member?.displayName ?? id}`}
                      className="ml-0.5 -mr-0.5 rounded-full p-0.5 hover:bg-foreground/10"
                      onClick={() => {
                        const next = allowlist.filter((item) => item !== id);
                        setAllowlist(next);
                        const nextApprover = next.includes(approverId)
                          ? approverId
                          : '';
                        setApproverId(nextApprover);
                        onChange({ allowlist: next, approver: nextApprover });
                      }}
                      type="button"
                    >
                      <XIcon aria-hidden="true" size={11} />
                    </button>
                  </Badge>
                );
              })}
            </div>
          ) : null}
        </label>
        <label className="onboarding-field">
          <span>Who approves its riskier actions?</span>
          <select
            disabled={allowlist.length === 0}
            onChange={(event) => {
              setApproverId(event.target.value);
              onChange({ approver: event.target.value });
            }}
            value={approverId}
          >
            <option value="">
              {allowlist.length === 0
                ? 'Choose who can talk to it first'
                : 'Choose one allowlisted member'}
            </option>
            {(members.data?.members ?? [])
              .filter((member) => allowlist.includes(member.id))
              .map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName}
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
