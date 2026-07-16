import { Bot, UserRound } from 'lucide-react';

import type { ChatMessagePreview } from '../chat-preview';
import { InteractionRenderer } from './interaction-renderer';

export function ChatThread({ messages }: { messages: ChatMessagePreview[] }) {
  return (
    <div aria-label="Messages" className="grid gap-6 p-4 sm:p-5">
      {messages.map((message) => (
        <article
          className={`grid gap-3 ${message.role === 'user' ? 'ml-auto w-[min(100%,760px)]' : 'w-full'}`}
          key={message.id}
        >
          <header className="flex items-center gap-2 text-xs text-text-muted">
            <span className="flex size-7 items-center justify-center rounded-full bg-surface-strong text-text-secondary">
              {message.role === 'user' ? (
                <UserRound size={14} aria-hidden="true" />
              ) : (
                <Bot size={14} aria-hidden="true" />
              )}
            </span>
            <strong className="font-semibold text-text">
              {message.author}
            </strong>
            <span>{message.time}</span>
          </header>
          <div
            className={
              message.role === 'user'
                ? 'rounded-md bg-ink px-4 py-3 text-sm leading-6 text-ink-on'
                : message.role === 'system'
                  ? 'border-l-2 border-status-attention px-4 text-sm leading-6 text-text-secondary'
                  : 'max-w-3xl text-sm leading-6 text-text'
            }
          >
            <p className="m-0 whitespace-pre-wrap">{message.content}</p>
          </div>
          {message.descriptors?.length ? (
            <div className="grid max-w-3xl gap-3">
              {message.descriptors.map((descriptor, index) => (
                <InteractionRenderer
                  descriptor={descriptor}
                  key={`${message.id}-${descriptor.kind}-${index}`}
                />
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}
