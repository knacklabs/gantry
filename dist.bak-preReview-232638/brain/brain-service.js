import { brainContentHash, brainEmbeddingText, extractBrainPageRefs, normalizeBrainSlug, normalizeEntityName, parseBrainMarkdown, sourceKindFromFrontmatter, } from './brain-page-ingest.js';
import { recallBrainPages } from './brain-recall.js';
import { MemoryLlmBrainSynthesis, } from './brain-synthesis.js';
export class BrainService {
    repository;
    deps;
    synthesis;
    constructor(repository, deps = {}) {
        this.repository = repository;
        this.deps = deps;
        this.synthesis = deps.synthesis ?? new MemoryLlmBrainSynthesis();
    }
    async write(input) {
        const parsed = parseBrainMarkdown(input.markdown);
        const slug = normalizeBrainSlug(input.slug);
        if (!slug)
            throw new Error('brain page slug is required');
        // The caller's source kind wins: frontmatter is untrusted content and
        // must not spoof internal kinds like 'channel' or 'dream'.
        const sourceKind = input.sourceKind ??
            sourceKindFromFrontmatter(parsed.frontmatter.source_kind, 'agent');
        const { page, created } = await this.repository.upsertPage({
            appId: input.appId,
            slug,
            title: input.title?.trim() || parsed.title,
            markdown: parsed.body,
            sourceKind,
            sourceRef: input.sourceRef ??
                stringFromFrontmatter(parsed.frontmatter.source_ref) ??
                null,
            authorId: input.authorId ??
                stringFromFrontmatter(parsed.frontmatter.author_id) ??
                null,
            metadata: parsed.frontmatter,
        });
        const extracted = extractBrainPageRefs(parsed);
        const entityRefs = ensureEdgeEntityRefs(extracted.entities, extracted.edges);
        const entities = await this.repository.upsertEntities(input.appId, entityRefs.map((ref) => ({
            kind: ref.kind,
            name: ref.name,
            normalizedName: normalizeEntityName(ref.name),
        })));
        const entityByKey = new Map(entities.map((entity) => [
            `${entity.kind}:${entity.normalizedName}`,
            entity,
        ]));
        const edges = await this.repository.replacePageEdges(input.appId, page.id, extracted.edges.flatMap((edge) => {
            const from = entityByKey.get(`${edge.from.kind}:${normalizeEntityName(edge.from.name)}`);
            const to = entityByKey.get(`${edge.to.kind}:${normalizeEntityName(edge.to.name)}`);
            return from && to
                ? [{ type: edge.type, fromEntityId: from.id, toEntityId: to.id }]
                : [];
        }));
        if (input.embed !== false)
            await this.embedPageIfEnabled(page);
        return { page, created, entities, edges };
    }
    getPageBySlug(appId, slug) {
        return this.repository.getPageBySlug(appId, normalizeBrainSlug(slug));
    }
    async search(input) {
        const queryVector = await this.embedQuery(input.query);
        const ranked = await recallBrainPages({
            repository: this.repository,
            appId: input.appId,
            query: input.query,
            limit: input.limit,
            queryVector,
            embedding: queryVector ? this.deps.embedding?.config : undefined,
        });
        return this.withGraph(ranked);
    }
    async query(input) {
        const edgeAnswer = await this.tryEdgeQuestion(input.appId, input.question);
        if (edgeAnswer)
            return edgeAnswer;
        const results = await this.search({
            appId: input.appId,
            query: input.question,
            limit: input.limit ?? 8,
        });
        const synthesized = await this.synthesis.synthesize({
            appId: input.appId,
            question: input.question,
            results,
            signal: input.signal,
            timeoutMs: input.timeoutMs,
        });
        return { ...synthesized, results };
    }
    status(appId) {
        return this.repository.status(appId, this.deps.embedding?.config);
    }
    async backfillEmbeddings(input) {
        if (!this.deps.embedding?.provider.isEnabled()) {
            return { indexed: 0, pending: 0, skipped: 0 };
        }
        const pending = await this.repository.listPendingEmbeddingPages({
            appId: input.appId,
            embedding: this.deps.embedding.config,
            limit: Math.max(1, Math.min(input.limit ?? 100, 1000)),
        });
        let indexed = 0;
        let skipped = 0;
        for (const candidate of pending) {
            input.signal?.throwIfAborted();
            try {
                const [vector] = await this.deps.embedding.provider.embedMany([
                    candidate.text,
                ]);
                if (!vector)
                    throw new Error('embedding provider returned no vector');
                await this.repository.writePageEmbedding({
                    pageId: candidate.page.id,
                    embedding: this.deps.embedding.config,
                    contentHash: candidate.contentHash,
                    vector,
                });
                indexed += 1;
            }
            catch (error) {
                await this.repository.markPageEmbeddingError({
                    pageId: candidate.page.id,
                    embedding: this.deps.embedding.config,
                    contentHash: candidate.contentHash,
                    error: error instanceof Error ? error.message : String(error),
                });
                skipped += 1;
            }
        }
        return {
            indexed,
            skipped,
            pending: Math.max(0, pending.length - indexed - skipped),
        };
    }
    async withGraph(ranked) {
        const graph = await this.repository.graphForPages(ranked[0]?.page.appId ?? '', ranked.map((row) => row.page.id));
        return ranked.map((row) => ({
            ...row,
            snippet: snippet(row.page.markdown),
            graph: graphForPage(graph, row.page.id),
        }));
    }
    async embedPageIfEnabled(page) {
        if (!this.deps.embedding?.provider.isEnabled())
            return;
        const contentHash = brainContentHash(page);
        try {
            const vector = await this.deps.embedding.provider.embedOne(brainEmbeddingText(page));
            await this.repository.writePageEmbedding({
                pageId: page.id,
                embedding: this.deps.embedding.config,
                contentHash,
                vector,
            });
        }
        catch (error) {
            await this.repository.markPageEmbeddingError({
                pageId: page.id,
                embedding: this.deps.embedding.config,
                contentHash,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    async embedQuery(query) {
        if (!query.trim() || !this.deps.embedding?.provider.isEnabled())
            return null;
        try {
            return await this.deps.embedding.provider.embedOne(query);
        }
        catch {
            return null;
        }
    }
    async tryEdgeQuestion(appId, question) {
        const match = /^who\s+works\s+at\s+(.+?)\??$/i.exec(question.trim());
        if (!match?.[1])
            return null;
        const rows = await this.repository.findPeopleWorkingAt(appId, match[1]);
        const citations = rows.map((row) => ({
            pageId: row.page.id,
            title: row.page.title,
            slug: row.page.slug,
        }));
        return {
            answer: rows.length > 0
                ? `${rows.map((row) => row.person.name).join(', ')} work${rows.length === 1 ? 's' : ''} at ${rows[0].company.name}.`
                : `No people working at ${match[1].trim()} are recorded in the company brain.`,
            citations,
            gaps: rows.length > 0
                ? 'Only explicit works_at edges are included.'
                : 'No works_at edge matched that company.',
            results: [],
        };
    }
}
function ensureEdgeEntityRefs(entities, edges) {
    return [...entities, ...edges.flatMap((edge) => [edge.from, edge.to])];
}
function stringFromFrontmatter(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function snippet(markdown) {
    return markdown.replace(/\s+/g, ' ').trim().slice(0, 280);
}
function graphForPage(graph, pageId) {
    const edges = graph.edges.filter((edge) => edge.evidencePageId === pageId);
    const entityIds = new Set(edges.flatMap((edge) => [edge.fromEntityId, edge.toEntityId]));
    return {
        edges,
        entities: graph.entities.filter((entity) => entityIds.has(entity.id)),
    };
}
