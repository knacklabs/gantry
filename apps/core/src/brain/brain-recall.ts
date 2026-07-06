import type { BrainRankedPage, BrainRepository } from './brain-repository.js';
import type { BrainEmbeddingConfig } from './brain-types.js';

export const BRAIN_RRF_K = 60;

export function brainHybridCandidateLimit(limit: number): number {
  return Math.min(100, Math.max(limit * 4, 20));
}

export async function recallBrainPages(input: {
  repository: BrainRepository;
  appId: string;
  query: string;
  limit?: number;
  queryVector?: number[] | null;
  embedding?: BrainEmbeddingConfig;
}): Promise<BrainRankedPage[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
  const query = input.query.trim();
  if (!input.queryVector || !input.embedding) {
    return input.repository.searchLexical({ appId: input.appId, query, limit });
  }
  const candidateLimit = brainHybridCandidateLimit(limit);
  const [lexicalRows, vectorRows] = await Promise.all([
    input.repository.searchLexical({
      appId: input.appId,
      query,
      limit: candidateLimit,
    }),
    input.repository.searchVector({
      appId: input.appId,
      vector: input.queryVector,
      embedding: input.embedding,
      limit: candidateLimit,
    }),
  ]);
  const merged = new Map<
    string,
    {
      row: BrainRankedPage;
      lexicalScore: number;
      vectorScore: number;
      rrf: number;
      reasons: Set<string>;
    }
  >();
  const ensure = (candidate: BrainRankedPage) => {
    const existing = merged.get(candidate.page.id);
    if (existing) return existing;
    const created = {
      row: candidate,
      lexicalScore: 0,
      vectorScore: 0,
      rrf: 0,
      reasons: new Set<string>(),
    };
    merged.set(candidate.page.id, created);
    return created;
  };
  lexicalRows.forEach((candidate, index) => {
    const entry = ensure(candidate);
    entry.lexicalScore = candidate.lexicalScore;
    entry.rrf += 1 / (BRAIN_RRF_K + index + 1);
    for (const reason of candidate.reasons) entry.reasons.add(reason);
  });
  vectorRows.forEach((candidate, index) => {
    const entry = ensure(candidate);
    entry.vectorScore = candidate.vectorScore;
    entry.rrf += 1 / (BRAIN_RRF_K + index + 1);
    for (const reason of candidate.reasons) entry.reasons.add(reason);
  });
  return [...merged.values()]
    .map((entry) => ({
      page: entry.row.page,
      score: entry.rrf,
      lexicalScore: entry.lexicalScore,
      vectorScore: entry.vectorScore,
      reasons: [...entry.reasons],
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const updated = b.page.updatedAt.localeCompare(a.page.updatedAt);
      if (updated !== 0) return updated;
      return a.page.slug.localeCompare(b.page.slug);
    })
    .slice(0, limit);
}
