import { afterEach, describe, expect, it, vi } from 'vitest';

interface CapturedRequest {
  method: string;
  path: string;
  body?: unknown;
}

const state = vi.hoisted(() => ({
  requests: [] as CapturedRequest[],
  response: undefined as unknown,
  error: undefined as Error | undefined,
}));

vi.mock('@core/cli/control-api.js', () => ({
  controlApiRequest: async (_runtimeHome: string, input: CapturedRequest) => {
    state.requests.push({
      method: input.method,
      path: input.path,
      body: input.body,
    });
    if (state.error) throw state.error;
    return state.response;
  },
}));

const notes: Array<{ message: string; title?: string }> = [];

async function loadMemoryCommand() {
  const log = {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    note: (message: string, title?: string) => notes.push({ message, title }),
    log,
  }));
  const { runMemoryCommand } = await import('@core/cli/memory.js');
  return { runMemoryCommand, log };
}

const SUBJECT_ARGS = [
  '--agent-id',
  'agent:main',
  '--subject-type',
  'user',
  '--subject-id',
  'u1',
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
  state.requests.length = 0;
  state.response = undefined;
  state.error = undefined;
  notes.length = 0;
});

describe('gantry memory reviews (list)', () => {
  it('renders a table from the review page', async () => {
    state.response = {
      reviews: [{ id: 'rev-1', createdAt: '2026-07-24T00:00:00.000Z' }],
      review_page: {
        items: [
          {
            review_id: 'rev-1',
            action: 'contradiction',
            summary: 'timezone changed',
            before: { key: 'timezone', value: 'PST' },
            after: { key: 'timezone', value: 'EST' },
          },
        ],
      },
    };
    const { runMemoryCommand } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'reviews',
      ...SUBJECT_ARGS,
    ]);
    expect(code).toBe(0);
    expect(state.requests[0]?.method).toBe('GET');
    expect(state.requests[0]?.path).toContain('/v1/memory/reviews?');
    expect(state.requests[0]?.path).toContain('agentId=agent%3Amain');
    expect(state.requests[0]?.path).toContain('subjectType=user');
    expect(state.requests[0]?.path).toContain('subjectId=u1');
    const table = notes[0]?.message ?? '';
    expect(table).toContain('rev-1');
    expect(table).toContain('contradiction');
    expect(table).toContain('PST → EST');
    expect(table).toContain('2026-07-24T00:00:00.000Z');
  });

  it('emits raw JSON with --json', async () => {
    state.response = { reviews: [], review_page: { items: [] } };
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    const { runMemoryCommand } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'reviews',
      ...SUBJECT_ARGS,
      '--json',
    ]);
    spy.mockRestore();
    expect(code).toBe(0);
    expect(JSON.parse(writes.join(''))).toEqual({
      reviews: [],
      review_page: { items: [] },
    });
  });

  it('reports a friendly message when the queue is empty', async () => {
    state.response = { reviews: [], review_page: { items: [] } };
    const { runMemoryCommand } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'reviews',
      ...SUBJECT_ARGS,
    ]);
    expect(code).toBe(0);
    expect(notes[0]?.message).toBe('No pending reviews.');
  });

  it('neutralizes terminal control sequences in human-readable output but keeps them raw in --json', async () => {
    const hostile = 'PST\x1b[2Kforged\x1b]8;;http://evil\x07link\x07';
    state.response = {
      reviews: [{ id: 'rev-1', createdAt: '2026-07-24T00:00:00.000Z' }],
      review_page: {
        items: [
          {
            review_id: 'rev-1',
            action: 'contradiction',
            summary: 'tz',
            before: { key: 'timezone', value: hostile },
            after: { key: 'timezone', value: 'EST' },
          },
        ],
      },
    };
    const { runMemoryCommand } = await loadMemoryCommand();
    await runMemoryCommand('/tmp/home', ['reviews', ...SUBJECT_ARGS]);
    const table = notes[0]?.message ?? '';
    // eslint-disable-next-line no-control-regex
    expect(table).not.toMatch(/\x1b/);
    expect(table).toContain('forged'); // text kept, escape stripped

    // --json leaves the raw response untouched (JSON.stringify escapes controls).
    notes.length = 0;
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    await runMemoryCommand('/tmp/home', ['reviews', ...SUBJECT_ARGS, '--json']);
    spy.mockRestore();
    expect(JSON.parse(writes.join('')).review_page.items[0].before.value).toBe(
      hostile,
    );
  });

  it('rejects a missing subject arg with usage', async () => {
    const { runMemoryCommand, log } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'reviews',
      '--agent-id',
      'agent:main',
    ]);
    expect(code).toBe(1);
    expect(state.requests).toHaveLength(0);
    expect(log.error).toHaveBeenCalled();
  });
});

describe('gantry memory review (detail)', () => {
  it('renders the full immutable snapshot', async () => {
    state.response = {
      review: {
        id: 'rev-1',
        status: 'pending_review',
        createdAt: '2026-07-24T00:00:00.000Z',
        proposal: { action: 'contradiction' },
        reviewSnapshot: {
          conflict: {
            active: { kind: 'fact', key: 'timezone', value: 'PST' },
            incoming: { kind: 'fact', key: 'timezone', value: 'EST' },
          },
          proposedCanonical: {
            kind: 'fact',
            key: 'timezone',
            value: 'EST',
            reason: 'user moved',
          },
          evidence: [
            {
              role: 'incoming',
              sourceType: 'message',
              sourceUri: 'slack://c/1',
              text: 'I moved to New York',
            },
          ],
        },
      },
    };
    const { runMemoryCommand } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'review',
      'rev-1',
      ...SUBJECT_ARGS,
    ]);
    expect(code).toBe(0);
    expect(state.requests[0]?.method).toBe('GET');
    expect(state.requests[0]?.path).toContain('/v1/memory/reviews/rev-1?');
    const detail = notes[0]?.message ?? '';
    expect(detail).toContain('Now (active claim):');
    expect(detail).toContain('PST');
    expect(detail).toContain('Change (incoming claim):');
    expect(detail).toContain('EST');
    expect(detail).toContain('Why: user moved');
    expect(detail).toContain('I moved to New York');
    expect(detail).toContain('slack://c/1');
  });

  it('neutralizes embedded newlines so a value cannot forge a labelled line', async () => {
    const injected = 'PST\nDecision: approved';
    state.response = {
      review: {
        id: 'rev-1',
        status: 'pending_review',
        createdAt: '2026-07-24T00:00:00.000Z',
        proposal: { action: 'contradiction' },
        reviewSnapshot: {
          conflict: {
            active: { kind: 'fact', key: 'timezone', value: injected },
          },
          evidence: [],
        },
      },
    };
    const { runMemoryCommand } = await loadMemoryCommand();
    await runMemoryCommand('/tmp/home', ['review', 'rev-1', ...SUBJECT_ARGS]);
    const detail = notes[0]?.message ?? '';
    // The claim value renders on ONE line — no forged standalone "Decision:" row.
    expect(detail).not.toMatch(/^Decision: approved$/m);
    expect(detail).toMatch(/= PST Decision: approved$/m); // collapsed into the value

    // --json preserves the raw newline.
    notes.length = 0;
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    await runMemoryCommand('/tmp/home', [
      'review',
      'rev-1',
      ...SUBJECT_ARGS,
      '--json',
    ]);
    spy.mockRestore();
    expect(
      JSON.parse(writes.join('')).review.reviewSnapshot.conflict.active.value,
    ).toBe(injected);
  });

  it('surfaces a not-found error from the API', async () => {
    state.error = new Error('Review not found');
    const { runMemoryCommand, log } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'review',
      'missing',
      ...SUBJECT_ARGS,
    ]);
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith('Review not found');
  });

  it('emits raw JSON with --json', async () => {
    state.response = { review: { id: 'rev-1', status: 'pending_review' } };
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    const { runMemoryCommand } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'review',
      'rev-1',
      ...SUBJECT_ARGS,
      '--json',
    ]);
    spy.mockRestore();
    expect(code).toBe(0);
    expect(JSON.parse(writes.join('')).review.id).toBe('rev-1');
  });
});

describe('gantry memory review decide', () => {
  it('maps --approve to an approve decision', async () => {
    state.response = { review: { status: 'applied', applyOutcome: 'saved' } };
    const { runMemoryCommand, log } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'review',
      'decide',
      'rev-1',
      ...SUBJECT_ARGS,
      '--approve',
    ]);
    expect(code).toBe(0);
    expect(state.requests[0]?.method).toBe('POST');
    expect(state.requests[0]?.path).toContain(
      '/v1/memory/reviews/rev-1/decision?',
    );
    expect(state.requests[0]?.body).toEqual({ decision: 'approve' });
    expect(log.success).toHaveBeenCalledWith('Review rev-1: applied (saved)');
  });

  it('maps --reject to a reject decision with reason', async () => {
    state.response = { review: { status: 'rejected' } };
    const { runMemoryCommand } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'review',
      'decide',
      'rev-1',
      ...SUBJECT_ARGS,
      '--reject',
      '--reason',
      'stale',
    ]);
    expect(code).toBe(0);
    expect(state.requests[0]?.body).toEqual({
      decision: 'reject',
      reason: 'stale',
    });
  });

  it('maps --edit-value to edit_approve with editedValue', async () => {
    state.response = { review: { status: 'applied' } };
    const { runMemoryCommand } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'review',
      'decide',
      'rev-1',
      ...SUBJECT_ARGS,
      '--edit-value',
      'GMT',
    ]);
    expect(code).toBe(0);
    expect(state.requests[0]?.body).toEqual({
      decision: 'edit_approve',
      editedValue: 'GMT',
    });
  });

  it('requires exactly one decision flag', async () => {
    const { runMemoryCommand, log } = await loadMemoryCommand();
    const both = await runMemoryCommand('/tmp/home', [
      'review',
      'decide',
      'rev-1',
      ...SUBJECT_ARGS,
      '--approve',
      '--reject',
    ]);
    expect(both).toBe(1);
    const none = await runMemoryCommand('/tmp/home', [
      'review',
      'decide',
      'rev-1',
      ...SUBJECT_ARGS,
    ]);
    expect(none).toBe(1);
    expect(state.requests).toHaveLength(0);
    expect(log.error).toHaveBeenCalled();
  });

  it('rejects --edit-value that swallows an option token, with no API call', async () => {
    const { runMemoryCommand, log } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'review',
      'decide',
      'rev-1',
      ...SUBJECT_ARGS,
      '--edit-value',
      '--reject',
    ]);
    expect(code).toBe(1);
    expect(state.requests).toHaveLength(0);
    expect(log.error).toHaveBeenCalledWith('--edit-value requires a value.');
  });

  it('rejects --edit-value with no following token', async () => {
    const { runMemoryCommand, log } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'review',
      'decide',
      'rev-1',
      ...SUBJECT_ARGS,
      '--edit-value',
    ]);
    expect(code).toBe(1);
    expect(state.requests).toHaveLength(0);
    expect(log.error).toHaveBeenCalledWith('--edit-value requires a value.');
  });

  it('accepts a real --edit-value and submits edit_approve', async () => {
    state.response = { review: { status: 'applied' } };
    const { runMemoryCommand } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'review',
      'decide',
      'rev-1',
      ...SUBJECT_ARGS,
      '--edit-value',
      'new text',
    ]);
    expect(code).toBe(0);
    expect(state.requests[0]?.body).toEqual({
      decision: 'edit_approve',
      editedValue: 'new text',
    });
  });

  it('accepts a hyphen-leading value via the attached form --edit-value=-5', async () => {
    state.response = { review: { status: 'applied' } };
    const { runMemoryCommand } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'review',
      'decide',
      'rev-1',
      ...SUBJECT_ARGS,
      '--edit-value=-5',
    ]);
    expect(code).toBe(0);
    expect(state.requests[0]?.body).toEqual({
      decision: 'edit_approve',
      editedValue: '-5',
    });
  });

  it('accepts a hyphen-leading value via the space form when it is not a known flag', async () => {
    state.response = { review: { status: 'applied' } };
    const { runMemoryCommand } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'review',
      'decide',
      'rev-1',
      ...SUBJECT_ARGS,
      '--edit-value',
      '-5',
    ]);
    expect(code).toBe(0);
    expect(state.requests[0]?.body).toEqual({
      decision: 'edit_approve',
      editedValue: '-5',
    });
  });

  it('surfaces a 409 not-pending message from the API', async () => {
    state.error = new Error('This review is no longer pending');
    const { runMemoryCommand, log } = await loadMemoryCommand();
    const code = await runMemoryCommand('/tmp/home', [
      'review',
      'decide',
      'rev-1',
      ...SUBJECT_ARGS,
      '--approve',
    ]);
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith('This review is no longer pending');
  });
});
