/** Public, secret-free validation model metadata. No production default mutation. */
export function lunaValidationAlias(alias) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(alias))
    throw new Error('Invalid isolated model alias');
  return {
    provider: 'openai',
    provider_model_id: 'gpt-6-luna',
    display_name: 'Isolated validation GPT-6 Luna',
    aliases: [alias],
    recommended_alias: alias,
    supported_workloads: [
      'chat',
      'one_time_job',
      'recurring_job',
      'memory_extractor',
      'memory_dreaming',
      'memory_consolidation',
    ],
    context_window_tokens: 1050000,
    max_output_tokens: 128000,
    input_usd_per_million_tokens: 0.1,
    output_usd_per_million_tokens: 0.5,
    cached_input_usd_per_million_tokens: 0.01,
    cache_write_usd_per_million_tokens: 0.125,
    supports_thinking: true,
    supported_effort_levels: ['low', 'medium', 'high', 'xhigh'],
    supports_tools: true,
    source: {
      label: 'Isolated GPT-6 Luna validation',
      url: 'https://developers.openai.com/api/docs/models/gpt-6-luna',
      verified_at: '2026-11-18',
    },
  };
}
