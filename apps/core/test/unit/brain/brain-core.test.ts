import { describe, expect, it } from 'vitest';

import {
  extractBrainPageRefs,
  normalizeEntityName,
  parseBrainMarkdown,
} from '@core/brain/brain-page-ingest.js';
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

  async upsertPage(input: BrainPageWrite) {
    const existing = this.pages.find(
      (page) => page.appId === input.appId && page.slug === input.slug,
    );
    if (existing) {
      Object.assign(existing, {
        title: input.title,
        markdown: input.markdown,
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      return { page: existing, created: false };
    }
    const created = page(input.slug, input.title, input.markdown);
    created.appId = input.appId;
    this.pages.push(created);
    return { page: created, created: true };
  }

  async upsertEntities(appId: string, writes: BrainEntityWrite[]) {
    for (const write of writes) {
      if (
        !this.entities.some(
          (entity) =>
            entity.appId === appId &&
            entity.kind === write.kind &&
            entity.normalizedName === write.normalizedName,
        )
      ) {
        this.entities.push({
          id: `entity-${this.entities.length + 1}`,
          appId,
          kind: write.kind,
          name: write.name,
          normalizedName: write.normalizedName,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        });
      }
    }
    return this.entities;
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
      entities: this.entities.length,
      edges: this.edges.length,
      readyEmbeddings: 0,
      pendingEmbeddings: 0,
    };
  }
}
