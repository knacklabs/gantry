/** Isolated operator bootstrap. This script never generates model output. */
import fs from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { createClient } from '@gantry/sdk';
process.on('uncaughtException', (error) => {
  console.error(
    JSON.stringify({
      error: 'Isolated Luna provisioning failed',
      ...(typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code)
        ? { code: error.code }
        : {}),
    }),
  );
  process.exit(1);
});
const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://127.0.0.1:3939' },
    'provider-env': { type: 'string' },
    'check-count': { type: 'boolean' },
    alias: { type: 'string', multiple: true, default: ['manipal.chat'] },
  },
});
if (
  process.env.GANTRY_FLEET_REHEARSAL_AUTO_SECRETS !== '1' ||
  process.env.GANTRY_CHAT_VALIDATION_MODEL !== 'gpt-6-luna'
)
  throw new Error('Explicit isolated Luna validation flags are required');
const database = new URL(
  process.env.GANTRY_DATABASE_URL ?? 'postgres://invalid/invalid',
);
if (!database.pathname.startsWith('/chat_'))
  throw new Error('Only an isolated chat validation database is allowed');
const appId = process.env.GANTRY_APP_ID;
if (!appId || appId !== process.env.GANTRY_CONTROL_APP_ID)
  throw new Error(
    'Matching isolated runtime/control application IDs are required',
  );
const url = new URL(values['base-url']);
if (!['127.0.0.1', 'localhost'].includes(url.hostname))
  throw new Error('Operator bootstrap requires a loopback endpoint');
const records = JSON.parse(process.env.GANTRY_CONTROL_API_KEYS_JSON ?? '[]');
const keyFor = (scope) => {
  const key = records.find(
    (row) => row.appId === appId && row.scopes?.includes(scope),
  );
  if (!key?.token) throw new Error(`Isolated ${scope} key unavailable`);
  return key.token;
};
if (!values['provider-env'])
  throw new Error('Private provider env path is required');
const secret = parseEnv(
  fs.readFileSync(values['provider-env'], 'utf8'),
).OPENAI_API_KEY?.trim();
if (!secret) throw new Error('Authorized OpenAI key unavailable');
const credentials = createClient({
  baseUrl: url.href,
  apiKey: keyFor('credentials:admin'),
});
await credentials.models.credentials.put('openai', {
  authMode: 'api_key',
  payload: { apiKey: secret },
});
const client = createClient({
  baseUrl: url.href,
  apiKey: keyFor('agents:admin'),
});
const state = await client.settings.getDesiredState();
if (!state.settings)
  throw new Error('Canonical app settings must be provisioned first');
const settings = structuredClone(state.settings);
settings.model_aliases ??= {};
for (const alias of values.alias) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(alias))
    throw new Error('Invalid isolated model alias');
  settings.model_aliases[alias] = {
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
    // Standard short-context rates verified at developers.openai.com/api/docs/pricing.
    input_usd_per_million_tokens: 0.1,
    output_usd_per_million_tokens: 0.5,
    cached_input_usd_per_million_tokens: 0.01,
    cache_write_usd_per_million_tokens: 0.125,
    supports_thinking: true,
    supported_effort_levels: ['low', 'medium', 'high', 'xhigh'],
    supports_tools: true,
    source: 'isolated-chat-validation',
  };
}
const updated = await client.settings.updateDesiredState({
  settings,
  expectedRevision: state.revision,
  note: 'Explicit isolated GPT-6 Luna validation override; production defaults preserved',
});
const effective = await client.settings.getDesiredState();
for (const alias of values.alias) {
  const model = effective.settings?.model_aliases?.[alias];
  if (model?.provider !== 'openai' || model?.provider_model_id !== 'gpt-6-luna')
    throw new Error('Canonical validation alias did not persist');
}
console.log(
  JSON.stringify({
    appId,
    revision: updated.revision,
    provider: 'openai',
    effectiveModel: 'gpt-6-luna',
    aliases: values.alias,
    reasoningEffort: 'none',
    endpoint: 'responses',
    paidCalls: 0,
  }),
);

if (values['check-count']) {
  const response = await fetch(
    'https://api.openai.com/v1/responses/input_tokens',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        input: 'Isolated validation count only.',
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    console.log(
      JSON.stringify({
        provider: 'openai',
        model: 'gpt-6-luna',
        countOnly: true,
        status: response.status,
        paidCalls: 0,
      }),
    );
    process.exitCode = 1;
  } else {
    const count = await response.json();
    if (
      count.object !== 'response.input_tokens' ||
      !Number.isSafeInteger(count.input_tokens) ||
      count.input_tokens < 0
    )
      throw new Error('Invalid count response');
    console.log(
      JSON.stringify({
        provider: 'openai',
        model: 'gpt-6-luna',
        countOnly: true,
        status: response.status,
        inputTokens: count.input_tokens,
        paidCalls: 0,
      }),
    );
  }
}
