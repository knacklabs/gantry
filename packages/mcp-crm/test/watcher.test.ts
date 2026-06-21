import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePool, makeFakeRepo, stubLlm } from './helpers/fakes.js';
import {
  runDigestCycleOnce,
  runManualConversationExtraction,
  startDigestWatcher,
} from '../src/watcher/index.js';
import { pendingDigestsSql } from '../src/watcher/digest-source.js';

const env = {
  gantrySchema: 'gantry',
  reconcileAgentId: 'agent:boondi_support',
  crmLeadQueryExtractionWatcher: {
    enabled: true,
    pollIntervalMs: 1,
    model: 'x',
  },
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

  it('excludes manual command messages and their assistant acknowledgements from extraction', async () => {
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

  it('runs the same digest cycle as the automatic watcher for one conversation', async () => {
    const { pool, query } = makeFakePool((sql) => {
      if (sql.includes('agent_session_digests')) {
        return {
          rows: [
            {
              digest_id: 'd_manual',
              conversation_id: 'conversation:wa:919654405340',
              digest: 'manual digest text',
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

    const stats = await runManualConversationExtraction(
      { env, logger, pool, repo, llm },
      'conversation:wa:919654405340',
    );

    expect(stats).toEqual({
      digests: 1,
      extracted: 1,
      created: 1,
      updated: 0,
      skipped: 0,
    });
    expect(query.mock.calls[0][1]).toEqual([
      env.reconcileAgentId,
      'conversation:wa:919654405340',
      25,
    ]);
    expect(repo.upsertOpportunity).toHaveBeenCalledTimes(1);
    const advanced = query.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO boondi_digest_cursor'),
    );
    expect(advanced).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        digests: 1,
        trigger: 'manual',
        apply: true,
      }),
      'digest_cycle_started',
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

  it('is a no-op when no pending digest exists', async () => {
    const { pool } = makeFakePool(() => ({ rows: [] }));
    const repo = makeFakeRepo();
    const complete = vi.fn(async () => '{"opportunities":[]}');

    const stats = await runManualConversationExtraction(
      { env, logger, pool, repo, llm: { complete } },
      'conversation:wa:919654405340',
    );

    expect(stats).toEqual({
      digests: 0,
      extracted: 0,
      created: 0,
      updated: 0,
      skipped: 0,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(repo.upsertOpportunity).not.toHaveBeenCalled();
  });
});

describe('startDigestWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the timer without running a digest cycle immediately', async () => {
    const { pool, query } = makeFakePool(() => ({ rows: [] }));
    const stop = startDigestWatcher({
      env,
      logger,
      pool,
      repo: makeFakeRepo(),
      llm,
    });

    expect(query).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(env.crmLeadQueryExtractionWatcher.pollIntervalMs);

    expect(query).toHaveBeenCalled();
    stop();
  });
});
