import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePool, makeFakeRepo, stubLlm } from './helpers/fakes.js';
import { runDigestCycleOnce, runManualConversationExtraction } from '../src/watcher/index.js';
import { pendingDigestsSql } from '../src/watcher/digest-source.js';

const env = {
  gantrySchema: 'gantry',
  reconcileAgentId: 'agent:boondi_support',
  reconcileIntervalMs: 1,
  extractorModel: 'x',
  anthropicApiKey: 'x',
} as any;
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
} as any;
const llm = stubLlm(
  '{"opportunities":[{"match":null,"isLead":true,"occasion":"Diwali","quantity":200,"summaryBrief":"200 Diwali","evidenceQuote":"200 boxes","confidence":0.9}]}',
);

describe('runDigestCycleOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds filter placeholders from SQL params, not predicate count', () => {
    const sql = pendingDigestsSql('gantry', {
      conversationId: 'conversation:wa:919654405340',
      since: '2026-06-08T20:00:00.000Z',
      limit: 1,
    });
    expect(sql).toContain('s.agent_id = $1');
    expect(sql).toContain('s.conversation_id = $2');
    expect(sql).toContain('d.created_at >= $3::timestamptz');
    expect(sql).toContain('LIMIT $4');
  });

  it('extracts from a new digest, upserts, and advances the cursor', async () => {
    const { pool, query } = makeFakePool((sql) => {
      if (sql.includes('agent_session_digests')) {
        return {
          rows: [
            {
              digest_id: 'd1',
              conversation_id: 'conversation:wa:9001',
              digest: 'digest text',
              created_at: '2026-06-06T00:00:00Z',
            },
          ],
        };
      }
      if (sql.includes('message_parts')) {
        return {
          rows: [{ direction: 'inbound', text: 'I want 200 boxes for Diwali' }],
        };
      }
      return { rows: [] };
    });
    const repo = makeFakeRepo();
    const stats = await runDigestCycleOnce({ env, logger, pool, repo, llm });
    expect(stats.digests).toBe(1);
    expect(stats.created).toBe(1);
    expect(repo.upsertOpportunity).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ digests: 1 }),
      'digest_cycle_started',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ digestId: 'd1', transcriptMessages: 1 }),
      'digest_process_started',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        digestId: 'd1',
        extracted: 1,
        created: 1,
        output: [
          expect.objectContaining({ action: 'created', status: 'lead' }),
        ],
      }),
      'digest_process_completed',
    );
    const advanced = query.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO boondi_digest_cursor'),
    );
    expect(advanced).toBe(true);
  });

  it('supports a filtered, read-only dry run of the digest cycle', async () => {
    const complete = vi.fn(
      async () =>
        '{"opportunities":[{"match":null,"isLead":true,"summaryBrief":"200 Diwali","evidenceQuote":"200 boxes","confidence":0.9}]}',
    );
    const { pool, query } = makeFakePool((sql) => {
      if (sql.includes('agent_session_digests')) {
        return {
          rows: [
            {
              digest_id: 'd1',
              conversation_id: 'conversation:wa:919654405340',
              digest: 'digest text',
              created_at: '2026-06-06T00:00:00Z',
            },
          ],
        };
      }
      if (sql.includes('message_parts')) {
        return {
          rows: [{ direction: 'inbound', text: 'I want 200 boxes for Diwali' }],
        };
      }
      return { rows: [] };
    });
    const repo = makeFakeRepo();

    const stats = await runDigestCycleOnce(
      { env, logger, pool, repo, llm: { complete } },
      {
        apply: false,
        conversationId: 'conversation:wa:919654405340',
        since: '2026-06-08T20:00:00.000Z',
        limit: 1,
      },
    );

    expect(stats).toMatchObject({
      digests: 1,
      extracted: 1,
      created: 0,
      updated: 0,
    });
    expect(query.mock.calls[0][1]).toEqual([
      env.reconcileAgentId,
      'conversation:wa:919654405340',
      '2026-06-08T20:00:00.000Z',
      1,
    ]);
    expect(repo.upsertOpportunity).not.toHaveBeenCalled();
    const advanced = query.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO boondi_digest_cursor'),
    );
    expect(advanced).toBe(false);
  });

  it('excludes manual digest command messages and their assistant acknowledgements from extraction', async () => {
    const complete = vi.fn(async () => '{"opportunities":[]}');
    const { pool } = makeFakePool((sql) => {
      if (sql.includes('agent_session_digests')) {
        return {
          rows: [
            {
              digest_id: 'd1',
              conversation_id: 'conversation:wa:9001',
              digest: 'digest text',
              created_at: '2026-06-06T00:00:00Z',
            },
          ],
        };
      }
      if (sql.includes('message_parts')) {
        return {
          rows: [
            { direction: 'inbound', text: '/digest-session' },
            { direction: 'outbound', text: 'Digest session queued.' },
            { direction: 'inbound', text: '/extract-leads-queries' },
            { direction: 'outbound', text: 'Lead extraction complete.' },
            { direction: 'inbound', text: 'I want 200 boxes for Diwali' },
            { direction: 'outbound', text: 'Sure, sharing options.' },
          ],
        };
      }
      return { rows: [] };
    });

    await runDigestCycleOnce({
      env,
      logger,
      pool,
      repo: makeFakeRepo(),
      llm: { complete },
    });

    const prompt = complete.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('customer: I want 200 boxes for Diwali');
    expect(prompt).toContain('assistant: Sure, sharing options.');
    expect(prompt).not.toContain('/digest-session');
    expect(prompt).not.toContain('Digest session queued.');
    expect(prompt).not.toContain('/extract-leads-queries');
    expect(prompt).not.toContain('Lead extraction complete.');
  });

  it('is a no-op when no digests are pending', async () => {
    const { pool } = makeFakePool(() => ({ rows: [] }));
    const repo = makeFakeRepo();
    const stats = await runDigestCycleOnce({ env, logger, pool, repo, llm });
    expect(stats.digests).toBe(0);
    expect(repo.upsertOpportunity).not.toHaveBeenCalled();
  });

  it('returns zeros when the llm is disabled (null)', async () => {
    const { pool } = makeFakePool(() => ({ rows: [] }));
    const repo = makeFakeRepo();
    const stats = await runDigestCycleOnce({
      env,
      logger,
      pool,
      repo,
      llm: null,
    });
    expect(stats.digests).toBe(0);
  });
});

describe('runManualConversationExtraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts from the live transcript with NO digest and NO cursor touch', async () => {
    const { pool, query } = makeFakePool((sql) => {
      if (sql.includes('message_parts')) {
        return {
          rows: [{ direction: 'inbound', text: 'I want 200 boxes for Diwali' }],
        };
      }
      return { rows: [] };
    });
    const repo = makeFakeRepo();

    const stats = await runManualConversationExtraction(
      { env, logger, pool, repo, llm },
      'conversation:wa:919654405340',
    );

    expect(stats).toEqual({ extracted: 1, created: 1, updated: 0, skipped: 0 });
    expect(repo.upsertOpportunity).toHaveBeenCalledTimes(1);
    // The manual path must never look at digests nor move the cursor.
    const sqls = query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((s) => s.includes('agent_session_digests'))).toBe(false);
    expect(sqls.some((s) => s.includes('boondi_digest_cursor'))).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptMessages: 1,
        extracted: 1,
        created: 1,
      }),
      'manual_extraction_completed',
    );
  });

  it('rejects a non-WhatsApp conversation id', async () => {
    const { pool } = makeFakePool(() => ({ rows: [] }));
    await expect(
      runManualConversationExtraction(
        { env, logger, pool, repo: makeFakeRepo(), llm },
        'conversation:slack:C123',
      ),
    ).rejects.toThrow(/conversation:wa:<digits>/);
  });

  it('throws extractor_disabled when the llm is null (defense; endpoint pre-checks)', async () => {
    const { pool } = makeFakePool(() => ({ rows: [] }));
    await expect(
      runManualConversationExtraction(
        { env, logger, pool, repo: makeFakeRepo(), llm: null },
        'conversation:wa:919654405340',
      ),
    ).rejects.toThrow(/extractor_disabled/);
  });

  it('returns zeros for an empty transcript without calling the llm', async () => {
    const complete = vi.fn(async () => '{"opportunities":[]}');
    const { pool } = makeFakePool(() => ({ rows: [] }));
    const repo = makeFakeRepo();
    const stats = await runManualConversationExtraction(
      { env, logger, pool, repo, llm: { complete } },
      'conversation:wa:919654405340',
    );
    expect(stats).toEqual({ extracted: 0, created: 0, updated: 0, skipped: 0 });
    expect(complete).not.toHaveBeenCalled();
    expect(repo.upsertOpportunity).not.toHaveBeenCalled();
  });

  it('reports skipped=1 on extractor parse failure and leaks no raw phone', async () => {
    const { pool } = makeFakePool((sql) => {
      if (sql.includes('message_parts')) {
        return {
          rows: [{ direction: 'inbound', text: 'I want 200 boxes for Diwali' }],
        };
      }
      return { rows: [] };
    });
    const repo = makeFakeRepo();
    const stats = await runManualConversationExtraction(
      {
        env,
        logger,
        pool,
        repo,
        llm: { complete: vi.fn(async () => '{"contactPhone": +919654405340}') },
      },
      'conversation:wa:919654405340',
    );
    expect(stats).toEqual({ extracted: 0, created: 0, updated: 0, skipped: 1 });
    expect(repo.upsertOpportunity).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      '919654405340',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('919654405');
  });

  it('passes open opportunities and an empty digestText to the extractor', async () => {
    const complete = vi.fn(async () => '{"opportunities":[]}');
    const { pool } = makeFakePool((sql) => {
      if (sql.includes('message_parts')) {
        return { rows: [{ direction: 'inbound', text: 'make it 50 boxes' }] };
      }
      return { rows: [] };
    });
    const repo = makeFakeRepo({
      getOpenOpportunitiesByPhone: vi.fn(async () => [
        {
          id: 'bcr_1',
          status: 'query',
          intentCategory: 'gifting_personal',
          occasion: 'Diwali',
          quantity: 20,
        },
      ]),
    });
    await runManualConversationExtraction(
      { env, logger, pool, repo, llm: { complete } },
      'conversation:wa:919654405340',
    );
    const prompt = complete.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('bcr_1: query gifting_personal Diwali qty=20');
    expect(prompt).toContain('customer: make it 50 boxes');
    expect(prompt).toContain('SESSION DIGEST (short-term memory):\n\n');
  });

  it('captures a soft browsing query when the extractor returns no opportunities', async () => {
    const complete = vi.fn(async () => '{"opportunities":[]}');
    const { pool } = makeFakePool((sql) => {
      if (sql.includes('message_parts')) {
        return {
          rows: [
            {
              direction: 'inbound',
              text: 'Just checking you out — a friend mentioned your sweets are amazing.',
            },
            {
              direction: 'outbound',
              text: "That's lovely to hear. If you're browsing BSS, I can help with favourites like Kaju Katli.",
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repo = makeFakeRepo();

    const stats = await runManualConversationExtraction(
      { env, logger, pool, repo, llm: { complete } },
      'conversation:wa:919654405340',
    );

    expect(stats).toEqual({ extracted: 1, created: 1, updated: 0, skipped: 0 });
    expect(repo.upsertOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({
        match: null,
        targetLead: false,
        input: expect.objectContaining({
          intentCategory: 'shopping',
          summaryBrief: expect.stringMatching(/browsing/i),
        }),
      }),
    );
  });

  it('captures recommendation shopping turns when the extractor misses them', async () => {
    const complete = vi.fn(async () => '{"opportunities":[]}');
    const { pool } = makeFakePool((sql) => {
      if (sql.includes('message_parts')) {
        return {
          rows: [
            {
              direction: 'inbound',
              text: "Hi! What's something really good and sweet you'd recommend?",
            },
            {
              direction: 'outbound',
              text: "A couple of lovely picks right now: Bombay's 3-Layer Chocolate Fudge and Indie Bar.",
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repo = makeFakeRepo();

    const stats = await runManualConversationExtraction(
      { env, logger, pool, repo, llm: { complete } },
      'conversation:wa:919654405340',
    );

    expect(stats).toEqual({ extracted: 1, created: 1, updated: 0, skipped: 0 });
    expect(repo.upsertOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({
        targetLead: false,
        input: expect.objectContaining({ intentCategory: 'shopping' }),
      }),
    );
  });

  it('matches the lone open personal gifting query when later extraction omits the id', async () => {
    const complete = vi.fn(
      async () =>
        '{"opportunities":[{"match":null,"isLead":true,"intentCategory":"gifting_personal","occasion":"family get-together","quantity":12,"budgetPerGiftInr":300,"timeline":"tomorrow","summaryBrief":"10-12 boxes for a family party tomorrow","evidenceQuote":"It is for a family party, 10-12 boxes, about 300 per box, needed tomorrow, multiple home addresses.","confidence":0.86}]}',
    );
    const { pool } = makeFakePool((sql) => {
      if (sql.includes('message_parts')) {
        return {
          rows: [
            {
              direction: 'inbound',
              text: 'I am looking to gift something for a family get-together.',
            },
            {
              direction: 'inbound',
              text: 'It is for a family party, 10-12 boxes, about 300 per box, needed tomorrow, multiple home addresses.',
            },
            {
              direction: 'inbound',
              text: 'Yes please have the team help with this.',
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repo = makeFakeRepo({
      getOpenOpportunitiesByPhone: vi.fn(async () => [
        {
          id: 'bcr_1',
          status: 'qualifying',
          intentCategory: 'gifting_personal',
          occasion: 'family get-together',
          quantity: 12,
        },
      ]),
    });

    const stats = await runManualConversationExtraction(
      { env, logger, pool, repo, llm: { complete } },
      'conversation:wa:919654405340',
    );

    expect(stats).toEqual({ extracted: 1, created: 0, updated: 1, skipped: 0 });
    expect(repo.upsertOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({
        match: 'bcr_1',
        targetLead: true,
      }),
    );
  });

  it('matches the oldest compatible open row when a background digest created a duplicate', async () => {
    const complete = vi.fn(
      async () =>
        '{"opportunities":[{"match":null,"isLead":true,"intentCategory":"gifting_personal","quantity":12,"summaryBrief":"10-12 boxes for a family party tomorrow","evidenceQuote":"It is for a family party, 10-12 boxes, about 300 per box, needed tomorrow, multiple home addresses.","confidence":0.86}]}',
    );
    const { pool } = makeFakePool((sql) => {
      if (sql.includes('message_parts')) {
        return {
          rows: [
            {
              direction: 'inbound',
              text: 'I am looking to gift something for a family get-together.',
            },
            {
              direction: 'inbound',
              text: 'It is for a family party, 10-12 boxes, about 300 per box, needed tomorrow, multiple home addresses.',
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repo = makeFakeRepo({
      getOpenOpportunitiesByPhone: vi.fn(async () => [
        {
          id: 'bcr_duplicate',
          status: 'qualifying',
          intentCategory: 'gifting_personal',
          createdAt: '2026-06-13T06:02:41.000Z',
        },
        {
          id: 'bcr_checkpoint',
          status: 'qualifying',
          intentCategory: 'gifting_personal',
          createdAt: '2026-06-13T06:02:34.000Z',
        },
      ]),
    });

    const stats = await runManualConversationExtraction(
      { env, logger, pool, repo, llm: { complete } },
      'conversation:wa:919654405340',
    );

    expect(stats).toEqual({ extracted: 1, created: 0, updated: 1, skipped: 0 });
    expect(repo.upsertOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({
        match: 'bcr_checkpoint',
        targetLead: true,
      }),
    );
  });
});
