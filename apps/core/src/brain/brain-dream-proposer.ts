import { getMemoryModelRuntimeConfig } from '../config/index.js';
import type { AppId } from '../domain/app/app.js';
import { getMemoryLlmClient } from '../memory/memory-llm-port.js';
import type { BrainPage } from './brain-types.js';

export interface BrainDreamProposalPort {
  propose(input: {
    appId: string;
    pages: BrainPage[];
    observerEnabled?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<unknown[] | BrainDreamProposal>;
}

export interface BrainDreamProposal {
  operations: unknown[];
  surfaceableInsights: unknown[];
}

const BRAIN_OPERATION_PROMPT_LINES = [
  'Allowed additive operations:',
  '{"action":"upsert_entity","kind":"person|company|project|topic","name":"name"}',
  '{"action":"upsert_edge","type":"works_at|member_of|mentions|authored|assigned_to|relates_to","from":{"kind":"person|company|project|topic","name":"name"},"to":{"kind":"person|company|project|topic","name":"name"},"evidencePageId":"page id"}',
  '{"action":"write_fact_page","topic":"stable topic","title":"title","markdown":"short durable fact page","evidencePageIds":["page id"]}',
  '{"action":"enrich_entity_page","kind":"person|company|project|topic","name":"name","markdown":"short entity summary","evidencePageIds":["page id"]}',
  'Destructive operations may be proposed, but the host journals them without applying.',
] as const;

const BRAIN_DREAM_PROMPT = [
  'You consolidate Gantry company brain pages into grounded knowledge.',
  'Return strict JSON array operations only.',
  ...BRAIN_OPERATION_PROMPT_LINES,
  'Use only supplied page ids as evidence.',
].join('\n');

const OBSERVER_BRAIN_DREAM_PROMPT = [
  'You consolidate Gantry company brain pages into grounded knowledge and identify surfaceable insights.',
  'Return one strict JSON object with arrays named operations and surfaceableInsights.',
  'operations accepts the same additive or destructive operation shapes below:',
  ...BRAIN_OPERATION_PROMPT_LINES,
  'Each surfaceable insight must have insightType, title, summary, canonicalSignature, confidence, and evidencePageIds.',
  'Allowed insightType values: commitment, contradiction, open_question, stale_fact, decision_without_owner, duplicated_work.',
  'canonicalSignature is the concise canonical content phrase, not a hash.',
  'confidence is a number from 0 through 1.',
  'Use only supplied page ids as evidence.',
].join('\n');

export class MemoryLlmBrainDreamProposer implements BrainDreamProposalPort {
  async propose(input: {
    appId: string;
    pages: BrainPage[];
    observerEnabled?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<unknown[] | BrainDreamProposal> {
    const llm = getMemoryLlmClient();
    if (!llm.isConfigured()) {
      throw new Error('Brain dreaming LLM client is not configured');
    }
    const { dreaming: model, modelProfiles } = getMemoryModelRuntimeConfig();
    const payload = {
      pages: input.pages.slice(0, 10).map((page) => ({
        id: page.id,
        slug: page.slug,
        title: page.title,
        sourceKind: page.sourceKind,
        markdown: dreamMarkdownWindow(page.markdown),
        metadata: page.metadata,
      })),
    };
    const prompt = input.observerEnabled
      ? OBSERVER_BRAIN_DREAM_PROMPT
      : BRAIN_DREAM_PROMPT;
    const text = await llm.query({
      appId: input.appId as AppId,
      model,
      modelProfile: modelProfiles?.dreaming,
      systemPrompt: prompt,
      prompt: `${prompt}\n\n${JSON.stringify(payload, null, 2)}`,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
    input.signal?.throwIfAborted();
    return input.observerEnabled
      ? parseJsonProposal(text)
      : parseJsonArray(text);
  }
}

// ponytail: bounded recency window — new harvest lines append at the tail,
// so the tail always reaches the model. First dream of a page already past
// the cap misses the oldest prefix; track a per-page dreamed offset if that
// ever matters.
export function dreamMarkdownWindow(markdown: string): string {
  const CAP = 5000;
  if (markdown.length <= CAP) return markdown;
  return `…${markdown.slice(-CAP)}`;
}

function parseJsonProposal(text: string): BrainDreamProposal {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last < first) {
    throw new Error('brain dream proposer returned no JSON object');
  }
  const value = JSON.parse(text.slice(first, last + 1)) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('brain dream proposer returned non-object JSON');
  }
  const proposal = value as Record<string, unknown>;
  if (
    !Array.isArray(proposal.operations) ||
    !Array.isArray(proposal.surfaceableInsights)
  ) {
    throw new Error(
      'Brain dreaming observer proposal requires operations and surfaceableInsights arrays',
    );
  }
  return {
    operations: proposal.operations,
    surfaceableInsights: proposal.surfaceableInsights,
  };
}

function parseJsonArray(text: string): unknown[] {
  // Malformed model output must throw, not read as a valid empty op list:
  // the batch loop saves the dream cursor after each page, and silently
  // returning [] would permanently skip the page.
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first < 0 || last < first) {
    throw new Error('brain dream proposer returned no JSON array');
  }
  const parsed = JSON.parse(text.slice(first, last + 1)) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('brain dream proposer returned non-array JSON');
  }
  return parsed;
}
