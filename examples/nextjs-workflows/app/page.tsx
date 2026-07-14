'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data
        ? String(data.error)
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return data;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  return readJson(
    await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function print(value: unknown): string {
  if (value instanceof Error) return value.message;
  return JSON.stringify(value, null, 2) ?? String(value);
}

export default function Home() {
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState(
    'Summarize why durable agent sessions matter.',
  );
  const [chatResult, setChatResult] = useState('No chat turn sent yet.');
  const [sessionId, setSessionId] = useState('');
  const [afterEventId, setAfterEventId] = useState('0');
  const [streamResult, setStreamResult] = useState('Stream not started.');
  const [ticketText, setTicketText] = useState(
    'I was charged twice for my subscription.',
  );
  const [workflowResult, setWorkflowResult] = useState('No workflow run yet.');
  const [llmText, setLlmText] = useState(
    'Classify this request: refund not received',
  );
  const [llmResult, setLlmResult] = useState('No Direct LLM API call yet.');
  const [usageResult, setUsageResult] = useState('Usage not loaded yet.');
  const streamRef = useRef<EventSource | undefined>(undefined);

  useEffect(() => () => streamRef.current?.close(), []);

  async function run(
    name: string,
    action: () => Promise<unknown>,
    setResult: (value: string) => void,
  ) {
    setBusy(name);
    try {
      setResult(print(await action()));
    } catch (error) {
      setResult(`Error: ${print(error)}`);
    } finally {
      setBusy(undefined);
    }
  }

  function submitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(
      'chat',
      async () => {
        const result = await postJson('/api/chat', { message });
        if (typeof result === 'object' && result !== null) {
          const session = 'session' in result ? result.session : undefined;
          const accepted = 'accepted' in result ? result.accepted : undefined;
          if (
            typeof session === 'object' &&
            session !== null &&
            'sessionId' in session
          ) {
            setSessionId(String(session.sessionId));
          }
          if (
            typeof accepted === 'object' &&
            accepted !== null &&
            'acceptedEventId' in accepted
          ) {
            setAfterEventId(String(accepted.acceptedEventId));
          }
        }
        return result;
      },
      setChatResult,
    );
  }

  function startStream(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    streamRef.current?.close();
    setStreamResult('Connecting…');

    const query = new URLSearchParams({ sessionId, afterEventId });
    const source = new EventSource(`/api/stream?${query}`);
    streamRef.current = source;
    const events: string[] = [];

    source.onmessage = (messageEvent) => {
      events.push(messageEvent.data);
      setStreamResult(events.join('\n\n'));
    };
    source.onerror = () => {
      source.close();
      streamRef.current = undefined;
      setStreamResult((current) => `${current}\n\nStream closed.`);
    };
  }

  function stopStream() {
    streamRef.current?.close();
    streamRef.current = undefined;
    setStreamResult((current) => `${current}\n\nStream stopped.`);
  }

  function submitWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(
      'workflow',
      () => postJson('/api/workflow', { ticketText }),
      setWorkflowResult,
    );
  }

  function submitLlm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(
      'llm',
      () => postJson('/api/llm', { text: llmText }),
      setLlmResult,
    );
  }

  return (
    <main>
      <h1>Gantry Next.js workflows</h1>
      <p className="intro">
        These browser forms call Next.js route handlers. Gantry credentials, the
        server-only SDK, and the official OpenAI client stay behind those
        handlers.
      </p>

      <div className="grid">
        <section>
          <h2>Chat turn</h2>
          <form onSubmit={submitChat}>
            <label>
              Message
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                required
              />
            </label>
            <button disabled={busy === 'chat'}>
              {busy === 'chat' ? 'Waiting…' : 'Send and wait'}
            </button>
          </form>
          <pre aria-live="polite">{chatResult}</pre>
        </section>

        <section>
          <h2>SSE session events</h2>
          <form onSubmit={startStream}>
            <label>
              Session ID
              <input
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value)}
                required
              />
            </label>
            <label>
              After event ID
              <input
                type="number"
                min="0"
                value={afterEventId}
                onChange={(event) => setAfterEventId(event.target.value)}
                required
              />
            </label>
            <div className="actions">
              <button>Start stream</button>
              <button className="secondary" type="button" onClick={stopStream}>
                Stop
              </button>
            </div>
          </form>
          <pre aria-live="polite">{streamResult}</pre>
        </section>

        <section>
          <h2>Structured workflow</h2>
          <form onSubmit={submitWorkflow}>
            <label>
              Support ticket
              <textarea
                value={ticketText}
                onChange={(event) => setTicketText(event.target.value)}
                required
              />
            </label>
            <button disabled={busy === 'workflow'}>
              {busy === 'workflow' ? 'Triaging…' : 'Run triage'}
            </button>
          </form>
          <pre aria-live="polite">{workflowResult}</pre>
        </section>

        <section>
          <h2>Direct LLM API</h2>
          <form onSubmit={submitLlm}>
            <label>
              Prompt
              <textarea
                value={llmText}
                onChange={(event) => setLlmText(event.target.value)}
                required
              />
            </label>
            <button disabled={busy === 'llm'}>
              {busy === 'llm' ? 'Calling…' : 'Call model'}
            </button>
          </form>
          <pre aria-live="polite">{llmResult}</pre>
        </section>

        <section className="wide">
          <h2>Demo usage window</h2>
          <button
            disabled={busy === 'usage'}
            onClick={() =>
              void run(
                'usage',
                () => fetch('/api/usage').then(readJson),
                setUsageResult,
              )
            }
          >
            {busy === 'usage' ? 'Loading…' : 'Refresh usage'}
          </button>
          <pre aria-live="polite">{usageResult}</pre>
        </section>
      </div>
    </main>
  );
}
