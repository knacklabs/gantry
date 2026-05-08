import type { SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';
import { collectDurableMemoryFromRepositories } from './boundary-extraction-core.js';
import { createLlmMemoryExtractionProvider } from './extractor-llm.js';
import { loadBoundaryExtractionAppMemoryItems } from './app-memory-session-hydration.js';

interface SessionBoundaryCollectorDeps {
  repositories: any;
  memory: {
    recordEvidence: (value: any) => Promise<{ id: string }>;
  };
}

export async function collectDurableMemoryAtBoundary(
  input: Parameters<SessionMemoryCollector>[0],
  deps: SessionBoundaryCollectorDeps,
): ReturnType<SessionMemoryCollector> {
  const extractor = createLlmMemoryExtractionProvider();
  return collectDurableMemoryFromRepositories({
    ...input,
    repositories: {
      agentSessions: deps.repositories.agentSessions,
      messages: deps.repositories.messages,
      memory: {
        listPriorMemoryItems: loadBoundaryExtractionAppMemoryItems,
        saveBoundaryEvidence: async (value) => {
          const evidence = await deps.memory.recordEvidence({
            ...value,
            sourceType: 'session',
          });
          return { id: evidence.id };
        },
      },
      sessionDigests: deps.repositories.agentSessionDigests,
    },
    extractFacts: (extractInput) => extractor.extractFacts(extractInput),
  });
}
