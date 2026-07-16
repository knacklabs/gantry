import { Paperclip, Send, Square } from 'lucide-react';
import { useRef, useState } from 'react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';

const MAX_DRAFT_CHARACTERS = 20_000;

type DraftAttachment = {
  id: string;
  name: string;
};

export function ChatComposer({ sessionTitle }: { sessionTitle: string }) {
  const { requestConnection } = useConnectionGate();
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div className="grid gap-3 border-t border-border bg-surface p-4">
      {attachments.length ? (
        <div className="flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <Badge key={attachment.id}>{attachment.name}</Badge>
          ))}
        </div>
      ) : null}
      <label className="sr-only" htmlFor="chat-draft">
        Message
      </label>
      <textarea
        className="min-h-24 w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-sm leading-6 text-text placeholder:text-text-muted"
        id="chat-draft"
        maxLength={MAX_DRAFT_CHARACTERS}
        placeholder="Write a message"
        value={draft}
        onChange={(event) =>
          setDraft(event.target.value.slice(0, MAX_DRAFT_CHARACTERS))
        }
      />
      <p className="m-0 text-right font-mono text-[10px] text-text-muted">
        {draft.length.toLocaleString()} /{' '}
        {MAX_DRAFT_CHARACTERS.toLocaleString()}
      </p>
      <input
        aria-label="Attach files"
        className="sr-only"
        multiple
        ref={fileInput}
        type="file"
        onChange={(event) =>
          setAttachments(
            Array.from(event.target.files ?? []).map((file, index) => ({
              id: `${file.name}:${file.size}:${file.lastModified}:${index}`,
              name: file.name,
            })),
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="ghost"
          type="button"
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip size={16} aria-hidden="true" />
          Attach
        </Button>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => requestConnection(`Stop run in ${sessionTitle}`)}
          >
            <Square size={14} fill="currentColor" aria-hidden="true" />
            Stop
          </Button>
          <Button
            disabled={!draft.trim() && attachments.length === 0}
            onClick={() => requestConnection(`Send message in ${sessionTitle}`)}
          >
            <Send size={16} aria-hidden="true" />
            Send
          </Button>
        </div>
      </div>
      <p className="m-0 text-[11px] leading-4 text-text-muted">
        Drafts stay in this page only. Nothing is sent while Gantry is
        disconnected.
      </p>
    </div>
  );
}
