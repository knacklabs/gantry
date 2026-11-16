import { StateBackend } from 'deepagents';

// Caller-only jobs have no filesystem reader. Refuse scratch offload so the
// library keeps complete inputs/results inline instead of inaccessible previews.
// This adds no filesystem authority; inherited reads still serve seeded skills.
export class InlineCallerEvidenceBackend extends StateBackend {
  override write(
    _filePath: string,
    _content: string,
  ): ReturnType<StateBackend['write']> {
    return {
      error:
        'Caller evidence must remain inline; scratch offload is unavailable.',
    };
  }
}
