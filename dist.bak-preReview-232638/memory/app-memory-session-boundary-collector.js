import { collectDurableMemoryFromRepositories } from './boundary-extraction-core.js';
import { createLlmMemoryExtractionProvider } from './extractor-llm.js';
import { loadBoundaryExtractionAppMemoryItems } from './app-memory-session-hydration.js';
export async function collectDurableMemoryAtBoundary(input, deps) {
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
        extractFacts: (extractInput) => extractor.extractFactsWithOutcome
            ? extractor.extractFactsWithOutcome(extractInput)
            : extractor.extractFacts(extractInput),
    });
}
