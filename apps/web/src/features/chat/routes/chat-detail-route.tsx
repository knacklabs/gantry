import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ArrowLeft,
  Files,
  ListTree,
  MessageSquareText,
  SearchX,
} from 'lucide-react';

import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { RouteTabs, type RouteTab } from '../../../ui/compositions/route-tabs';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { ChatComposer } from '../components/chat-composer';
import {
  ChatInspector,
  type ChatInspectorTab,
} from '../components/chat-inspector';
import { ChatSessionDrawer } from '../components/chat-session-drawer';
import { ChatThread } from '../components/chat-thread';
import { messagePreviewQuery, sessionPreviewQuery } from '../chat-queries';

const inspectorTabs: RouteTab<ChatInspectorTab>[] = [
  { value: 'thread', label: 'Details' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'files', label: 'Files' },
];

export function ChatDetailRoute() {
  const { sessionId } = useParams({ from: '/chat/$sessionId' });
  const search = useSearch({ from: '/chat/$sessionId' });
  const navigate = useNavigate({ from: '/chat/$sessionId' });
  const { data: sessions } = useQuery(sessionPreviewQuery);
  const { data: messages } = useQuery(messagePreviewQuery(sessionId));
  const session = sessions.find((item) => item.id === sessionId);

  if (!session) {
    return (
      <PageState
        kind="empty"
        icon={<SearchX size={18} aria-hidden="true" />}
        title="Session not found"
        description="This preview snapshot does not contain that chat session."
      />
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-[1320px] gap-5">
      <div className="flex items-center justify-between gap-3">
        <Link
          className="inline-flex min-h-8 items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
          search={{ q: '', status: 'all', agent: 'all' }}
          to="/chat"
        >
          <ArrowLeft size={15} aria-hidden="true" /> Chat
        </Link>
        <ChatSessionDrawer currentSessionId={session.id} sessions={sessions} />
      </div>
      <PageHeader
        eyebrow={`${session.agent} · ${session.conversation}`}
        title={session.title}
        description={`Last activity ${session.activity}`}
        action={<StatusBadge status={session.status} />}
      />

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Panel
          title="Thread"
          description={`${messages.length} messages in this preview session`}
          action={<MessageSquareText size={16} aria-hidden="true" />}
        >
          <div className="max-h-[760px] overflow-y-auto">
            <ChatThread messages={messages} />
          </div>
          <ChatComposer sessionTitle={session.title} />
        </Panel>

        <Panel
          title="Session inspector"
          description="Owner-visible state only"
          action={
            search.inspector === 'files' ? (
              <Files size={16} aria-hidden="true" />
            ) : (
              <ListTree size={16} aria-hidden="true" />
            )
          }
        >
          <RouteTabs
            label="Session inspector"
            tabs={inspectorTabs}
            value={search.inspector}
            onValueChange={(inspector) =>
              void navigate({ search: { inspector } })
            }
          />
          <ChatInspector
            messages={messages}
            session={session}
            tab={search.inspector}
          />
        </Panel>
      </div>
    </div>
  );
}
