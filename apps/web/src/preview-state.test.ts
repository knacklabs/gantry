import { describe, expect, it } from 'vitest';

import { agentListSearchSchema } from './features/agents/agents-search';
import { providers } from './features/operations/operations-preview';
import { providerSearchSchema } from './features/operations/operations-search';
import { workflowPreviewQuery } from './features/workflows/workflows-queries';

describe('static preview state', () => {
  it('filters_and_defaults_preview_search_without_runtime_input', () => {
    expect(providerSearchSchema.parse({})).toMatchObject({
      q: '',
      status: 'all',
      page: 1,
    });
    expect(agentListSearchSchema.parse({ page: 0 })).toMatchObject({ page: 1 });
    expect(
      providers.filter((provider) => provider.status === 'ready'),
    ).toHaveLength(2);
  });

  it('keeps_workflow_data_in_memory', () => {
    expect(workflowPreviewQuery.queryKey).toEqual(['workflows', 'definitions']);
    expect(workflowPreviewQuery.queryFn?.({} as never)).toEqual(
      workflowPreviewQuery.initialData,
    );
  });
});
