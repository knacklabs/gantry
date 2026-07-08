import { describe, expect, it } from 'vitest';

import {
  extractBrainPageRefs,
  normalizeEntityName,
  normalizeBrainSlug,
  parseBrainMarkdown,
} from '@core/brain/brain-page-ingest.js';
import { BrainChannelHarvester } from '@core/brain/brain-channel-harvest.js';
import {
  applyBrainDreamOperations,
  dreamMarkdownWindow,
  runBrainDreamBatch,
} from '@core/brain/brain-dreaming.js';
import { recallBrainPages } from '@core/brain/brain-recall.js';
import { BrainService } from '@core/brain/brain-service.js';
import { parseBrainSynthesisOutput } from '@core/brain/brain-synthesis.js';
import type {
  BrainEdge,
  BrainEntity,
  BrainGraph,
  BrainPage,
} from '@core/brain/brain-types.js';
import type {
  BrainEdgeWrite,
  BrainEntityWrite,
  BrainPageWrite,
  BrainRankedPage,
  BrainRepository,
  BrainDreamCursor,
  BrainDreamDecisionWrite,
} from '@core/brain/brain-repository.js';

describe('company brain core', () => {
  it('parses a frontmatter-only page without leaking metadata into the body', () => {
    const parsed = parseBrainMarkdown(
      '---\ntitle: Metadata only\npeople: [Alice]\n---',
    );

    expect(parsed.body).toBe('');
    expect(parsed.title).toBe('Metadata only');
    expect(parsed.frontmatter.people).toEqual(['Alice']);
  });

  it('extracts entities and deduped graph edges from markdown frontmatter', () => {
    const parsed = parseBrainMarkdown(`---
title: Acme roster
people: [Alice, Alice]
companies: [Acme]
projects: [Beacon]
assignee: Beacon: Alice
mentions: [Roadmap]
---
# Acme roster
Alice works on [[Roadmap]].`);

    const refs = extractBrainPageRefs(parsed);

    expect(
      refs.entities.map((entity) => `${entity.kind}:${entity.name}`),
    ).toEqual([
      'person:Alice',
      'company:Acme',
      'project:Beacon',
      'topic:Roadmap',
    ]);
    expect(
      refs.edges.map(
        (edge) => `${edge.type}:${edge.from.name}->${edge.to.name}`,
      ),
    ).toContain('works_at:Alice->Acme');
    expect(
      refs.edges.map(
        (edge) => `${edge.type}:${edge.from.name}->${edge.to.name}`,
      ),
    ).toContain('assigned_to:Beacon->Alice');
  });

  it('answers direct graph questions from edges', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    await brain.write({
      appId: 'default',
      slug: 'acme-roster',
      markdown: `---
title: Acme roster
people: [Alice]
companies: [Acme]
---
Alice works at Acme.`,
    });

    const result = await brain.query({
      appId: 'default',
      question: 'who works at Acme?',
    });

    expect(result.answer).toContain('Alice');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.slug).toBe('acme-roster');
  });

  it('uses vector recall when embeddings are available', async () => {
    const fresh = page('fresh', 'Fresh', 'Fresh semantic evidence');
    const repo: Pick<BrainRepository, 'searchLexical' | 'searchVector'> = {
      searchLexical: async () => [],
      searchVector: async () => [
        {
          page: fresh,
          score: 0.9,
          lexicalScore: 0,
          vectorScore: 0.9,
          reasons: ['semantic'],
        },
      ],
    };

    const result = await recallBrainPages({
      repository: repo as BrainRepository,
      appId: 'default',
      query: 'semantic',
      queryVector: [1, 0],
      embedding: { provider: 'test', model: 'fake', dimensions: 2 },
    });

    expect(result[0]?.page.slug).toBe('fresh');
    expect(result[0]?.reasons).toEqual(['semantic']);
  });

  it('keeps synthesized citations restricted to retrieved pages', () => {
    const allowed = page('allowed', 'Allowed', 'Allowed evidence');
    const fallback = {
      answer: 'fallback',
      citations: [
        { pageId: allowed.id, title: allowed.title, slug: allowed.slug },
      ],
      gaps: 'none',
    };

    const parsed = parseBrainSynthesisOutput(
      JSON.stringify({
        answer: 'answer',
        citations: [
          { pageId: 'missing', title: 'Missing', slug: 'missing' },
          { pageId: allowed.id, title: 'Wrong title', slug: 'wrong' },
        ],
        gaps: 'gap',
      }),
      fallback,
      [
        {
          page: allowed,
          score: 1,
          lexicalScore: 1,
          vectorScore: 0,
          reasons: ['lexical'],
          snippet: 'Allowed evidence',
          graph: { entities: [], edges: [] },
        },
      ],
    );

    expect(parsed.citations).toEqual([
      { pageId: allowed.id, title: 'Allowed', slug: 'allowed' },
    ]);
  });

  it('harvests opted-in channel messages into deterministic pages', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    const harvester = new BrainChannelHarvester(brain);
    const settings = settingsWithHarvest(true);
    const message = channelMessage({
      id: 'm1',
      content: 'Alice works at Acme.',
      timestamp: '2026-07-07T01:02:03.000Z',
      sender_name: 'Alice',
      thread_id: 'T123',
    });

    await harvester.harvest({ appId: 'default', message, settings });
    await harvester.harvest({ appId: 'default', message, settings });
    await harvester.harvest({
      appId: 'default',
      message: channelMessage({
        id: 'm2',
        content: 'Bob joined later.',
        timestamp: '2026-07-07T01:03:00.000Z',
        sender_name: 'Bob',
        thread_id: 'T123',
      }),
      settings,
    });

    const page = repo.pages.find((candidate) =>
      candidate.slug.startsWith('chan-slack-one-sl-c123-t123'),
    );
    expect(page?.sourceKind).toBe('channel');
    expect(page?.markdown.match(/Alice works at Acme/g)).toHaveLength(1);
    expect(page?.markdown).toContain('[Bob at 2026-07-07T01:03:00.000Z]');
    expect(page?.metadata.people).toEqual(['Alice', 'Bob']);
  });

  it('harvests unthreaded messages by day and skips non-opted channels', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    const harvester = new BrainChannelHarvester(brain);

    await harvester.harvest({
      appId: 'default',
      message: channelMessage({ id: 'm1', thread_id: undefined }),
      settings: settingsWithHarvest(false),
    });
    expect(repo.pages).toHaveLength(0);

    await harvester.harvest({
      appId: 'default',
      message: channelMessage({
        id: 'm2',
        thread_id: undefined,
        timestamp: '2026-07-07T09:00:00.000Z',
      }),
      settings: settingsWithHarvest(true),
    });

    // chan-<prefix>-<day>-<sha256(account:jid#day).slice(0,10)>
    expect(repo.pages[0]?.slug).toBe(
      'chan-slack-one-sl-c123-2026-07-07-d491827c09',
    );
  });

  it('keeps long conversation ids from truncating away the discriminator', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    const harvester = new BrainChannelHarvester(brain);
    const longJid = `teams:19_${'x'.repeat(150)}`;
    const settings = {
      providerAccounts: {
        teams_one: {
          agentId: 'main_agent',
          provider: 'teams',
          label: 'Teams',
          runtimeSecretRefs: {},
        },
      },
      conversations: {
        long_a: {
          providerAccount: 'teams_one',
          externalId: longJid,
          kind: 'channel',
          displayName: 'Long A',
          brainHarvest: true,
          senderPolicy: { allow: '*', mode: 'trigger' },
          controlApprovers: [],
          installedAgents: {},
        },
      },
    } as never;

    await harvester.harvest({
      appId: 'default',
      message: channelMessage({
        chat_jid: longJid,
        providerAccountId: 'teams_one',
        thread_id: `${'t'.repeat(40)}alpha`,
      }),
      settings,
    });
    await harvester.harvest({
      appId: 'default',
      message: channelMessage({
        chat_jid: longJid,
        providerAccountId: 'teams_one',
        thread_id: `${'t'.repeat(40)}beta`,
      }),
      settings,
    });

    const slugs = repo.pages.map((page) => page.slug);
    expect(slugs).toHaveLength(2);
    expect(slugs[0]).not.toBe(slugs[1]);
    for (const slug of slugs) expect(slug.length).toBeLessThanOrEqual(120);
  });

  it('refuses to harvest over a non-channel page occupying the slug', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    const harvester = new BrainChannelHarvester(brain);
    const settings = settingsWithHarvest(true);
    const message = channelMessage({ thread_id: 'TCOLLIDE' });

    await harvester.harvest({ appId: 'default', message, settings });
    const harvested = repo.pages[0]!;
    harvested.sourceKind = 'import';

    await expect(
      harvester.harvest({
        appId: 'default',
        message: channelMessage({
          id: 'm2',
          content: 'Another message',
          thread_id: 'TCOLLIDE',
        }),
        settings,
      }),
    ).rejects.toThrow('collides with a import page');
    expect(harvested.markdown).not.toContain('Another message');
  });

  it('never lets frontmatter spoof internal source kinds', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);

    const explicit = await brain.write({
      appId: 'default',
      slug: 'spoof-explicit',
      markdown: '---\nsource_kind: dream\n---\nBody.',
      sourceKind: 'agent',
      embed: false,
    });
    expect(explicit.page.sourceKind).toBe('agent');

    const omitted = await brain.write({
      appId: 'default',
      slug: 'spoof-omitted',
      markdown: '---\nsource_kind: channel\n---\nBody.',
      embed: false,
    });
    expect(omitted.page.sourceKind).toBe('agent');
  });

  it('never harvests messages without a provider account id', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    const harvester = new BrainChannelHarvester(brain);

    await harvester.harvest({
      appId: 'default',
      message: channelMessage({ providerAccountId: undefined }),
      settings: settingsWithHarvest(true),
    });

    expect(repo.pages).toHaveLength(0);
  });

  it('rejects dream pages whose slug collides with a non-dream page', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    const imported = (
      await brain.write({
        appId: 'default',
        slug: 'fact-launch-plan',
        markdown: '# Launch plan\nThe real imported plan.',
        sourceKind: 'import',
        embed: false,
      })
    ).page;
    const evidence = (
      await brain.write({
        appId: 'default',
        slug: 'chan-evidence',
        markdown: '# Evidence\nSomeone discussed the launch plan.',
        sourceKind: 'channel',
        embed: false,
      })
    ).page;

    const summary = await applyBrainDreamOperations({
      brain,
      repository: repo,
      appId: 'default',
      runId: 'bdr_test',
      evidencePages: [evidence],
      ops: [
        {
          action: 'write_fact_page',
          topic: 'launch plan',
          title: 'Launch plan',
          markdown: 'LLM-proposed replacement.',
          evidencePageIds: [evidence.id],
        },
      ],
    });

    expect(summary.rejected).toBe(1);
    expect(summary.applied).toBe(0);
    const page = await brain.getPageBySlug('default', 'fact-launch-plan');
    expect(page?.markdown).toContain('The real imported plan');
    expect(page?.sourceKind).toBe('import');
    expect(page?.id).toBe(imported.id);
  });

  it('keeps concurrent same-thread harvests lossless', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    const harvester = new BrainChannelHarvester(brain);
    const settings = settingsWithHarvest(true);

    await Promise.all([
      harvester.harvest({
        appId: 'default',
        message: channelMessage({
          id: 'c1',
          content: 'First racer',
          timestamp: '2026-07-07T01:00:00.000Z',
          thread_id: 'T9',
        }),
        settings,
      }),
      harvester.harvest({
        appId: 'default',
        message: channelMessage({
          id: 'c2',
          content: 'Second racer',
          sender_name: 'Bob',
          timestamp: '2026-07-07T01:00:01.000Z',
          thread_id: 'T9',
        }),
        settings,
      }),
    ]);

    const page = repo.pages.find((candidate) =>
      candidate.slug.includes('-t9-'),
    );
    expect(page?.markdown).toContain('First racer');
    expect(page?.markdown).toContain('Second racer');
  });

  it('flattens multiline messages into one dedupable line', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    const harvester = new BrainChannelHarvester(brain);
    const settings = settingsWithHarvest(true);
    const message = channelMessage({
      id: 'ml1',
      content: 'Deploy plan:\n- step one\n- step two',
      thread_id: 'T77',
    });

    await harvester.harvest({ appId: 'default', message, settings });
    await harvester.harvest({ appId: 'default', message, settings });

    const page = repo.pages.find((candidate) =>
      candidate.slug.includes('-t77-'),
    );
    const bodyLines = page?.markdown
      .split('\n')
      .filter((line) => line.includes('Deploy plan'));
    expect(bodyLines).toHaveLength(1);
    expect(bodyLines?.[0]).toContain('Deploy plan: - step one - step two');
  });

  it('keeps harvest pages separate per provider account', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    const harvester = new BrainChannelHarvester(brain);
    const settings = {
      providerAccounts: {
        slack_one: {
          agentId: 'main_agent',
          provider: 'slack',
          label: 'Slack One',
          runtimeSecretRefs: {},
        },
        slack_two: {
          agentId: 'main_agent',
          provider: 'slack',
          label: 'Slack Two',
          runtimeSecretRefs: {},
        },
      },
      conversations: {
        sales_one: {
          providerAccount: 'slack_one',
          externalId: 'C123',
          kind: 'channel',
          displayName: 'Sales One',
          brainHarvest: true,
          senderPolicy: { allow: '*', mode: 'trigger' },
          controlApprovers: [],
          installedAgents: {},
        },
        sales_two: {
          providerAccount: 'slack_two',
          externalId: 'C123',
          kind: 'channel',
          displayName: 'Sales Two',
          brainHarvest: true,
          senderPolicy: { allow: '*', mode: 'trigger' },
          controlApprovers: [],
          installedAgents: {},
        },
      },
    } as never;

    await harvester.harvest({
      appId: 'default',
      message: channelMessage({ providerAccountId: 'slack_one' }),
      settings,
    });
    await harvester.harvest({
      appId: 'default',
      message: channelMessage({ providerAccountId: 'slack_two' }),
      settings,
    });

    const slugs = repo.pages.map((page) => page.slug).sort();
    expect(slugs).toHaveLength(2);
    expect(slugs[0]).not.toBe(slugs[1]);
  });

  it('keeps the tail of oversized pages inside the dream window', () => {
    const head = 'OLDEST '.repeat(200);
    const tail = 'Alice moved to Beacon yesterday.';
    const markdown = `${head}${'filler '.repeat(1000)}${tail}`;

    const window = dreamMarkdownWindow(markdown);

    expect(window.length).toBeLessThanOrEqual(5001);
    expect(window).toContain(tail);
    expect(dreamMarkdownWindow('short page')).toBe('short page');
  });

  it('stops applying dream ops when the signal aborts mid-batch', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    await brain.write({
      appId: 'default',
      slug: 'chan-abort-ops',
      markdown: '# Thread\nAlice works at Acme.',
      sourceKind: 'channel',
      embed: false,
    });
    const controller = new AbortController();

    await expect(
      runBrainDreamBatch({
        brain,
        repository: repo,
        appId: 'default',
        signal: controller.signal,
        proposer: {
          propose: async () => {
            controller.abort(new Error('deadline fired during proposal'));
            return [{ action: 'upsert_entity', kind: 'person', name: 'Alice' }];
          },
        },
      }),
    ).rejects.toThrow('deadline fired');
    expect(repo.entities).toHaveLength(0);
    expect(repo.cursor).toBeNull();
  });

  it('does not advance the dream cursor when the proposer fails', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    await brain.write({
      appId: 'default',
      slug: 'chan-broken-thread',
      markdown: '# Thread\nSomething happened.',
      sourceKind: 'channel',
      embed: false,
    });

    await expect(
      runBrainDreamBatch({
        brain,
        repository: repo,
        appId: 'default',
        proposer: {
          propose: async () => {
            throw new Error('model returned malformed output');
          },
        },
      }),
    ).rejects.toThrow('malformed');
    expect(repo.cursor).toBeNull();
  });

  it('applies additive dream ops and journals invalid/destructive ops', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    const evidence = (
      await brain.write({
        appId: 'default',
        slug: 'chan-sl-c123-t1',
        markdown: '# Thread\nAlice works at Acme.',
        sourceKind: 'channel',
        embed: false,
      })
    ).page;
    const ops = [
      { action: 'upsert_entity', kind: 'person', name: 'Alice' },
      { action: 'upsert_entity', kind: 'company', name: 'Acme' },
      {
        action: 'upsert_edge',
        type: 'works_at',
        from: { kind: 'person', name: 'Alice' },
        to: { kind: 'company', name: 'Acme' },
        evidencePageId: evidence.id,
      },
      {
        action: 'write_fact_page',
        topic: 'Alice works at Acme',
        markdown: 'Alice works at Acme.',
        evidencePageIds: [evidence.id],
      },
      {
        action: 'enrich_entity_page',
        kind: 'person',
        name: 'Alice',
        markdown: 'Alice works at Acme.',
        evidencePageIds: [evidence.id],
      },
      { action: 'merge_entities', from: 'Alice', to: 'Alicia' },
      { action: 'upsert_entity', kind: 'planet', name: 'Mars' },
    ];

    const first = await applyBrainDreamOperations({
      brain,
      repository: repo,
      appId: 'default',
      runId: 'run-one',
      page: evidence,
      evidencePages: [evidence],
      ops,
    });
    const counts = {
      pages: repo.pages.length,
      entities: repo.entities.length,
      edges: repo.edges.length,
    };
    const second = await applyBrainDreamOperations({
      brain,
      repository: repo,
      appId: 'default',
      runId: 'run-two',
      page: evidence,
      evidencePages: [evidence],
      ops,
    });

    expect(first).toMatchObject({ applied: 5, proposed: 1, rejected: 1 });
    expect(second.noop).toBeGreaterThanOrEqual(5);
    expect({
      pages: repo.pages.length,
      entities: repo.entities.length,
      edges: repo.edges.length,
    }).toEqual(counts);
    expect(repo.decisions.map((decision) => decision.outcome)).toEqual(
      expect.arrayContaining(['applied', 'noop', 'proposed', 'rejected']),
    );
  });

  it('dreams a prose-only relation into grounded entities and edge', async () => {
    const repo = new InMemoryBrainRepository();
    const brain = new BrainService(repo);
    const pageResult = await brain.write({
      appId: 'default',
      slug: 'chan-sl-c123-t1',
      markdown: '# Thread\nAlice works at Acme.',
      sourceKind: 'channel',
      embed: false,
    });
    const result = await runBrainDreamBatch({
      brain,
      repository: repo,
      appId: 'default',
      proposer: {
        propose: async ({ pages }) => [
          { action: 'upsert_entity', kind: 'person', name: 'Alice' },
          { action: 'upsert_entity', kind: 'company', name: 'Acme' },
          {
            action: 'upsert_edge',
            type: 'works_at',
            from: { kind: 'person', name: 'Alice' },
            to: { kind: 'company', name: 'Acme' },
            evidencePageId: pages[0]!.id,
          },
        ],
      },
    });

    expect(result.applied).toBe(3);
    expect(await repo.findPeopleWorkingAt('default', 'Acme')).toMatchObject([
      { page: { id: pageResult.page.id } },
    ]);
  });
});

function page(slug: string, title: string, markdown: string): BrainPage {
  return {
    id: `page-${slug}`,
    appId: 'default',
    slug,
    title,
    markdown,
    sourceKind: 'agent',
    sourceRef: null,
    authorId: null,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

class InMemoryBrainRepository implements BrainRepository {
  pages: BrainPage[] = [];
  entities: BrainEntity[] = [];
  edges: BrainEdge[] = [];
  decisions: BrainDreamDecisionWrite[] = [];
  cursor: BrainDreamCursor | null = null;

  async upsertPage(input: BrainPageWrite) {
    const existing = this.pages.find(
      (page) => page.appId === input.appId && page.slug === input.slug,
    );
    if (existing) {
      Object.assign(existing, {
        title: input.title,
        markdown: input.markdown,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef ?? null,
        metadata: input.metadata ?? {},
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      return { page: existing, created: false };
    }
    const created = page(input.slug, input.title, input.markdown);
    created.appId = input.appId;
    created.sourceKind = input.sourceKind;
    created.sourceRef = input.sourceRef ?? null;
    created.metadata = input.metadata ?? {};
    this.pages.push(created);
    return { page: created, created: true };
  }

  async getPageBySlug(appId: string, slug: string) {
    return (
      this.pages.find(
        (page) =>
          page.appId === appId && page.slug === normalizeBrainSlug(slug),
      ) ?? null
    );
  }

  async getEntityByName(
    appId: string,
    kind: BrainEntity['kind'],
    normalizedName: string,
  ) {
    return (
      this.entities.find(
        (entity) =>
          entity.appId === appId &&
          entity.kind === kind &&
          entity.normalizedName === normalizedName,
      ) ?? null
    );
  }

  async upsertEntities(appId: string, writes: BrainEntityWrite[]) {
    const out: BrainEntity[] = [];
    for (const write of writes) {
      let entity = this.entities.find(
        (candidate) =>
          candidate.appId === appId &&
          candidate.kind === write.kind &&
          candidate.normalizedName === write.normalizedName,
      );
      if (!entity) {
        entity = {
          id: `entity-${this.entities.length + 1}`,
          appId,
          kind: write.kind,
          name: write.name,
          normalizedName: write.normalizedName,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
        this.entities.push(entity);
      }
      out.push(entity);
    }
    return out;
  }

  async replacePageEdges(
    appId: string,
    pageId: string,
    writes: BrainEdgeWrite[],
  ) {
    this.edges = this.edges.filter((edge) => edge.evidencePageId !== pageId);
    for (const write of writes) {
      this.edges.push({
        id: `edge-${this.edges.length + 1}`,
        appId,
        type: write.type,
        fromEntityId: write.fromEntityId,
        toEntityId: write.toEntityId,
        evidencePageId: pageId,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    }
    return this.edges.filter((edge) => edge.evidencePageId === pageId);
  }

  async getEdge(input: {
    appId: string;
    type: BrainEdge['type'];
    fromEntityId: string;
    toEntityId: string;
    evidencePageId: string;
  }) {
    return (
      this.edges.find(
        (edge) =>
          edge.appId === input.appId &&
          edge.type === input.type &&
          edge.fromEntityId === input.fromEntityId &&
          edge.toEntityId === input.toEntityId &&
          edge.evidencePageId === input.evidencePageId,
      ) ?? null
    );
  }

  async upsertEdges(appId: string, pageId: string, writes: BrainEdgeWrite[]) {
    for (const write of writes) {
      const existing = await this.getEdge({
        appId,
        type: write.type,
        fromEntityId: write.fromEntityId,
        toEntityId: write.toEntityId,
        evidencePageId: pageId,
      });
      if (!existing) {
        this.edges.push({
          id: `edge-${this.edges.length + 1}`,
          appId,
          type: write.type,
          fromEntityId: write.fromEntityId,
          toEntityId: write.toEntityId,
          evidencePageId: pageId,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        });
      }
    }
    return this.edges.filter((edge) => edge.evidencePageId === pageId);
  }

  async searchLexical(): Promise<BrainRankedPage[]> {
    return [];
  }

  async searchVector(): Promise<BrainRankedPage[]> {
    return [];
  }

  async graphForPages(_appId: string, pageIds: string[]): Promise<BrainGraph> {
    const edges = this.edges.filter((edge) =>
      pageIds.includes(edge.evidencePageId),
    );
    const entityIds = new Set(
      edges.flatMap((edge) => [edge.fromEntityId, edge.toEntityId]),
    );
    return {
      edges,
      entities: this.entities.filter((entity) => entityIds.has(entity.id)),
    };
  }

  async findPeopleWorkingAt(appId: string, companyName: string) {
    const company = this.entities.find(
      (entity) =>
        entity.appId === appId &&
        entity.kind === 'company' &&
        entity.normalizedName === normalizeEntityName(companyName),
    );
    if (!company) return [];
    return this.edges
      .filter(
        (edge) =>
          edge.appId === appId &&
          edge.type === 'works_at' &&
          edge.toEntityId === company.id,
      )
      .flatMap((edge) => {
        const person = this.entities.find(
          (entity) => entity.id === edge.fromEntityId,
        );
        const evidence = this.pages.find(
          (candidate) => candidate.id === edge.evidencePageId,
        );
        return person && evidence ? [{ person, company, page: evidence }] : [];
      });
  }

  async writePageEmbedding(): Promise<void> {}
  async markPageEmbeddingError(): Promise<void> {}
  async listPendingEmbeddingPages() {
    return [];
  }
  async status() {
    return {
      pages: this.pages.length,
      channelPages: this.pages.filter((page) => page.sourceKind === 'channel')
        .length,
      dreamPages: this.pages.filter((page) => page.sourceKind === 'dream')
        .length,
      entities: this.entities.length,
      edges: this.edges.length,
      dreamDecisions: this.decisions.length,
      lastDreamCursor: this.cursor?.updatedAt ?? null,
      readyEmbeddings: 0,
      pendingEmbeddings: 0,
    };
  }

  async getDreamCursor() {
    return this.cursor;
  }

  async listPagesForDream(input: {
    cursor?: BrainDreamCursor | null;
    limit: number;
  }) {
    return this.pages
      .filter((page) => page.sourceKind !== 'dream')
      .filter((page) => {
        if (!input.cursor) return true;
        return (
          page.updatedAt > input.cursor.updatedAt ||
          (page.updatedAt === input.cursor.updatedAt &&
            page.id > input.cursor.pageId)
        );
      })
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, input.limit);
  }

  async saveDreamCursor(_appId: string, cursor: BrainDreamCursor) {
    this.cursor = cursor;
  }

  async journalDreamDecision(input: BrainDreamDecisionWrite) {
    this.decisions.push(input);
  }
}

function channelMessage(
  overrides: Partial<import('@core/domain/types.js').NewMessage>,
) {
  return {
    id: 'm1',
    chat_jid: 'sl:C123',
    providerAccountId: 'slack_one',
    sender: 'U1',
    sender_name: 'Alice',
    content: 'Hello',
    timestamp: '2026-07-07T01:02:03.000Z',
    ...overrides,
  };
}

function settingsWithHarvest(enabled: boolean) {
  return {
    providerAccounts: {
      slack_one: {
        agentId: 'main_agent',
        provider: 'slack',
        label: 'Slack',
        runtimeSecretRefs: {},
      },
    },
    conversations: {
      sales: {
        providerAccount: 'slack_one',
        externalId: 'C123',
        kind: 'channel',
        displayName: 'Sales',
        brainHarvest: enabled,
        senderPolicy: { allow: '*', mode: 'trigger' },
        controlApprovers: [],
        installedAgents: {},
      },
    },
  } as never;
}
