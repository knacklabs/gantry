import type { AppId } from '../domain/app/app.js';
import { getMemoryModelRuntimeConfig } from '../config/index.js';
import { getMemoryLlmClient } from '../memory/memory-llm-port.js';
import type { BrainCitation, BrainSearchResult } from './brain-types.js';

export interface BrainSynthesisInput {
  appId: string;
  question: string;
  results: BrainSearchResult[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BrainSynthesisOutput {
  answer: string;
  citations: BrainCitation[];
  gaps: string;
}

export interface BrainSynthesisPort {
  synthesize(input: BrainSynthesisInput): Promise<BrainSynthesisOutput>;
}

const BRAIN_SYNTHESIS_PROMPT = [
  'You answer questions using only the provided Gantry company brain pages.',
  'Return strict JSON: {"answer":"short answer","citations":[{"pageId":"id","title":"title","slug":"slug"}],"gaps":"what is unknown"}',
  'Citations must use only provided page ids. If evidence is missing, say so in gaps.',
].join('\n');

export class MemoryLlmBrainSynthesis implements BrainSynthesisPort {
  async synthesize(input: BrainSynthesisInput): Promise<BrainSynthesisOutput> {
    const llm = getMemoryLlmClient();
    const fallback = fallbackSynthesis(input);
    if (!llm.isConfigured()) return fallback;
    const { consolidation: model, modelProfiles } =
      getMemoryModelRuntimeConfig();
    const payload = {
      question: input.question,
      pages: input.results.slice(0, 8).map((result) => ({
        pageId: result.page.id,
        title: result.page.title,
        slug: result.page.slug,
        markdown: result.page.markdown.slice(0, 2400),
        entities: result.graph.entities.map((entity) => ({
          id: entity.id,
          kind: entity.kind,
          name: entity.name,
        })),
        edges: result.graph.edges.map((edge) => ({
          type: edge.type,
          fromEntityId: edge.fromEntityId,
          toEntityId: edge.toEntityId,
          evidencePageId: edge.evidencePageId,
        })),
      })),
    };
    const text = await llm.query({
      appId: input.appId as AppId,
      model,
      modelProfile: modelProfiles?.consolidation,
      systemPrompt: BRAIN_SYNTHESIS_PROMPT,
      prompt: `${BRAIN_SYNTHESIS_PROMPT}\n\n${JSON.stringify(payload, null, 2)}`,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
    return parseBrainSynthesisOutput(text, fallback, input.results);
  }
}

export function parseBrainSynthesisOutput(
  text: string,
  fallback: BrainSynthesisOutput,
  results: BrainSearchResult[],
): BrainSynthesisOutput {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last < first) return fallback;
  try {
    const parsed = JSON.parse(text.slice(first, last + 1)) as Record<
      string,
      unknown
    >;
    const answer =
      typeof parsed.answer === 'string' && parsed.answer.trim()
        ? parsed.answer.trim()
        : fallback.answer;
    const gaps =
      typeof parsed.gaps === 'string' && parsed.gaps.trim()
        ? parsed.gaps.trim()
        : fallback.gaps;
    const allowedPages = new Map(
      results.map((result) => [result.page.id, result.page]),
    );
    const citations = Array.isArray(parsed.citations)
      ? parsed.citations
          .map((entry) =>
            entry && typeof entry === 'object'
              ? (entry as Record<string, unknown>)
              : null,
          )
          .filter((entry): entry is Record<string, unknown> => Boolean(entry))
          .map((entry) => ({
            pageId: String(entry.pageId || ''),
            title: String(entry.title || ''),
            slug: String(entry.slug || ''),
          }))
          .filter((entry) => allowedPages.has(entry.pageId))
          .map((entry) => {
            const page = allowedPages.get(entry.pageId)!;
            return {
              pageId: page.id,
              title: page.title,
              slug: page.slug,
            };
          })
      : fallback.citations;
    return { answer, citations, gaps };
  } catch {
    return fallback;
  }
}

function fallbackSynthesis(input: BrainSynthesisInput): BrainSynthesisOutput {
  const citations = input.results.slice(0, 3).map((result) => ({
    pageId: result.page.id,
    title: result.page.title,
    slug: result.page.slug,
  }));
  return {
    answer:
      input.results[0]?.snippet ||
      'No matching company brain pages were found.',
    citations,
    gaps:
      input.results.length > 0
        ? 'Synthesis model was not configured; answer is an extractive summary.'
        : 'The company brain has no retrieved evidence for this question.',
  };
}
