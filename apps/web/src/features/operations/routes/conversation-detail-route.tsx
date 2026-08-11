import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  Bot,
  MessageSquareText,
  SearchX,
  ShieldCheck,
  UserRoundCheck,
} from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import { conversationPreviewQuery } from '../operations-queries';

const threadPreview = [
  {
    id: 'thread-1',
    sender: 'Maya Chen',
    message: 'Can you summarize the open incidents before standup?',
    time: '11 min ago',
    replies: 3,
  },
  {
    id: 'thread-2',
    sender: 'Gantry',
    message: 'The weekly summary is ready for owner review.',
    time: '43 min ago',
    replies: 1,
  },
] as const;

export function ConversationDetailRoute() {
  const { conversationId } = useParams({
    from: '/conversations/$conversationId',
  });
  const { data } = useQuery(conversationPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const conversation = data.find((item) => item.id === conversationId);

  if (!conversation) {
    return (
      <PageState
        kind="empty"
        icon={<SearchX size={18} aria-hidden="true" />}
        title="Conversation not found"
        description="This preview snapshot does not contain that conversation."
      />
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        search={{
          q: '',
          status: 'all',
          page: 1,
          sort: 'activity',
          desc: false,
        }}
        to="/conversations"
      >
        <ArrowLeft size={15} aria-hidden="true" />
        Conversations
      </Link>
      <PageHeader
        eyebrow={`${conversation.provider} · ${conversation.kind}`}
        title={conversation.name}
        description={`${conversation.members} members · Last activity ${conversation.activity}`}
        action={<StatusBadge status={conversation.status} />}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Panel
          title="Recent messages"
          description="Representative preview threads for this conversation."
        >
          <div className="divide-y divide-border">
            {threadPreview.map((thread) => (
              <article className="grid gap-2 px-5 py-4" key={thread.id}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-semibold text-text">
                    {thread.sender}
                  </span>
                  <span className="text-xs text-text-muted">{thread.time}</span>
                </div>
                <p className="m-0 text-sm leading-6 text-text-secondary">
                  {thread.message}
                </p>
                <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                  <MessageSquareText size={14} aria-hidden="true" />
                  {thread.replies} {thread.replies === 1 ? 'reply' : 'replies'}
                </span>
              </article>
            ))}
          </div>
        </Panel>

        <div className="grid content-start gap-4">
          <Panel
            title="Installed agent"
            action={<Bot size={16} aria-hidden="true" />}
          >
            <div className="grid gap-3 p-4">
              <p className="m-0 text-sm font-semibold text-text">
                {conversation.agent}
              </p>
              <p className="m-0 text-xs leading-5 text-text-secondary">
                Handles eligible messages after conversation policy and trigger
                checks.
              </p>
              <Button
                variant="secondary"
                onClick={() =>
                  requestConnection(`Change agent for ${conversation.name}`)
                }
              >
                Change installation
              </Button>
            </div>
          </Panel>

          <Panel
            title="Conversation policy"
            action={<ShieldCheck size={16} aria-hidden="true" />}
          >
            <dl className="m-0 grid gap-3 p-4 text-[13px]">
              <Detail label="Sender policy" value={conversation.policy} />
              <Detail
                label="Trigger"
                value={
                  conversation.kind === 'Direct message'
                    ? 'Every message'
                    : 'Mention required'
                }
              />
              <Detail
                label="Thread scope"
                value="Replies stay in originating thread"
              />
            </dl>
            <div className="border-t border-border p-4">
              <Button
                className="w-full"
                variant="secondary"
                onClick={() =>
                  requestConnection(`Edit policy for ${conversation.name}`)
                }
              >
                Edit policy
              </Button>
            </div>
          </Panel>
        </div>
      </div>

      <Panel
        title="Control approvers"
        description="Verified conversation members who can answer permission prompts."
        action={<UserRoundCheck size={16} aria-hidden="true" />}
      >
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Approver
            name="Maya Chen"
            identity="maya@acme.example"
            role="Owner"
          />
          <Approver name="Jon Bell" identity="U04JBELL" role="Approver" />
        </div>
        <div className="border-t border-border p-4">
          <Button
            onClick={() =>
              requestConnection(`Manage approvers for ${conversation.name}`)
            }
          >
            Manage approvers
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="mt-1 ml-0 text-text">{value}</dd>
    </div>
  );
}

function Approver({
  name,
  identity,
  role,
}: {
  name: string;
  identity: string;
  role: string;
}) {
  return (
    <div className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border p-3">
      <span className="flex size-9 items-center justify-center rounded-full bg-surface-strong text-xs font-semibold text-text">
        {name
          .split(' ')
          .map((part) => part[0])
          .join('')}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-text">
          {name}
        </span>
        <span className="block truncate font-mono text-[10px] text-text-muted">
          {identity}
        </span>
      </span>
      <span className="text-xs text-text-secondary">{role}</span>
    </div>
  );
}
