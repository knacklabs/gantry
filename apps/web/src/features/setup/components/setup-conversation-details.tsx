import { useEffect, useState } from 'react';

import { Button } from '../../../ui/primitives/button';
import type { ConversationView } from '../../operations/conversation-api';
import { useReplaceConversationInstall } from '../../operations/use-conversations';

export function SetupConversationDetails({
  agentId,
  conversations,
  selectedConversationId,
  onSelect,
}: {
  agentId?: string;
  conversations: ConversationView[];
  selectedConversationId: string;
  onSelect: (conversationId: string) => void;
}) {
  const replaceInstall = useReplaceConversationInstall();
  const [requiresTrigger, setRequiresTrigger] = useState(true);
  const [trigger, setTrigger] = useState('');
  const [replaceApprovers, setReplaceApprovers] = useState(false);
  const [approverIds, setApproverIds] = useState('');
  const selectedConversation = conversations.find(
    (conversation) => conversation.id === selectedConversationId,
  );
  const missingRequiredTrigger = requiresTrigger && !trigger.trim();

  useEffect(() => {
    setRequiresTrigger(selectedConversation?.kind !== 'Direct message');
    setTrigger('');
  }, [selectedConversation?.id, selectedConversation?.kind]);

  return (
    <div className="grid gap-4">
      <label className="grid gap-1.5 text-xs font-semibold text-text">
        Conversation
        <select
          className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text disabled:text-text-muted"
          disabled={conversations.length === 0}
          value={selectedConversationId}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">
            {conversations.length === 0
              ? 'No conversations are available.'
              : 'Choose a conversation'}
          </option>
          {conversations.map((conversation) => (
            <option key={conversation.id} value={conversation.id}>
              {conversation.name} · {conversation.provider}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-text">
        <input
          checked={requiresTrigger}
          type="checkbox"
          onChange={(event) => setRequiresTrigger(event.target.checked)}
        />
        Require a trigger before the agent responds
      </label>
      {requiresTrigger ? (
        <label className="grid gap-1.5 text-xs font-semibold text-text">
          Trigger text
          <input
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text placeholder:text-text-muted"
            placeholder="e.g. @assistant"
            value={trigger}
            onChange={(event) => setTrigger(event.target.value)}
          />
          {missingRequiredTrigger ? (
            <span className="font-normal text-status-idle">
              Add the trigger text required for this conversation.
            </span>
          ) : null}
        </label>
      ) : null}
      <p className="m-0 text-sm text-text-secondary">
        Sender policy is managed by the provider. Conversation approvers govern
        who can approve requests for this agent.
      </p>
      <label className="flex items-center gap-2 text-sm text-text">
        <input
          checked={replaceApprovers}
          type="checkbox"
          onChange={(event) => setReplaceApprovers(event.target.checked)}
        />
        Replace conversation approvers
      </label>
      {replaceApprovers ? (
        <label className="grid gap-1.5 text-xs font-semibold text-text">
          Approver user IDs
          <input
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text placeholder:text-text-muted"
            placeholder="User IDs separated by commas"
            value={approverIds}
            onChange={(event) => setApproverIds(event.target.value)}
          />
          <span className="font-normal text-text-muted">
            Leave empty only if you intend to remove all approvers.
          </span>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={
            !agentId ||
            !selectedConversation ||
            replaceInstall.isPending ||
            missingRequiredTrigger
          }
          onClick={() => {
            if (!agentId || !selectedConversation) return;
            replaceInstall.mutate({
              conversation: selectedConversation,
              currentAgentId: selectedConversation.agentId,
              nextAgentId: agentId,
              trigger,
              requiresTrigger,
              ...(replaceApprovers
                ? {
                    approverUserIds: approverIds
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean),
                  }
                : {}),
            });
          }}
        >
          {replaceInstall.isPending
            ? 'Saving access…'
            : 'Save conversation access'}
        </Button>
        {!agentId ? (
          <span className="text-sm text-text-muted">
            Create the agent before assigning a conversation.
          </span>
        ) : null}
      </div>
      {replaceInstall.isError ? (
        <p className="m-0 text-sm text-danger">
          {replaceInstall.error.message}
        </p>
      ) : null}
      {replaceInstall.isSuccess ? (
        <p className="m-0 text-sm text-status-ready">
          Conversation access saved.
        </p>
      ) : null}
    </div>
  );
}
